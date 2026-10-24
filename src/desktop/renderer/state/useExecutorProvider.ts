import { useEffect, useState } from 'react';
import { DEFAULT_EXECUTOR_PROVIDER, isExecutorProviderId, type ExecutorProviderId } from '../../shared/executor-providers.ts';
import { useBridge } from './BridgeProvider.tsx';

const savedListeners = new Set<() => void>();

/** Settings calls this after a successful save so every screen naming the executor re-reads the setting. */
export function notifyProjectConfigSaved(): void {
  for (const listener of savedListeners) listener();
}

/**
 * docs/64 — the AI CLI filling the developer slot: the active/last run's own (Core reports it
 * in the status), else the project's setting. Defaults to Claude Code until the config is
 * loaded, and for a project without the setting.
 */
export function useExecutorProvider(): ExecutorProviderId {
  const { api, snapshot } = useBridge();
  const fromRun = snapshot?.status?.executor ?? null;
  const projectPath = snapshot?.project?.path ?? null;
  const [configured, setConfigured] = useState<ExecutorProviderId>(DEFAULT_EXECUTOR_PROVIDER);
  const [savedSeq, setSavedSeq] = useState(0);

  useEffect(() => {
    const listener = () => setSavedSeq((n) => n + 1);
    savedListeners.add(listener);
    return () => {
      savedListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (fromRun !== null) return;
    let active = true;
    void api.getSettings().then((res) => {
      const provider = res.ok ? res.data?.project?.config?.executor?.provider : undefined;
      if (active) setConfigured(isExecutorProviderId(provider) ? provider : DEFAULT_EXECUTOR_PROVIDER);
    });
    return () => {
      active = false;
    };
  }, [api, projectPath, fromRun, savedSeq]);

  return fromRun ?? configured;
}
