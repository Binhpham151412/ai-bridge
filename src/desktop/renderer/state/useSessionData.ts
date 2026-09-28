import { useEffect, useState } from 'react';
import type { JournalIndex } from '../../../core/journal/journal.ts';
import type { SessionArtifacts } from '../../../core/session-history/session-history.ts';
import type { DataResponse, UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from './BridgeProvider.tsx';

interface Loaded<T> {
  data: T | null;
  error: UiError | null;
}

/**
 * Loads `load(runId)` (an IPC call) and re-reads it whenever `refreshKey` changes. A
 * result is only returned for the run id it was loaded for — switching sessions never
 * shows the previous session's data while the new one loads. `runId === null` loads nothing.
 */
function useRunData<T>(runId: string | null, refreshKey: string | undefined, load: (runId: string) => Promise<DataResponse<T>>): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { for: string | null }>({ data: null, error: null, for: null });
  useEffect(() => {
    let active = true;
    if (runId === null) return;
    void load(runId).then((res) => {
      if (!active) return;
      setState(res.ok ? { data: res.data, error: null, for: runId } : { data: null, error: res.error, for: runId });
    });
    return () => {
      active = false;
    };
    // `load` wraps a stable api method; runId/refreshKey drive reloads.
  }, [runId, refreshKey]);
  return state.for === runId ? { data: state.data, error: state.error } : { data: null, error: null };
}

/** One session's artifacts via Core (`getSessionArtifacts`). */
export function useSessionArtifacts(runId: string | null, refreshKey?: string): Loaded<SessionArtifacts> {
  const { api } = useBridge();
  return useRunData(runId, refreshKey, (id) => api.getSessionArtifacts({ runId: id }));
}

/** The M4.2 Development Journal index of one session (`getJournal`) — rounds, states,
 * verdicts and which entries exist; never any entry text. */
export function useJournalIndex(runId: string | null, refreshKey?: string): Loaded<JournalIndex> {
  const { api } = useBridge();
  return useRunData(runId, refreshKey, (id) => api.getJournal({ runId: id }));
}
