// Test Workflow Host process for the M5.8 tests: the production `serveWorkflowHost` (the same
// entry logic Electron Main forks), with either
//   FAKE_WF_PORT=scripted   an in-process FakeExecutionPort (FAKE_WF_BEHAVE: done | stoppable | needs-human)
//   FAKE_WF_PORT=forked     the production ExecutionPort (createExecutionPort: ForkedExecutionPort,
//                           'independent' Execution Host lifetime) over REAL Execution Host processes
//                           (fake-execution-host.ts: the real run host + BridgeEngine with fake CLIs)
// Never runs a real CLI or spends quota.
import { fileURLToPath } from 'node:url';
import { createExecutionPort } from '../../../src/hosts/execution-host-spawn.ts';
import { serveWorkflowHost } from '../../../src/hosts/workflow-host.ts';
import { FakeExecutionPort } from '../../workflow/fake-execution-port.ts';
import { needsHumanPort, stoppablePort } from '../../workflow/host-fixtures.ts';

const EXEC_HOST = fileURLToPath(new URL('./fake-execution-host.ts', import.meta.url));
const mode = process.env.FAKE_WF_PORT ?? 'scripted';
const behave = process.env.FAKE_WF_BEHAVE ?? 'done';

function scriptedPort(): FakeExecutionPort {
  if (behave === 'stoppable') return stoppablePort();
  if (behave === 'needs-human') return needsHumanPort();
  return new FakeExecutionPort();
}

serveWorkflowHost({
  createDeps: (projectPath) =>
    mode === 'forked'
      ? {
          projectPath,
          port: createExecutionPort({ projectPath, scriptPath: EXEC_HOST, execPath: process.execPath, env: process.env }),
          engine: { pollIntervalMs: 50 },
          controlPollMs: 50,
        }
      : { projectPath, port: scriptedPort(), engine: { pollIntervalMs: 5, preflightGraceMs: 0, isPidAlive: () => false }, controlPollMs: 20 },
});
