import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutionPort } from './execution-host-spawn.ts';
import { serveWorkflowHost } from './workflow-host.ts';

// The Workflow Host process (ADR-011 option A). Bundled as dist-desktop/workflow-host.mjs and
// forked by Electron Main's WorkflowController with ELECTRON_RUN_AS_NODE. It runs the
// WorkflowEngine only; every execution runs in its own Execution Host — the existing run host
// (dist-desktop/run-host.mjs; from source, src/desktop/main/run-host-entry.ts) — so
// BridgeEngine.stop() of an execution kills that host's tree, never this process. Execution Hosts
// are forked with the 'independent' lifetime (execution-host-spawn.ts): they outlive this process
// if it dies; this process itself keeps the default lifetime and ends with its parent.
//
// ELECTRON_RUN_AS_NODE is removed from this process's environment (as in run-host-entry.ts)
// and set again only for the Execution Hosts it forks with the same Electron binary; the
// run host removes it before Claude/Codex are spawned.
const electronNode = process.env.ELECTRON_RUN_AS_NODE === '1';
delete process.env.ELECTRON_RUN_AS_NODE;

const here = fileURLToPath(import.meta.url);
const RUN_HOST = here.endsWith('.ts') ? path.join(path.dirname(here), '..', 'desktop', 'main', 'run-host-entry.ts') : path.join(path.dirname(here), 'run-host.mjs');

serveWorkflowHost({
  createDeps: (projectPath) => ({
    projectPath,
    port: createExecutionPort({ projectPath, scriptPath: RUN_HOST, execPath: process.execPath, env: { ...process.env, ...(electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }),
  }),
});
