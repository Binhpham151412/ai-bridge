import type { BridgeRunOutcome } from '../../core/bridge-engine.ts';
import { EVENT_TYPES, type BridgeEvent } from '../../core/observability/events.ts';
import { isPermissionPolicyRequest, type PermissionPolicyRequest } from '../../core/permissions/permission-policy.ts';

/**
 * Messages between Electron Main and the run host — the child process in which
 * `BridgeEngine.start()`/`resume()` actually execute (see run-host.ts for why the loop
 * does not run inside the Electron main process itself).
 */
/** `correlation` (M5.4, ADR-017) is optional and additive: the workflow attemptId, passed
 * through unchanged to BridgeEngine.start(); the desktop app never sets it. */
/** `permissionPolicy` (M5.10.1) is optional and additive too: an execution-level override
 * (inherit/ask/bypass) passed through to BridgeEngine.start(); the desktop app never sets it. */
export type HostCommand =
  | { type: 'start'; projectPath: string; task: string; maxIterations?: number; correlation?: string; permissionPolicy?: PermissionPolicyRequest }
  | { type: 'resume'; projectPath: string };

export type HostMessage = { type: 'event'; event: BridgeEvent } | { type: 'outcome'; outcome: BridgeRunOutcome } | { type: 'failed'; message: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isHostCommand(v: unknown): v is HostCommand {
  if (!isObject(v) || typeof v.projectPath !== 'string' || v.projectPath === '') return false;
  if (v.type === 'resume') return true;
  if (v.type !== 'start' || typeof v.task !== 'string') return false;
  if (v.correlation !== undefined && typeof v.correlation !== 'string') return false; // content is validated by BridgeEngine (INVALID_OPTIONS)
  if (v.permissionPolicy !== undefined && !isPermissionPolicyRequest(v.permissionPolicy)) return false;
  return v.maxIterations === undefined || (typeof v.maxIterations === 'number' && Number.isInteger(v.maxIterations) && v.maxIterations > 0);
}

export function isHostMessage(v: unknown): v is HostMessage {
  if (!isObject(v)) return false;
  if (v.type === 'failed') return typeof v.message === 'string';
  if (v.type === 'outcome') return isObject(v.outcome) && typeof v.outcome.kind === 'string';
  if (v.type === 'event') {
    const e = v.event;
    return isObject(e) && typeof e.timestamp === 'string' && typeof e.runId === 'string' && typeof e.iteration === 'number' && typeof e.phase === 'string' && (EVENT_TYPES as readonly string[]).includes(e.event as string);
  }
  return false;
}
