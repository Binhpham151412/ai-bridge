import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ClaudeCodeCliAdapter } from '../src/adapters/claude/claude-code-cli-adapter.ts';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

async function withProject<T>(fn: (dirs: { projectPath: string; sessionDir: string; reportsDir: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-integrity-chain-'));
  try {
    const sessionDir = path.join(root, 'session');
    const reportsDir = path.join(root, 'reports');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(reportsDir, { recursive: true });
    return await fn({ projectPath: root, sessionDir, reportsDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeOrchestrator(dirs: { projectPath: string; sessionDir: string; reportsDir: string }, overrides: Record<string, unknown> = {}) {
  return new Orchestrator({
    projectName: 'Demo Project',
    projectPath: dirs.projectPath,
    bridgeSessionId: '2026-09-25_001',
    sessionDir: dirs.sessionDir,
    reportsDir: dirs.reportsDir,
    initialPrompt: 'Create src/sum.js with a sum(a, b) function and a test.',
    maxIterations: 10,
    claudeTimeoutMs: 5000,
    codexTimeoutMs: 5000,
    claudeAdapter: new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLAUDE] }),
    codexAdapter: new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] }),
    ...overrides,
  });
}

test('writes an immutable per-iteration integrity-chain artifact whose hashes match the actual on-disk artifacts', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_MODE: 'sequence' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    assert.equal(r.iterations.length, 2);

    for (const iter of r.iterations) {
      const chainPath = path.join(dirs.sessionDir, `${String(iter.iteration).padStart(3, '0')}-integrity.json`);
      const chain = JSON.parse(await readFile(chainPath, 'utf8'));
      assert.equal(chain.iteration, iter.iteration);

      const promptText = await readFile(iter.promptPath, 'utf8');
      assert.equal(chain.claudeInputHash, sha256(promptText), `iteration ${iter.iteration}: claudeInputHash must match the prompt actually written to disk`);

      const reportText = await readFile(iter.reportPath, 'utf8');
      assert.equal(chain.reportHash, sha256(reportText), `iteration ${iter.iteration}: reportHash must match the report file on disk`);
      assert.equal(chain.reportHash, iter.reportSha256, 'reportHash must agree with the existing reportSha256 field');

      const codexInputText = await readFile(iter.codexInputPath, 'utf8');
      assert.equal(chain.codexInputHash, sha256(codexInputText), `iteration ${iter.iteration}: codexInputHash must match what was actually sent to Codex`);

      const codexResponseText = await readFile(iter.codexReviewPath, 'utf8');
      assert.equal(chain.codexResponseHash, sha256(codexResponseText), `iteration ${iter.iteration}: codexResponseHash must match Codex's raw response file`);

      if (iter.extractedPromptPath) {
        const extractedText = await readFile(iter.extractedPromptPath, 'utf8');
        assert.equal(chain.promptHash, sha256(extractedText), `iteration ${iter.iteration}: promptHash must match the extracted <PROMPT> written to disk`);
      }
    }
  }));

test('a mismatch between a persisted hash and the live artifact is detectable by direct recomputation (the chain is a real audit trail, not a placeholder)', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { maxIterations: 1, claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_MODE: 'ok' } });
    const r = await orch.run();
    const chainPath = path.join(dirs.sessionDir, '001-integrity.json');
    const chain = JSON.parse(await readFile(chainPath, 'utf8'));
    const reportText = await readFile(r.iterations[0].reportPath, 'utf8');
    // Mutation check: corrupting the read text must change the recomputed hash, proving
    // the stored hash is a real content digest and not a constant/placeholder value.
    assert.notEqual(chain.reportHash, sha256(reportText + ' tampered'));
    assert.equal(chain.reportHash, sha256(reportText));
  }));
