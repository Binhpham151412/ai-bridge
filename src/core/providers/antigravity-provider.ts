import { describeFailure, parseVersion, safeExcerpt } from './cli-provider.ts';
import type { DiagnosticDepth, ProviderAdapter, ProviderDiagnosticContext, ProviderDiagnosticError, ProviderStatus } from './provider-types.ts';

/**
 * docs/65 — Antigravity (`agy`) as an executor. The CLI has no command that reports whether
 * you are signed in (its subcommands are changelog / install / plugin / update), and the only
 * way to find out is a model call, which a detection check must never make. So this reports what
 * can be known — installed + version — and says plainly that the sign-in is unknown until a run.
 */
export function createAntigravityProvider(): ProviderAdapter {
  const descriptor = {
    id: 'antigravity',
    displayName: 'Antigravity',
    roles: ['executor' as const],
    capabilities: ['status-check' as const],
    executableName: 'agy',
  };

  const diagnose = async (ctx: ProviderDiagnosticContext, depth: DiagnosticDepth): Promise<ProviderStatus> => {
    const startedMs = Date.now();
    const errors: ProviderDiagnosticError[] = [];
    const finish = (fields: Pick<ProviderStatus, 'executable' | 'installation' | 'version' | 'state' | 'readiness' | 'diagnosticMessage'>): ProviderStatus => ({
      provider: descriptor.id,
      displayName: descriptor.displayName,
      roles: [...descriptor.roles],
      capabilities: [...descriptor.capabilities],
      authentication: { status: 'UNKNOWN', method: 'UNKNOWN', account: null, subscription: null },
      quota: { status: 'UNKNOWN', scope: null, detail: null },
      executionCheck: { status: depth === 'execution' ? 'SKIPPED' : 'NOT_RUN', durationMs: null },
      errors,
      depth,
      checkedAt: ctx.now().toISOString(),
      durationMs: Date.now() - startedMs,
      ...fields,
    });

    const executable = await ctx.locateExecutable(descriptor.executableName).catch(() => null);
    if (executable === null) {
      const message = `${descriptor.displayName} CLI (${descriptor.executableName}) was not found on PATH.`;
      errors.push({ code: 'PROVIDER_NOT_INSTALLED', step: 'discover', message, detail: null });
      return finish({ executable: null, installation: 'NOT_INSTALLED', version: null, state: 'NOT_INSTALLED', readiness: 'NOT_READY', diagnosticMessage: message });
    }

    const prefix = ctx.commandArgsPrefix?.[descriptor.id] ?? [];
    const v = await ctx.runCommand({ command: executable, args: [...prefix, '--version'], env: ctx.env, timeoutMs: ctx.statusTimeoutMs, maxBufferBytes: 1024 * 1024 });
    let version: string | null = null;
    if (v.timedOut) errors.push({ code: 'PROVIDER_TIMEOUT', step: 'version', message: `"agy --version" timed out after ${ctx.statusTimeoutMs} ms.`, detail: null });
    else if (v.exitCode !== 0) errors.push({ code: 'PROVIDER_COMMAND_FAILED', step: 'version', message: '"agy --version" failed.', detail: describeFailure(v) });
    else {
      version = parseVersion(v.stdout) ?? parseVersion(v.stderr);
      if (version === null) errors.push({ code: 'PROVIDER_OUTPUT_INVALID', step: 'version', message: '"agy --version" printed no recognizable version.', detail: safeExcerpt(v.stdout || v.stderr || '(no output)') });
    }

    return finish({
      executable,
      installation: 'INSTALLED',
      version,
      state: 'UNKNOWN',
      readiness: 'UNKNOWN',
      diagnosticMessage: `Antigravity is installed${version ? ` (${version})` : ''}. The CLI has no sign-in status command, so whether you are signed in is only known when a run starts. No model was called.`,
    });
  };

  return {
    descriptor,
    diagnose,
    // agy has no separate login subcommand: its interactive session starts the sign-in.
    loginCommand: (executable) => ({ executable, args: [], displayCommand: 'agy', interactive: true }),
  };
}
