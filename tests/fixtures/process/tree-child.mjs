import { writeFileSync } from 'node:fs';

const heartbeatFile = process.argv[2];
let i = 0;
setInterval(() => {
  writeFileSync(heartbeatFile, String(i++));
}, 40);
