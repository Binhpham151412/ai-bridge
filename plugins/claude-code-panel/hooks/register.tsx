// The "AI Bridge" pane beside the chat (docs/66). It reads what the ai-bridge plugin's hooks
// write under ~/.ai-bridge/claude-code/<session id>/ and draws the exchange as a conversation:
// per round Claude's final message, then Codex's review; each folded to one line until the
// person opens it (drawn as Markdown), each with a Copy button.
// It drives the loop in two ways only: its task field runs `/bridge <task>` as if typed, and its
// Stop button marks the loop STOPPED in state.json exactly as `/bridge stop` does (a command a
// plugin runs waits for the session to be idle, which a running loop never is).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BridgeMessage, BridgeView } from '../types'

const PANE = 'ai-bridge'
const TITLE = 'AI Bridge'
const POLL_MS = 2_000
const PREVIEW_CHARS = 160
/** A drawing holds 100 000 characters in all; one opened message never takes more than this. */
const MESSAGE_CHARS = 20_000
/** A `/bridge` the pane ran that armed no loop within this long is reported, not waited on forever. */
const START_WAIT_MS = 30_000

const view = atom({ plugin: 'ai-bridge-panel', key: 'view' } as const, null)
const expanded = atom({ plugin: 'ai-bridge-panel', key: 'expanded' } as const, [])
const pending = atom({ plugin: 'ai-bridge-panel', key: 'pending' } as const, null)
const now = atom({ plugin: 'ai-bridge-panel', key: 'now' } as const, 0)
/** The hook's own cap (MAX_ROUNDS in bridge-loop.ts): picking it sends no `--vong`. */
const DEFAULT_ROUNDS = '10'
const ROUND_CHOICES = ['3', '5', '10'] as const
const rounds = atom({ plugin: 'ai-bridge-panel', key: 'rounds' } as const, DEFAULT_ROUNDS)

const STATUS_LABEL: Record<BridgeView['status'], string> = {
  RUNNING: 'Đang chạy',
  DONE: '✅ Xong — Codex đã duyệt',
  NEED_HUMAN: '⏸ Cần bạn quyết định',
  ERROR: 'Dừng vì lỗi',
  STOPPED: 'Đã dừng',
}

/** Codex's verdict on one round, in the words the chat uses. */
const VERDICT_WORDS: Record<NonNullable<BridgeMessage['status']>, string> = {
  CONTINUE: 'chưa duyệt',
  DONE: 'đã duyệt',
  NEED_HUMAN: 'cần bạn',
}

const isBridgeCommand = (name: string | undefined) => name === 'bridge' || name === 'ai-bridge:bridge'

/**
 * The plugin's `/bridge` skill is `ai-bridge:bridge` in a session that namespaces plugin commands
 * and plain `bridge` in one that does not, and `$.command.run` rejects a name the session does not
 * know ("no command named /bridge in this session"): ask the session which one it has.
 */
const BRIDGE_COMMANDS = ['ai-bridge:bridge', 'bridge'] as const

async function bridgeCommand($: EngineInterface): Promise<string> {
  const names = (await $.command.list().catch(() => [])).map(c => c.name)
  return BRIDGE_COMMANDS.find(n => names.includes(n)) ?? 'bridge'
}

async function stateRoot($: EngineInterface): Promise<string> {
  const own = await $.env.get('AI_BRIDGE_CLAUDE_CODE_DIR')
  if (own) return own
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}/.ai-bridge/claude-code`
}

const statePath = async ($: EngineInterface) => `${await stateRoot($)}/${await $.session.id()}/state.json`

const readOrNull = ($: EngineInterface, path: string) => $.fs.read(path).then(t => (typeof t === 'string' ? t : null), () => null)

function parseOrNull(raw: string | null) {
  try {
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

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

/** The first line of the review's `## Kết luận` (Codex's conclusion for the user), if it wrote one. */
function conclusionOf(review: string): string {
  let inside = false
  for (const line of review.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) inside = (heading[1] ?? '').normalize('NFC').toLowerCase() === 'kết luận'
    else if (inside && line.trim() !== '') return clip(line.trim(), PREVIEW_CHARS)
  }
  return ''
}

/** Codex's response file: its review (before the block), STATUS and PROMPT. Display only: the hook already parsed it strictly. */
function codexMessage(round: number, raw: string): BridgeMessage {
  const review = (raw.split('<AI_BRIDGE_RESPONSE>')[0] ?? '').trim()
  const found = /<STATUS>\s*([A-Z_]+)\s*<\/STATUS>/.exec(raw)?.[1]
  const status = STATUSES.find(s => s === found)
  const prompt = (/<PROMPT>([\s\S]*?)<\/PROMPT>/.exec(raw)?.[1] ?? '').trim()
  const said = prompt === '' ? '' : `\n\n---\n\n**${status === 'CONTINUE' ? 'Prompt gửi Claude (vòng tiếp theo)' : 'Codex nhắn'}:**\n\n${prompt}`
  return {
    id: `${round}-codex`,
    who: 'codex',
    round,
    ...(status ? { status } : {}),
    text: `${review}${said}`.trim(),
    ...(prompt !== '' ? { prompt } : {}),
    preview: conclusionOf(review) || previewOf(review) || previewOf(prompt),
  }
}

const windowWords = (minutes: number) =>
  minutes % 1440 === 0 ? `${minutes / 1440} ngày` : minutes % 60 === 0 ? `${minutes / 60} giờ` : `${minutes} phút`

/** The Codex plan and quota the Stop hook read from Codex's log (the chat line says the same, with the reset). */
function quotaOf(a: { plan?: unknown; usedPercent?: unknown; windowMinutes?: unknown } | null, checksCode: boolean): string | null {
  if (a === null || (typeof a.plan !== 'string' && typeof a.usedPercent !== 'number')) return null
  const parts = [typeof a.plan === 'string' ? `Codex ${a.plan}` : 'Codex']
  if (typeof a.usedPercent === 'number') {
    parts.push(`đã dùng ${Math.round(a.usedPercent)}% hạn mức${typeof a.windowMinutes === 'number' && a.windowMinutes > 0 ? ` ${windowWords(a.windowMinutes)}` : ''}`)
  }
  parts.push(checksCode ? 'Codex kiểm tra cả code' : 'Codex chỉ đọc báo cáo')
  return parts.join(' · ')
}

async function load($: EngineInterface): Promise<BridgeView | null> {
  const path = await statePath($)
  const dir = path.slice(0, -'/state.json'.length)
  const s = parseOrNull(await readOrNull($, path))
  if (s === null) return null
  const messages: BridgeMessage[] = []
  // round+1: Claude's message Codex is reviewing now (or that a failed review left).
  for (let round = 1; round <= s.round + 1; round++) {
    const base = `${dir}/loop-${s.loop}/${String(round).padStart(3, '0')}`
    const isFinished = round <= s.round
    const report = await readRound($, `${base}-report.md`, isFinished)
    if (report === null) break
    messages.push({ id: `${round}-claude`, who: 'claude', round, text: report, preview: previewOf(report) })
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
    progress: s.progress ?? null,
    question: s.status === 'NEED_HUMAN' ? (s.lastVerdict?.prompt ?? null) : null,
    quota: quotaOf(s.codexAccount ?? null, s.checksCode === true),
    messages,
  }
}

let poll: { cancel: () => void } | undefined

/**
 * Reads the loop again. Keeps polling while it runs (the Stop hook writes from its own process)
 * and while a task sent from the field has not armed a loop yet.
 */
async function refresh($: EngineInterface): Promise<BridgeView | null> {
  const next = await load($)
  const prev = await read($, view)
  if (JSON.stringify(prev) !== JSON.stringify(next)) await update($, view, () => next)
  const t = await $.clock.now()
  if (next?.status === 'RUNNING' && next.reviewingSince !== null) await update($, now, () => t)

  let sent = await read($, pending)
  // A new task arms a newer loop; an answer to Codex sets the same loop running again.
  const isArmed = sent !== null && next !== null && (next.loop > sent.afterLoop || (sent.continues && next.loop === sent.afterLoop && next.status === 'RUNNING'))
  if (isArmed) {
    sent = null
    await update($, pending, () => null)
  } else if (sent !== null && sent.ranAt !== null && t - sent.ranAt >= START_WAIT_MS) {
    sent = null
    await update($, pending, () => null)
    $.ui.toast('AI Bridge: /bridge đã chạy nhưng chưa thấy vòng review nào bắt đầu — plugin ai-bridge đã bật chưa?')
  }

  if (next?.status === 'RUNNING' || sent !== null) poll ??= $.clock.every(POLL_MS, () => void refresh($))
  else {
    poll?.cancel()
    poll = undefined
  }
  return next
}

/**
 * The field's Enter: `/bridge <text>`, as if typed; it waits in the queue while Claude works.
 * While Codex waits on the user the text is the answer (the hook carries the loop on); otherwise
 * it is a new task, with `--vong N` when the person picked other than the default.
 */
async function sendTask($: EngineInterface, text: string): Promise<void> {
  const typed = text.trim()
  if (typed === '') return
  const shown = await read($, view)
  const continues = shown?.status === 'NEED_HUMAN'
  const picked = await read($, rounds)
  const task = continues || picked === DEFAULT_ROUNDS ? typed : `--vong ${picked} ${typed}`
  await update($, pending, () => ({ task, afterLoop: shown?.loop ?? 0, continues, ranAt: null }))
  await refresh($)
  try {
    await $.command.run({ command: await bridgeCommand($), args: task })
    const ranAt = await $.clock.now()
    await update($, pending, p => (p === null ? null : { ...p, ranAt }))
  } catch (err) {
    await update($, pending, () => null)
    $.ui.toast(`AI Bridge: không chạy được /bridge (${err instanceof Error ? err.message : String(err)}).`)
  }
  await refresh($)
}

/** Stop: what `/bridge stop` writes, and only over the loop the pane showed, still running or waiting on the user. */
async function stopLoop($: EngineInterface): Promise<void> {
  const shown = await read($, view)
  const path = await statePath($)
  const s = parseOrNull(await readOrNull($, path))
  if (shown !== null && (s?.status === 'RUNNING' || s?.status === 'NEED_HUMAN') && s.loop === shown.loop) {
    const at = new Date(await $.clock.now()).toISOString()
    await $.fs.write(path, JSON.stringify({ ...s, status: 'STOPPED', reviewingSince: null, humanReply: null, updatedAt: at }, null, 2))
  }
  await refresh($)
}

const labelOf = (m: BridgeMessage) => `${m.who === 'claude' ? 'Claude' : 'Codex'} · vòng ${m.round}${m.status ? ` · ${VERDICT_WORDS[m.status]}` : ''}`

/** The whole exchange as one Markdown document, for "Copy tất cả". */
const exchangeOf = (v: BridgeView) => [`# AI Bridge — ${v.task}`, ...v.messages.map(m => `## ${labelOf(m)}\n\n${m.text}`)].join('\n\n')

async function copy($: EngineInterface, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'], text: string, what: string) {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `Đã copy ${what}.` : `Không copy được ${what} (${r.reason}).`)
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s} giây` : `${Math.floor(s / 60)} phút ${String(s % 60).padStart(2, '0')} giây`
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
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
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
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const v = await read($, view)
    const sent = await read($, pending)
    const picked = await read($, rounds)
    const isRunning = v?.status === 'RUNNING'
    const isWaiting = v?.status === 'NEED_HUMAN'

    // The foot of the pane: the task on its way; Codex's question and the field that answers it;
    // the field for a new task and its number of rounds; or (no field on this surface) the chat.
    const foot =
      sent !== null ? (
        <Text color="suggestion">
          Đã gửi /bridge {sent.task} — chờ Claude nhận việc…
        </Text>
      ) : isRunning ? null : Input ? (
        <Box flexDirection="column" gap={1}>
          {isWaiting && v.question !== null && <Text color="warning">Codex hỏi: {v.question}</Text>}
          <Input
            key="task"
            autoFocus
            rows={3}
            label={isWaiting ? 'Trả lời Codex' : 'Việc cần làm'}
            placeholder={isWaiting ? 'Trả lời để vòng lặp chạy tiếp…' : 'Mô tả việc cần làm…'}
            submitLabel={isWaiting ? 'gửi câu trả lời' : 'chạy /bridge'}
            onSubmit={value => void sendTask($, value)}
          />
          {!isWaiting && Select && (
            <Select
              key="rounds"
              label="Số vòng review"
              value={picked}
              options={ROUND_CHOICES.map(n => ({ value: n, label: `${n} vòng` }))}
              onSelect={value => void update($, rounds, () => value)}
            />
          )}
        </Box>
      ) : (
        <Text dimColor>Gõ /bridge &lt;việc cần làm&gt; ở khung chat để bắt đầu; /bridge stop để dừng.</Text>
      )

    if (v === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text dimColor>Phiên này chưa có vòng review nào.</Text>
            <Text dimColor>Nhập việc cần làm rồi Enter: Claude làm, Codex review sau mỗi lượt (như gõ /bridge &lt;việc&gt;).</Text>
          </Box>
          {foot}
        </Box>
      )
    }
    const open = await read($, expanded)
    const at = await read($, now)
    const parts = v.progress?.items ?? []
    const toggle = (id: string) => () =>
      void update($, expanded, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={v.status === 'ERROR' ? 'error' : v.status === 'DONE' ? 'success' : v.status === 'NEED_HUMAN' ? 'warning' : undefined}>
            {STATUS_LABEL[v.status] ?? v.status}
          </Text>
          <Text>Việc: {v.progress?.title ?? v.task}</Text>
          <Text dimColor>
            Vòng review: {v.round} / {v.maxRounds}
          </Text>
          {parts.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>
                Tiến độ: {parts.filter(p => p.done).length}/{parts.length} phần xong
              </Text>
              {parts.map((p, i) => (
                <Text key={`part-${i}`} color={p.done ? 'success' : undefined} dimColor={!p.done}>
                  {p.done ? '✓' : '✗'} {p.text}
                </Text>
              ))}
            </Box>
          )}
          {v.progress?.verdict && <Text>Codex: {v.progress.verdict}</Text>}
          {v.quota !== null && <Text dimColor>{v.quota}</Text>}
          {v.error !== null && <Text color="error">Lỗi: {v.error}</Text>}
          <Box flexDirection="row" gap={2}>
            {v.messages.length > 0 && (
              <Button key="copy-all" plain dimColor onPress={press => void copy($, press.surface, exchangeOf(v), 'toàn bộ cuộc trao đổi')}>
                Copy tất cả
              </Button>
            )}
            {(isRunning || isWaiting) && (
              <Button key="stop" plain onPress={() => void stopLoop($)}>
                {isWaiting ? 'Kết thúc vòng này' : 'Dừng vòng lặp'}
              </Button>
            )}
          </Box>
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
                  {labelOf(m)}
                </Text>
                <Box flexDirection="row" gap={2}>
                  <Button key={`copy-${m.id}`} plain dimColor onPress={press => void copy($, press.surface, m.text, `tin ${labelOf(m)}`)}>
                    Copy
                  </Button>
                  {m.prompt !== undefined && m.status === 'CONTINUE' && (
                    <Button key={`copy-prompt-${m.round}`} plain dimColor onPress={press => void copy($, press.surface, m.prompt ?? '', 'prompt Codex gửi Claude')}>
                      Copy prompt
                    </Button>
                  )}
                  <Button key={`toggle-${m.id}`} plain dimColor onPress={toggle(`${v.loop}:${m.id}`)}>
                    {isOpen ? 'Thu gọn' : 'Xem đầy đủ'}
                  </Button>
                </Box>
              </Box>
              {isOpen ? <Markdown text={clip(m.text, MESSAGE_CHARS)} /> : <Text dimColor>{m.preview}</Text>}
            </Box>
          )
        })}
        {isRunning && v.reviewingSince !== null && (
          <Box borderStyle="round" borderColor="suggestion" borderDimColor paddingX={1} marginLeft={4}>
            <Text color="suggestion">
              Codex đang review vòng {v.round + 1}… {elapsed(at - Date.parse(v.reviewingSince))}
            </Text>
          </Box>
        )}
        {foot}
      </Box>
    )
  })
}
