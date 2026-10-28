---
name: bridge
description: Start the AI Bridge review loop for a task (Codex reviews each turn and sends the next instruction until DONE). `/bridge --vong 3 <task>` caps it at 3 rounds; while Codex waits on the user, `/bridge <answer>` carries the same loop on; `/bridge stop` ends it. Use when the user's message starts with /bridge.
---

The user's message starts with `/bridge`. The text after it is a new task or, when the AI Bridge
review loop was waiting on the user, their answer to Codex's question; a leading `--vong N` only
sets the number of review rounds. AI Bridge adds its instructions to the conversation itself (a
system message with the report format, and Codex's instructions after each review): follow them.
Do the work now, and end every final message in the format they describe.
