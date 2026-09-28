import { tmpdir } from 'node:os';
import { runProcess } from '../../automation/process-runner.ts';
import { createClaudeCodeProvider } from './claude-code-provider.ts';
import { createCodexProvider } from './codex-provider.ts';
import { createRealExecutableLocator } from './executable-discovery.ts';
import type { DiagnosticDepth, ProviderAdapter, ProviderDescriptor, ProviderDiagnosticContext, ProviderErrorCode, ProviderId, ProviderLoginCommand, ProviderStatus } from './provider-types.ts';
import { safeExcerpt } from './cli-provider.ts';

export class UnknownProviderError extends Error {
  readonly code = 'UNKNOWN_PROVIDER_ID';
  readonly providerId: string;
  constructor(providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = 'UnknownProviderError';
    this.providerId = providerId;
  }
}

export interface ProviderRegistryOptions {
  /** Upper bound for one adapter's whole diagnosis, so a misbehaving adapter can't hang the
   * caller even if its own per-command timeouts fail. Defaults to a bound derived from the
   * context's command timeouts. */
  adapterTimeoutMs?: number;
}

/**
 * Holds provider adapters and their last diagnostic result. Nothing is spawned on
 * construction, on lookup, or by getCachedStatus — processes only start when a caller
 * explicitly asks for a check (or for a status that has never been checked).
 */
export class ProviderRegistry {
  readonly #ctx: ProviderDiagnosticContext;
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #cache = new Map<string, ProviderStatus>();
  readonly #inFlight = new Map<string, Promise<ProviderStatus>>();
  readonly #adapterTimeoutMs: number;

  constructor(ctx: ProviderDiagnosticContext, adapters: ProviderAdapter[] = [], options: ProviderRegistryOptions = {}) {
    this.#ctx = ctx;
    this.#adapterTimeoutMs = options.adapterTimeoutMs ?? ctx.statusTimeoutMs * 3 + ctx.probeTimeoutMs + 10000;
    for (const a of adapters) this.register(a);
  }

  /** Extension point: future providers (Grok, Cursor, …) register an adapter here. */
  register(adapter: ProviderAdapter): void {
    const id = adapter.descriptor.id;
    if (this.#adapters.has(id)) throw new Error(`Provider already registered: ${id}`);
    this.#adapters.set(id, adapter);
  }

  has(id: ProviderId): boolean {
    return this.#adapters.has(id);
  }

  listProviders(): ProviderDescriptor[] {
    return [...this.#adapters.values()].map((a) => structuredClone(a.descriptor));
  }

  /** Last result for `id`, or null if never checked. Never spawns a process. */
  getCachedStatus(id: ProviderId): ProviderStatus | null {
    this.#adapter(id);
    const s = this.#cache.get(id);
    return s ? structuredClone(s) : null;
  }

  /** Cached status, running a status-depth check only when nothing is cached or `refresh` is set. */
  async getProviderStatus(id: ProviderId, options: { refresh?: boolean } = {}): Promise<ProviderStatus> {
    const cached = options.refresh ? null : this.getCachedStatus(id);
    return cached ?? this.checkProvider(id, { depth: 'status' });
  }

  /** Always runs a fresh diagnosis. Concurrent identical requests share one run. */
  async checkProvider(id: ProviderId, options: { depth?: DiagnosticDepth } = {}): Promise<ProviderStatus> {
    const adapter = this.#adapter(id);
    const depth = options.depth ?? 'status';
    const key = `${id}\u0000${depth}`;
    const pending = this.#inFlight.get(key);
    if (pending) return pending.then((s) => structuredClone(s));

    const run = this.#guardedDiagnose(adapter, depth)
      .then((status) => {
        this.#cache.set(id, status);
        return status;
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, run);
    return run.then((s) => structuredClone(s));
  }

  /** Every provider, in registration order; checks run in parallel. */
  async getAllProviderStatuses(options: { refresh?: boolean } = {}): Promise<ProviderStatus[]> {
    return Promise.all([...this.#adapters.keys()].map((id) => this.getProviderStatus(id, options)));
  }

  /** Describes the official login command; never executes it. Uses the executable from the
   * last check when known. */
  getLoginCommand(id: ProviderId): ProviderLoginCommand | null {
    return this.#adapter(id).loginCommand(this.#cache.get(id)?.executable ?? null);
  }

  clearCache(id?: ProviderId): void {
    if (id === undefined) this.#cache.clear();
    else this.#cache.delete(id);
  }

  #adapter(id: ProviderId): ProviderAdapter {
    const a = this.#adapters.get(id);
    if (!a) throw new UnknownProviderError(id);
    return a;
  }

  async #guardedDiagnose(adapter: ProviderAdapter, depth: DiagnosticDepth): Promise<ProviderStatus> {
    const startedMs = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#adapterTimeoutMs);
    });
    try {
      const outcome = await Promise.race([adapter.diagnose(this.#ctx, depth), timeout]);
      if (outcome === 'timeout') return this.#failedStatus(adapter, depth, startedMs, 'PROVIDER_TIMEOUT', `${adapter.descriptor.displayName} diagnostics did not finish within ${this.#adapterTimeoutMs} ms.`, null);
      return outcome;
    } catch (err) {
      const detail = safeExcerpt(err instanceof Error ? err.message : String(err));
      return this.#failedStatus(adapter, depth, startedMs, 'PROVIDER_UNKNOWN', `${adapter.descriptor.displayName} diagnostics failed unexpectedly.`, detail);
    } finally {
      clearTimeout(timer);
    }
  }

  #failedStatus(adapter: ProviderAdapter, depth: DiagnosticDepth, startedMs: number, code: ProviderErrorCode, message: string, detail: string | null): ProviderStatus {
    const d = adapter.descriptor;
    return {
      provider: d.id,
      displayName: d.displayName,
      roles: [...d.roles],
      capabilities: [...d.capabilities],
      executable: null,
      installation: 'UNKNOWN',
      version: null,
      authentication: { status: 'UNKNOWN', method: 'UNKNOWN', account: null, subscription: null },
      quota: { status: 'UNKNOWN', scope: null, detail: null },
      executionCheck: { status: 'NOT_RUN', durationMs: null },
      state: 'UNKNOWN',
      readiness: 'ERROR',
      diagnosticMessage: message,
      errors: [{ code, step: 'adapter', message, detail }],
      depth,
      checkedAt: this.#ctx.now().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  }
}

export function createRealProviderContext(overrides: Partial<ProviderDiagnosticContext> = {}): ProviderDiagnosticContext {
  const env = overrides.env ?? process.env;
  return {
    locateExecutable: createRealExecutableLocator(env),
    runCommand: runProcess,
    env,
    statusTimeoutMs: 15000,
    probeTimeoutMs: 120000,
    probeCwd: tmpdir(),
    now: () => new Date(),
    ...overrides,
  };
}

/** Claude Code + Codex, wired to the real PATH and process runner. */
export function createDefaultProviderRegistry(ctx: ProviderDiagnosticContext = createRealProviderContext(), options: ProviderRegistryOptions = {}): ProviderRegistry {
  return new ProviderRegistry(ctx, [createClaudeCodeProvider(), createCodexProvider()], options);
}
