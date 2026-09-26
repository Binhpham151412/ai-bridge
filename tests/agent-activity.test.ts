import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAgentActivity } from '../src/core/status/agent-activity.ts';

test('a live CLAUDE_EXECUTING session means Claude executes while Codex waits', () => {
  assert.deepEqual(describeAgentActivity('RUNNING', 'CLAUDE_EXECUTING'), { claude: 'EXECUTING', codex: 'WAITING' });
});

test('a live CODEX_REVIEWING session means Codex reviews while Claude waits', () => {
  assert.deepEqual(describeAgentActivity('RUNNING', 'CODEX_REVIEWING'), { claude: 'WAITING', codex: 'REVIEWING' });
});

test('any other live phase means both wait (the bridge itself is working)', () => {
  for (const phase of ['PREFLIGHT', 'REPORT_DETECTED', 'REPORT_VALIDATED', 'RESPONSE_PARSED', null]) {
    assert.deepEqual(describeAgentActivity('RUNNING', phase), { claude: 'WAITING', codex: 'WAITING' });
  }
});

test('a non-running session is idle even if its last persisted phase was mid-flight (crash)', () => {
  for (const status of ['INTERRUPTED', 'PAUSED', 'DONE', 'ERROR', 'STOPPED', 'NOT_STARTED']) {
    assert.deepEqual(describeAgentActivity(status, 'CLAUDE_EXECUTING'), { claude: 'IDLE', codex: 'IDLE' });
  }
});
