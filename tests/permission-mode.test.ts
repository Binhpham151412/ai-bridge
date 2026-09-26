import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafePermissionMode, SAFE_PERMISSION_MODES } from '../src/core/preflight/permission-mode.ts';

test('accepts every mode in the safe allowlist', () => {
  for (const mode of SAFE_PERMISSION_MODES) {
    assert.doesNotThrow(() => assertSafePermissionMode(mode));
  }
});

test('rejects bypassPermissions even though the real CLI supports it', () => {
  assert.throws(() => assertSafePermissionMode('bypassPermissions'), /bypassPermissions/);
});

test('rejects an unrecognized permission mode', () => {
  assert.throws(() => assertSafePermissionMode('whatever'), /whatever/);
});

test('the safe allowlist never contains bypassPermissions', () => {
  assert.ok(!SAFE_PERMISSION_MODES.includes('bypassPermissions' as never));
});
