import { readFile } from 'node:fs/promises';

/** One line of a Claude Code session transcript (JSONL). Only the fields read here are typed. */
export interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  message?: { id?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
}

const blocks = (r: TranscriptRecord): ContentBlock[] => (Array.isArray(r.message?.content) ? (r.message.content as ContentBlock[]) : []);

/** Unparseable lines are skipped: the transcript is being appended to while it is read. */
export async function readTranscript(transcriptPath: string): Promise<TranscriptRecord[]> {
  const text = await readFile(transcriptPath, 'utf8');
  const records: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // a partial last line
    }
  }
  return records;
}

/**
 * The text of Claude's final message of the turn, or null when it is not in the
 * transcript yet: the Stop hook can fire before the reply is flushed. One API message
 * is written as several records (thinking, text, …) sharing `message.id`.
 */
export function finalReply(records: TranscriptRecord[]): string | null {
  const main = records.filter((r) => !r.isSidechain && (r.type === 'user' || r.type === 'assistant'));
  const last = main.at(-1);
  if (last?.type !== 'assistant') return null;
  const id = last.message?.id;
  const parts = id === undefined ? [last] : main.filter((r) => r.type === 'assistant' && r.message?.id === id);
  const texts = parts.flatMap((r) => blocks(r).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string));
  return texts.length > 0 ? texts.join('\n') : null;
}
