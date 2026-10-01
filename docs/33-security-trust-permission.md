# 33 — Security, Trust and Permission (PROPOSED, extending EXISTING docs/07)

## 1. Purpose

Define the security boundaries for providers, CLI execution, tools, MCP, skills, agents
and external (e.g. GitHub-hosted) capabilities, using the lifecycle
**INSPECT → EVALUATE → CLASSIFY → ADAPT → REGISTER**, and define the permission and trust
concepts that M5–M9 must respect.

## 2. Current State (EXISTING controls — keep all of them)

| Control | Where |
|---|---|
| No API-key billing: env guard + auth-mode check, enforced in doctor **and** Orchestrator | cost-guard.ts, orchestrator.ts |
| Claude permission mode allowlist; `bypassPermissions` refused | permission-mode.ts |
| Codex always read-only sandbox | codex adapter |
| No shell spawning; argv arrays only | process-runner.ts |
| Output caps, timeouts, process-tree kill | process-runner.ts |
| Redaction of CLI output, errors, events, IPC errors | redact.ts, desktop/main/redaction.ts |
| No caller-supplied paths: `RUN_ID_PATTERN`, fixed artifact/journal names | session-history.ts, journal.ts |
| Untrusted content boundary for reports/responses; strict parsers; integrity hashes | templates.ts, parsers, integrity.ts |
| Electron: sandbox, contextIsolation, no nodeIntegration, CSP `default-src 'none'`, deny permissions/navigation/popups, sender check, channel allowlist, payload validation, frozen preload | desktop/main, preload |
| Run lock; stop only targets the lock-file pid | run-lock.ts, process-manager.ts |
| Login commands are described, never executed | providers |

**Known uncontrolled surface (EXISTING fact):** Claude Code runs with the user's global
configuration (settings, MCP servers, hooks, skills) and `acceptEdits` in the project
directory. Its Bash tool is not sandboxed on native Windows (per Claude Code docs, via the
external research). AI Bridge currently relies on Claude Code's own permission prompts,
and those cannot be answered in headless mode.

## 3. Threat model (local-first)

In scope: prompt injection via reports, responses, memory or third-party content; a
malicious or over-privileged workflow definition or capability; accidental destructive
commands; secret leakage into logs or the UI; runaway cost; tampering with or corruption
of audit files by accident. Out of scope: a malicious local administrator, OS compromise,
network attackers (AI Bridge makes no network calls of its own).

## 4. Permission concepts (PROPOSED)

```ts
type Permission =
  | { kind: 'fs.read'; scope: 'project' }
  | { kind: 'fs.write'; scope: 'project'; exclude?: string[] }        // e.g. ['.ai-bridge/**', '.git/**']
  | { kind: 'process.exec'; commands: { executable: string; argsPattern?: string[] }[] }  // verification checks
  | { kind: 'provider.invoke'; provider: string; role: 'executor' | 'reviewer'; profile: string }
  | { kind: 'network'; hosts: string[] }                               // never granted to USER_LOCAL/THIRD_PARTY by default
  | { kind: 'memory.read'; keys: string[] } | { kind: 'memory.propose' };
```

- **Effective permission** = declared ∩ tier maximum ∩ user approval.
- **Permission profiles** per agent role (ADOPT from Claude/Codex):
  - `executor-default`: Claude `acceptEdits`, `fs.write` in the project, excluding `.ai-bridge/**`
  - `reviewer-readonly`: Codex `read-only`
  - `verifier`: `process.exec` of approved commands only

  The effective profile is recorded in every attempt record.

## 5. Lifecycle applied to each surface

| Surface | INSPECT | EVALUATE | CLASSIFY | ADAPT | REGISTER |
|---|---|---|---|---|---|
| Provider CLI | discovery + `--version` + auth status (EXISTING, no quota) | version range; auth mode must be account login (EXISTING rule) | FIRST_PARTY (official CLIs only) | diagnostics adapter (EXISTING) + execution adapter | registered when doctor passes |
| CLI execution flags | the adapter code review (static) | forbidden flags list: `bypassPermissions`, `--dangerously-skip-permissions`, `--bare`, API-key env | builtin | fixed argv in adapters | n/a |
| Verification commands | shown verbatim from the definition | executable resolves; not a shell interpreter (default); timeout present | inherits the definition's tier | `process.exec` permission entries | approved + pinned to `definitionHash` |
| Tools (inside the provider) | declared names | the allow/deny lists vs the profile | per agent profile | `--allowedTools/--disallowedTools` (EXISTING adapter support, unused today) | with the agent |
| MCP servers | the config file content (command, args, env keys; never values) | network or filesystem reach; a command that is a shell | THIRD_PARTY unless built in | a declaration used to allow or deny loading (mechanism OPEN QUESTION) | disabled by default |
| Skills | text content | scanned for instruction patterns that conflict with the profile (informational only; skills cannot grant permissions) | per source | injected as labelled context | pinned by hash |
| Agents | the configuration | the profile ⊆ tier max | per source | provider + profile + prompt ids | pinned |
| External GitHub capabilities | the repo is **cloned or downloaded by the user**, never by AI Bridge; inspected as files | full diff review of commands/permissions; no execution during evaluation | THIRD_PARTY | as above | disabled until explicit enablement; re-inspected on any hash change |

## 6. Trust rules (PROPOSED)

1. Trust is assigned by AI Bridge from the **source**, never self-declared by a manifest.
2. Content from a lower tier is always presented to models as **data** inside labelled
   blocks (the EXISTING report pattern), never as system instructions.
3. A hash change always drops trust to UNTRUSTED until re-approved.
4. Nothing is auto-downloaded, auto-installed or auto-updated.
5. Blocking policies fail closed (a missing approval → BLOCKED, never "allow once").
6. Human approvals are events in the audit stream (who, when, which hash).

## 7. Workflow-specific controls (M5/M6)

- Definitions are validated before use. Unknown fields are rejected (the `config.ts` style).
- The step `maxIterations` stays within 1..100 (the EXISTING cap).
- Task text is composed by AI Bridge. User inputs are inserted as labelled blocks.
- The workspace digest before and after reviewer and verification phases detects
  unexpected writes (docs/24, docs/25).
- `.ai-bridge/workflows/**` is excluded from executor writes by the report-contract rule
  (EXISTING wording "Do not modify any other file under .ai-bridge/"). Enforcement beyond
  that instruction depends on tool deny lists (M7) and is recorded as a limitation.
- IPC: new channels follow the EXISTING pattern (allowlist, validation, sender check). The
  renderer can never submit command strings for verification; it can only start
  definitions that are already approved by id + hash.

## 8. Responsibilities / Boundaries

The Security policy module (PROPOSED, pure) owns tier maxima and permission
intersections. Registries record approvals. The adapters and process-runner enforce at
execution time. The UI shows approval prompts but never decides.

## 9. Data Flow

`source → INSPECT (read-only) → EVALUATE (checks + human diff approval) → CLASSIFY (tier)
→ ADAPT (flags/profiles) → REGISTER (hash-pinned) → per-attempt effective permissions
recorded`.

## 10. Failure Cases

| Case | Handling |
|---|---|
| A definition requests `bypassPermissions` | Rejected at validation (the EXISTING allowlist is reused) |
| A check command is `powershell -c …` | Rejected by default (OPEN QUESTION: trusted override) |
| A reviewer run modifies files | Discarded, NEEDS_HUMAN |
| A secret in a verification output | Redacted before persistence (reuse `redactSecrets`) |
| A report contains "ignore previous instructions" | Data framing plus strict parsers; deterministic checks gate DONE |

## 11. Decisions

ADR-004, ADR-005, ADR-007, ADR-010; a proposed ADR for trust tiers.

## 12. Open Questions

Isolating Claude from the user's global MCP servers and hooks during workflows (the flag's
existence is UNCERTAIN); allowing shell interpreters as check commands; enforcing
`.ai-bridge/**` write exclusion technically (deny list) rather than by instruction.

## 13. Explicitly Out of Scope

OS-level sandboxing implementation, code signing of capabilities, multi-user access control.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Relying on CLI sandboxes on native Windows | Treat them as advisory; digest checks; least-privilege profiles |
| Approval fatigue | Diff-only approvals; approvals pinned by hash, so they are not re-asked without a change |
| The executor's global config adding tools silently | Documented; M7 open question on isolation |
