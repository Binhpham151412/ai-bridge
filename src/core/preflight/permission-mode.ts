/**
 * Modes AI Bridge is willing to pass to `claude --permission-mode`. The real CLI also
 * accepts "bypassPermissions" (confirmed via `claude --help`), but this project's own
 * safety rule (M1/M2 spec §10/§36) forbids it: AI Bridge must never let Claude skip
 * permission checks, even if a caller tries to configure it that way.
 */
export const SAFE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const;
export type SafePermissionMode = (typeof SAFE_PERMISSION_MODES)[number];

export function assertSafePermissionMode(mode: string): asserts mode is SafePermissionMode {
  if (!(SAFE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `Unsafe or unrecognized permission mode "${mode}". AI Bridge only allows: ${SAFE_PERMISSION_MODES.join(', ')}. "bypassPermissions" is never allowed.`,
    );
  }
}
