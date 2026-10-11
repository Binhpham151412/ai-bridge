# 62 — Claude model selection

Status: implemented and tested with fake CLIs only (2026-10-02). No real Claude/Codex call was made.

## Why

AI Bridge never passed `--model`, so every Claude call used whatever the **Claude Code CLI's own
settings** said (`~/.claude/settings.json` → `"model": "sonnet"` on the development machine). In the
first real M5.10 run that alias resolved to `claude-sonnet-4-6`, because the installed standalone CLI
is **2.1.161**, whose alias table (its `--help` still gives `claude-opus-4-8` as the example) predates
newer models such as Opus 5.5. The model picked in the Claude desktop app's chat, or for a single
Claude Code session, does not reach the CLI that AI Bridge spawns.

## Setting

`.ai-bridge/config.json` (per project, edited in Settings → Run configuration → **Claude model**):

```json
{ "models": { "claude": "claude-opus-5-5" } }
```

- `null` / absent (default) → no `--model` flag; the Claude CLI's own setting decides (unchanged
  behaviour for existing projects).
- A full model id (`claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1`,
  `claude-haiku-4-5-20251001`) is sent as-is: `claude ... --model <id>`. An alias (`opus`, `sonnet`)
  is resolved by the installed CLI, so an older CLI may still map it to an older model.
- Names are validated by Core (`isValidModelName`): letters/digits first (never a flag), no spaces,
  `. _ : [ ] -` allowed, at most 100 characters. Unknown providers are refused — only Claude is
  configurable (Codex keeps `~/.codex/config.toml`; it supports `-m` on `exec` and `exec resume`,
  so it could be added the same way).
- `--model` is sent on every Claude call of a run, including `--resume` iterations.

Whether the signed-in account can actually use a model is only known when a call runs; the CLI
rejects an unavailable model and the execution record/diagnostics show that error.

## Audit

Each `<NNN>-claude-execution.json` records

```json
"model": { "requested": "claude-opus-5-5", "reported": "claude-opus-5-5" }
```

- `requested` — the `--model` value, or `null` for "the CLI's own setting";
- `reported` — what the CLI itself said it used (stream-json `system/init` `model`, else the first
  real assistant message's `message.model`, never the `<synthetic>` placeholder); `null` = not
  reported. Never inferred from the request.

Also shown in the journal (`NNN-claude-report.md`: `- Model: …`), the execution panel ("Model"
row), the Start Run dialog, and `RUN_STARTED` (`models: { claude }`).

## To use newer models through aliases

Update the standalone CLI (e.g. `claude update`, run by the user) so its alias table knows the
newer models — or pick a full model id here, which does not depend on the alias table.
