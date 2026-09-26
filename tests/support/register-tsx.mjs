// Loaded via `node --import` by `pnpm test`: Node strips types from .ts natively but
// does not understand JSX, so .tsx modules (renderer components and their tests) are
// transformed by esbuild — the same transformer that bundles the renderer.
import { register } from 'node:module';

register('./tsx-hooks.mjs', import.meta.url);
