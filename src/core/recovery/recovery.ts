export interface RecoverableState {
  status: string;
  iteration: number;
  claudeSessionId: string | null;
  codexThreadId: string | null;
}

export interface ResumeState {
  startIteration: number;
  claudeSessionId: string | null;
  codexThreadId: string | null;
  skipClaudeThisIteration: boolean;
}

export type RecoveryStrategy =
  | { kind: 'CONTINUE_FROM_PROMPT'; readPromptForIteration: number; resumeState: ResumeState }
  | { kind: 'RESEND_REPORT_TO_CODEX'; iteration: number; resumeState: ResumeState }
  | { kind: 'BLOCKED'; reason: string };

/**
 * Decides how (or whether) an interrupted session can be resumed, from its last
 * persisted phase alone — the two checkpoints the M3 spec explicitly names as safe
 * (§14-15), never anything ambiguous. Pure and side-effect free: the caller (currently
 * `cli.ts`'s `cmdResume`) is responsible for actually reading the named files and
 * invoking `Orchestrator` with the returned `resumeState`. Extracted out of the CLI
 * handler per M3 §8 ("Đưa recovery logic ra khỏi CLI command handler").
 */
export function decideRecoveryStrategy(state: RecoverableState): RecoveryStrategy {
  const { status, iteration, claudeSessionId, codexThreadId } = state;

  if (status === 'RESPONSE_PARSED' || (status === 'PAUSED' && iteration >= 1)) {
    return {
      kind: 'CONTINUE_FROM_PROMPT',
      readPromptForIteration: iteration,
      resumeState: { startIteration: iteration + 1, claudeSessionId, codexThreadId, skipClaudeThisIteration: false },
    };
  }

  if (status === 'PAUSED' && iteration === 0) {
    return { kind: 'BLOCKED', reason: 'Paused before any iteration started — the original task text was never persisted, so there is nothing safe to resume automatically.' };
  }

  if (status === 'REPORT_VALIDATED' || status === 'CODEX_REVIEWING') {
    return {
      kind: 'RESEND_REPORT_TO_CODEX',
      iteration,
      resumeState: { startIteration: iteration, claudeSessionId, codexThreadId, skipClaudeThisIteration: true },
    };
  }

  return {
    kind: 'BLOCKED',
    reason: `Session last known phase was "${status}", which is not a safely resumable checkpoint — resuming blindly could duplicate work or lose context.`,
  };
}
