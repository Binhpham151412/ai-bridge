import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodexCliAdapter } from '../../adapters/chatgpt/codex-cli-adapter.ts';

/**
 * What the judge needs from `codex exec`, checked against the installed CLI before anything is sent (nothing here
 * calls a model: `--help`, `features list` and `debug prompt-input` only render local information). The flag names
 * are the ones of codex-cli 0.167.0-alpha.3.2; a CLI that no longer lists one is refused rather than guessed at.
 */
export const REQUIRED_EXEC_FLAGS = [
  '--ignore-user-config', // no $CODEX_HOME/config.toml: none of the user's MCP servers, hooks or write settings (sign-in still comes from CODEX_HOME)
  '--ignore-rules', // no user or project execpolicy rules
  '--ephemeral', // no session files
  '--sandbox', // with the read-only value
  '--disable', // switch off the features that bring tools
  '--output-last-message',
  '--skip-git-repo-check',
  '--json',
] as const;

/**
 * Features of `codex features list` that bring tools into a session (plugin and app MCP servers, the browser, computer
 * use, hooks, ...). Each one the CLI lists is switched off with `--disable`; one it does not list is not passed (an
 * unknown name could be an error). Verified with `codex debug prompt-input`: `--disable plugins --disable apps`
 * removes the `mcp__cua_repl` tools of a user's setup, while `-c mcp_servers={}` does not.
 */
export const TOOL_FEATURES = ['apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'multi_agent', 'skill_search', 'tool_suggest'] as const;

/**
 * The tool namespaces codex 0.167 gives a session on its own and that no flag removes: `functions` (exec, wait,
 * request_user_input), `clock` (sleep) and `collaboration` (sub-agents). What they can do is bounded by the read-only
 * sandbox. Anything else the model would be offered (an `mcp__*` namespace, an app, a browser) refuses the launch.
 */
export const ALLOWED_TOOL_NAMESPACES = ['functions', 'clock', 'collaboration'] as const;

export interface Lockdown {
  /** The `codex exec` flags that isolate the judge (after the sandbox flags, before `-m`). */
  args: string[];
  /** The features switched off. */
  disabled: string[];
  /** The tool namespaces the model would still see in a configuration-free session. */
  tools: string[];
}

export type LockdownOutcome = { ok: true; lockdown: Lockdown } | { ok: false; reason: string };

const PROBE_TIMEOUT_MS = 20_000;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasFlag = (help: string, flag: string): boolean => new RegExp(`(^|[\\s,])${escapeRegExp(flag)}(?=[\\s,=<]|$)`, 'm').test(help);

const refuse = (detail: string): LockdownOutcome => ({ ok: false, reason: `The codex CLI cannot be put in read-only isolation (${detail}); nothing was sent.` });

/**
 * Establishes the judge's isolation, or says why it cannot be: the CLI must list every flag the judge relies on and a
 * read-only sandbox, must list its features, and a session with no configuration and these features off must offer
 * no tool beyond `ALLOWED_TOOL_NAMESPACES`. Anything short of that is a refusal, never a warning.
 */
export async function establishReadOnly(codex: CodexCliAdapter, env: NodeJS.ProcessEnv): Promise<LockdownOutcome> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'ai-bridge-judge-probe-'));
  try {
    const help = await codex.probe(['exec', '--help'], { cwd: scratch, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (!help.ok) return refuse('"codex exec --help" failed');
    const missing = REQUIRED_EXEC_FLAGS.filter((flag) => !hasFlag(help.stdout, flag));
    if (missing.length > 0) return refuse(`this codex does not list ${missing.join(', ')}`);
    if (!/read-only/.test(help.stdout)) return refuse('this codex lists no read-only sandbox');

    const features = await codex.probe(['features', 'list'], { cwd: scratch, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (!features.ok) return refuse('its feature list could not be read ("codex features list" failed)');
    const listed = new Set(
      features.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((tokens) => tokens.length >= 3 && (tokens[tokens.length - 1] === 'true' || tokens[tokens.length - 1] === 'false'))
        .map((tokens) => tokens[0]),
    );
    const disabled = TOOL_FEATURES.filter((name) => listed.has(name));
    const disableArgs = disabled.flatMap((name) => ['--disable', name]);

    // What the model would be offered, with no configuration (an empty CODEX_HOME: like --ignore-user-config) and
    // these features off. `exec` is not asked: it has no way to run without a model.
    const home = path.join(scratch, 'empty-codex-home');
    await mkdir(home);
    const surface = await codex.probe(['debug', 'prompt-input', ...disableArgs, 'hello'], { cwd: scratch, env: { ...env, CODEX_HOME: home }, timeoutMs: PROBE_TIMEOUT_MS });
    if (!surface.ok) return refuse('its tool list could not be read ("codex debug prompt-input" failed)');
    const tools = toolNamespaces(surface.stdout);
    if (tools === null) return refuse('its tool list is not in the expected form, so nothing proves it is closed');
    const unexpected = tools.filter((name) => !(ALLOWED_TOOL_NAMESPACES as readonly string[]).includes(name));
    if (unexpected.length > 0) return refuse(`the model would still be offered ${unexpected.join(', ')}`);

    return { ok: true, lockdown: { args: ['--ignore-user-config', '--ignore-rules', '--ephemeral', ...disableArgs], disabled, tools } };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The names of the tools or tool namespaces in the `additional_tools` item of `codex debug prompt-input`; null if there is none. */
function toolNamespaces(stdout: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const item = parsed.find((x): x is { type: string; tools: unknown } => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === 'additional_tools');
  if (item === undefined || !Array.isArray(item.tools)) return null;
  const names: string[] = [];
  for (const tool of item.tools) {
    const name = typeof tool === 'object' && tool !== null ? (tool as { name?: unknown }).name : undefined;
    if (typeof name !== 'string') return null;
    names.push(name);
  }
  return names;
}
