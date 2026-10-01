# 29 — Agent / Skill / Tool / MCP / Provider / Workflow: Conceptual Model (PROPOSED)

## 1. Purpose

Give each concept exactly one meaning and one responsibility in AI Bridge, so that later
milestones (M7–M9) don't produce overlapping abstractions.

## 2. Current State (EXISTING)

| Concept | Exists in AI Bridge today? |
|---|---|
| Provider | Yes, as an **AI CLI** with roles executor/reviewer (`core/providers`, diagnostics), plus the concrete adapters used by execution |
| Agent | Implicitly: "Claude the executor" and "Codex the reviewer" are fixed roles inside the Orchestrator |
| Workflow | No (M5) |
| Prompt | Yes, as code templates (`templates.ts`) |
| Skill / Tool / MCP | Not in AI Bridge. Claude Code may use the user's own skills, tools and MCP servers internally; AI Bridge neither sees nor controls them |

## 3. Proposed Definitions

| Concept | Definition | Has its own process? | Who invokes it | Example |
|---|---|---|---|---|
| **Provider** | An external AI runtime that AI Bridge can drive through an adapter, with authentication and quota of its own. | yes (a CLI process) | an adapter, only from the execution layer | Claude Code CLI, Codex CLI |
| **Agent** | A **role configuration** of a provider for a purpose: provider + role + prompt contract + permission profile + limits. An agent is data, not code. | no (it runs as its provider) | the Workflow Engine, by selecting it for a step | "executor-acceptEdits" = Claude Code + report contract + `acceptEdits`; "reviewer-readonly" = Codex + reviewer template + `read-only` |
| **Skill** | Reusable **instructions / know-how** that an agent can be given (text plus optional reference files). It is never executable by AI Bridge. | no | injected into an agent's prompt by the step-planner (FUTURE), or used natively by Claude Code | "how to run this repo's tests", a code-style guide |
| **Tool** | A single **callable operation** with typed inputs and outputs and side effects, invoked *by an agent* inside its provider runtime. | depends on the provider | the provider (e.g. Claude Code's Edit/Bash tools), under AI Bridge's permission profile flags | Edit, Read, Bash(pnpm test) |
| **MCP server** | A **transport and packaging** of tools, resources and prompts, speaking the Model Context Protocol, attached to a provider runtime. | yes | the provider runtime, never AI Bridge directly | a GitHub MCP server configured in Claude Code |
| **Workflow** | An ordered, bounded composition of **steps**; each step binds an agent (executor), a verification policy and a retry policy. | no (it runs in the workflow host) | a user / host | "implement → test → review" |
| **Prompt** | A versioned **template** with declared variables that produces the text given to an agent. | no | the step-planner or BridgeEngine templates | report contract, reviewer input |

## 4. How they interact

```
Workflow ──step──► Agent (role config) ──runs on──► Provider (CLI) ──may call──► Tools
   │                  │ uses                               └──may load──► MCP servers (tools/resources)
   │                  └── Prompt templates + Skills (as text)
   └── Verification (deterministic checks run by AI Bridge, not tools of an agent)
```

Rules that prevent overlap:
1. **Only Providers are processes that AI Bridge spawns for AI work**, and only via the
   execution layer's adapters.
2. **Agents are not processes.** Two agents on one provider are two configurations, not
   two runtimes.
3. **Tools are invoked by providers, never by the Workflow Engine.** When AI Bridge itself
   runs a command, that is a *verification check*, not a tool.
4. **MCP is packaging, not a new actor.** An MCP server's tools are just tools. AI Bridge
   registers MCP servers only as declarations that restrict or enable what a provider may
   load (M7, OPEN QUESTION on the mechanism).
5. **Skills are text.** They do not get permissions of their own. They inherit the agent's
   profile, so a skill can't escalate privileges.
6. **Workflows compose agents; agents never compose workflows.** An agent may *propose*
   a follow-up (e.g. in NEXT_RECOMMENDATION); only a human or the definition turns a
   proposal into a step (M9 delegation, docs/32).
7. **Prompts belong to the layer that uses them:** execution prompts (report contract,
   reviewer template) stay in `templates.ts` (EXISTING); workflow prompts (step
   instruction framing, retry sections) belong to the step-planner.

## 5. Responsibilities / Boundaries

| Concept | Owner module | Registry kind (docs/28) |
|---|---|---|
| Provider | `core/providers` (diagnostics) + adapters (execution) | `provider` |
| Agent | workflow definition + capability registry (M7) | `agent` |
| Skill | capability registry (M7); delivery via prompt | `skill` |
| Tool | provider runtime; AI Bridge only declares allow/deny | `tool` |
| MCP | provider runtime; AI Bridge only declares | `mcp` |
| Workflow | Workflow Engine | `workflow` |
| Prompt | templates / step-planner | `prompt` |

## 6. Data Flow

Definition → (M7) resolve the agent → provider + profile + prompt ids → BridgeEngine run
(today the agent is fixed) → provider tools act on the workspace → report → verification.

## 7. Failure Cases

- A skill text that contradicts the permission profile ("use --dangerously-…"): it has no
  effect, because the profile is enforced by flags (EXISTING `assertSafePermissionMode`
  refuses `bypassPermissions`).
- An MCP server unavailable in the provider: the provider's problem, surfaced in the
  execution's CLI output; not an AI Bridge state.

## 8. Decisions

ADR-005, a proposed ADR-016 (agents are configurations, not processes).

## 9. Open Questions

- Whether AI Bridge should ever pass `--allowedTools`/`--disallowedTools` per agent (the
  adapter supports it; nothing passes it today). This is recommended for M7 profiles.
- How to express "no user-global MCP servers during workflow runs" (docs/28 §9).

## 10. Explicitly Out of Scope

Implementing any of these registries; AI Bridge acting as an MCP client or server.

## 11. Risks

- Term drift in future docs. This document is the glossary; later documents must use it.
- Users expecting AI Bridge to manage Claude Code skills and MCP config: that is explicitly
  not the case until M7 decides.
