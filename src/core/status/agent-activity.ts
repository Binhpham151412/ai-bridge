export type ClaudeActivity = 'IDLE' | 'WAITING' | 'EXECUTING';
export type CodexActivity = 'IDLE' | 'WAITING' | 'REVIEWING';

export interface AgentActivity {
  claude: ClaudeActivity;
  codex: CodexActivity;
}

/**
 * What Claude and Codex are each doing right now, derived only from the session's
 * display status (`BridgeStatus.status`) and the orchestrator's exact persisted phase
 * (`BridgeStatus.currentPhase`). Lives in Core so every caller (CLI, Electron) shows the
 * same answer instead of each UI inventing its own mapping. Anything other than a live
 * RUNNING session means neither agent is doing anything.
 */
export function describeAgentActivity(displayStatus: string, currentPhase: string | null): AgentActivity {
  if (displayStatus !== 'RUNNING') return { claude: 'IDLE', codex: 'IDLE' };
  if (currentPhase === 'CLAUDE_EXECUTING') return { claude: 'EXECUTING', codex: 'WAITING' };
  if (currentPhase === 'CODEX_REVIEWING') return { claude: 'WAITING', codex: 'REVIEWING' };
  return { claude: 'WAITING', codex: 'WAITING' };
}
