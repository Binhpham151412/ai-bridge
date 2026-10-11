import type { RunProcessResult } from '../../automation/process-runner.ts';
import { describeFailure, parseVersion, safeExcerpt } from './cli-provider.ts';
import type { DiagnosticDepth, ProviderAdapter, ProviderDiagnosticContext, ProviderDiagnosticError, ProviderStatus } from './provider-types.ts';

/** Strips terminal colour codes: `opencode auth list` prints a coloured box. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * `opencode auth list` prints the credentials file and a count — "8 credentials" (observed in
 * 1.14.30). OpenCode is a front-end for many model providers, so a stored credential is a
 * per-provider API key, not an account login: this does not prove any model answers, and a
 * project that needs no credential (a local or free model) can still run. The count is the
 * only thing used; provider names and key types are never read or returned.
 * Returns null when the output has no count.
 */
export function parseOpenCodeCredentialCount(r: RunProcessResult): number | null {
  const m = /(\d+)\s+credentials?/i.exec(stripAnsi(r.stdout));
  return m ? Number(m[1]) : null;
}

/**
 * docs/64 — OpenCode as an executor. Unlike Claude Code and Codex it has no account login that
 * AI Bridge could require or refuse, so it does not use the shared account-login pipeline:
 * installed + version + credential count, nothing that spends model quota (no execution probe).
 */
export function createOpenCodeProvider(): ProviderAdapter {
  const descriptor = {
    id: 'opencode',
    displayName: 'OpenCode',
    roles: ['executor' as const],
    capabilities: ['status-check' as const, 'cli-login' as const],
    executableName: 'opencode',
  };

  const diagnose = async (ctx: ProviderDiagnosticContext, depth: DiagnosticDepth): Promise<ProviderStatus> => {
    const startedMs = Date.now();
    const errors: ProviderDiagnosticError[] = [];
    const finish = (fields: Pick<ProviderStatus, 'executable' | 'installation' | 'version' | 'authentication' | 'state' | 'readiness' | 'diagnosticMessage'>): ProviderStatus => ({
      provider: descriptor.id,
      displayName: descriptor.displayName,
      roles: [...descriptor.roles],
      capabilities: [...descriptor.capabilities],
      quota: { status: 'UNKNOWN', scope: null, detail: null },
      executionCheck: { status: depth === 'execution' ? 'SKIPPED' : 'NOT_RUN', durationMs: null },
      errors,
      depth,
      checkedAt: ctx.now().toISOString(),
      durationMs: Date.now() - startedMs,
      ...fields,
    });
    const unknownAuth = { status: 'UNKNOWN', method: 'UNKNOWN', account: null, subscription: null } as const;

    const executable = await ctx.locateExecutable(descriptor.executableName).catch(() => null);
    if (executable === null) {
      const message = `${descriptor.displayName} CLI (${descriptor.executableName}) was not found on PATH.`;
      errors.push({ code: 'PROVIDER_NOT_INSTALLED', step: 'discover', message, detail: null });
      return finish({ executable: null, installation: 'NOT_INSTALLED', version: null, authentication: { ...unknownAuth }, state: 'NOT_INSTALLED', readiness: 'NOT_READY', diagnosticMessage: message });
    }

    const prefix = ctx.commandArgsPrefix?.[descriptor.id] ?? [];
    const run = (args: string[]) => ctx.runCommand({ command: executable, args: [...prefix, ...args], env: ctx.env, timeoutMs: ctx.statusTimeoutMs, maxBufferBytes: 1024 * 1024 });

    let version: string | null = null;
    const v = await run(['--version']);
    if (v.timedOut) errors.push({ code: 'PROVIDER_TIMEOUT', step: 'version', message: `"opencode --version" timed out after ${ctx.statusTimeoutMs} ms.`, detail: null });
    else if (v.exitCode !== 0) errors.push({ code: 'PROVIDER_COMMAND_FAILED', step: 'version', message: '"opencode --version" failed.', detail: describeFailure(v) });
    else {
      version = parseVersion(v.stdout) ?? parseVersion(v.stderr);
      if (version === null) errors.push({ code: 'PROVIDER_OUTPUT_INVALID', step: 'version', message: '"opencode --version" printed no recognizable version.', detail: safeExcerpt(v.stdout || v.stderr || '(no output)') });
    }

    const a = await run(['auth', 'list']);
    if (a.timedOut || a.exitCode !== 0) {
      const message = a.timedOut ? `"opencode auth list" timed out after ${ctx.statusTimeoutMs} ms.` : '"opencode auth list" failed.';
      errors.push({ code: a.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_COMMAND_FAILED', step: 'auth', message, detail: a.timedOut ? null : describeFailure(a) });
      return finish({ executable, installation: 'INSTALLED', version, authentication: { ...unknownAuth }, state: 'UNKNOWN', readiness: 'ERROR', diagnosticMessage: message });
    }
    const count = parseOpenCodeCredentialCount(a);
    if (count === null) {
      const message = 'Could not interpret "opencode auth list" output.';
      errors.push({ code: 'PROVIDER_OUTPUT_INVALID', step: 'auth', message, detail: safeExcerpt(stripAnsi(a.stdout) || a.stderr || '(no output)') });
      return finish({ executable, installation: 'INSTALLED', version, authentication: { ...unknownAuth }, state: 'UNKNOWN', readiness: 'UNKNOWN', diagnosticMessage: message });
    }
    if (count === 0) {
      const message = 'OpenCode is installed but has no stored credentials. Add one with: opencode auth login (a local or free model may not need one).';
      errors.push({ code: 'PROVIDER_NOT_AUTHENTICATED', step: 'auth', message, detail: null });
      return finish({ executable, installation: 'INSTALLED', version, authentication: { status: 'NOT_AUTHENTICATED', method: 'NONE', account: null, subscription: null }, state: 'INSTALLED_NOT_AUTHENTICATED', readiness: 'NOT_READY', diagnosticMessage: message });
    }
    return finish({
      executable,
      installation: 'INSTALLED',
      version,
      authentication: { status: 'AUTHENTICATED', method: 'UNKNOWN', account: null, subscription: null },
      state: 'AUTHENTICATED',
      readiness: 'READY',
      diagnosticMessage: `OpenCode is installed with ${count} stored credential${count === 1 ? '' : 's'}. No model was called, so it is not verified that a model answers.`,
    });
  };

  return {
    descriptor,
    diagnose,
    loginCommand: (executable) => ({ executable, args: ['auth', 'login'], displayCommand: 'opencode auth login', interactive: true }),
  };
}
