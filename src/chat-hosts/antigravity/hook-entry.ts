// docs/68 — the Antigravity plugin's hook command, bundled to plugins/antigravity/dist/hook.mjs:
//   node hook.mjs pre    PreInvocation (`/bridge <task>`, `/bridge stop`)
//   node hook.mjs stop   Stop (Codex review)
// Reads the hook input from stdin, prints the hook output as JSON, always exits 0: a failure must
// never block the agent, so it lets the stop through (any `decision` but "continue" does).
import { realReviewDeps, stateRootOf } from '../review-deps.ts';
import { handleAgyStop, handlePreInvocation, type AgyDeps, type AgyHookInput } from './hooks.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const deps: AgyDeps = { stateRoot: stateRootOf('antigravity', 'AI_BRIDGE_ANTIGRAVITY_DIR'), now: () => new Date(), ...realReviewDeps() };
const kind = process.argv[2];

try {
  const input = JSON.parse(await readStdin()) as AgyHookInput;
  if (kind === 'pre') process.stdout.write(JSON.stringify((await handlePreInvocation(input, deps)) ?? {}));
  else if (kind === 'stop') process.stdout.write(JSON.stringify((await handleAgyStop(input, deps)) ?? { decision: 'allow' }));
  else throw new Error(`unknown hook kind ${JSON.stringify(kind)}`);
} catch (err) {
  process.stderr.write(`AI Bridge hook error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stdout.write(JSON.stringify(kind === 'stop' ? { decision: 'allow' } : {}));
}
process.exitCode = 0;
