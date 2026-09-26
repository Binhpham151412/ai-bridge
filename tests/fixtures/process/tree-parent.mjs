import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const heartbeatFile = process.argv[2];

spawn(process.execPath, [path.join(dir, 'tree-child.mjs'), heartbeatFile], { stdio: 'ignore' });

process.stdout.write('parent-started\n');
setInterval(() => {}, 1_000_000);
