import { readFile } from 'node:fs/promises';

/**
 * docs/68 — Antigravity (`agy`) keeps each conversation as a JSONL transcript
 * (`~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl`;
 * its path is in every hook's input). Observed on agy 1.3.4: one object per step —
 * `USER_INPUT` (source `USER_EXPLICIT`, the text wrapped in `<USER_REQUEST>`), `PLANNER_RESPONSE`
 * (source `MODEL`: tool calls, or the reply as `content`), `SYSTEM_MESSAGE` (hook injections) and
 * tool results. Only the fields read here are typed.
 */
export interface AgyStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: unknown[];
}

/** Unparseable lines are skipped: the transcript is being appended to while it is read. */
export async function readSteps(transcriptPath: string): Promise<AgyStep[]> {
  const steps: AgyStep[] = [];
  for (const line of (await readFile(transcriptPath, 'utf8')).split('\n')) {
    if (line.trim() === '') continue;
    try {
      steps.push(JSON.parse(line) as AgyStep);
    } catch {
      // a partial last line
    }
  }
  return steps;
}

const USER_REQUEST = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;

/** The user's latest message: its step index and its text without agy's metadata wrapper. */
export function lastUserRequest(steps: AgyStep[]): { stepIndex: number; text: string } | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type !== 'USER_INPUT' || s.source !== 'USER_EXPLICIT' || typeof s.content !== 'string') continue;
    return { stepIndex: s.step_index ?? i, text: (USER_REQUEST.exec(s.content)?.[1] ?? s.content).trim() };
  }
  return null;
}

/**
 * The agent's final message of the turn: the last step, when it is a finished reply (text, no tool
 * call). Null while the transcript does not show one yet (the Stop hook can run before the reply is
 * flushed) or when the turn ended some other way.
 */
export function finalReply(steps: AgyStep[]): string | null {
  const last = steps.at(-1);
  if (last?.source !== 'MODEL' || last.type !== 'PLANNER_RESPONSE') return null;
  if (last.status !== undefined && last.status !== 'DONE') return null;
  if (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) return null;
  return typeof last.content === 'string' && last.content.trim() !== '' ? last.content : null;
}
