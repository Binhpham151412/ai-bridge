export interface ReportContractInput {
  reportPath: string;
  sessionId: string;
  iteration: number;
}

export interface ReviewerInputParams {
  projectName: string;
  sessionId: string;
  iteration: number;
  reportText: string;
}

/**
 * The report-file contract, sent to Claude via --append-system-prompt (never mixed
 * into the piped prompt). Tells Claude exactly where to write its report and in
 * what format, so the loop can validate it deterministically (see ReportValidator).
 */
export function buildReportContract(input: ReportContractInput): string {
  return [
    'AI_BRIDGE_REPORT_CONTRACT',
    `REPORT_FILE: ${input.reportPath}`,
    `SESSION_ID: ${input.sessionId}`,
    `ITERATION: ${input.iteration}`,
    '',
    'After you finish the task in the prompt, write a report to REPORT_FILE using exactly',
    'this format (the file must start with the header line below and contain each',
    'section heading exactly once, in this order):',
    '',
    '# AI Bridge Report',
    '',
    `SESSION_ID: ${input.sessionId}`,
    `ITERATION: ${input.iteration}`,
    'REPORT_STATUS: COMPLETE',
    'NEXT_ACTION: CONTINUE, DONE, or NEED_HUMAN',
    '',
    '## TASK',
    '## CHANGES',
    '## TESTS',
    '## ISSUES',
    '## NEXT_RECOMMENDATION',
    '',
    'Recommended (for the development journal): after ## NEXT_RECOMMENDATION, also add these',
    'sections, each at most once, in this order: ## FILES CREATED, ## FILES MODIFIED,',
    '## FILES DELETED, ## VALIDATION, ## DECISIONS, ## REMAINING WORK, ## SUMMARY.',
    '',
    'Rules:',
    '- This is an automated, unattended run. Nobody will read chat replies or answer questions:',
    '  do not ask questions — do the work, then write REPORT_FILE with your file-writing tool.',
    '  Answering only in chat, without writing REPORT_FILE, fails the run.',
    '- Describe only work you actually did. Anything not verified must be written as UNKNOWN or',
    '  NOT VERIFIED — never report unverified work as done.',
    '',
    'Do not create any other report file. Do not modify any other file under .ai-bridge/.',
  ].join('\n');
}

/** One part of the task in Codex's checklist (docs/66): `done` only when done and verified. */
export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface ChatReviewerInputParams extends ReviewerInputParams {
  /** The task as the user gave it after `/bridge`. */
  task: string;
  maxRounds: number;
  /** Codex's checklist from its previous review in this loop; null before the first. */
  checklist: readonly ChecklistItem[] | null;
}

const checklistLines = (items: readonly ChecklistItem[]) => items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`);

/**
 * docs/66: the report contract for the Claude Code plugin, where Claude is the session the
 * user is in. The report ends Claude's final message instead of going to REPORT_FILE: the
 * Stop hook hands that message to the reviewer. It opens with a summary the user reads in the
 * chat, ticked against Codex's checklist once Codex has made one.
 */
export function buildChatReportContract(checklist: readonly ChecklistItem[] | null = null): string {
  return [
    'AI_BRIDGE_REVIEW_LOOP',
    'The AI Bridge review loop is on for this session: each time you finish a turn, Codex',
    'reviews your final message and decides what you do next, until it says DONE.',
    '',
    'End every final message with these two parts, in this order.',
    '',
    '1. A summary for the user, in Vietnamese, starting with the line **Tóm tắt cho bạn**:',
    '   - Việc: the task in one plain sentence (rewrite it; do not paste the user\'s words)',
    '   - Tiến độ: X/Y phần xong, then one line per part: "✓ <part>" when done and verified,',
    '     "✗ <part> — <what is missing>" otherwise',
    '   - Vòng này đã làm: one to three short points',
    '   - Cần bạn: what the user must do or decide, or "Không có"',
    ...(checklist && checklist.length > 0
      ? ['   Codex\'s checklist (use exactly these parts, in this order; tick what is now done):', ...checklistLines(checklist).map((l) => `   ${l}`)]
      : ['   Until Codex sends its checklist, break the task into 3 to 7 parts yourself.']),
    '',
    '2. The report for the reviewer (each heading exactly once, in this order):',
    '',
    '## TASK',
    '## CHANGES',
    '## TESTS',
    '## ISSUES',
    '## NEXT_RECOMMENDATION',
    'NEXT_ACTION: CONTINUE, DONE, or NEED_HUMAN',
    '',
    'Rules:',
    '- Do not stop to ask questions: do the work. If a human decision is really needed, say',
    '  what under ## ISSUES (and under Cần bạn) and set NEXT_ACTION: NEED_HUMAN.',
    '- Describe only work you actually did. Anything not verified must be written as UNKNOWN or',
    '  NOT VERIFIED (✗ in the summary) — never report unverified work as done.',
  ].join('\n');
}

/**
 * docs/66: the reviewer input for the Claude Code plugin. Unlike `buildReviewerInput` (the
 * desktop's fixed M1 template, which session history parses back), Codex also gets the task as
 * the user gave it and writes its review for the user, in Vietnamese, with a checklist of the
 * task's parts that stays the same from round to round, so the chat can say how far it is.
 */
export function buildChatReviewerInput(params: ChatReviewerInputParams): string {
  const keep = params.checklist && params.checklist.length > 0 ? params.checklist : null;
  return [
    'You are the senior reviewer for this project.',
    '',
    'You are the Reviewer/Architect for AI Bridge, reviewing the work Claude Code does in the',
    "user's chat session. Your job is to determine what Claude should do next, and to tell the",
    'user plainly how far the task is.',
    '',
    'Rules:',
    '',
    '1. Review ONLY the information provided.',
    '2. Do not invent completed work.',
    '3. Do not modify the project yourself.',
    '4. Return exactly one AI_BRIDGE_RESPONSE block.',
    '5. Return exactly one STATUS.',
    '6. Return exactly one PROMPT.',
    '7. Preserve the PROMPT as an executable instruction for Claude Code.',
    '',
    'PROJECT:',
    params.projectName,
    '',
    'SESSION:',
    params.sessionId,
    '',
    'ITERATION:',
    String(params.iteration),
    '',
    'ROUND LIMIT:',
    String(params.maxRounds),
    '',
    'ORIGINAL TASK (as the user typed it):',
    '--- BEGIN TASK ---',
    params.task,
    '--- END TASK ---',
    '',
    ...(keep ? ['YOUR CHECKLIST FROM THE PREVIOUS ROUND:', ...checklistLines(keep), ''] : []),
    'CLAUDE REPORT:',
    '--------------------------------',
    '',
    '--- BEGIN REPORT ---',
    '',
    params.reportText,
    '',
    '--- END REPORT ---',
    '',
    '--------------------------------',
    '',
    'First write a short review for the user, in Vietnamese, in Markdown, OUTSIDE the response',
    'block and without any XML-style tags, with exactly these headings, in this order:',
    '',
    '## Việc',
    'One plain sentence: what the user asked for (rewrite the ORIGINAL TASK clearly; do not quote it).',
    '',
    '## Tiến độ',
    'The task as 3 to 7 concrete parts, one line each: "- [x] <part>" when the report shows it done',
    'and verified, "- [ ] <part>" otherwise. Unverified work is not done.',
    keep
      ? 'Keep the parts of that checklist, same wording, same order; add a part only if the task truly needs it.'
      : 'Make the list from the ORIGINAL TASK, not from the report, and keep it the same in later rounds.',
    '',
    '## Kết luận',
    'One sentence for the user: is the task finished and approved, and if not, what is missing.',
    '',
    '## Vấn đề',
    'The problems found, or "Không có".',
    '',
    '## Việc tiếp theo',
    'What Claude, or the user, should do next.',
    '',
    'Then return the response block using exactly this structure:',
    '',
    '<AI_BRIDGE_RESPONSE>',
    '',
    '<STATUS>',
    'CONTINUE',
    '</STATUS>',
    '',
    '<PROMPT>',
    'Exact instruction for Claude Code goes here.',
    '</PROMPT>',
    '',
    '</AI_BRIDGE_RESPONSE>',
    '',
    'Allowed STATUS values:',
    '',
    'CONTINUE',
    'DONE',
    'NEED_HUMAN',
    '',
    'Use DONE only when every part of ## Tiến độ is [x]. When a part needs the user (a decision,',
    'a manual check), use NEED_HUMAN and say what in the PROMPT.',
    '',
  ].join('\n');
}

/** The message sent to the Codex reviewer, per the M1 spec's fixed template. */
export function buildReviewerInput(params: ReviewerInputParams): string {
  return [
    'You are the senior reviewer for this project.',
    '',
    'You are the Reviewer/Architect for AI Bridge.',
    '',
    'Review the following Claude Code execution report.',
    '',
    'Your job is to determine what Claude should do next.',
    '',
    'Rules:',
    '',
    '1. Review ONLY the information provided.',
    '2. Do not invent completed work.',
    '3. Do not modify the project yourself.',
    '4. Return exactly one AI_BRIDGE_RESPONSE block.',
    '5. Return exactly one STATUS.',
    '6. Return exactly one PROMPT.',
    '7. Preserve the PROMPT as an executable instruction for Claude Code.',
    '',
    'PROJECT:',
    params.projectName,
    '',
    'SESSION:',
    params.sessionId,
    '',
    'ITERATION:',
    String(params.iteration),
    '',
    'CLAUDE REPORT:',
    '--------------------------------',
    '',
    '--- BEGIN REPORT ---',
    '',
    params.reportText,
    '',
    '--- END REPORT ---',
    '',
    '--------------------------------',
    '',
    'First write a short human-readable review in Markdown, OUTSIDE the response block and',
    'without any XML-style tags, using these headings: ## Summary, ## What Was Done Correctly,',
    '## Problems Found, ## Required Changes, ## Development Phase (only if clearly established),',
    '## Next Objective. Base it only on the report above.',
    '',
    'Then return the response block using exactly this structure:',
    '',
    '<AI_BRIDGE_RESPONSE>',
    '',
    '<STATUS>',
    'CONTINUE',
    '</STATUS>',
    '',
    '<PROMPT>',
    'Exact instruction for Claude Code goes here.',
    '</PROMPT>',
    '',
    '</AI_BRIDGE_RESPONSE>',
    '',
    'Allowed STATUS values:',
    '',
    'CONTINUE',
    'DONE',
    'NEED_HUMAN',
    '',
  ].join('\n');
}
