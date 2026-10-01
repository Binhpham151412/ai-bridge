# 54 — M9 Agent Contracts: Identity, Correlation, Communication, Adapters (PROPOSED — documentation only)

Covers item 7 (contracts) of the M9 definition (docs/53 §0). All types are documentation
examples. Status legend: see docs/41.

## 1. Identities (ADR-042)

```ts
interface AgentIdentity {
  agentRef: string;          // "agent:executor-frontend@1.2.0#<contentHash>" (M7); BUILTIN agents too
  role: 'executor' | 'reviewer';
  profileRef: string;        // the execution profile id@version#flagsSha256 (M7, ADR-034)
}
interface ProviderIdentity {
  providerRef: string;       // "provider:claude-code@2.1.161" — the version from doctor/status (EXISTING field)
  model: string | 'UNKNOWN'; // as REPORTED by the CLI for this call; never inferred from a flag or a plan
  modelEvidence: 'CONFIRMED_BY_CLI' | 'REQUESTED_NOT_CONFIRMED' | 'UNKNOWN';   // the EXISTING evidence vocabulary (M4.1)
}
```

Execution record v2 (additive; v1 still readable): `agent` becomes
`{ providerRef, agentRef | null, model, modelEvidence }`. A v1 record maps to `providerRef:
provider:claude-code@UNKNOWN`, `model: UNKNOWN`.

## 2. Correlation and causation (extends docs/27 §3.2 and ADR-017)

| Id | Format | Minted by | Carried on |
|---|---|---|---|
| `correlationId` | = `workflowId` (EXISTING) | WorkflowEngine | every workflow event |
| `causationId` | the `eventId` of the causing event (EXISTING) | WorkflowEngine | every workflow event |
| `groupId` | `<workflowId>/<groupStepId>` | WorkflowEngine | group/branch events |
| `branchId` | `<groupId>/<branchName>` | WorkflowEngine | branch events, attempts in the branch |
| `attemptId` | `<workflowId>/<stepId>/<n>` (EXISTING; step ids are unique across branches) | WorkflowEngine | attempt records; **the run's `correlation`** (ADR-017, unchanged) |
| `executionId` | runId (EXISTING), unique **per worktree** | BridgeEngine of that worktree | attempt records; paired with `worktreePath` because runIds may repeat across worktrees |
| `executionKey` | `<worktreeId>:<runId>` | WorkflowEngine | everywhere the supervisor refers to an execution across worktrees |
| `reviewCorrelation` | `<attemptId>/review/<runNo>[/<reviewerIndex>]` (M6 + multi-reviewer) | VerificationEngine | review runs |
| `worktreeId` | `<workflowId>/<branchName>` (+ `/merge` for the scratch worktree) | WorktreeManager | the worktree registry, events |

Because each worktree has its own `.ai-bridge/` and run-id allocator, a `runId` alone is **not**
unique inside an M9 workflow. Records use `executionKey`. This is the main identity change M9
needs.

## 3. Communication through artifacts only

Agents never exchange messages. The supervisor moves **artifact references** between steps:

```ts
interface ArtifactEnvelope {
  schema: 1;
  artifactId: string;                         // "<attemptId>/<kind>"
  kind: 'report' | 'output' | 'diff' | 'verification' | 'review';
  producer: { attemptId: string; branchId: string | null; agent: AgentIdentity; provider: ProviderIdentity };
  location: { worktreeId: string; path: string };   // inside that worktree's .ai-bridge/ or the attempt directory
  sha256: string; bytes: number;
  trust: 'AI_GENERATED' | 'AI_BRIDGE_EVIDENCE';     // how the consumer must label it
}
```

- The downstream step-planner inserts the referenced content as **labelled data blocks** with the
  producer identity (the EXISTING `{{steps.<id>.outputs.<name>}}` mechanism, extended with the
  branch). `AI_GENERATED` content is always framed as untrusted.
- A `diff` artifact is produced by AI Bridge (`git diff` in the branch worktree against the
  base commit), so it is `AI_BRIDGE_EVIDENCE` of *what changed*, not of *whether it is correct*.
- Cross-worktree reads happen only by the supervisor, from recorded paths, with the sha256
  checked on read.

## 4. Execution adapter interfaces (ADR-041; docs/30 §4.3 made concrete)

```ts
interface ExecutorAdapter {
  readonly capabilities: ProviderExecutionCapabilities;          // docs/30 §4.1, static per version range
  readonly identity: (status: ProviderStatus) => ProviderIdentity;
  run(o: { cwd: string; prompt: string; session: { id: string | null; resume: boolean };
           systemContract?: string; timeoutMs: number; profile: ExecutionProfileRef;
           onSpawn?: (pid: number) => void; onInputFlushed?: (bytes: number) => void }): Promise<ExecutorRunResult>;
}
interface ReviewerAdapter {
  readonly capabilities: ProviderExecutionCapabilities;
  readonly identity: (status: ProviderStatus) => ProviderIdentity;
  review(o: { cwd: string; input: string; thread: { id: string | null; resume: boolean };
              timeoutMs: number; profile: ExecutionProfileRef; onSpawn?: (pid: number) => void }): Promise<ReviewerRunResult>;
}
// ExecutorRunResult / ReviewerRunResult carry exactly what finalizeExecutionRecord needs today
// (ProcessOutcome, session/thread id evidence, usage) — so the EXISTING evidence model is kept.
```

Rules: the Orchestrator depends on the interfaces only; the two EXISTING adapters implement
them **without behavior change**; a provider missing a capability (e.g. resume) cannot be
resolved for steps that require it (M7 tags); there is no branching on provider names inside the
Orchestrator (docs/30 §6).

## 5. Per-branch ports

```ts
interface BranchPorts {                       // one per worktree; created by the supervisor
  worktreeId: string; projectPath: string;    // the worktree path
  execution: ExecutionPort;                   // EXISTING contract and ForkedExecutionPort impl, unchanged
  review: ReviewPort;                         // M6 contract
}
```

`EXECUTION_PORT_BUSY` still applies per port: one execution per worktree at a time. Concurrency
comes only from several ports.

## 6. Delegation proposals (bounded)

```ts
interface DelegationSlot {                    // declared in a schema-2 definition, validated before the run
  slotId: string; maxSteps: number /* ≤ 3 */; allowedAgents: string[]; maxIterationsPerStep: number;
  requiresHumanApproval: boolean;             // default true
}
interface DelegationProposal {                // extracted by AI Bridge from a report section, never executed directly
  fromAttemptId: string; slotId: string;
  steps: { title: string; instruction: string /* ≤ 4 KB */ }[];
}
```

A proposal becomes steps only if a slot exists, the counts and agents are within the slot, the
workflow budgets have room, and (by default) a human approves. Delegated steps cannot delegate
(depth ≤ 1). They count against every workflow budget.

## 7. Cross-agent verification (ADR-045)

```ts
interface CrossReviewPolicy {
  reviewers: { agent: string /* agent ref pin or requirement */ }[];   // 1..3
  rule: 'ALL_APPROVE';                          // a minority veto: any REJECT → FAIL, any NEEDS_HUMAN/INVALID → NEEDS_HUMAN
  distinctProviderFromExecutor: true;           // hard rule; unresolvable → NEEDS_HUMAN (OQ-M6-06 stays "no fallback")
}
```

Reviews remain evidence, not authority (ADR-015). A unanimous APPROVE still cannot raise the
evidence level above what the deterministic checks support (ADR-024).

## 8. Why each contract exists

| Contract | Reason |
|---|---|
| Identities | Records must say which agent, provider and model produced a result; "UNKNOWN" rather than a guess |
| `executionKey` | runIds are per worktree; without it recovery could confuse executions |
| ArtifactEnvelope | Communication must be auditable and hash-checked, not conversational |
| Adapter interfaces | The only way to add providers without branching inside the Orchestrator |
| BranchPorts | Reuse the proven single-execution port unchanged; concurrency = multiple ports |
| Delegation slot | Bounded, validated growth instead of agent-driven planning |
| CrossReviewPolicy | Makes the cross-model mitigation explicit and enforceable |
