import { createHash } from 'node:crypto';

export interface IntegrityCheckResult {
  ok: boolean;
  reason?: string;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Guards against a future refactor silently breaking "the report text Codex sees is
 * byte-identical to the report file": both the report file's own hash and its verbatim
 * presence inside what was actually sent are checked.
 */
export function verifyReportTransportIntegrity(reportFileSha256: string, reportText: string, sentText: string): IntegrityCheckResult {
  if (sha256Text(reportText) !== reportFileSha256) {
    return { ok: false, reason: 'Report text hash does not match the report file hash' };
  }
  if (!sentText.includes(reportText)) {
    return { ok: false, reason: 'Report text is not present verbatim in the text sent to the reviewer' };
  }
  return { ok: true };
}

/** Guards the write/read round-trip of the prompt sent to Claude against silent corruption. */
export function verifyPromptIntegrity(sourceSha256: string, writtenText: string): IntegrityCheckResult {
  if (sha256Text(writtenText) !== sourceSha256) {
    return { ok: false, reason: 'Written prompt hash does not match the source prompt hash' };
  }
  return { ok: true };
}
