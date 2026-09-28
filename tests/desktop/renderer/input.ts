import { act } from 'react';
import { flush } from './harness.tsx';

// Node's global `Event` and happy-dom's are different classes — dispatchEvent on a
// happy-dom element requires an instance of *its* Event (see start-run-dialog.test.tsx).
function domEvent(type: string): Event {
  const Ctor = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
  return new Ctor(type, { bubbles: true });
}

/** Sets a form control's value the way React listens for it (native setter + input/change). */
export async function change(el: Element | null | undefined, value: string): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(domEvent('input'));
    if (el instanceof HTMLSelectElement) el.dispatchEvent(domEvent('change'));
  });
  await flush();
}
