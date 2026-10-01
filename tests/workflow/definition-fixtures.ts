// Fresh, mutable M5 workflow-definition fixtures for the validator/hash tests. Every call
// returns a new object, so a test can mutate its copy freely.

export type Mutable = Record<string, any>;

export function step(id: string, extra: Mutable = {}): Mutable {
  return {
    id,
    title: `Step ${id}`,
    instruction: `Do the ${id} work.`,
    executor: { role: 'executor', maxIterations: 3 },
    verification: { checks: [], acceptAiOnly: true },
    retry: { maxAttempts: 1 },
    ...extra,
  };
}

/** The smallest definition the M5 validator accepts. */
export function minimalDefinition(): Mutable {
  return { schema: 1, id: 'minimal', version: 1, title: 'Minimal workflow', steps: [step('only')] };
}

/** A multi-step definition using every M5 feature: inputs, budgets, outputs, context
 * references to earlier steps, placeholders, `$comment`, explicit inert reserved fields. */
export function fullDefinition(): Mutable {
  return {
    $comment: 'Implements a feature, then documents it.',
    schema: 1,
    id: 'implement-and-document',
    version: 2,
    title: 'Implement and document',
    inputs: {
      $comment: 'Supplied by the user at start.',
      feature: { type: 'string', required: true, maxLength: 4000 },
      'extra-notes': { type: 'string', required: false, maxLength: 1000 },
    },
    budgets: { maxDurationMs: 14_400_000, maxTotalIterations: 40, maxExecutions: 6, maxReportedTokens: 2_000_000 },
    steps: [
      step('implement', {
        instruction: 'Implement the following feature:\n{{inputs.feature}}\nNotes: {{inputs.extra-notes}}',
        executor: { role: 'executor', maxIterations: 10, requires: [] },
        outputs: ['report.summary', 'report.filesChanged'],
        verification: { checks: [], acceptAiOnly: true, requireReviewer: false, acceptMaxIterationsOutcome: false },
        retry: { maxAttempts: 1, retryOn: [] },
        context: { fromSteps: [], memory: [] },
      }),
      step('document', {
        $comment: 'Uses the implementation summary.',
        instruction: 'Update the README for this change:\n{{steps.implement.outputs.report.summary}}',
        outputs: ['report.remainingWork'],
        context: { fromSteps: [{ step: 'implement', output: 'report.filesChanged', maxChars: 8000 }] },
      }),
      step('wrap-up', {
        instruction: 'Summarize what remains: {{steps.document.outputs.report.remainingWork}}',
        context: { fromSteps: [{ step: 'implement', output: 'report.summary', maxChars: 16384 }] },
      }),
    ],
  };
}
