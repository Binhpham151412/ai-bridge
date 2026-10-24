// The renderer may import only types from Core, so the (dependency-free) executor provider table
// reaches it through this shared module — the same route ipc-contract.ts takes for Core constants.
export { DEFAULT_EXECUTOR_PROVIDER, EXECUTOR_PROVIDERS, EXECUTOR_PROVIDER_INFO, isExecutorProviderId } from '../../core/executor/executor-adapter.ts';
export type { ExecutorProviderId } from '../../core/executor/executor-adapter.ts';
