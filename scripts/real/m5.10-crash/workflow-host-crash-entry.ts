// TEST-ONLY (M5.10 B″, docs/59 §22.5/§23): the Workflow Host entry of the isolated CRASH APP.
// build-crash-app.ts bundles this file — and only this file — as
// sandbox/m5.10-crash-app/dist-desktop/workflow-host.mjs. It is never part of dist-desktop/ (the
// production build's entry list is src/hosts/workflow-host-entry.ts) or of a packaged app.
//
// It mirrors src/hosts/workflow-host-entry.ts line for line (ELECTRON_RUN_AS_NODE handling, the
// sibling run-host.mjs, createExecutionPort with the same environment); the only difference is
// the crash-point decorator around the production ExecutionPort (crash-port.ts), armed only by
// AI_BRIDGE_TEST_WF_CRASH_AT + AI_BRIDGE_TEST_WF_CRASH_MARKER (crash-config.ts). No engine
// overrides: production recovery timings apply (preflightGraceMs ≈ 5 min).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveCrashWorkflowHost } from './crash-port.ts';

const electronNode = process.env.ELECTRON_RUN_AS_NODE === '1';
delete process.env.ELECTRON_RUN_AS_NODE;

const here = fileURLToPath(import.meta.url);
const RUN_HOST = here.endsWith('.ts') ? path.join(path.dirname(here), '..', '..', '..', 'src', 'desktop', 'main', 'run-host-entry.ts') : path.join(path.dirname(here), 'run-host.mjs');

serveCrashWorkflowHost({
  runHostScript: RUN_HOST,
  execPath: process.execPath,
  hostEnv: { ...process.env, ...(electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
});
