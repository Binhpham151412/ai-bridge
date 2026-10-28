import type { CodexCliAdapter } from '../../src/adapters/chatgpt/codex-cli-adapter.ts';
import { handlePrompt, handleStop, loadLoopState, type HookOutput, type LoopState } from '../../src/claude-code/bridge-loop.ts';
import type { CodexAccount } from '../../src/claude-code/codex-account.ts';

/**
 * docs/67 — the AI Bridge review loop inside OpenCode (prototype). The loop itself is the Claude
 * Code plugin's, reused as it is (`src/claude-code/bridge-loop.ts`): `handlePrompt` arms it when
 * `/bridge <task>` runs, `handleStop` has Codex review the agent's final message. This file only
 * maps OpenCode's plugin hooks onto those two functions:
 *
 *   /bridge …            command.execute.before → handlePrompt (contract added to the prompt)
 *   the agent finished   `session.idle` event   → handleStop   (Codex reviews the final message)
 *   Codex said CONTINUE  client.session.promptAsync(next instruction), the loop goes on
 *   the loop ended       a chat-only message (`ignored` part) + a toast; the OS notification
 *                        is raised by `handleStop` itself
 */

/** The parts of OpenCode's SDK client used here (`@opencode-ai/sdk`); structural, so the repo needs no OpenCode dependency. */
export interface OpenCodeClient {
  session: {
    messages(options: { path: { id: string } }): Promise<{ data?: SessionMessage[] }>;
    prompt(options: { path: { id: string }; body: PromptBody }): Promise<unknown>;
    promptAsync(options: { path: { id: string }; body: PromptBody }): Promise<unknown>;
  };
  tui: {
    showToast(options: { body: { title?: string; message: string; variant: 'info' | 'success' | 'warning' | 'error'; duration?: number } }): Promise<unknown>;
  };
}

interface SessionMessage {
  info: { role: string; error?: { name?: string }; time?: { completed?: number } };
  parts: Array<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean }>;
}

/**
 * `synthetic`: sent to the model, not drawn in the chat. `ignored`: drawn in the chat, never sent
 * to the model (a user message made only of ignored parts is left out of the model's context).
 */
interface PromptBody {
  noReply?: boolean;
  parts: Array<{ type: 'text'; text: string; synthetic?: boolean; ignored?: boolean }>;
}

export interface BridgeDeps {
  client: OpenCodeClient;
  /** The project OpenCode runs in: Codex reviews there, and its changes are read from there. */
  directory: string;
  stateRoot: string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  codexTimeoutMs: number;
  locateCodex: () => Promise<Pick<CodexCliAdapter, 'run'> | null>;
  headCommit?: (cwd: string) => Promise<string | null>;
  changesSince?: (cwd: string, base: string | null) => Promise<string | null>;
  codexAccount?: (threadId: string) => Promise<CodexAccount | null>;
  notify?: (title: string, body: string) => void | Promise<void>;
  /** Wait between reads while the final message is still being written (default 300 ms, 0 = no retry). */
  retryMs?: number;
}

interface OpenCodeEvent {
  type: string;
  properties?: { sessionID?: string; status?: { type?: string }; error?: { name?: string } };
}

/** What `/bridge` is in OpenCode: a command whose text is the task (cf. plugins/claude-code/skills/bridge/SKILL.md). */
export const BRIDGE_COMMAND = {
  description: 'AI Bridge: Codex reviews each turn and sends the next instruction until DONE. /bridge --vong 3 <task> | /bridge <answer to Codex> | /bridge stop',
  template: [
    'Work on the text below. The AI Bridge review loop is on for this session: when you finish,',
    'Codex reviews your final message and may send the next instruction. The text is a new task,',
    "or, when the loop was waiting on the user, their answer to Codex's question (the AI Bridge",
    'context says which). A leading `--vong N` only sets the number of review rounds.',
    '',
    'Task: $ARGUMENTS',
  ].join('\n'),
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const MESSAGE_READS = 4;

export function createBridgeHooks(deps: BridgeDeps) {
  const { client } = deps;
  /** Sessions whose Codex review is running: an idle event meanwhile (the user typed) does not start a second one. */
  const reviewing = new Set<string>();
  /**
   * Sessions whose last turn the user interrupted. OpenCode emits `session.error` (MessageAbortedError)
   * and then `session.idle` twice (before and after the half-written message is closed), so the
   * message itself cannot tell an interrupt from a finished turn at the first idle. The next turn
   * (`session.status` busy) clears it.
   */
  const aborted = new Set<string>();
  /** Sessions whose agent is mid-turn (`session.status`). */
  const busy = new Set<string>();
  /**
   * Chat-only messages waiting for their session's agent to go idle. A user message that arrives
   * mid-turn makes OpenCode run one more step after the turn, even one the model never sees (seen
   * on 1.19.0: a second full answer), so `/bridge stop` and the like must not post it at once.
   */
  const held = new Map<string, string[]>();

  const toast = async (message: string, variant: 'info' | 'success' | 'warning' | 'error', duration?: number) => {
    try {
      await client.tui.showToast({ body: { title: 'AI Bridge', message: clip(message, 400), variant, duration } });
    } catch {
      // no terminal UI attached (headless or desktop app): the chat message carries it
    }
  };

  /** A line in the chat that the model never sees (held while the agent is mid-turn). */
  const say = async (sessionID: string, text: string) => {
    if (busy.has(sessionID)) held.set(sessionID, [...(held.get(sessionID) ?? []), text]);
    else await post(sessionID, text);
  };

  const post = async (sessionID: string, text: string) => {
    try {
      await client.session.prompt({ path: { id: sessionID }, body: { noReply: true, parts: [{ type: 'text', text, ignored: true }] } });
    } catch {
      // the toast still shows it
    }
  };

  const flushHeld = async (sessionID: string) => {
    if (busy.has(sessionID)) return; // the user started another turn meanwhile: wait for its end
    const texts = held.get(sessionID) ?? [];
    held.delete(sessionID);
    for (const text of texts) await post(sessionID, text);
  };

  /** The text of the agent's final message, or null when there is none (an error, no text). */
  async function finalReply(sessionID: string): Promise<string | null> {
    const waitMs = deps.retryMs ?? 300;
    for (let i = 1; ; i++) {
      const messages = (await client.session.messages({ path: { id: sessionID } })).data ?? [];
      // chat-only lines of ours (posted at an earlier idle) may trail the agent's message
      let end = messages.length - 1;
      while (end >= 0 && messages[end].info.role === 'user' && messages[end].parts.every((p) => p.ignored)) end--;
      const last = messages[end];
      if (last?.info.role !== 'assistant' || last.info.error) return null;
      // idle can come before the message is closed: give it a moment
      if (last.info.time?.completed === undefined && i < MESSAGE_READS && waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      const text = last.parts
        .filter((p) => p.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim();
      return text === '' ? null : text;
    }
  }

  /** The loop's end (or its error): in the chat, as a toast, and (by `handleStop`) as an OS notification. */
  async function announce(sessionID: string, out: HookOutput) {
    if (!out.systemMessage) return;
    const status = (await loadLoopState(deps.stateRoot, sessionID))?.status;
    await say(sessionID, out.systemMessage);
    await toast(out.systemMessage, status === 'DONE' ? 'success' : status === 'ERROR' ? 'error' : 'warning', 15_000);
  }

  /** CONTINUE: Codex's instruction goes in as the next user message; the contract part is only for the model. */
  async function continueLoop(sessionID: string, out: HookOutput, state: LoopState | null) {
    const reason = out.reason ?? '';
    const prompt = state?.lastVerdict?.prompt ?? '';
    const cut = prompt !== '' && reason.includes(prompt) ? reason.indexOf(prompt) + prompt.length : reason.length;
    const rest = reason.slice(cut).trim();
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [
          ...(out.systemMessage ? [{ type: 'text' as const, text: out.systemMessage, ignored: true }] : []),
          { type: 'text' as const, text: reason.slice(0, cut) },
          ...(rest !== '' ? [{ type: 'text' as const, text: rest, synthetic: true }] : []),
        ],
      },
    });
  }

  /** The agent finished a turn in `sessionID`: Codex reviews it, if a loop is armed there. */
  async function review(sessionID: string) {
    if (reviewing.has(sessionID)) return;
    const state = await loadLoopState(deps.stateRoot, sessionID);
    if (state?.status !== 'RUNNING') return;
    if (aborted.has(sessionID)) return; // the user interrupted: the loop waits for their next turn
    reviewing.add(sessionID);
    try {
      const reply = await finalReply(sessionID);
      void toast('Codex đang review…', 'info', 30_000);
      const out = await handleStop(
        { session_id: sessionID, cwd: state.projectPath, transcript_path: '', last_assistant_message: reply ?? '' },
        {
          stateRoot: deps.stateRoot,
          now: deps.now,
          env: deps.env,
          codexTimeoutMs: deps.codexTimeoutMs,
          locateCodex: deps.locateCodex,
          changesSince: deps.changesSince,
          codexAccount: deps.codexAccount,
          notify: deps.notify,
          transcriptRetryMs: 0,
        },
      );
      if (out === null) return;
      if (out.decision === 'block') await continueLoop(sessionID, out, await loadLoopState(deps.stateRoot, sessionID));
      else await announce(sessionID, out);
    } catch (err) {
      await say(sessionID, `AI Bridge plugin error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reviewing.delete(sessionID);
    }
  }

  return {
    /** Registers `/bridge`, so no command file has to be installed next to the plugin. */
    config: async (cfg: { command?: Record<string, unknown> }) => {
      cfg.command = { ...cfg.command, bridge: BRIDGE_COMMAND };
    },

    'command.execute.before': async (input: { command: string; sessionID: string; arguments: string }, output: { parts: unknown[] }) => {
      if (input.command !== 'bridge') return;
      const out = await handlePrompt(
        { session_id: input.sessionID, cwd: deps.directory, prompt: `/bridge ${input.arguments}` },
        { stateRoot: deps.stateRoot, now: deps.now, headCommit: deps.headCommit },
      );
      // `/bridge stop`, a missing task, a bad --vong: the message is the answer and the agent gets no
      // turn. Failing the command is the only way to skip it, and the TUI does not show that failure
      // (it sends the command and ignores the result), so the message goes to the chat first.
      if (out?.decision === 'block') {
        const message = out.reason ?? 'AI Bridge';
        await say(input.sessionID, message);
        await toast(message, 'warning', 8_000);
        throw new Error(message);
      }
      const context = out?.hookSpecificOutput?.additionalContext;
      if (context) output.parts.push({ type: 'text', text: context, synthetic: true });
    },

    event: async ({ event }: { event: OpenCodeEvent }) => {
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;
      if (event.type === 'session.error' && event.properties?.error?.name === 'MessageAbortedError') aborted.add(sessionID);
      else if (event.type === 'session.status' && event.properties?.status?.type === 'busy') {
        busy.add(sessionID);
        aborted.delete(sessionID);
      } else if (event.type === 'session.status' && event.properties?.status?.type === 'idle') busy.delete(sessionID);
      else if (event.type === 'session.idle') {
        busy.delete(sessionID);
        try {
          await review(sessionID);
        } finally {
          await flushHeld(sessionID);
        }
      }
    },
  };
}
