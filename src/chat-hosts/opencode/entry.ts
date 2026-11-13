// docs/67, docs/68 — the OpenCode plugin, bundled to plugins/opencode/dist/ai-bridge.js (scripts/opencode-plugin/build.ts).
// OpenCode calls every export of a plugin file as a plugin and rejects any export that is not a
// function, so this file exports the one plugin and nothing else.
import { realReviewDeps, stateRootOf } from '../review-deps.ts';
import { createBridgeHooks, type OpenCodeClient } from './bridge.ts';

export const AiBridge = async ({ client, directory }: { client: OpenCodeClient; directory: string }) =>
  createBridgeHooks({
    client,
    directory,
    stateRoot: stateRootOf('opencode', 'AI_BRIDGE_OPENCODE_DIR'),
    now: () => new Date(),
    ...realReviewDeps(),
  });
