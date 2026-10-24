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
function world(on: On, files: Record<string, string>) {
  const opened: string[] = []
  mock.env(on, { AI_BRIDGE_CLAUDE_CODE_DIR: ROOT })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: SESSION }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bridge-panel' } }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  // The engine hands the path on resolved, with the platform's separators.
  on('fs.read', (_, e) => {
    const text = files[e.path.replace(/\\/g, '/')]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  return { clock, opened }
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
  expect(await ui.find({ type: 'Text', text: /CONTINUE/ })).toBeTruthy()
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
