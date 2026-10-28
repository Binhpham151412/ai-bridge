#!/usr/bin/env node
// Installs the OpenCode or Antigravity plugin (docs/67, docs/68) from this checkout: copies the
// committed bundle, nothing else, and never anything outside the folder you name.
//   node scripts/chat-hosts/install.ts opencode    --project <dir>   → <dir>/.opencode/plugins/ai-bridge.js
//   node scripts/chat-hosts/install.ts opencode    --global          → ~/.config/opencode/plugins/ai-bridge.js
//   node scripts/chat-hosts/install.ts antigravity --project <dir>   → <dir>/.agents/plugins/ai-bridge/
//   node scripts/chat-hosts/install.ts antigravity --global          → ~/.gemini/config/plugins/ai-bridge/
// (Antigravity also installs it itself: `agy plugin install plugins/antigravity`.)
// `--global` changes the settings of every project you open with that tool, so it is never the default.

import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export type Host = 'opencode' | 'antigravity';

/** The folder a host reads plugins from, for one project or for the user. */
export function pluginsFolder(host: Host, scope: { project: string } | { global: true }, home = homedir()): string {
  if (host === 'opencode') return 'project' in scope ? path.join(scope.project, '.opencode', 'plugins') : path.join(home, '.config', 'opencode', 'plugins');
  return 'project' in scope ? path.join(scope.project, '.agents', 'plugins') : path.join(home, '.gemini', 'config', 'plugins');
}

/** Copies the plugin into `folder` (replacing an earlier copy); returns what was written. */
export async function installPlugin(host: Host, folder: string, root = ROOT): Promise<string> {
  await mkdir(folder, { recursive: true });
  if (host === 'opencode') {
    const target = path.join(folder, 'ai-bridge.js');
    await cp(path.join(root, 'plugins', 'opencode', 'dist', 'ai-bridge.js'), target);
    return target;
  }
  const target = path.join(folder, 'ai-bridge');
  const from = path.join(root, 'plugins', 'antigravity');
  await rm(target, { recursive: true, force: true });
  // only what agy loads: the manifest, the hooks, the skills and the bundled hook command
  await mkdir(path.join(target, 'dist'), { recursive: true });
  for (const f of ['plugin.json', 'hooks.json']) await cp(path.join(from, f), path.join(target, f));
  await cp(path.join(from, 'skills'), path.join(target, 'skills'), { recursive: true });
  await cp(path.join(from, 'dist', 'hook.mjs'), path.join(target, 'dist', 'hook.mjs'));
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, ...rest] = process.argv.slice(2);
  const projectAt = rest.indexOf('--project');
  const scope = rest.includes('--global') ? ({ global: true } as const) : projectAt !== -1 && rest[projectAt + 1] ? { project: path.resolve(rest[projectAt + 1]) } : null;
  if ((host !== 'opencode' && host !== 'antigravity') || scope === null) {
    console.error('usage: node scripts/chat-hosts/install.ts <opencode|antigravity> (--project <dir> | --global)');
    process.exit(2);
  }
  console.log(`Installed the ${host} plugin: ${await installPlugin(host, pluginsFolder(host, scope))}`);
}
