let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  data += c;
});
process.stdin.on('end', () => {
  process.stdout.write('got:' + data);
});
