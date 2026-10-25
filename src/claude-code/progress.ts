import type { ChecklistItem } from '../prompts/templates.ts';

/**
 * docs/66 — how far the task is, as Codex's review for the user says it (`buildChatReviewerInput`):
 * `## Việc` (the task in one sentence), `## Tiến độ` (the checklist) and `## Kết luận`.
 * Display only, read leniently: the loop's decisions stay with `CodexResponseParser`.
 */
export interface ReviewProgress {
  title: string | null;
  items: ChecklistItem[];
  verdict: string | null;
}

const CHECKLIST_LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;

/** The review's `## <name>` sections (the text before the response block), by name. */
function sections(review: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let lines: string[] | null = null;
  for (const line of review.split('<AI_BRIDGE_RESPONSE>')[0].split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) found.set(heading[1].normalize('NFC').toLowerCase(), (lines = []));
    else lines?.push(line);
  }
  return found;
}

const firstLine = (lines: string[] | undefined) => lines?.map((l) => l.trim()).find((l) => l !== '') ?? null;

export function parseReviewProgress(review: string): ReviewProgress | null {
  const s = sections(review);
  const items: ChecklistItem[] = [];
  for (const line of s.get('tiến độ') ?? []) {
    const m = CHECKLIST_LINE.exec(line);
    if (m) items.push({ text: m[2], done: m[1] !== ' ' });
  }
  const verdict = firstLine(s.get('kết luận'));
  if (items.length === 0 && verdict === null) return null;
  return { title: firstLine(s.get('việc')), items, verdict };
}
