/** One turn of the Claude ↔ Codex exchange, as the pane draws it. */
export type BridgeMessage = {
  /** `<round>-claude` or `<round>-codex`. */
  id: string
  who: 'claude' | 'codex'
  round: number
  /** Codex's verdict; absent on Claude's messages. */
  status?: 'CONTINUE' | 'DONE' | 'NEED_HUMAN'
  /** The whole message as Markdown (what Copy takes; the pane clips what it draws): Claude's final message, or Codex's review and what it said next. */
  text: string
  /** Codex's PROMPT alone, copied on its own; absent on Claude's messages. */
  prompt?: string
  /** One line drawn while the message is folded. */
  preview: string
}

/** How far the task is, from Codex's latest review that said it (`progress` in state.json). */
export type BridgeProgress = {
  /** The task in one sentence, as Codex wrote it. */
  title: string | null
  items: { text: string; done: boolean }[]
  /** Codex's conclusion: approved, or what is missing. */
  verdict: string | null
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
  progress: BridgeProgress | null
  messages: BridgeMessage[]
}

/** A task sent from the pane's field, until a loop newer than `afterLoop` shows up. */
export type PendingTask = {
  task: string
  /** The loop the pane showed when the task was sent (0: none). */
  afterLoop: number
  /** When `/bridge` ran (ms, the engine clock); null while it waits in the queue. */
  ranAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'ai-bridge-panel': {
      view: BridgeView | null
      /** `<loop>:<message id>` of each message the person unfolded. */
      expanded: string[]
      pending: PendingTask | null
      /** The engine clock at the last read while Codex reviews: the reviewing line counts up to it. */
      now: number
    }
  }
}
