---
name: bridge
description: Start the AI Bridge review loop for a task (Codex reviews each turn and sends the next instruction until DONE). `/bridge --vong 3 <task>` caps it at 3 rounds; while Codex waits on you, `/bridge <answer>` carries the same loop on; `/bridge stop` ends it.
argument-hint: [--vong N] <task> | <answer to Codex> | stop
disable-model-invocation: true
---

Work on the text below. The AI Bridge review loop is on for this session: when you finish,
Codex reviews your final message and may send the next instruction. The text is a new task,
or, when the loop was waiting on the user, their answer to Codex's question (the AI Bridge
context says which). A leading `--vong N` only sets the number of review rounds.

Task: $ARGUMENTS
