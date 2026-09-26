import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context);
  const filename = fileURLToPath(url);
  const source = await readFile(filename, 'utf8');
  const { code } = await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'esm', target: 'node22', sourcefile: filename, sourcemap: 'inline' });
  return { format: 'module', source: code, shortCircuit: true };
}
