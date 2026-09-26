import {
  isInvokeChannel,
  validateRequest,
  type InvokeChannel,
  type RequestOf,
  type ResponseOf,
  type UiError,
} from '../shared/ipc-contract.ts';
import { unexpectedError } from '../shared/messages.ts';
import { redactUiError } from './redaction.ts';

export type ChannelHandlers = { [C in InvokeChannel]: (request: RequestOf<C>) => Promise<ResponseOf<C>> };

export interface IpcRouterOptions {
  handlers: ChannelHandlers;
  isTrustedSender: (senderUrl: string | undefined) => boolean;
}

export type RouteResult = ResponseOf<InvokeChannel> | { ok: false; error: UiError };

function reject(code: string, title: string, details: string): { ok: false; error: UiError } {
  return { ok: false, error: { code, title, message: 'Yêu cầu bị từ chối bởi Electron Main.', details } };
}

/** The only path from an IPC message to a handler: sender check → channel allowlist →
 * payload validation → handler → redaction of any error. Electron-free, so every
 * rejection path is unit-tested without launching Electron. */
export function createIpcRouter(options: IpcRouterOptions): (channel: unknown, payload: unknown, senderUrl: string | undefined) => Promise<RouteResult> {
  async function dispatch<C extends InvokeChannel>(channel: C, request: RequestOf<C>): Promise<ResponseOf<C>> {
    // TypeScript cannot correlate `handlers[channel]` with `C` through the mapped type
    // (the classic correlated-union limitation); the cast is sound because both sides
    // are indexed by the same `C`.
    const handler = options.handlers[channel] as (request: RequestOf<C>) => Promise<ResponseOf<C>>;
    return handler(request);
  }

  return async (channel, payload, senderUrl) => {
    if (!options.isTrustedSender(senderUrl)) return reject('UNTRUSTED_SENDER', 'Nguồn yêu cầu không hợp lệ', `sender: ${String(senderUrl)}`);
    if (!isInvokeChannel(channel)) return reject('UNKNOWN_CHANNEL', 'Kênh IPC không được phép', `channel: ${String(channel)}`);
    const validation = validateRequest(channel, payload);
    if (!validation.ok) return reject('INVALID_REQUEST', 'Yêu cầu không hợp lệ', validation.reason);
    try {
      const response = await dispatch(channel, validation.value);
      return response.ok ? response : { ok: false, error: redactUiError(response.error) };
    } catch (err) {
      return { ok: false, error: redactUiError(unexpectedError(err)) };
    }
  };
}

/** Only the app's own bundled renderer page may call Main (hash/query ignored). */
export function createTrustedSenderCheck(expectedUrl: string): (senderUrl: string | undefined) => boolean {
  const normalize = (url: string) => url.replace(/[?#].*$/, '');
  const expected = normalize(expectedUrl);
  return (senderUrl) => typeof senderUrl === 'string' && normalize(senderUrl) === expected;
}
