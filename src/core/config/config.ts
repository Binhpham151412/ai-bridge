import { PERMISSION_POLICIES, defaultProviderPermissions, isPermissionPolicy, isPermissionProvider, type ProviderPermissionSettings } from '../permissions/permission-policy.ts';

export interface AiBridgeConfig {
  maxIterations: number;
  claudeTimeoutMs: number;
  codexTimeoutMs: number;
  reportMaxBytes: number;
  stopOnUncommittedChanges: boolean;
  requireGitRepository: boolean;
  /** M5.10.1: per-provider permission policy (docs/61). Absent in a file → `bypass`. */
  permissions: ProviderPermissionSettings;
  /** Model per provider (docs/62). `null` = no `--model` flag: the CLI's own setting decides. */
  models: { claude: string | null };
}

/** A model alias or full id as the CLI accepts it (`opus`, `claude-opus-5-5`, `opus[1m]`):
 * never starts with `-` (it must not read as a flag), no spaces, at most 100 characters. */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

export function isValidModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME_PATTERN.test(value);
}

export const DEFAULT_CONFIG: AiBridgeConfig = {
  maxIterations: 10,
  claudeTimeoutMs: 1_800_000,
  codexTimeoutMs: 600_000,
  reportMaxBytes: 1_048_576,
  stopOnUncommittedChanges: false,
  requireGitRepository: false,
  permissions: defaultProviderPermissions(),
  models: { claude: null },
};

export interface ValidateConfigResult {
  config: AiBridgeConfig;
  errors: string[];
}

export interface LoadConfigDeps {
  readFile: (path: string) => Promise<string>;
}

/** Safety ceiling for review rounds per run (M4.2): large tasks may need tens of rounds,
 * but never an unbounded loop. Shared by config validation, start() and the IPC layer. */
export const MAX_RUN_ITERATIONS = 100;
const MAX_ITERATIONS_CAP = MAX_RUN_ITERATIONS;
const NUMBER_FIELDS = ['maxIterations', 'claudeTimeoutMs', 'codexTimeoutMs', 'reportMaxBytes'] as const;
const BOOLEAN_FIELDS = ['stopOnUncommittedChanges', 'requireGitRepository'] as const;
const KNOWN_FIELDS: readonly string[] = [...NUMBER_FIELDS, ...BOOLEAN_FIELDS, 'permissions', 'models'];
const MODEL_PROVIDERS = ['claude'] as const;

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Fails fast and specifically: every problem is reported, never silently coerced or dropped. */
export function validateConfig(raw: unknown): ValidateConfigResult {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: { ...DEFAULT_CONFIG }, errors: ['Config must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.includes(key)) errors.push(`Unknown config field: "${key}"`);
  }

  const config: AiBridgeConfig = { ...DEFAULT_CONFIG, permissions: defaultProviderPermissions(), models: { claude: null } };

  for (const field of NUMBER_FIELDS) {
    if (!(field in obj)) continue;
    const v = obj[field];
    if (!isPositiveInteger(v)) {
      errors.push(`${field} must be a positive integer, got ${JSON.stringify(v)}`);
      continue;
    }
    if (field === 'maxIterations' && v > MAX_ITERATIONS_CAP) {
      errors.push(`maxIterations must be at most ${MAX_ITERATIONS_CAP} (no unbounded loops), got ${v}`);
      continue;
    }
    config[field] = v;
  }

  for (const field of BOOLEAN_FIELDS) {
    if (!(field in obj)) continue;
    const v = obj[field];
    if (typeof v !== 'boolean') {
      errors.push(`${field} must be a boolean, got ${JSON.stringify(v)}`);
      continue;
    }
    config[field] = v;
  }

  if ('permissions' in obj) {
    const v = obj.permissions;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      errors.push(`permissions must be an object like {"claude": "bypass", "codex": "ask"}, got ${JSON.stringify(v)}`);
    } else {
      for (const [provider, policy] of Object.entries(v as Record<string, unknown>)) {
        if (!isPermissionProvider(provider)) errors.push(`Unknown permissions provider: "${provider}"`);
        else if (!isPermissionPolicy(policy)) errors.push(`permissions.${provider} must be one of ${PERMISSION_POLICIES.join(', ')}, got ${JSON.stringify(policy)}`);
        else config.permissions[provider] = policy;
      }
    }
  }

  if ('models' in obj) {
    const v = obj.models;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      errors.push(`models must be an object like {"claude": "claude-opus-5-5"}, got ${JSON.stringify(v)}`);
    } else {
      for (const [provider, model] of Object.entries(v as Record<string, unknown>)) {
        if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) errors.push(`Unknown models provider: "${provider}" (only claude is configurable)`);
        else if (model !== null && !isValidModelName(model)) errors.push(`models.${provider} must be null (use the CLI's setting) or a model name like "opus" or "claude-opus-5-5", got ${JSON.stringify(model)}`);
        else config.models.claude = model as string | null;
      }
    }
  }

  return { config, errors };
}

/** Missing config.json is not an error — it means "use defaults." A present-but-invalid file is. */
export async function loadConfig(configPath: string, deps: LoadConfigDeps): Promise<ValidateConfigResult> {
  let text: string;
  try {
    text = await deps.readFile(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: { ...DEFAULT_CONFIG }, errors: [] };
    return { config: { ...DEFAULT_CONFIG }, errors: [`Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { config: { ...DEFAULT_CONFIG }, errors: [`Invalid JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  return validateConfig(parsed);
}
