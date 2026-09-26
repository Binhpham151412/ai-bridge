// Side-effect module: must be the FIRST import of every renderer test, so React DOM sees
// a DOM when it is evaluated. Installs a happy-dom window's globals on globalThis.
import { Window } from 'happy-dom';

const window = new Window({ url: 'file:///C:/app/dist-desktop/renderer/index.html', width: 1400, height: 900 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  try {
    g[key] = (window as unknown as Record<string, unknown>)[key];
  } catch {
    // some accessors are not readable detached — irrelevant for these tests
  }
}
g.window = window;
g.document = window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
// Confirmation dialogs (STOP / DISCARD) are accepted in tests.
(window as unknown as { confirm: () => boolean }).confirm = () => true;
