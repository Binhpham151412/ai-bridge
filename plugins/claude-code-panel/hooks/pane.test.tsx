import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ROOT = 'C:/state'
const DIR = `${ROOT}/${SESSION}`
const LOOP = `${DIR}/loop-1`

const PANE = {
  plugin: 'ai-bridge-panel',
  component: 'Pane',
  requestId: 'ai-bridge',
  props: {
    title: 'AI Bridge',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const state = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    sessionId: SESSION,
    projectPath: 'D:/proj',
    task: 'fix the login bug',
    status: 'RUNNING',
    loop: 1,
    round: 1,
    maxRounds: 10,
    codexThreadId: 't',
    reviewingSince: null,
    lastVerdict: { round: 1, status: 'CONTINUE', prompt: 'Add a test for the expired token.' },
    error: null,
    armedAt: '2026-10-23T10:00:00.000Z',
    updatedAt: '2026-10-23T10:05:00.000Z',
    ...over,
  })

const REPORT_1 = 'Fixed the login check.\n\n## TASK\nfix the login bug\n## CHANGES\n- src/login.ts: compare hashes in constant time\n## TESTS\n3 pass'
const REVIEW_1 =
  '## Summary\nLogin fixed, expired tokens untested.\n\n## Problems Found\n- No test for an expired token.\n\n<AI_BRIDGE_RESPONSE>\n<STATUS>\nCONTINUE\n</STATUS>\n<PROMPT>\nAdd a test for the expired token.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n'
const REPORT_2 = 'Added the expired-token test.\n\n## TESTS\n4 pass'

/** The engine beneath the pane: the files the ai-bridge hooks wrote, by path. */
function world(on: On, files: Record<string, string>, { now = 0, copies = true, bridge = true, commands = ['ai-bridge:bridge'] } = {}) {
  const opened: string[] = []
  const focused: string[] = []
  const ran: { command: string; args: string }[] = []
  const copied: string[] = []
  const toasts: string[] = []
  mock.env(on, { AI_BRIDGE_CLAUDE_CODE_DIR: ROOT })
  const clock = mock.clock(on, { now })
  on('session.id', () => ({ value: SESSION }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bridge-panel' } }))
  // The plugin's skill is `ai-bridge:bridge` in a session that namespaces plugin commands (the user's desktop one does), plain `bridge` in one that does not.
  on('command.list', () => ({ value: commands.map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('ui.open', (_, e) => (opened.push(e.id), e.focus && focused.push(e.id), { value: { isPlaced: true } }))
  if (bridge) on('command.run', { command: 'ai-bridge:bridge' }, (_, e) => (ran.push({ command: e.command, args: e.args }), {}))
  on('ui.copy', (_, e) => (copied.push(e.text), { value: copies ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  // The engine hands the path on resolved, with the platform's separators.
  on('fs.read', (_, e) => {
    const text = files[e.path.replace(/\\/g, '/')]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_, e) => ((files[e.path.replace(/\\/g, '/')] = e.text), { value: undefined }))
  return { clock, opened, focused, ran, copied, toasts }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

test('the exchange reads as a conversation: Claude then Codex, each round, collapsed to one line', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /1\s*\/\s*10/ })).toBeTruthy()
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const claudeAt = texts.findIndex(t => /Claude · vòng 1/.test(t))
  const codexAt = texts.findIndex(t => /Codex · vòng 1/.test(t))
  expect(claudeAt).toBeGreaterThan(-1)
  expect(codexAt).toBeGreaterThan(claudeAt)
  expect(await ui.find({ type: 'Text', text: /chưa duyệt/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Fixed the login check\.$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Login fixed, expired tokens untested\.$/ })).toBeTruthy()
  // Collapsed: the rest of either message is not drawn.
  expect(await ui.find({ type: 'Markdown' })).toBeFalsy()
  expect(await ui.find({ text: /constant time/ })).toBeFalsy()
  await ui.unmount()
})

test('"Xem đầy đủ" shows the whole message as Markdown; "Thu gọn" folds it again', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'toggle-1-claude' })
  const md = await ui.find({ type: 'Markdown' })
  expect(md?.props.text).toBe(REPORT_1)
  expect((await ui.find({ key: 'toggle-1-claude' }))?.text).toMatch(/Thu gọn/)

  await ui.press({ key: 'toggle-1-claude' })
  expect(await ui.find({ type: 'Markdown' })).toBeFalsy()
  await ui.unmount()
})

test('an opened Codex message shows its review as Markdown, without the response block, and the prompt it sent Claude', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'toggle-1-codex' })
  const md = (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text)).join('\n')
  expect(md).toMatch(/## Problems Found/)
  expect(md).toMatch(/Add a test for the expired token\./)
  expect(md).not.toMatch(/AI_BRIDGE_RESPONSE/)
  await ui.unmount()
})

test('while Codex reviews, the conversation ends with Claude\'s new message and a "reviewing" line', async ($, on) => {
  world(on, {
    [`${DIR}/state.json`]: state({ reviewingSince: '2026-10-23T10:06:00.000Z' }),
    [`${LOOP}/001-report.md`]: REPORT_1,
    [`${LOOP}/001-codex-review.md`]: REVIEW_1,
    [`${LOOP}/002-report.md`]: REPORT_2,
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const claude2 = texts.findIndex(t => /Claude · vòng 2/.test(t))
  const reviewing = texts.findIndex(t => /Codex đang review vòng 2/.test(t))
  expect(claude2).toBeGreaterThan(-1)
  expect(reviewing).toBeGreaterThan(claude2)
  await ui.unmount()
})

test('a loop that is no longer running never says Codex is reviewing, even if an interrupted review left its mark', async ($, on) => {
  world(on, {
    [`${DIR}/state.json`]: state({ status: 'STOPPED', reviewingSince: '2026-10-23T10:06:00.000Z' }),
    [`${LOOP}/001-report.md`]: REPORT_1,
    [`${LOOP}/001-codex-review.md`]: REVIEW_1,
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Đã dừng/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Codex đang review/ })).toBeFalsy()
  await ui.unmount()
})

test('shows the error that stopped the loop', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state({ status: 'ERROR', error: 'Codex review failed (TIMEOUT)' }) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Codex review failed \(TIMEOUT\)/ })).toBeTruthy()
  await ui.unmount()
})

test('without a loop in this session it says how to start one', async ($, on) => {
  world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\/bridge/ })).toBeTruthy()
  await ui.unmount()
})

test('/bridge opens the pane; /bridge stop does not', async ($, on) => {
  const { opened } = world(on, { [`${DIR}/state.json`]: state() })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($)
  opened.length = 0

  await $.prompt.submit({ text: '/bridge stop', command: { name: 'bridge', args: 'stop' }, wait: false, origin: { kind: 'composer' } })
  expect(opened).toEqual([])
  await $.prompt.submit({ text: '/bridge fix it', command: { name: 'bridge', args: 'fix it' }, wait: false, origin: { kind: 'composer' } })
  expect(opened).toEqual(['ai-bridge'])
})

test('while the loop runs, the pane follows what the Stop hook writes', async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/state.json`]: state({ round: 0, lastVerdict: null }), [`${LOOP}/001-report.md`]: REPORT_1 }
  const { clock } = world(on, files)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Codex · vòng 1/ })).toBeFalsy()

  files[`${DIR}/state.json`] = state()
  files[`${LOOP}/001-codex-review.md`] = REVIEW_1
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /Codex · vòng 1/ })).toBeTruthy()
  await ui.unmount()
})

test('an opened conversation draws on every surface', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if ((await ui.find({ type: 'Markdown' })) === undefined) await ui.press({ key: 'toggle-1-codex' })
    expect(await ui.find({ type: 'Markdown' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Claude · vòng 1/ })).toBeTruthy()
    await ui.unmount()
  }
})

// ── Driving the loop from the pane ──────────────────────────────────────────

test('without a loop the pane offers a task field, focused, and Enter runs /bridge <task>', async ($, on) => {
  const { ran } = world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const field = await ui.find({ type: 'Input', key: 'task' })
  expect(field?.props.autoFocus).toBe(true)
  await ui.input({ key: 'task', text: '  fix the login bug\nand add a test  ' })
  expect(ran).toEqual([{ command: 'ai-bridge:bridge', args: 'fix the login bug\nand add a test' }])
  await ui.unmount()
})

test('a session that names the command plain /bridge: the pane runs it under that name', async ($, on) => {
  const { ran } = world(on, {}, { bridge: false, commands: ['bridge'] })
  on('command.run', { command: 'bridge' }, (_, e) => (ran.push({ command: e.command, args: e.args }), {}))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'task', text: 'fix the login bug' })
  expect(ran).toEqual([{ command: 'bridge', args: 'fix the login bug' }])
  await ui.unmount()
})

test('a session that has both names: the namespaced one', async ($, on) => {
  const { ran } = world(on, {}, { bridge: false, commands: ['bridge', 'ai-bridge:bridge'] })
  on('command.run', { command: 'ai-bridge:bridge' }, (_, e) => (ran.push({ command: e.command, args: e.args }), {}))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'task', text: 'fix the login bug' })
  expect(ran).toEqual([{ command: 'ai-bridge:bridge', args: 'fix the login bug' }])
  await ui.unmount()
})

test('a session that lists neither name: the command is tried as /bridge, and the failure is reported with the field back', async ($, on) => {
  const { toasts } = world(on, {}, { bridge: false, commands: [] })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'task', text: 'fix the login bug' })
  expect(toasts.some(t => /^AI Bridge: không chạy được \/bridge \(/.test(t))).toBe(true)
  expect(await ui.find({ type: 'Input', key: 'task' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeFalsy()
  await ui.unmount()
})

test('an empty task runs nothing', async ($, on) => {
  const { ran } = world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'task', text: '   \n ' })
  expect(ran).toEqual([])
  expect(await ui.find({ type: 'Input', key: 'task' })).toBeTruthy()
  await ui.unmount()
})

test('after Enter the pane says the task is on its way while it waits for Claude, then follows the loop it armed', async ($, on) => {
  const files: Record<string, string> = {}
  const { clock } = world(on, files, { bridge: false })
  // Claude is busy: the command waits in the queue, then the UserPromptSubmit hook arms the loop.
  on('command.run', { command: 'ai-bridge:bridge' }, async () => {
    await clock.sleep(5_000)
    files[`${DIR}/state.json`] = state({ round: 0, lastVerdict: null })
    return {}
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'task', text: 'fix the login bug' })
  expect(await ui.find({ type: 'Text', text: /Đã gửi \/bridge fix the login bug/ })).toBeTruthy()
  expect(await ui.find({ type: 'Input', key: 'task' })).toBeFalsy()

  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeTruthy()
  await clock.advance(4_000)
  expect(await ui.find({ type: 'Text', text: /Đang chạy/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeFalsy()
  await ui.unmount()
})

test('a /bridge that armed no loop is reported after a while and the field comes back', async ($, on) => {
  const { clock, toasts } = world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'task', text: 'fix the login bug' })
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeTruthy()
  await clock.advance(30_000)
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeFalsy()
  expect(await ui.find({ type: 'Input', key: 'task' })).toBeTruthy()
  expect(toasts.at(-1)).toMatch(/chưa thấy vòng review nào bắt đầu/)
  await ui.unmount()
})

test('a finished loop offers the field again, and Enter starts the next loop', async ($, on) => {
  const { ran } = world(on, { [`${DIR}/state.json`]: state({ status: 'DONE' }), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Input', key: 'task' }))?.props.label).toBe('Việc cần làm')
  await ui.input({ key: 'task', text: 'use the refresh token' })
  expect(ran).toEqual([{ command: 'ai-bridge:bridge', args: 'use the refresh token' }])
  await ui.unmount()
})

const WAITING = () =>
  state({ status: 'NEED_HUMAN', round: 1, lastVerdict: { round: 1, status: 'NEED_HUMAN', prompt: 'Postgres or SQLite?' } })

test("while Codex waits on the user, the pane shows its question and the field answers it, carrying the same loop on", async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/state.json`]: WAITING(), [`${LOOP}/001-report.md`]: REPORT_1 }
  const { ran, clock } = world(on, files, { bridge: false })
  const ran2: string[] = []
  on('command.run', { command: 'ai-bridge:bridge' }, async (_, e) => {
    ran2.push(e.args)
    await clock.sleep(1_000)
    files[`${DIR}/state.json`] = state({ status: 'RUNNING', round: 1 })
    return {}
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Codex hỏi: Postgres or SQLite\?/ })).toBeTruthy()
  expect((await ui.find({ type: 'Input', key: 'task' }))?.props.label).toBe('Trả lời Codex')
  expect(await ui.find({ key: 'rounds' })).toBeFalsy()

  await ui.input({ key: 'task', text: 'SQLite' })
  expect(ran2).toEqual(['SQLite'])
  expect(ran).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeTruthy()
  // Same loop number: the pane sees it running again and lets go of the sent line.
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /Đang chạy/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Đã gửi/ })).toBeFalsy()
  await ui.unmount()
})

test('"Kết thúc vòng này" ends a loop that waits on the user, and the field then takes a new task', async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/state.json`]: WAITING() }
  world(on, files)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  expect(JSON.parse(files[`${DIR}/state.json`] ?? '{}').status).toBe('STOPPED')
  expect((await ui.find({ type: 'Input', key: 'task' }))?.props.label).toBe('Việc cần làm')
  await ui.unmount()
})

test('the number of rounds picked beside the field goes with a new task as --vong; the default adds nothing', async ($, on) => {
  const { ran } = world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'rounds' }))?.props.value).toBe('10')
  await ui.select({ key: 'rounds', value: '3' })
  expect((await ui.find({ key: 'rounds' }))?.props.value).toBe('3')
  await ui.input({ key: 'task', text: 'fix it' })
  expect(ran).toEqual([{ command: 'ai-bridge:bridge', args: '--vong 3 fix it' }])
  await ui.unmount()
})

test('a running loop has no task field but a Stop button that marks the loop STOPPED, as /bridge stop does', async ($, on) => {
  const files: Record<string, string> = {
    [`${DIR}/state.json`]: state({ reviewingSince: '2026-10-23T10:06:00.000Z' }),
    [`${LOOP}/001-report.md`]: REPORT_1,
    [`${LOOP}/001-codex-review.md`]: REVIEW_1,
  }
  world(on, files, { now: Date.parse('2026-10-23T10:07:00.000Z') })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Input', key: 'task' })).toBeFalsy()

  await ui.press({ key: 'stop' })
  const saved = JSON.parse(files[`${DIR}/state.json`] ?? '{}')
  expect(saved).toMatchObject({ status: 'STOPPED', reviewingSince: null, task: 'fix the login bug', loop: 1, round: 1, codexThreadId: 't' })
  expect(saved.updatedAt).toBe('2026-10-23T10:07:00.000Z')
  expect(await ui.find({ type: 'Text', text: /Đã dừng/ })).toBeTruthy()
  expect(await ui.find({ key: 'stop' })).toBeFalsy()
  expect(await ui.find({ type: 'Input', key: 'task' })).toBeTruthy()
  await ui.unmount()
})

test('Stop leaves alone a loop that ended or was re-armed since the pane last read it', async ($, on) => {
  const files: Record<string, string> = { [`${DIR}/state.json`]: state() }
  world(on, files)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  const rearmed = state({ loop: 2, round: 0 })
  files[`${DIR}/state.json`] = rearmed
  await ui.press({ key: 'stop' })
  expect(files[`${DIR}/state.json`]).toBe(rearmed)

  // The press read the file again: the pane now shows loop 2, still running.
  const done = state({ loop: 2, status: 'DONE' })
  files[`${DIR}/state.json`] = done
  await ui.press({ key: 'stop' })
  expect(files[`${DIR}/state.json`]).toBe(done)
  await ui.unmount()
})

test('the reviewing line counts how long Codex has been at it', async ($, on) => {
  const { clock } = world(
    on,
    { [`${DIR}/state.json`]: state({ reviewingSince: '2026-10-23T10:06:00.000Z' }), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1, [`${LOOP}/002-report.md`]: REPORT_2 },
    { now: Date.parse('2026-10-23T10:06:45.000Z') },
  )
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Codex đang review vòng 2… 45 giây/ })).toBeTruthy()
  await clock.advance(80_000)
  expect(await ui.find({ type: 'Text', text: /Codex đang review vòng 2… 2 phút 05 giây/ })).toBeTruthy()
  await ui.unmount()
})

// ── Copying out of the pane ─────────────────────────────────────────────────

test('each message copies whole, even past what the pane draws', async ($, on) => {
  const long = `Fixed it.\n\n${'x'.repeat(30_000)}\nEND`
  const { copied, toasts } = world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: long, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'copy-1-claude' })
  expect(copied).toEqual([long])
  expect(toasts.at(-1)).toMatch(/Đã copy/)

  await ui.press({ key: 'toggle-1-claude' })
  expect(String((await ui.find({ type: 'Markdown' }))?.props.text).length).toBeLessThan(long.length)
  await ui.unmount()
})

test('Codex\'s message copies its review and prompt; the prompt also copies on its own', async ($, on) => {
  const { copied } = world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'copy-1-codex' })
  expect(copied[0]).toMatch(/## Problems Found[\s\S]*Add a test for the expired token\./)
  expect(copied[0]).not.toMatch(/AI_BRIDGE_RESPONSE/)
  await ui.press({ key: 'copy-prompt-1' })
  expect(copied[1]).toBe('Add a test for the expired token.')
  await ui.unmount()
})

test('"Copy tất cả" copies the whole exchange in order, each message under its label', async ($, on) => {
  const { copied } = world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1, [`${LOOP}/002-report.md`]: REPORT_2 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'copy-all' })
  const all = copied[0] ?? ''
  const at = (s: string) => all.indexOf(s)
  expect(at('fix the login bug')).toBeGreaterThan(-1)
  expect(at('Claude · vòng 1')).toBeGreaterThan(-1)
  expect(at('Fixed the login check.')).toBeGreaterThan(at('Claude · vòng 1'))
  expect(at('Codex · vòng 1 · chưa duyệt')).toBeGreaterThan(at('Fixed the login check.'))
  expect(at('Claude · vòng 2')).toBeGreaterThan(at('Codex · vòng 1 · chưa duyệt'))
  expect(at('Added the expired-token test.')).toBeGreaterThan(at('Claude · vòng 2'))
  await ui.unmount()
})

test('a copy that reached no clipboard says so', async ($, on) => {
  const { toasts } = world(on, { [`${DIR}/state.json`]: state(), [`${LOOP}/001-report.md`]: REPORT_1 }, { copies: false })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'copy-1-claude' })
  expect(toasts.at(-1)).toMatch(/Không copy được/)
  await ui.unmount()
})

// ── Opening ─────────────────────────────────────────────────────────────────

test('/bridge-panel opens the pane asking for the keyboard, so the task field takes the typing', async ($, on) => {
  const { focused } = world(on, {})
  await start($)
  await $.command.run({ command: 'bridge-panel', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(focused).toEqual(['ai-bridge'])
})

test('a surface with no text field says how to start a loop from the chat', async ($, on) => {
  world(on, {})
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /\/bridge/ })).toBeTruthy()
  await ui.unmount()
})

// ── How far the task is ─────────────────────────────────────────────────────

const PROGRESS = {
  title: 'Sửa lỗi đăng nhập.',
  items: [
    { text: 'So sánh hash an toàn', done: true },
    { text: 'Test token hết hạn', done: false },
  ],
  verdict: 'Chưa duyệt: còn thiếu test token hết hạn.',
}

test("the head of the pane says how far the task is: Codex's one-line task, parts done, each part and its conclusion", async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state({ progress: PROGRESS }), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: REVIEW_1 })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = (re: RegExp) => texts.findIndex(t => re.test(t))
  expect(at(/^Việc: Sửa lỗi đăng nhập\.$/)).toBeGreaterThan(-1)
  expect(at(/^Tiến độ: 1\/2 phần xong$/)).toBeGreaterThan(-1)
  expect(at(/^✓ So sánh hash an toàn$/)).toBeGreaterThan(at(/^Tiến độ/))
  expect(at(/^✗ Test token hết hạn$/)).toBeGreaterThan(at(/^✓ So sánh hash an toàn$/))
  expect(at(/Codex: Chưa duyệt: còn thiếu test token hết hạn\./)).toBeGreaterThan(-1)
  // The head comes before the conversation.
  expect(at(/^✗ Test token hết hạn$/)).toBeLessThan(at(/Claude · vòng 1/))
  await ui.unmount()
})

test('before Codex made a checklist the pane shows the task as typed and no progress', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state({ round: 0, lastVerdict: null }) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Việc: fix the login bug$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Tiến độ/ })).toBeFalsy()
  await ui.unmount()
})

test("verdicts read in words, and a Codex message folds to its conclusion", async ($, on) => {
  const review = `## Việc\nSửa lỗi đăng nhập.\n\n## Tiến độ\n- [x] So sánh hash an toàn\n\n## Kết luận\nĐã xong, đã kiểm chứng.\n\n<AI_BRIDGE_RESPONSE>\n<STATUS>\nDONE\n</STATUS>\n<PROMPT>\nNothing left.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n`
  world(on, { [`${DIR}/state.json`]: state({ status: 'DONE' }), [`${LOOP}/001-report.md`]: REPORT_1, [`${LOOP}/001-codex-review.md`]: review })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Xong — Codex đã duyệt/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Codex · vòng 1 · đã duyệt/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Đã xong, đã kiểm chứng\.$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /DONE/ })).toBeFalsy()
  await ui.unmount()
})

test("the head shows the Codex plan, how much of its quota is used, and whether Codex checks the code", async ($, on) => {
  const account = { plan: 'free', usedPercent: 62, windowMinutes: 43200, resetsAt: 1795407841 }
  world(on, { [`${DIR}/state.json`]: state({ codexAccount: account, checksCode: false }) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Codex free · đã dùng 62% hạn mức 30 ngày · Codex chỉ đọc báo cáo$/ })).toBeTruthy()
  await ui.unmount()
})

test('before any review there is no quota line', async ($, on) => {
  world(on, { [`${DIR}/state.json`]: state({ round: 0, lastVerdict: null }) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /hạn mức/ })).toBeFalsy()
  await ui.unmount()
})
