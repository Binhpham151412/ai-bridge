import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../src/automation/process-runner.ts';
import type { ProviderDiagnosticContext } from '../../src/core/providers/provider-types.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/fake-provider/', import.meta.url));
export const FAKE_CLAUDE_DIAG = path.join(FIXTURES, 'fake-claude-diag.mjs');
export const FAKE_CODEX_DIAG = path.join(FIXTURES, 'fake-codex-diag.mjs');

const SCRUBBED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'FAKE_DIAG_VERSION', 'FAKE_DIAG_AUTH', 'FAKE_DIAG_PROBE', 'FAKE_DIAG_LOG'];

/** process.env without any API-key vars or leftover fake-CLI modes, plus `extra`. */
export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SCRUBBED_ENV_KEYS) delete env[k];
  return { ...env, ...extra };
}

export function newLogPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'ai-bridge-provider-')), 'argv.jsonl');
}

/** argv of every fake-CLI invocation recorded via FAKE_DIAG_LOG. */
export function readInvocations(logPath: string): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}

export interface FakeContextOptions {
  /** false simulates "not found on PATH". */
  installed?: boolean;
  env?: Record<string, string>;
  statusTimeoutMs?: number;
  probeTimeoutMs?: number;
}

/**
 * A real ProviderDiagnosticContext whose "executable" is node running a fake CLI script
 * (same pattern as the existing adapter tests' commandArgsPrefix).
 */
export function fakeContext(opts: FakeContextOptions = {}): ProviderDiagnosticContext {
  const installed = opts.installed ?? true;
  return {
    locateExecutable: async () => (installed ? process.execPath : null),
    runCommand: runProcess,
    env: testEnv(opts.env),
    statusTimeoutMs: opts.statusTimeoutMs ?? 10000,
    probeTimeoutMs: opts.probeTimeoutMs ?? 10000,
    probeCwd: tmpdir(),
    now: () => new Date('2026-09-27T12:00:00.000Z'),
    commandArgsPrefix: { 'claude-code': [FAKE_CLAUDE_DIAG], codex: [FAKE_CODEX_DIAG] },
  };
}
