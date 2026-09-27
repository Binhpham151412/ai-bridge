/**
 * Zero-dependency identifiers shared between Core's Development Journal (`journal.ts`)
 * and the desktop IPC contract (`desktop/shared/ipc-contract.ts`) — which the sandboxed
 * renderer's `platform: 'browser'` esbuild bundle also pulls in (M4 §4/§21: the renderer
 * shares only type-safe contract code, never a runtime dependency on Node or Core).
 * `JOURNAL_ENTRY_KINDS`/`isJournalEntryKind` are real runtime values the IPC validator
 * needs, so this file deliberately has NO imports of its own (not even `node:*`) — moving
 * them here instead of importing them from `journal.ts` (which imports `node:fs/promises`
 * and `node:path`) keeps the renderer bundle from ever trying to resolve Node builtins.
 */

export const JOURNAL_ENTRY_KINDS = ['SESSION_INDEX', 'FINAL_REPORT', 'CLAUDE_REPORT', 'CHATGPT_REVIEW', 'CLAUDE_PROMPT', 'NEXT_PROMPT', 'RAW_CODEX_RESPONSE'] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

export function isJournalEntryKind(value: unknown): value is JournalEntryKind {
  return typeof value === 'string' && (JOURNAL_ENTRY_KINDS as readonly string[]).includes(value);
}
