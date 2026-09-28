import { createContext, useContext } from 'react';

export type View = 'run' | 'journal' | 'artifacts' | 'settings' | 'system';

/** Where a cross-view link lands: a session, and optionally one of its rounds. */
export interface NavTarget {
  runId: string;
  iteration?: number;
}

export interface NavValue {
  view: View;
  /** The last explicit target for the view being shown (null = view's own default). */
  target: NavTarget | null;
  go: (view: View, target?: NavTarget) => void;
}

const NavContext = createContext<NavValue>({ view: 'run', target: null, go: () => {} });

export const NavProvider = NavContext.Provider;

export function useNav(): NavValue {
  return useContext(NavContext);
}
