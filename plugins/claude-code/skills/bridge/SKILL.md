---
name: bridge
description: Start the AI Bridge review loop for a task (Codex reviews each turn and sends the next instruction until DONE). `/bridge stop` ends it.
argument-hint: <task> | stop
disable-model-invocation: true
---

Work on the task below. The AI Bridge review loop is on for this session: when you finish,
Codex reviews your final message and may send the next instruction.

Task: $ARGUMENTS
