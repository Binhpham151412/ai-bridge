/** One turn of the Claude ↔ Codex exchange, as the pane draws it. */
export type BridgeMessage = {
  /** `<round>-claude` or `<round>-codex`. */
  id: string
  who: 'claude' | 'codex'
  round: number
  /** Codex's verdict; absent on Claude's messages. */
  status?: 'CONTINUE' | 'DONE' | 'NEED_HUMAN'
  /** The whole message as Markdown: Claude's final message, or Codex's review and what it said next. */
  text: string
  /** One line drawn while the message is folded. */
  preview: string
}

/** What the pane draws: the loop state the ai-bridge plugin's hooks write (docs/66) and the exchange so far. */
export type BridgeView = {
  /** The N-th `/bridge` of the session: an expanded message is remembered per loop. */
  loop: number
  task: string
  status: 'RUNNING' | 'DONE' | 'NEED_HUMAN' | 'ERROR' | 'STOPPED'
  round: number
  maxRounds: number
  reviewingSince: string | null
  error: string | null
  messages: BridgeMessage[]
}

declare module 'claude-code' {
  interface PluginState {
    'ai-bridge-panel': {
      view: BridgeView | null
      /** `<loop>:<message id>` of each message the person unfolded. */
      expanded: string[]
    }
  }
}
