import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * docs/66 — the user's Codex plan and quota, as Codex itself logs them: each run appends
 * `token_count` events carrying `rate_limits` (`plan_type`, `primary` / `secondary` windows with
 * `used_percent`) to `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`.
 * Only that thread's log is read, only for those fields; the credentials file is never touched.
 * Anything unexpected (no log, another format) means "unknown", which keeps the review cheap.
 */
export interface CodexAccount {
  /** `free`, `plus`, `pro`, `team`, …; null when the log does not say. */
  plan: string | null;
  /** The more used of the quota windows. */
  usedPercent: number | null;
  windowMinutes: number | null;
  /** When that window starts over (Unix seconds). */
  resetsAt: number | null;
}

/** `AI_BRIDGE_CODEX_CHECK_CODE`: `auto` (paid plans check the code), `on`, `off`. */
export type CheckCodeMode = 'auto' | 'on' | 'off';

export function checkCodeMode(env: NodeJS.ProcessEnv): CheckCodeMode {
  const v = (env.AI_BRIDGE_CODEX_CHECK_CODE ?? '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : 'auto';
}

/** Codex checks the code itself (changes + files) only on a known paid plan: the free plan's quota goes on the report alone. */
export function shouldCheckCode(mode: CheckCodeMode, account: CodexAccount | null): boolean {
  if (mode !== 'auto') return mode === 'on';
  return account?.plan != null && account.plan !== 'free';
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function rateLimitsOf(value: unknown, depth = 0): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || depth > 4) return null;
  const rl = (value as Record<string, unknown>).rate_limits;
  if (rl !== null && typeof rl === 'object') return rl as Record<string, unknown>;
  for (const child of Object.values(value)) {
    const found = rateLimitsOf(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The plan and quota from the last `rate_limits` in a Codex log, or null. */
export function accountFromRollout(text: string): CodexAccount | null {
  let last: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      last = rateLimitsOf(JSON.parse(line)) ?? last;
    } catch {
      // a line cut short while Codex was writing it
    }
  }
  if (last === null) return null;
  const windows = [last.primary, last.secondary]
    .filter((w): w is Record<string, unknown> => w !== null && typeof w === 'object' && num((w as Record<string, unknown>).used_percent) !== null)
    .sort((a, b) => (num(b.used_percent) ?? 0) - (num(a.used_percent) ?? 0));
  const w = windows[0];
  return {
    plan: typeof last.plan_type === 'string' ? last.plan_type : null,
    usedPercent: w ? num(w.used_percent) : null,
    windowMinutes: w ? num(w.window_minutes) : null,
    resetsAt: w ? num(w.resets_at) : null,
  };
}

const DAYS_SEARCHED = 120;

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort().reverse();
}

/** `<codexHome>/sessions/YYYY/MM/DD/*-<threadId>.jsonl`, newest days first, or null. */
async function findRollout(codexHome: string, threadId: string): Promise<string | null> {
  const sessions = path.join(codexHome, 'sessions');
  let days = 0;
  for (const y of await names(sessions)) {
    for (const m of await names(path.join(sessions, y))) {
      for (const d of await names(path.join(sessions, y, m))) {
        if (++days > DAYS_SEARCHED) return null;
        const dir = path.join(sessions, y, m, d);
        const hit = (await names(dir)).find((f) => f.endsWith(`-${threadId}.jsonl`));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** The account as the log of Codex thread `threadId` last recorded it, or null. */
export async function readCodexAccount(codexHome: string, threadId: string): Promise<CodexAccount | null> {
  if (!/^[0-9A-Za-z-]{8,64}$/.test(threadId)) return null;
  const file = await findRollout(codexHome, threadId);
  if (file === null) return null;
  return accountFromRollout(await readFile(file, 'utf8').catch(() => ''));
}
