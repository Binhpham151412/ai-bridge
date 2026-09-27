import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { sha256Text } from '../integrity/integrity.ts';
import { EVENT_TYPES, type BridgeEvent } from '../observability/events.ts';
import { CodexResponseParser } from '../../reports/codex-response-parser.ts';
import { redactSecrets } from '../security/redact.ts';
import type { ExecutionAgent, ExecutionRecord, ExecutionStatus } from '../execution/execution-record.ts';

/**
 * Read-only views over the session structure AI Bridge already writes to disk
 * (`.ai-bridge/sessions/<runId>/`, `.ai-bridge/reports/`, `.ai-bridge/logs/events.jsonl`)
 * — no new database, no new files (M4 §11). Used by `BridgeEngine.listSessions()` /
 * `getSessionArtifacts()` / `recentEvents()` so a UI never has to know this layout.
 */

/** `<YYYY-MM-DD>_<NNN>`, exactly what `SessionManager` produces. Also the only shape a
 * caller-supplied run id is ever allowed to have before it touches a path — rules out
 * `..`, separators, drive letters, etc. */
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{3}$/;

export function isValidRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/** Per-file cap on what is returned to a caller — artifacts are shown, never edited. */
export const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_EVENTS_PER_READ = 5000;

export interface SessionSummary {
  runId: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Live display status for the current session (RUNNING/INTERRUPTED/...), else the
   * final status recorded by its last RUN_COMPLETED/RUN_STOPPED event, else UNKNOWN. */
  status: string;
  iterations: number;
  /** The errorCode recorded with the session's final event, if any. */
  errorCode: string | null;
  recovered: boolean;
  isCurrent: boolean;
  /** M4.1: the Claude CLI session / Codex thread this AI Bridge session used — as the CLI
   * reported it (or as requested, when never confirmed); null = unknown. Never invented. */
  claudeSessionId: string | null;
  codexThreadId: string | null;
}

/** An execution record as stored, plus what it means *now*: a record still saying
 * RUNNING whose session is no longer running was cut off (crash or stop). */
export interface ExecutionView {
  record: ExecutionRecord;
  effectiveStatus: ExecutionStatus | 'INTERRUPTED' | 'STOPPED';
}

export interface ArtifactText {
  path: string;
  text: string;
  bytes: number;
  truncated: boolean;
  sha256: string;
}

export type ReportArtifact =
  | ({ availability: 'AVAILABLE'; source: 'REPORT_FILE' | 'CODEX_INPUT'; verification: 'VERIFIED' | 'UNVERIFIED' } & ArtifactText)
  | { availability: 'MISSING' | 'OVERWRITTEN'; path: string; note: string };

export interface IterationArtifacts {
  iteration: number;
  /** Exactly what AI Bridge piped to Claude for this iteration. */
  claudePrompt: ArtifactText | null;
  report: ReportArtifact;
  /** Exactly what AI Bridge sent to Codex (template + verbatim report). */
  codexInput: ArtifactText | null;
  /** Codex's raw response for this iteration. */
  codexResponse: ArtifactText | null;
  /** The PROMPT block extracted from Codex's response (next iteration's Claude prompt). */
  extractedPrompt: ArtifactText | null;
  integrity: Record<string, unknown> | null;
  /** M4.1 execution records (null for sessions recorded before M4.1, or a step never reached). */
  claudeExecution: ExecutionView | null;
  codexExecution: ExecutionView | null;
  /** STATUS Codex returned for this iteration (CONTINUE / DONE / NEED_HUMAN), null if none/invalid. */
  codexVerdict: string | null;
}

export interface SessionArtifacts {
  runId: string;
  iterations: IterationArtifacts[];
  events: BridgeEvent[];
  /** `current-session.json`, only when this run is the project's current session. */
  state: Record<string, unknown> | null;
}

export interface CurrentSessionInfo {
  runId: string;
  displayStatus: string;
  iteration: number;
  state: Record<string, unknown>;
}

function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === 'string' &&
    typeof v.runId === 'string' &&
    typeof v.iteration === 'number' &&
    typeof v.phase === 'string' &&
    typeof v.event === 'string' &&
    (EVENT_TYPES as readonly string[]).includes(v.event) &&
    (v.detail === undefined || typeof v.detail === 'string')
  );
}

/** Reads `events.jsonl.1` (the rotated backup, older) then `events.jsonl`, skipping any
 * line that isn't a well-formed event rather than failing the whole read. Returns at
 * most the newest `limit` events, oldest first. */
export async function readEventLog(eventsPath: string, limit = MAX_EVENTS_PER_READ): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = [];
  for (const file of [`${eventsPath}.1`, eventsPath]) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isBridgeEvent(parsed)) events.push(parsed);
      } catch {
        // A torn/corrupt line (e.g. a crash mid-append) is skipped, never fatal.
      }
    }
  }
  return events.slice(-limit);
}

export async function readArtifact(filePath: string): Promise<ArtifactText | null> {
  const size = await stat(filePath).then((s) => (s.isFile() ? s.size : null)).catch(() => null);
  if (size === null) return null;
  const buffer = await readFile(filePath).catch(() => null);
  if (buffer === null) return null;
  const full = buffer.toString('utf8');
  const truncated = buffer.byteLength > MAX_ARTIFACT_BYTES;
  return {
    path: filePath,
    text: truncated ? buffer.subarray(0, MAX_ARTIFACT_BYTES).toString('utf8') : full,
    bytes: buffer.byteLength,
    truncated,
    sha256: sha256Text(full),
  };
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const BEGIN_REPORT = '--- BEGIN REPORT ---\n\n';
const END_REPORT = '\n\n--- END REPORT ---';

/** Inverse of `buildReviewerInput`'s fixed framing (src/prompts/templates.ts): the
 * report text sits verbatim between these two marker lines. */
function extractReportFromCodexInput(codexInput: string): string | null {
  const start = codexInput.indexOf(BEGIN_REPORT);
  const end = codexInput.lastIndexOf(END_REPORT);
  if (start === -1 || end === -1 || end < start + BEGIN_REPORT.length) return null;
  return codexInput.slice(start + BEGIN_REPORT.length, end);
}

/**
 * `.ai-bridge/reports/NNN-report.md` is shared by every session of a project, so a later
 * session overwrites an earlier one's report with the same NNN. The report file is only
 * returned when it provably is *this* session's report (hash recorded in
 * `NNN-integrity.json`, or verbatim inside what was sent to Codex); otherwise the report
 * as it was actually sent to Codex is recovered from `NNN-chatgpt-input.md`.
 */
async function resolveReport(reportPath: string, codexInput: ArtifactText | null, integrity: Record<string, unknown> | null): Promise<ReportArtifact> {
  const recordedHash = typeof integrity?.reportHash === 'string' ? integrity.reportHash : null;
  const file = await readArtifact(reportPath);

  if (file) {
    const matchesHash = recordedHash !== null && file.sha256 === recordedHash;
    const insideCodexInput = codexInput !== null && !codexInput.truncated && !file.truncated && codexInput.text.includes(file.text);
    if (matchesHash || (recordedHash === null && insideCodexInput)) {
      return { availability: 'AVAILABLE', source: 'REPORT_FILE', verification: 'VERIFIED', ...file };
    }
    if (recordedHash === null && codexInput === null) {
      // Claude wrote a report but Codex never received it (e.g. the run stopped at
      // REPORT_VALIDATED) — nothing to verify against yet; shown, flagged as such.
      return { availability: 'AVAILABLE', source: 'REPORT_FILE', verification: 'UNVERIFIED', ...file };
    }
  }

  const fromInput = codexInput && !codexInput.truncated ? extractReportFromCodexInput(codexInput.text) : null;
  if (codexInput && fromInput !== null) {
    const sha256 = sha256Text(fromInput);
    return {
      availability: 'AVAILABLE',
      source: 'CODEX_INPUT',
      verification: recordedHash !== null && sha256 === recordedHash ? 'VERIFIED' : 'UNVERIFIED',
      path: codexInput.path,
      text: fromInput,
      bytes: Buffer.byteLength(fromInput, 'utf8'),
      truncated: false,
      sha256,
    };
  }

  if (file) {
    return { availability: 'OVERWRITTEN', path: reportPath, note: "The report file on disk belongs to a later session (same iteration number) and this session's copy could not be recovered." };
  }
  return { availability: 'MISSING', path: reportPath, note: 'No report was produced for this iteration.' };
}

async function listIterationNumbers(sessionDir: string): Promise<number[]> {
  const names = await readdir(sessionDir).catch(() => [] as string[]);
  const numbers = new Set<number>();
  for (const name of names) {
    const m = /^(\d{3})-/.exec(name);
    if (m) numbers.add(Number(m[1]));
  }
  return [...numbers].filter((n) => n > 0).sort((a, b) => a - b);
}

function isExecutionRecord(v: unknown): v is ExecutionRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.schema === 1 && (r.agent === 'claude' || r.agent === 'codex') && typeof r.iteration === 'number' && typeof r.status === 'string';
}

async function readExecution(sessionDir: string, nnn: string, agent: ExecutionAgent, runId: string, current: CurrentSessionInfo | null): Promise<ExecutionView | null> {
  const raw = await readJson(path.join(sessionDir, `${nnn}-${agent}-execution.json`));
  if (!isExecutionRecord(raw)) return null;
  let effectiveStatus: ExecutionView['effectiveStatus'] = raw.status;
  if (raw.status === 'RUNNING') {
    const live = current !== null && current.runId === runId && current.displayStatus === 'RUNNING';
    if (!live) effectiveStatus = current !== null && current.runId === runId && current.displayStatus === 'STOPPED' ? 'STOPPED' : 'INTERRUPTED';
  }
  return { record: raw, effectiveStatus };
}

const responseParser = new CodexResponseParser();

function codexVerdict(response: ArtifactText | null): string | null {
  if (!response || response.truncated) return null;
  const parsed = responseParser.parse(response.text);
  return parsed.valid ? (parsed.status ?? null) : null;
}

/** The CLI session/thread this AI Bridge session actually worked in: the id the CLI
 * reported for the latest *successful* call. A failed call's reported id is not trusted
 * (real finding: `claude --resume <unknown id>` exits 1 yet reports a brand-new id).
 * Falls back to any reported id, then to the latest requested one. */
async function latestCliId(sessionDir: string, agent: ExecutionAgent, iterations: number[]): Promise<string | null> {
  let anyReported: string | null = null;
  let requested: string | null = null;
  for (const n of [...iterations].reverse()) {
    const rec = await readJson(path.join(sessionDir, `${String(n).padStart(3, '0')}-${agent}-execution.json`));
    if (!isExecutionRecord(rec)) continue;
    if (rec.status === 'COMPLETED' && rec.cliSessionId.reported) return rec.cliSessionId.reported;
    anyReported ??= rec.cliSessionId.reported;
    requested ??= rec.cliSessionId.requested;
  }
  return anyReported ?? requested;
}

function summarize(runId: string, events: BridgeEvent[], iterations: number, current: CurrentSessionInfo | null, ids: { claude: string | null; codex: string | null }): SessionSummary {
  const own = events.filter((e) => e.runId === runId);
  const firstStart = own.find((e) => e.event === 'RUN_STARTED');
  const lastStart = [...own].reverse().find((e) => e.event === 'RUN_STARTED');
  const lastEnd = [...own].reverse().find((e) => e.event === 'RUN_COMPLETED' || e.event === 'RUN_STOPPED');
  // A RUN_STARTED after the last end (e.g. a resume still going, or one that crashed)
  // means the session has not ended.
  const ended = lastEnd !== undefined && (lastStart === undefined || lastEnd.timestamp >= lastStart.timestamp);
  const isCurrent = current !== null && current.runId === runId;

  let status = 'UNKNOWN';
  if (isCurrent) status = current.displayStatus;
  else if (ended) status = lastEnd.phase;

  return {
    runId,
    startedAt: firstStart?.timestamp ?? null,
    endedAt: ended ? lastEnd.timestamp : null,
    status,
    iterations: isCurrent ? Math.max(iterations, current.iteration) : iterations,
    errorCode: ended && lastEnd.detail ? lastEnd.detail : null,
    recovered: own.some((e) => e.event === 'RECOVERY_STARTED'),
    isCurrent,
    claudeSessionId: ids.claude ?? (isCurrent && typeof current.state.claudeSessionId === 'string' ? current.state.claudeSessionId : null),
    codexThreadId: ids.codex ?? (isCurrent && typeof current.state.codexThreadId === 'string' ? current.state.codexThreadId : null),
  };
}

/** Newest session first. */
export async function listSessions(aiBridgeDir: string, eventsPath: string, current: CurrentSessionInfo | null): Promise<SessionSummary[]> {
  const sessionsDir = path.join(aiBridgeDir, 'sessions');
  const names = (await readdir(sessionsDir).catch(() => [] as string[])).filter(isValidRunId).sort().reverse();
  const events = await readEventLog(eventsPath);
  const summaries: SessionSummary[] = [];
  for (const runId of names) {
    const sessionDir = path.join(sessionsDir, runId);
    const iterations = await listIterationNumbers(sessionDir);
    const ids = { claude: await latestCliId(sessionDir, 'claude', iterations), codex: await latestCliId(sessionDir, 'codex', iterations) };
    summaries.push(summarize(runId, events, iterations.length > 0 ? iterations[iterations.length - 1] : 0, current, ids));
  }
  return summaries;
}

export async function readSessionArtifacts(aiBridgeDir: string, eventsPath: string, runId: string, current: CurrentSessionInfo | null): Promise<SessionArtifacts | null> {
  if (!isValidRunId(runId)) return null;
  const sessionDir = path.join(aiBridgeDir, 'sessions', runId);
  const dirStat = await stat(sessionDir).catch(() => null);
  if (!dirStat?.isDirectory()) return null;

  const iterations: IterationArtifacts[] = [];
  for (const n of await listIterationNumbers(sessionDir)) {
    const nnn = String(n).padStart(3, '0');
    const codexInput = await readArtifact(path.join(sessionDir, `${nnn}-chatgpt-input.md`));
    const integrity = await readJson(path.join(sessionDir, `${nnn}-integrity.json`));
    const codexResponse = await readArtifact(path.join(sessionDir, `${nnn}-chatgpt-review.md`));
    iterations.push({
      iteration: n,
      claudePrompt: await readArtifact(path.join(sessionDir, `${nnn}-claude-prompt.md`)),
      report: await resolveReport(path.join(aiBridgeDir, 'reports', `${nnn}-report.md`), codexInput, integrity),
      codexInput,
      codexResponse,
      extractedPrompt: await readArtifact(path.join(sessionDir, `${nnn}-extracted-prompt.md`)),
      integrity,
      claudeExecution: await readExecution(sessionDir, nnn, 'claude', runId, current),
      codexExecution: await readExecution(sessionDir, nnn, 'codex', runId, current),
      codexVerdict: codexVerdict(codexResponse),
    });
  }

  const events = (await readEventLog(eventsPath)).filter((e) => e.runId === runId);
  return { runId, iterations, events, state: current !== null && current.runId === runId ? current.state : null };
}

export type OutputStream = 'stdout' | 'stderr';

/** At most this much CLI output crosses to a caller per request — the *tail* (the end of
 * a CLI's output is where errors and the final result live). The full file stays on disk. */
export const MAX_OUTPUT_TAIL_BYTES = 256 * 1024;

export interface ExecutionOutput {
  path: string;
  /** The last MAX_OUTPUT_TAIL_BYTES of the persisted (already redacted) output, redacted again. */
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Reads a persisted CLI output artifact by its fixed name — the caller never supplies a
 * path. Only the tail is read from disk (no full read of a large file). */
export async function readExecutionOutput(aiBridgeDir: string, runId: string, iteration: number, agent: ExecutionAgent, stream: OutputStream): Promise<ExecutionOutput | null> {
  if (!isValidRunId(runId) || !Number.isInteger(iteration) || iteration < 1 || iteration > 999) return null;
  if ((agent !== 'claude' && agent !== 'codex') || (stream !== 'stdout' && stream !== 'stderr')) return null;
  const nnn = String(iteration).padStart(3, '0');
  const file = path.join(aiBridgeDir, 'sessions', runId, `${nnn}-${agent}-${stream === 'stdout' ? 'stdout.jsonl' : 'stderr.log'}`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const bytes = info.size;
  const length = Math.min(bytes, MAX_OUTPUT_TAIL_BYTES);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, bytes - length);
    return { path: file, text: redactSecrets(buffer.toString('utf8')), bytes, truncated: bytes > length };
  } finally {
    await handle.close();
  }
}
