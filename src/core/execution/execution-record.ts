import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AtomicJsonWriter } from '../state-manager/atomic-json-writer.ts';
import { redactSecrets } from '../security/redact.ts';
import type { ResolvedPermissionPolicy } from '../permissions/permission-policy.ts';

/**
 * One persisted record per CLI invocation (M4.1): `<sessionDir>/<NNN>-claude-execution.json`
 * and `<NNN>-codex-execution.json`, next to the existing per-iteration artifacts — no new
 * database. Written once before the process is spawned (status RUNNING) and rewritten when
 * it ends, so a crash mid-call still leaves an honest "was running" record behind.
 *
 * Evidence rules (never claim more than was observed):
 * - `cliSessionId.evidence`: CONFIRMED_BY_CLI only when the CLI itself reported the id in
 *   its own output; an id AI Bridge merely requested stays REQUESTED_NOT_CONFIRMED; with
 *   neither, UNKNOWN — an id is never invented.
 * - `input.delivery`: STDIN_FLUSHED_AND_CLOSED means every prompt byte was accepted by
 *   the OS pipe and stdin was closed. It does NOT prove the CLI read or processed it.
 * - `continuity` (resume only): VERIFIED only when the CLI reported the exact session id
 *   that was asked to be resumed.
 */

export type ExecutionAgent = 'claude' | 'codex';
export type ExecutionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';
export type SessionIdEvidence = 'CONFIRMED_BY_CLI' | 'REQUESTED_NOT_CONFIRMED' | 'UNKNOWN';
export type ContinuityVerdict = 'VERIFIED' | 'MISMATCH' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type InputDelivery = 'PENDING' | 'STDIN_FLUSHED_AND_CLOSED' | 'STDIN_ERROR' | 'NOT_CONFIRMED';

/**
 * Token usage exactly as the CLI reported it for this call (M4.2) — never estimated from
 * characters/bytes/words. null in the record means UNKNOWN (the CLI reported nothing
 * usable). Claude: the stream-json `result` event's `usage` (Anthropic semantics — cache
 * tokens are in addition to input_tokens). Codex: the `turn.completed` event's `usage`
 * (OpenAI semantics — cached ⊂ input, reasoning ⊂ output). `totalTokens` states its formula.
 */
export interface TokenUsage {
  source: 'claude-result-event' | 'codex-turn-completed';
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number;
  totalFormula: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** From Claude's final `result` event only; null (UNKNOWN) when absent or malformed. */
export function parseClaudeUsage(stdout: string): TokenUsage | null {
  for (const line of stdout.split('\n').reverse()) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; usage?: Record<string, unknown> };
      if (e.type !== 'result') continue;
      const u = e.usage;
      const input = num(u?.input_tokens);
      const output = num(u?.output_tokens);
      if (!u || input === null || output === null) return null;
      const cacheCreate = num(u.cache_creation_input_tokens);
      const cacheRead = num(u.cache_read_input_tokens);
      return {
        source: 'claude-result-event',
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: cacheCreate,
        cacheReadInputTokens: cacheRead,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: input + output + (cacheCreate ?? 0) + (cacheRead ?? 0),
        totalFormula: 'input + cache_creation_input + cache_read_input + output',
      };
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

/** From Codex's last `turn.completed` event only; null (UNKNOWN) when absent or malformed. */
export function parseCodexUsage(stdout: string): TokenUsage | null {
  for (const line of stdout.split('\n').reverse()) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; usage?: Record<string, unknown> };
      if (e.type !== 'turn.completed') continue;
      const u = e.usage;
      const input = num(u?.input_tokens);
      const output = num(u?.output_tokens);
      if (!u || input === null || output === null) return null;
      return {
        source: 'codex-turn-completed',
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        cachedInputTokens: num(u.cached_input_tokens),
        reasoningTokens: num(u.reasoning_output_tokens),
        totalTokens: input + output,
        totalFormula: 'input + output (cached is part of input, reasoning is part of output)',
      };
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

export interface ExecutionRecord {
  schema: 1;
  agent: ExecutionAgent;
  iteration: number;
  bridgeSessionId: string;
  /** NEW = a fresh CLI session/thread; RESUME = continuing an existing one. */
  mode: 'NEW' | 'RESUME';
  cliSessionId: {
    /** The id AI Bridge asked the CLI to use/resume (Claude `--session-id`/`--resume`, Codex `exec resume`). */
    requested: string | null;
    /** The id the CLI itself reported in its output (Claude stream `session_id`, Codex `thread.started`). */
    reported: string | null;
    evidence: SessionIdEvidence;
  };
  continuity: { expected: string | null; reported: string | null; verdict: ContinuityVerdict; note: string };
  input: {
    /** Artifact holding the exact bytes written to the CLI's stdin. */
    file: string;
    sha256: string;
    bytes: number;
    delivery: InputDelivery;
    deliveredAt: string | null;
    deliveryError: string | null;
  };
  process: {
    pid: number | null;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
  };
  status: ExecutionStatus;
  /** The adapter's error code (e.g. NON_ZERO_EXIT) — null on success. */
  errorCode: string | null;
  output: {
    /** Always "CLI output": the CLI's own stdout event stream, not a conversation transcript. */
    kind: 'CLI_OUTPUT';
    stdoutFile: string | null;
    stdoutBytes: number;
    stdoutTruncated: boolean;
    stderrFile: string | null;
    stderrBytes: number;
    stderrTruncated: boolean;
  };
  /** Executable basename + argv with secrets redacted and long values summarized. */
  command: { executable: string; args: string[] };
  /** M4.2: token usage as reported by the CLI; null = UNKNOWN. Absent in pre-M4.2 records. */
  usage?: TokenUsage | null;
  /** M5.10.1: the permission policy this call ran under and the exact CLI flags it became.
   * Absent in pre-M5.10.1 records. */
  permission?: ExecutionPermission;
  updatedAt: string;
}

export interface ExecutionPermission extends ResolvedPermissionPolicy {
  cliArgs: string[];
}

export interface NewExecutionInput {
  agent: ExecutionAgent;
  iteration: number;
  bridgeSessionId: string;
  mode: 'NEW' | 'RESUME';
  requestedSessionId: string | null;
  inputFile: string;
  inputSha256: string;
  inputBytes: number;
  permission?: ExecutionPermission;
}

export function newExecutionRecord(i: NewExecutionInput): ExecutionRecord {
  return {
    schema: 1,
    agent: i.agent,
    iteration: i.iteration,
    bridgeSessionId: i.bridgeSessionId,
    mode: i.mode,
    cliSessionId: { requested: i.requestedSessionId, reported: null, evidence: i.requestedSessionId ? 'REQUESTED_NOT_CONFIRMED' : 'UNKNOWN' },
    continuity: {
      expected: i.mode === 'RESUME' ? i.requestedSessionId : null,
      reported: null,
      verdict: i.mode === 'RESUME' ? 'UNKNOWN' : 'NOT_APPLICABLE',
      note: i.mode === 'RESUME' ? 'Not yet known — the CLI has not reported a session id.' : 'Fresh session — nothing to continue.',
    },
    input: { file: path.basename(i.inputFile), sha256: i.inputSha256, bytes: i.inputBytes, delivery: 'PENDING', deliveredAt: null, deliveryError: null },
    process: { pid: null, startedAt: null, endedAt: null, durationMs: null, exitCode: null, signal: null, timedOut: false },
    status: 'RUNNING',
    errorCode: null,
    output: { kind: 'CLI_OUTPUT', stdoutFile: null, stdoutBytes: 0, stdoutTruncated: false, stderrFile: null, stderrBytes: 0, stderrTruncated: false },
    command: { executable: '', args: [] },
    usage: null,
    ...(i.permission !== undefined ? { permission: i.permission } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/** Argument values longer than this are summarized (e.g. the report contract passed via
 * --append-system-prompt) — the record documents *how* the CLI was called, not payloads. */
const MAX_ARG_CHARS = 200;

export function sanitizeCommand(executable: string, args: readonly string[]): { executable: string; args: string[] } {
  return {
    executable: path.basename(executable),
    args: args.map((a) => (a.length > MAX_ARG_CHARS ? `<${Buffer.byteLength(a, 'utf8')} bytes omitted>` : redactSecrets(a))),
  };
}

/** What the adapters report back, in the shape the finalizer needs. */
export interface ProcessOutcome {
  ok: boolean;
  errorCode: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  pid: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  reportedSessionId: string | null;
  inputDelivered: boolean;
  inputDeliveryError: string | null;
  executable: string;
  args: readonly string[];
}

export function finalizeExecutionRecord(record: ExecutionRecord, o: ProcessOutcome, files: { stdoutFile: string; stderrFile: string }): ExecutionRecord {
  const reported = o.reportedSessionId;
  const requested = record.cliSessionId.requested;
  let evidence: SessionIdEvidence = 'UNKNOWN';
  if (reported !== null) evidence = 'CONFIRMED_BY_CLI';
  else if (requested !== null) evidence = 'REQUESTED_NOT_CONFIRMED';

  let continuity = record.continuity;
  if (record.mode === 'RESUME') {
    if (reported === null) {
      continuity = { expected: requested, reported: null, verdict: 'UNKNOWN', note: 'The CLI did not report a session id in its output, so continuity cannot be proven.' };
    } else if (reported === requested) {
      continuity = { expected: requested, reported, verdict: 'VERIFIED', note: 'The CLI reported exactly the session id that was requested for resume.' };
    } else {
      continuity = { expected: requested, reported, verdict: 'MISMATCH', note: 'The CLI reported a different session id than the one requested for resume.' };
    }
  }

  const status: ExecutionStatus = o.ok ? 'COMPLETED' : o.timedOut ? 'TIMEOUT' : 'FAILED';
  return {
    ...record,
    cliSessionId: { requested, reported, evidence },
    continuity,
    input: {
      ...record.input,
      delivery: o.inputDelivered ? 'STDIN_FLUSHED_AND_CLOSED' : o.inputDeliveryError ? 'STDIN_ERROR' : 'NOT_CONFIRMED',
      deliveredAt: o.inputDelivered ? (record.input.deliveredAt ?? o.startedAt) : null,
      deliveryError: o.inputDeliveryError ? redactSecrets(o.inputDeliveryError) : null,
    },
    process: {
      pid: o.pid,
      startedAt: o.startedAt,
      endedAt: o.endedAt,
      durationMs: o.durationMs,
      exitCode: o.exitCode,
      signal: o.signal,
      timedOut: o.timedOut,
    },
    status,
    errorCode: o.ok ? null : o.errorCode,
    output: {
      kind: 'CLI_OUTPUT',
      stdoutFile: path.basename(files.stdoutFile),
      stdoutBytes: Buffer.byteLength(o.stdout, 'utf8'),
      stdoutTruncated: o.stdoutTruncated,
      stderrFile: path.basename(files.stderrFile),
      stderrBytes: Buffer.byteLength(o.stderr, 'utf8'),
      stderrTruncated: o.stderrTruncated,
    },
    command: sanitizeCommand(o.executable, o.args),
    usage: record.agent === 'claude' ? parseClaudeUsage(o.stdout) : parseCodexUsage(o.stdout),
    updatedAt: new Date().toISOString(),
  };
}

export async function writeExecutionRecord(file: string, record: ExecutionRecord): Promise<void> {
  await new AtomicJsonWriter<ExecutionRecord>(file).write(record);
}

/** CLI stdout/stderr are diagnostics (unlike prompts/reports, which must stay byte-exact),
 * so they are persisted with credential-shaped substrings masked. Already bounded in
 * memory by runProcess's maxBufferBytes. */
export async function persistCliOutput(file: string, text: string): Promise<void> {
  await writeFile(file, redactSecrets(text), 'utf8');
}

/** Short, redacted context for a failed (or suspicious) step, carried in the run outcome
 * so the UI's "View details" is useful without reading files. Tails are capped. */
export interface ExecutionDiagnostics {
  agent: ExecutionAgent;
  iteration: number;
  bridgeSessionId: string;
  cliSessionId: string | null;
  cliSessionIdEvidence: SessionIdEvidence;
  /** The id AI Bridge asked for (resume target), so a mismatch is visible, not hidden. */
  requestedSessionId: string | null;
  continuity: ContinuityVerdict;
  status: ExecutionStatus;
  errorCode: string | null;
  exitCode: number | null;
  durationMs: number | null;
  inputSha256: string;
  inputBytes: number;
  inputDelivery: InputDelivery;
  /** Claude only: the CLI's final `result` message (e.g. the answer it gave instead of writing a report). */
  finalMessage: string | null;
  stderrTail: string;
  stdoutTail: string;
  executionFile: string;
}

export const DIAGNOSTIC_TAIL_CHARS = 4000;

export function tail(text: string, chars = DIAGNOSTIC_TAIL_CHARS): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

export function buildDiagnostics(record: ExecutionRecord, o: { stdout: string; stderr: string; finalMessage: string | null }, executionFile: string): ExecutionDiagnostics {
  return {
    agent: record.agent,
    iteration: record.iteration,
    bridgeSessionId: record.bridgeSessionId,
    cliSessionId: record.cliSessionId.reported ?? record.cliSessionId.requested,
    cliSessionIdEvidence: record.cliSessionId.evidence,
    requestedSessionId: record.cliSessionId.requested,
    continuity: record.continuity.verdict,
    status: record.status,
    errorCode: record.errorCode,
    exitCode: record.process.exitCode,
    durationMs: record.process.durationMs,
    inputSha256: record.input.sha256,
    inputBytes: record.input.bytes,
    inputDelivery: record.input.delivery,
    finalMessage: o.finalMessage === null ? null : redactSecrets(tail(o.finalMessage, 2000)),
    stderrTail: redactSecrets(tail(o.stderr)),
    stdoutTail: redactSecrets(tail(o.stdout, 2000)),
    executionFile: path.basename(executionFile),
  };
}
