// The "AI Bridge" pane beside the chat (docs/66). It only reads what the ai-bridge plugin's
// hooks write under ~/.ai-bridge/claude-code/<session id>/ and never changes the loop.
// The exchange is drawn as a conversation: per round Claude's final message, then Codex's
// review; each folded to one line until the person opens it (drawn as Markdown).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BridgeMessage, BridgeView } from '../types'

const PANE = 'ai-bridge'
const TITLE = 'AI Bridge'
const POLL_MS = 2_000
const PREVIEW_CHARS = 160
/** A drawing holds 100 000 characters in all; one opened message never takes more than this. */
const MESSAGE_CHARS = 20_000

const view = atom({ plugin: 'ai-bridge-panel', key: 'view' } as const, null)
const expanded = atom({ plugin: 'ai-bridge-panel', key: 'expanded' } as const, [])

const STATUS_LABEL: Record<BridgeView['status'], string> = {
  RUNNING: 'Đang chạy',
  DONE: 'Xong (Codex: DONE)',
  NEED_HUMAN: 'Cần bạn quyết định',
  ERROR: 'Dừng vì lỗi',
  STOPPED: 'Đã dừng (/bridge stop)',
}

const isBridgeCommand = (name: string | undefined) => name === 'bridge' || name === 'ai-bridge:bridge'

async function stateRoot($: EngineInterface): Promise<string> {
  const own = await $.env.get('AI_BRIDGE_CLAUDE_CODE_DIR')
  if (own) return own
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.ai-bridge/claude-code`
}

const readOrNull = ($: EngineInterface, path: string) => $.fs.read(path).then(t => (typeof t === 'string' ? t : null), () => null)

/** Files of finished rounds never change again; the module's own cache starts over on a reload. */
const finished = new Map<string, string>()
async function readRound($: EngineInterface, path: string, isFinished: boolean): Promise<string | null> {
  const cached = finished.get(path)
  if (cached !== undefined) return cached
  const text = await readOrNull($, path)
  if (text !== null && isFinished) finished.set(path, text)
  return text
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** The first line of prose: headings, fences and rules skipped, list and emphasis marks dropped. */
function previewOf(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('```') || /^[-*_]{3,}$/.test(line)) continue
    return clip(line.replace(/^([-*+]|\d+\.)\s+/, '').replace(/\*\*|__|`/g, ''), PREVIEW_CHARS)
  }
  return ''
}

const STATUSES = ['CONTINUE', 'DONE', 'NEED_HUMAN'] as const

/** Codex's response file: its review (before the block), STATUS and PROMPT. Display only: the hook already parsed it strictly. */
function codexMessage(round: number, raw: string): BridgeMessage {
  const review = (raw.split('<AI_BRIDGE_RESPONSE>')[0] ?? '').trim()
  const found = /<STATUS>\s*([A-Z_]+)\s*<\/STATUS>/.exec(raw)?.[1]
  const status = STATUSES.find(s => s === found)
  const prompt = (/<PROMPT>([\s\S]*?)<\/PROMPT>/.exec(raw)?.[1] ?? '').trim()
  const said = prompt === '' ? '' : `\n\n---\n\n**${status === 'CONTINUE' ? 'Prompt gửi Claude (vòng tiếp theo)' : 'Codex nhắn'}:**\n\n${prompt}`
  const text = clip(`${review}${said}`.trim(), MESSAGE_CHARS)
  return { id: `${round}-codex`, who: 'codex', round, ...(status ? { status } : {}), text, preview: previewOf(review) || previewOf(prompt) }
}

async function load($: EngineInterface): Promise<BridgeView | null> {
  const dir = `${await stateRoot($)}/${await $.session.id()}`
  const raw = await readOrNull($, `${dir}/state.json`)
  if (raw === null) return null
  let s
  try {
    s = JSON.parse(raw)
  } catch {
    return null
  }
  const messages: BridgeMessage[] = []
  // round+1: Claude's message Codex is reviewing now (or that a failed review left).
  for (let round = 1; round <= s.round + 1; round++) {
    const base = `${dir}/loop-${s.loop}/${String(round).padStart(3, '0')}`
    const isFinished = round <= s.round
    const report = await readRound($, `${base}-report.md`, isFinished)
    if (report === null) break
    messages.push({ id: `${round}-claude`, who: 'claude', round, text: clip(report, MESSAGE_CHARS), preview: previewOf(report) })
    const review = await readRound($, `${base}-codex-review.md`, isFinished)
    if (review !== null) messages.push(codexMessage(round, review))
  }
  return {
    loop: s.loop,
    task: s.task,
    status: s.status,
    round: s.round,
    maxRounds: s.maxRounds,
    reviewingSince: s.reviewingSince ?? null,
    error: s.error ?? null,
    messages,
  }
}

let poll: { cancel: () => void } | undefined

/** Reads the loop again; keeps polling only while it runs (the Stop hook writes from its own process). */
async function refresh($: EngineInterface): Promise<BridgeView | null> {
  const next = await load($)
  const prev = await read($, view)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, view, () => next)
  if (next?.status === 'RUNNING') poll ??= $.clock.every(POLL_MS, () => void refresh($))
  else {
    poll?.cancel()
    poll = undefined
  }
  return next
}

const VERDICT_COLOR = { CONTINUE: undefined, DONE: 'success', NEED_HUMAN: 'warning' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'bridge-panel', description: 'Show the AI Bridge review loop pane' })
    if ((await refresh($))?.status === 'RUNNING') void $.ui.open({ id: PANE, title: TITLE })
    return started
  })

  on('command.run', { command: 'bridge-panel' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'AI Bridge pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    if (isBridgeCommand(e.command?.name)) {
      await refresh($).catch(() => null)
      if (e.command?.args.trim() !== 'stop') void $.ui.open({ id: PANE, title: TITLE }).catch(() => null)
    }
    return done
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => null)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const v = await read($, view)
    if (v === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Phiên này chưa có vòng review nào.</Text>
          <Text dimColor>Gõ /bridge &lt;việc cần làm&gt; để bắt đầu; /bridge stop để dừng.</Text>
        </Box>
      )
    }
    const open = await read($, expanded)
    const toggle = (id: string) => () =>
      void update($, expanded, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={v.status === 'ERROR' ? 'error' : v.status === 'DONE' ? 'success' : v.status === 'NEED_HUMAN' ? 'warning' : undefined}>
            {STATUS_LABEL[v.status] ?? v.status}
          </Text>
          <Text>Việc: {v.task}</Text>
          <Text dimColor>
            Vòng review: {v.round} / {v.maxRounds}
          </Text>
          {v.error !== null && <Text color="error">Lỗi: {v.error}</Text>}
        </Box>
        {v.messages.map(m => {
          const isOpen = open.includes(`${v.loop}:${m.id}`)
          const isClaude = m.who === 'claude'
          return (
            <Box
              key={`msg-${m.id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={isClaude ? 'claude' : 'suggestion'}
              paddingX={1}
              marginLeft={isClaude ? 0 : 4}
              marginRight={isClaude ? 4 : 0}
            >
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text bold color={isClaude ? 'claude' : (m.status && VERDICT_COLOR[m.status]) || 'suggestion'}>
                  {isClaude ? 'Claude' : 'Codex'} · vòng {m.round}
                  {m.status ? ` · ${m.status}` : ''}
                </Text>
                <Button key={`toggle-${m.id}`} plain dimColor onPress={toggle(`${v.loop}:${m.id}`)}>
                  {isOpen ? 'Thu gọn' : 'Xem đầy đủ'}
                </Button>
              </Box>
              {isOpen ? <Markdown text={m.text} /> : <Text dimColor>{m.preview}</Text>}
            </Box>
          )
        })}
        {v.status === 'RUNNING' && v.reviewingSince !== null && (
          <Box borderStyle="round" borderColor="suggestion" borderDimColor paddingX={1} marginLeft={4}>
            <Text color="suggestion">Codex đang review vòng {v.round + 1}…</Text>
          </Box>
        )}
      </Box>
    )
  })
}
