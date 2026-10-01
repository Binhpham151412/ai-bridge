import type { EvidenceLevel, VerificationVerdict, WorkflowAttempt } from './types.ts';

/**
 * M5.5 — the M5 verification slot (docs/24 §3.5, ADR-020): OutcomeOnly. A step whose
 * execution CLAIMED done (Codex's DONE verdict, class CLAIM_DONE) passes with evidence level
 * AI_ATTESTED. That label is not the same as VERIFIED: nothing here runs a command, reads a
 * file, checks git or runs tests. Deterministic checks and the step-level Reviewer are M6.
 */

export interface VerificationOutcome {
  verdict: VerificationVerdict;
  evidenceLevel: EvidenceLevel;
  failureSummary: string | null;
}

/** The engine's verification boundary; M6 replaces the implementation, not the call site. */
export interface VerificationPort {
  verify(attempt: WorkflowAttempt): Promise<VerificationOutcome>;
}

export function verifyOutcomeOnly(attempt: WorkflowAttempt): VerificationOutcome {
  if (attempt.lastOutcome?.class === 'CLAIM_DONE') return { verdict: 'PASS', evidenceLevel: 'AI_ATTESTED', failureSummary: null };
  return { verdict: 'FAIL', evidenceLevel: 'NONE', failureSummary: `the execution did not claim DONE (${attempt.lastOutcome?.finalStatus ?? 'no outcome'})` };
}

export const outcomeOnlyVerifier: VerificationPort = {
  verify: async (attempt) => verifyOutcomeOnly(attempt),
};
