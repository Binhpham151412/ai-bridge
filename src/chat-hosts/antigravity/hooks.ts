import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { handlePrompt, handleStop, loadLoopState, type PromptDeps, type StopDeps } from '../../claude-code/bridge-loop.ts';
import { finalReply, lastUserRequest, readSteps } from './transcript.ts';

/**
 * docs/68 — the AI Bridge review loop inside Antigravity (`agy`), over the Claude Code plugin's
 * loop (`src/claude-code/bridge-loop.ts`, unchanged). agy hooks (antigravity.google/docs/hooks,
 * checked against agy 1.3.4):
 *
 *   PreInvocation (the first model call of a turn: `invocationNum` 0)  →  `/bridge …` armed
 *       from the transcript's last user message; the report contract goes in as `injectSteps`.
 *   Stop  →  Codex reviews the agent's final message (from the transcript); CONTINUE answers
 *       `{ decision: "continue", reason }`, which agy injects as a system message and re-enters.
 *
 * agy hooks have no field that shows the user a message, so the round's status line (and the loop's
 * end) reach the user through the model: the reason asks it to show them verbatim.
 */

export interface AgyHookInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  executionNum?: number;
  terminationReason?: string;
  error?: string;
  /** false while background commands are still running: the agent has not finished. */
  fullyIdle?: boolean;
}

export interface PreInvocationOutput {
  injectSteps: Array<{ systemMessage: { systemMessage: string } }>;
}

export interface StopOutput {
  decision: 'continue';
  reason: string;
}

export type AgyDeps = Omit<StopDeps, 'transcriptRetryMs'> &
  Pick<PromptDeps, 'headCommit'> & {
    /** Wait between transcript reads while the step is not flushed yet (default 300 ms, 0 = no retry). */
    retryMs?: number;
  };

const READS = 4;
const BRIDGE_COMMAND = /^\/(?:ai-bridge:)?bridge(?=\s|$)/;
/** agy conversation ids are UUIDs; anything else would not be a safe folder name. */
const conversationOf = (i: AgyHookInput) => (typeof i.conversationId === 'string' && /^[A-Za-z0-9_-]+$/.test(i.conversationId) ? i.conversationId : null);
const cwdOf = (i: AgyHookInput) => i.workspacePaths?.find((p) => typeof p === 'string' && p !== '') ?? process.cwd();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The last user message handled, so a hook run twice for one message arms once. */
const cursorPath = (root: string, conversation: string) => path.join(root, conversation, 'prompt-cursor.json');

async function loadCursor(root: string, conversation: string): Promise<number> {
  try {
    const v = (JSON.parse(await readFile(cursorPath(root, conversation), 'utf8')) as { stepIndex?: unknown }).stepIndex;
    return typeof v === 'number' ? v : -1;
  } catch {
    return -1;
  }
}

async function saveCursor(root: string, conversation: string, stepIndex: number): Promise<void> {
  await mkdir(path.join(root, conversation), { recursive: true });
  await writeFile(cursorPath(root, conversation), JSON.stringify({ stepIndex }), 'utf8');
}

/** The answer to `/bridge stop` or a refused command, for the model to hand on (there is no way to block the prompt). */
const answerToUser = (message: string) =>
  `The user typed an AI Bridge command, and AI Bridge answered it: "${message}". Reply with exactly that message, in one short line, and do nothing else: do not start a task, do not use any tool.`;

const injected = (text: string): PreInvocationOutput => ({ injectSteps: [{ systemMessage: { systemMessage: text } }] });

export async function handlePreInvocation(input: AgyHookInput, deps: AgyDeps): Promise<PreInvocationOutput | null> {
  const conversation = conversationOf(input);
  if (conversation === null || input.invocationNum !== 0 || !input.transcriptPath) return null;

  // the user's message is the newest step; it may not be flushed to the file yet
  let request = null;
  for (let i = 1; i <= READS; i++) {
    const steps = await readSteps(input.transcriptPath).catch(() => []);
    request = lastUserRequest(steps);
    if (steps.length >= (input.initialNumSteps ?? 0) || i === READS || (deps.retryMs ?? 300) === 0) break;
    await pause(deps.retryMs ?? 300);
  }
  if (request === null || !BRIDGE_COMMAND.test(request.text)) return null;
  if (request.stepIndex <= (await loadCursor(deps.stateRoot, conversation))) return null;
  await saveCursor(deps.stateRoot, conversation, request.stepIndex);

  const out = await handlePrompt({ session_id: conversation, cwd: cwdOf(input), prompt: request.text }, { stateRoot: deps.stateRoot, now: deps.now, headCommit: deps.headCommit });
  if (out === null) return null;
  if (out.decision === 'block') return injected(answerToUser(out.reason ?? 'AI Bridge'));
  const context = out.hookSpecificOutput?.additionalContext;
  return context ? injected(context) : null;
}

/** The agent's final message, waiting for the transcript to show it. */
async function readReply(transcriptPath: string | undefined, retryMs: number): Promise<string | null> {
  if (!transcriptPath) return null;
  for (let i = 1; ; i++) {
    const reply = finalReply(await readSteps(transcriptPath).catch(() => []));
    if (reply !== null) return reply;
    if (i >= READS || retryMs === 0) return null;
    await pause(retryMs);
  }
}

const block = (message: string) => `---\n${message}\n---`;

export async function handleAgyStop(input: AgyHookInput, deps: AgyDeps): Promise<StopOutput | null> {
  const conversation = conversationOf(input);
  if (conversation === null || input.fullyIdle === false || input.error) return null;
  const state = await loadLoopState(deps.stateRoot, conversation);
  if (state?.status !== 'RUNNING') return null;

  const reply = await readReply(input.transcriptPath, deps.retryMs ?? 300);
  const out = await handleStop(
    { session_id: conversation, cwd: state.projectPath, transcript_path: '', last_assistant_message: reply ?? '' },
    { ...deps, transcriptRetryMs: 0 },
  );
  if (out === null) return null;
  if (out.decision === 'block') {
    const status = out.systemMessage ? `AI Bridge status for the user: start your reply with the block below, exactly as written.\n${block(out.systemMessage)}\n\n` : '';
    return { decision: 'continue', reason: `${status}${out.reason ?? ''}` };
  }
  if (!out.systemMessage) return null;
  // The loop ended (approved, needs the user, round cap, error): agy shows nothing of a hook's own, so the model says it.
  return {
    decision: 'continue',
    reason: `The AI Bridge review loop has ended. Reply with the block below exactly as written and nothing else: do not use any tool, do not continue the task.\n${block(out.systemMessage)}`,
  };
}
