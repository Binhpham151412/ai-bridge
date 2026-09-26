// Writes a fixed number of lines to stdout as fast as possible, then exits 0.
// Used to test runProcess's maxBufferBytes cap without needing a hanging process.
const lines = Number(process.argv[2] ?? '1000');
const lineText = 'x'.repeat(100) + '\n';
for (let i = 0; i < lines; i++) process.stdout.write(lineText);
