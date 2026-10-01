/**
 * M5.10.1 — the provider-neutral execution permission policy (docs/61). Zero imports on
 * purpose: shared by Core, the provider adapters, Electron Main and (as types) the
 * renderer.
 *
 * - `bypass` — the provider runs the operations its CLI supports without interactive
 *   permission prompts. **Product default** (an explicit requirement, see docs/61 §3).
 * - `ask` — the provider's normal permission behaviour. AI Bridge drives providers
 *   headless, so "ask" cannot put a question to a human mid-run: whatever the provider
 *   would need approval for is refused by the provider itself and reported back.
 * - `inherit` — an execution-level request only: "use the project's setting for this
 *   provider". The workflow layer sends this (by omission) today.
 *
 * Which concrete CLI flags a policy becomes is decided by each provider adapter — the
 * workflow layer, ExecutionPort and BridgeEngine only ever handle these words.
 */

export const PERMISSION_POLICIES = ['ask', 'bypass'] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

export const PERMISSION_POLICY_REQUESTS = ['inherit', 'ask', 'bypass'] as const;
export type PermissionPolicyRequest = (typeof PERMISSION_POLICY_REQUESTS)[number];

export const PERMISSION_PROVIDERS = ['claude', 'codex'] as const;
export type PermissionProvider = (typeof PERMISSION_PROVIDERS)[number];

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = 'bypass';

/** The per-project setting (`.ai-bridge/config.json` → `permissions`). */
export type ProviderPermissionSettings = Record<PermissionProvider, PermissionPolicy>;

export function defaultProviderPermissions(): ProviderPermissionSettings {
  return { claude: DEFAULT_PERMISSION_POLICY, codex: DEFAULT_PERMISSION_POLICY };
}

export function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  return typeof value === 'string' && (PERMISSION_POLICIES as readonly string[]).includes(value);
}

export function isPermissionPolicyRequest(value: unknown): value is PermissionPolicyRequest {
  return typeof value === 'string' && (PERMISSION_POLICY_REQUESTS as readonly string[]).includes(value);
}

export function isPermissionProvider(value: unknown): value is PermissionProvider {
  return typeof value === 'string' && (PERMISSION_PROVIDERS as readonly string[]).includes(value);
}

export type PermissionPolicySource = 'execution-override' | 'provider-setting';

/** What every execution records (execution record + journal): enough to answer "why did
 * this execution (not) ask for permission?" without reading anything else. */
export interface ResolvedPermissionPolicy {
  provider: PermissionProvider;
  requested: PermissionPolicyRequest;
  resolved: PermissionPolicy;
  source: PermissionPolicySource;
  reason: string;
}

export type PermissionResolution =
  | { ok: true; policy: ResolvedPermissionPolicy }
  | { ok: false; code: 'UNSUPPORTED_PERMISSION_POLICY'; reason: string };

/**
 * `inherit` (or no request) → the provider's setting; `ask`/`bypass` → that value as an
 * execution override. Fails closed: an unknown provider, request or setting value is an
 * error, never a guess. A missing setting is the product default (`bypass`).
 */
export function resolvePermissionPolicy(input: { provider: unknown; requested?: unknown; settings?: Partial<Record<string, unknown>> | null }): PermissionResolution {
  const { provider } = input;
  const requested = input.requested ?? 'inherit';
  if (!isPermissionProvider(provider)) {
    return { ok: false, code: 'UNSUPPORTED_PERMISSION_POLICY', reason: `no permission policy is defined for provider ${JSON.stringify(provider)}` };
  }
  if (!isPermissionPolicyRequest(requested)) {
    return { ok: false, code: 'UNSUPPORTED_PERMISSION_POLICY', reason: `permission policy must be one of ${PERMISSION_POLICY_REQUESTS.join(', ')}, got ${JSON.stringify(requested)}` };
  }
  if (requested !== 'inherit') {
    return { ok: true, policy: { provider, requested, resolved: requested, source: 'execution-override', reason: `Execution-level permission override = ${requested}` } };
  }
  const setting = input.settings?.[provider];
  if (setting === undefined) {
    return {
      ok: true,
      policy: { provider, requested, resolved: DEFAULT_PERMISSION_POLICY, source: 'provider-setting', reason: `Global provider permission policy (${provider}) = ${DEFAULT_PERMISSION_POLICY} (default)` },
    };
  }
  if (!isPermissionPolicy(setting)) {
    return { ok: false, code: 'UNSUPPORTED_PERMISSION_POLICY', reason: `the ${provider} permission setting must be one of ${PERMISSION_POLICIES.join(', ')}, got ${JSON.stringify(setting)}` };
  }
  return { ok: true, policy: { provider, requested, resolved: setting, source: 'provider-setting', reason: `Global provider permission policy (${provider}) = ${setting}` } };
}

/** One policy a provider's installed CLI actually supports, and how. */
export interface ProviderPermissionMode {
  policy: PermissionPolicy;
  label: string;
  description: string;
  /** The exact CLI mechanism this policy maps to (shown in Settings and the audit). */
  cliMechanism: string;
}

/** Declared by each adapter; never claims a mode its CLI does not have. */
export interface ProviderPermissionCapability {
  provider: PermissionProvider;
  displayName: string;
  /** The CLI version whose `--help` the mapping was checked against (no task was run). */
  verifiedAgainst: string;
  modes: ProviderPermissionMode[];
}

export const BYPASS_WARNING =
  'Permission bypass is enabled by default. AI providers may execute commands and access project resources without interactive approval.';
