import { createDefaultProviderRegistry, type ProviderRegistry } from '../../core/providers/provider-registry.ts';
import type { ProviderStatus } from '../../core/providers/provider-types.ts';
import { EXECUTOR_PROVIDERS, EXECUTOR_PROVIDER_INFO } from '../../core/executor/executor-adapter.ts';
import type { DataResponse, ExecutorProviderView } from '../shared/ipc-contract.ts';

/** One executor CLI as the developer picker shows it. Pure: `status` is whatever the provider
 * registry found, `info` is the static table — nothing here is guessed. */
export function toExecutorProviderView(status: ProviderStatus, info: (typeof EXECUTOR_PROVIDER_INFO)[keyof typeof EXECUTOR_PROVIDER_INFO], id: ExecutorProviderView['id']): ExecutorProviderView {
  return {
    id,
    displayName: info.displayName,
    installed: status.installation === 'INSTALLED',
    version: status.version,
    // UNKNOWN sign-in on an installed CLI (Antigravity has no status command) is "can't tell", not "not signed in".
    ready: status.readiness === 'READY' ? true : status.installation === 'INSTALLED' && status.authentication.status === 'UNKNOWN' && status.readiness === 'UNKNOWN' && status.errors.length === 0 ? null : false,
    message: status.diagnosticMessage,
    loginHint: info.loginHint,
    modelHint: info.modelHint,
  };
}

/**
 * docs/64 — detects the AI CLIs the developer slot can use. Every call runs a fresh status-depth
 * check (version + login status; never a model call), so "I just installed/logged in" shows up
 * on the next refresh. A detection failure of one CLI never hides the others.
 */
export class ExecutorProviderService {
  readonly #registry: ProviderRegistry;

  constructor(registry: ProviderRegistry = createDefaultProviderRegistry()) {
    this.#registry = registry;
  }

  async list(): Promise<DataResponse<ExecutorProviderView[]>> {
    const views = await Promise.all(
      EXECUTOR_PROVIDERS.map(async (id) => {
        const status = await this.#registry.getProviderStatus(id, { refresh: true });
        return toExecutorProviderView(status, EXECUTOR_PROVIDER_INFO[id], id);
      }),
    );
    return { ok: true, data: views };
  }
}
