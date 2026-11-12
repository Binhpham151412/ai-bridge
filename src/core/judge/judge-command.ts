import { readFile } from 'node:fs/promises';
import { CodexCliAdapter } from '../../adapters/chatgpt/codex-cli-adapter.ts';
import { runJudge } from './judge-runner.ts';

export interface JudgeCliIo {
  /** One line of the verdict JSON; stdout carries nothing else. */
  out: (line: string) => void;
  err: (line: string) => void;
  readStdin: () => Promise<string>;
}

export interface JudgeCliDeps {
  /** Where the `codex` executable is, or null. */
  resolveCodex: () => Promise<string | null>;
  /** Prepended to argv — tests run `node <fake-codex.mjs>` instead of the real binary. */
  commandArgsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
}

export const DEFAULT_JUDGE_TIMEOUT_MS = 300_000;
export const MAX_JUDGE_TIMEOUT_MS = 1_800_000;

/**
 * `ai-bridge judge --request <file|-> [--timeout-ms N] [--model NAME]` (docs/67-judge-command.md).
 * Exit 0: a verdict (pass or fail) is on stdout as one JSON object. Exit 2: refused before running (API key in
 * the environment, Codex not installed). Exit 1: no verdict (bad request, Codex failed or timed out, answer not
 * valid). Errors go to stderr as `ERROR_<CODE>: <message>`; stdout stays empty then.
 */
export async function runJudgeCli(flags: Record<string, string>, io: JudgeCliIo, deps: JudgeCliDeps): Promise<number> {
  if (!flags.request) {
    io.err('Usage: ai-bridge judge --request <file|-> [--timeout-ms <n>] [--model <name>]');
    return 1;
  }
  const timeoutMs = flags['timeout-ms'] === undefined ? DEFAULT_JUDGE_TIMEOUT_MS : Number(flags['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_JUDGE_TIMEOUT_MS) {
    io.err(`ERROR_BAD_REQUEST: --timeout-ms must be a whole number from 1000 to ${MAX_JUDGE_TIMEOUT_MS}.`);
    return 1;
  }
  let requestText: string;
  try {
    requestText = flags.request === '-' ? await io.readStdin() : await readFile(flags.request, 'utf8');
  } catch {
    io.err(`ERROR_BAD_REQUEST: the request could not be read from ${flags.request === '-' ? 'stdin' : flags.request}.`);
    return 1;
  }
  const executable = await deps.resolveCodex();
  if (executable === null) {
    io.err('ERROR_CODEX_NOT_FOUND: the codex CLI was not found (run "ai-bridge doctor").');
    return 2;
  }
  const outcome = await runJudge(requestText, {
    codex: new CodexCliAdapter({ executable, commandArgsPrefix: deps.commandArgsPrefix }),
    timeoutMs,
    env: deps.env ?? process.env,
    model: flags.model,
    tmpRoot: deps.tmpRoot,
  });
  if (!outcome.ok) {
    io.err(`ERROR_${outcome.code}: ${outcome.message}`);
    return outcome.code === 'BLOCKED_API_KEY' ? 2 : 1;
  }
  io.out(JSON.stringify(outcome.verdict));
  return 0;
}
