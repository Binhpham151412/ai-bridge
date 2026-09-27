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
