import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../../adapters/chatgpt/codex-cli-adapter.ts';
import { checkEnvForApiKeys } from '../cost-guard.ts';
import { buildJudgePrompt, parseJudgeRequest, parseJudgeResponse, type JudgeVerdict } from './judge-contract.ts';

export type JudgeErrorCode = 'BAD_REQUEST' | 'BLOCKED_API_KEY' | 'CODEX_FAILED' | 'TIMEOUT' | 'BAD_RESPONSE';

export type JudgeOutcome = { ok: true; verdict: JudgeVerdict } | { ok: false; code: JudgeErrorCode; message: string };

export interface JudgeRunOptions {
  codex: CodexCliAdapter;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Reported in the verdict and passed to `codex exec -m`. Absent: the CLI's own default model, reported as "unknown". */
  model?: string;
  /** Where the scratch directory goes (tests); defaults to the OS temp directory. */
  tmpRoot?: string;
}

/**
 * One verdict. A fresh Codex thread, the read-only sandbox, an empty scratch directory as the working directory
 * (there is nothing of the user's to read), and no AI Bridge run lock or session state: this never touches a
 * project and cannot collide with a running `start`. API-key environments are refused before anything starts.
 */
export async function runJudge(requestText: string, options: JudgeRunOptions): Promise<JudgeOutcome> {
  const request = parseJudgeRequest(requestText);
  if (!request.ok) return { ok: false, code: 'BAD_REQUEST', message: request.reason };
  const keys = checkEnvForApiKeys(options.env);
  if (keys.blocked) {
    return { ok: false, code: 'BLOCKED_API_KEY', message: `Refusing to run with ${keys.foundKeys.join(', ')} set: AI Bridge only uses subscriptions, never API keys.` };
  }
  const scratch = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), 'ai-bridge-judge-'));
  try {
    const run = await options.codex.run({
      cwd: scratch,
      input: buildJudgePrompt(request.value),
      threadId: null,
      outputPath: path.join(scratch, 'verdict.md'),
      timeoutMs: options.timeoutMs,
      env: options.env,
      permissionPolicy: 'ask',
      extraArgs: options.model ? ['-m', options.model] : [],
    });
    if (!run.ok || run.responseText === null) {
      if (run.errorCode === 'TIMEOUT') return { ok: false, code: 'TIMEOUT', message: `Codex did not answer within ${options.timeoutMs} ms.` };
      return { ok: false, code: 'CODEX_FAILED', message: `Codex failed (${run.errorCode ?? 'unknown'}${run.exitCode === null ? '' : `, exit ${run.exitCode}`}).` };
    }
    const verdict = parseJudgeResponse(run.responseText, request.value, options.model ?? 'unknown');
    if (!verdict.ok) return { ok: false, code: 'BAD_RESPONSE', message: verdict.reason };
    return { ok: true, verdict: verdict.value };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
