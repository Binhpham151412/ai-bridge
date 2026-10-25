import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodexCliAdapter } from '../adapters/chatgpt/codex-cli-adapter.ts';
import { checkEnvForApiKeys } from '../core/cost-guard.ts';
import { AtomicJsonWriter } from '../core/state-manager/atomic-json-writer.ts';
import { buildChatReportContract, buildChatReviewerInput } from '../prompts/templates.ts';
import { CodexResponseParser, type BridgeStatus } from '../reports/codex-response-parser.ts';
import { parseReviewProgress, type ReviewProgress } from './progress.ts';
import { finalReply, readTranscript } from './transcript.ts';

/**
 * docs/66 — the AI Bridge review loop inside a Claude Code session. `handlePrompt` is the
 * UserPromptSubmit hook (`/bridge <task>` arms the loop), `handleStop` the Stop hook (Codex
 * reviews Claude's final message; CONTINUE blocks the stop with Codex's next prompt).
 * Both return the hook's JSON output, or null for "print nothing, change nothing".
 */

export type LoopStatus = 'RUNNING' | 'DONE' | 'NEED_HUMAN' | 'ERROR' | 'STOPPED';

export interface LoopState {
  sessionId: string;
  projectPath: string;
  task: string;
  status: LoopStatus;
  /** 1 for the first `/bridge` in this session; each re-arm gets its own artifact folder. */
  loop: number;
  /** Reviews done in this loop. */
  round: number;
  maxRounds: number;
  codexThreadId: string | null;
  /** When the running Codex review started (for the side pane); null between reviews. */
  reviewingSince: string | null;
  lastVerdict: { round: number; status: BridgeStatus; prompt: string } | null;
  /** Codex's checklist and conclusion from its latest review that had them (absent in a state written before 0.3.0). */
  progress?: ReviewProgress | null;
  error: string | null;
  armedAt: string;
  updatedAt: string;
}

export interface HookOutput {
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'UserPromptSubmit'; additionalContext: string };
}

export interface PromptInput {
  session_id: string;
  cwd: string;
  prompt: string;
}

export interface PromptDeps {
  stateRoot: string;
  now: () => Date;
}

export interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export interface StopDeps {
  stateRoot: string;
  now: () => Date;
  /** The hook's environment: checked by the cost guard, inherited by Codex. */
  env: NodeJS.ProcessEnv;
  codexTimeoutMs: number;
  /** Called only when a review is due; null = Codex is not installed. */
  locateCodex: () => Promise<Pick<CodexCliAdapter, 'run'> | null>;
  /** Wait between transcript reads when the reply is not flushed yet (default 500 ms, 0 = no retry). */
  transcriptRetryMs?: number;
}

export const MAX_ROUNDS = 10;
const TRANSCRIPT_READS = 4;

const BRIDGE_COMMAND = /^\/(?:ai-bridge:)?bridge(?=\s|$)([\s\S]*)$/;
/** Claude Code session ids are UUIDs; anything else would not be a safe folder name. */
const isPlainId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);

const statePath = (root: string, sessionId: string) => path.join(root, sessionId, 'state.json');
const loopDir = (root: string, s: LoopState) => path.join(root, s.sessionId, `loop-${s.loop}`);

export async function loadLoopState(root: string, sessionId: string): Promise<LoopState | null> {
  try {
    return JSON.parse(await readFile(statePath(root, sessionId), 'utf8')) as LoopState;
  } catch {
    return null;
  }
}

function saveLoopState(root: string, state: LoopState): Promise<void> {
  return new AtomicJsonWriter<LoopState>(statePath(root, state.sessionId)).write(state);
}

export async function handlePrompt(input: PromptInput, deps: PromptDeps): Promise<HookOutput | null> {
  if (!isPlainId(input.session_id)) return null;
  const m = BRIDGE_COMMAND.exec((input.prompt ?? '').trim());
  if (!m) return null;
  const arg = m[1].trim();
  const prev = await loadLoopState(deps.stateRoot, input.session_id);
  const at = deps.now().toISOString();

  if (arg === '') return { decision: 'block', reason: 'AI Bridge: give the task, e.g. `/bridge fix the login bug`, or `/bridge stop` to end the loop.' };
  if (arg === 'stop') {
    if (prev?.status !== 'RUNNING') return { decision: 'block', reason: 'AI Bridge: no review loop is running in this session.' };
    await saveLoopState(deps.stateRoot, { ...prev, status: 'STOPPED', reviewingSince: null, updatedAt: at });
    return { decision: 'block', reason: `AI Bridge: review loop stopped after ${prev.round} round(s).` };
  }

  await saveLoopState(deps.stateRoot, {
    sessionId: input.session_id,
    projectPath: input.cwd,
    task: arg,
    status: 'RUNNING',
    loop: (prev?.loop ?? 0) + 1,
    round: 0,
    maxRounds: MAX_ROUNDS,
    codexThreadId: null,
    reviewingSince: null,
    lastVerdict: null,
    progress: null,
    error: null,
    armedAt: at,
    updatedAt: at,
  });
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: buildChatReportContract() } };
}

async function readReply(input: StopInput, retryMs: number): Promise<string | null> {
  if (input.last_assistant_message?.trim()) return input.last_assistant_message;
  for (let i = 1; ; i++) {
    const reply = finalReply(await readTranscript(input.transcript_path).catch(() => []));
    if (reply?.trim()) return reply;
    if (i >= TRANSCRIPT_READS || retryMs === 0) return null;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

export async function handleStop(input: StopInput, deps: StopDeps): Promise<HookOutput | null> {
  if (!isPlainId(input.session_id)) return null;
  const state = await loadLoopState(deps.stateRoot, input.session_id);
  if (state?.status !== 'RUNNING') return null;

  const end = async (status: LoopStatus, message: string, patch: Partial<LoopState> = {}): Promise<HookOutput> => {
    await saveLoopState(deps.stateRoot, { ...state, ...patch, status, reviewingSince: null, updatedAt: deps.now().toISOString() });
    return { systemMessage: message };
  };
  const fail = (error: string, patch: Partial<LoopState> = {}) => end('ERROR', `AI Bridge: ${error} — review loop stopped.`, { ...patch, error });

  const keys = checkEnvForApiKeys(deps.env);
  if (keys.blocked) return fail(`cost-risk env vars set (${keys.foundKeys.join(', ')})`);

  const reply = await readReply(input, deps.transcriptRetryMs ?? 500);
  if (reply === null) return fail('no final message from Claude to review');

  const codex = await deps.locateCodex();
  if (codex === null) return fail('Codex CLI not found (PATH or %LOCALAPPDATA%\\OpenAI\\Codex\\bin)');

  const round = state.round + 1;
  const nnn = String(round).padStart(3, '0');
  const dir = loopDir(deps.stateRoot, state);
  await mkdir(dir, { recursive: true });
  await setAsideInterrupted(dir, nnn, state.reviewingSince ?? deps.now().toISOString());
  await writeFile(path.join(dir, `${nnn}-report.md`), reply, 'utf8');
  const reviewerInput = buildChatReviewerInput({
    projectName: path.basename(state.projectPath),
    sessionId: state.sessionId,
    iteration: round,
    reportText: reply,
    task: state.task,
    maxRounds: state.maxRounds,
    checklist: state.progress?.items ?? null,
  });
  await writeFile(path.join(dir, `${nnn}-codex-input.md`), reviewerInput, 'utf8');
  await saveLoopState(deps.stateRoot, { ...state, reviewingSince: deps.now().toISOString(), updatedAt: deps.now().toISOString() });

  const result = await codex.run({
    cwd: state.projectPath,
    input: reviewerInput,
    threadId: state.codexThreadId,
    outputPath: path.join(dir, `${nnn}-codex-review.md`),
    timeoutMs: deps.codexTimeoutMs,
    env: deps.env,
  });
  // `/bridge stop` or a new `/bridge` typed while Codex was reviewing wins over this review.
  const current = await loadLoopState(deps.stateRoot, state.sessionId);
  if (current?.status !== 'RUNNING' || current.loop !== state.loop) return null;
  if (!result.ok) return fail(`Codex review failed (${result.errorCode})`, { round });

  const parsed = new CodexResponseParser().parse(result.responseText ?? '');
  if (!parsed.valid || parsed.status === null || parsed.prompt === null) {
    return fail(`Codex response not usable (${parsed.errors.map((e) => e.code).join(', ')})`, { round, codexThreadId: result.threadId });
  }

  // A review that left out its checklist keeps the last one.
  const progress = parseReviewProgress(result.responseText ?? '') ?? state.progress ?? null;
  const patch: Partial<LoopState> = { round, codexThreadId: result.threadId, lastVerdict: { round, status: parsed.status, prompt: parsed.prompt }, progress, error: null };
  const message = (verdict: string, next: string) => roundMessage(round, state.maxRounds, verdict, progress, next);
  if (parsed.status === 'DONE') return end('DONE', message(VERDICT_WORDS.DONE, `Xong sau ${round} vòng review, vòng lặp kết thúc.`), patch);
  if (parsed.status === 'NEED_HUMAN') return end('NEED_HUMAN', message(VERDICT_WORDS.NEED_HUMAN, `→ Codex cần bạn: ${parsed.prompt}`), patch);
  if (round >= state.maxRounds) {
    return end('NEED_HUMAN', message('⏸ Đã hết số vòng', `Codex chưa duyệt; vòng lặp dừng ở đây. Chỉ dẫn Codex định gửi tiếp:\n${parsed.prompt}`), patch);
  }

  await saveLoopState(deps.stateRoot, { ...state, ...patch, reviewingSince: null, updatedAt: deps.now().toISOString() });
  return {
    decision: 'block',
    reason: [
      `AI Bridge — Codex review, round ${round}: CONTINUE. Next instruction:`,
      '',
      parsed.prompt,
      '',
      acknowledgeReview(round),
      '',
      buildChatReportContract(progress?.items ?? null),
    ].join('\n'),
    systemMessage: message(VERDICT_WORDS.CONTINUE, '→ Claude làm tiếp theo chỉ dẫn của Codex.'),
  };
}

const ROUND_FILES = ['report.md', 'codex-input.md', 'codex-review.md'];

/**
 * A Stop hook killed mid-review (the user interrupted it) leaves this round's files behind
 * without counting the round. They move to `interrupted/<NNN>-<when it began>-…`, so the retry
 * keeps the same number and overwrites nothing.
 */
async function setAsideInterrupted(dir: string, nnn: string, since: string): Promise<void> {
  const stamp = since.replace(/:/g, '-');
  for (const name of ROUND_FILES) {
    const from = path.join(dir, `${nnn}-${name}`);
    if (!(await stat(from).then(() => true, () => false))) continue;
    await mkdir(path.join(dir, 'interrupted'), { recursive: true });
    await rename(from, path.join(dir, 'interrupted', `${nnn}-${stamp}-${name}`));
  }
}

/** Codex's verdict in the user's words, as the chat and the side pane say it. */
const VERDICT_WORDS: Record<BridgeStatus, string> = {
  CONTINUE: 'Codex: chưa duyệt, Claude làm tiếp',
  DONE: '✅ Codex đã duyệt',
  NEED_HUMAN: '⏸ Codex cần bạn',
};

/**
 * What the chat shows after a reviewed round: round of rounds, the verdict in plain words and
 * how many parts are done; Codex's conclusion and each part (✓/✗); then what happens next.
 */
function roundMessage(round: number, maxRounds: number, verdict: string, progress: ReviewProgress | null, next: string): string {
  const items = progress?.items ?? [];
  const count = items.length > 0 ? ` · ${items.filter((i) => i.done).length}/${items.length} phần xong` : '';
  return [
    `AI Bridge · vòng ${round}/${maxRounds} · ${verdict}${count}`,
    ...(progress?.verdict ? [progress.verdict] : []),
    ...items.map((i) => `${i.done ? '✓' : '✗'} ${i.text}`),
    next,
  ].join('\n');
}

/** Makes Claude say in the chat that the review arrived, so the chat matches the side pane. */
function acknowledgeReview(round: number): string {
  return (
    `Begin your reply with one short line, in the user's language, telling the user you received Codex's round ${round} review ` +
    `and what you will do next (for example: "Đã nhận review vòng ${round} của Codex (CONTINUE) — tiếp theo tôi sẽ …").`
  );
}
