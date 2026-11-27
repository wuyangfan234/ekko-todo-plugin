// Todo #101 — settings say what really applies, a new card goes to a topic of its own project, and empty
// screens name the next step. Three layers: pure rules (src/client/trust-view.js), static render of the small
// exported pieces, and source wiring of the dialogs that live behind a Radix portal.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { cleanupClient, loadClient, mountElement, walk } from './helpers/mini-dom.mjs'

const pkgRoot = new URL('../', import.meta.url).pathname
const read = rel => readFileSync(join(pkgRoot, rel), 'utf8')
const tvPath = join(pkgRoot, 'src/client/trust-view.js')
// Loaded lazily so code without the module fails each assertion instead of the whole file import.
const tv = existsSync(tvPath) ? await import(pathToFileURL(tvPath).href) : {}

const PROJECTS = [
  { id: 'p-a', name: 'alpha', displayName: '甲项目' },
  { id: 'p-b', name: 'beta', displayName: '乙项目' },
  { id: 'p-c', name: 'gamma', displayName: '丙项目' },
]
const TOPICS = [
  { id: 't-a1', title: '甲的话题一', projectId: 'p-a' },
  { id: 't-free', title: '没绑项目的话题', projectId: '' },
  { id: 't-b1', title: '乙的话题', projectId: 'p-b' },
  { id: 't-a2', title: '甲的话题二', projectId: 'p-a' },
  { id: 't-a-old', title: '甲的归档话题', projectId: 'p-a', archived: true },
]

let bundle = null
let workDir = ''
async function loadBundle() {
  if (bundle) return bundle
  workDir = mkdtempSync(join(tmpdir(), 'ekko-t101-'))
  const entry = join(workDir, 'entry.jsx')
  const src = rel => JSON.stringify(join(pkgRoot, rel))
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import * as Dialogs from ${src('src/client/components/Dialogs.jsx')}`,
    `import * as Board from ${src('src/client/components/KanbanBoard.jsx')}`,
    `import * as Chat from ${src('src/client/components/ChatPane.jsx')}`,
    `import * as Settings from ${src('src/client/components/SettingsPanel.jsx')}`,
    `const all = { ...Dialogs, ...Board, ...Chat, ...Settings }`,
    `export function render(name, props) {`,
    `  if (!all[name]) throw new Error('component not exported: ' + name)`,
    `  return renderToStaticMarkup(React.createElement(all[name], props))`,
    `}`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  const purifyStub = join(workDir, 'purify-stub.mjs')
  writeFileSync(purifyStub, 'export default { sanitize: html => html, addHook() {}, removeHook() {} }\n')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    alias: { dompurify: purifyStub },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  bundle = await import(pathToFileURL(out).href)
  return bundle
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }); cleanupClient() })

const optionsOf = (html, testid) => {
  const sel = new RegExp(`<select[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</select>`).exec(html)
  assert.ok(sel, `select ${testid} is rendered`)
  return [...sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map(m => ({ value: m[1], text: m[2] }))
}
const ownerProps = over => ({
  projects: PROJECTS, topics: TOPICS, projectId: 'p-a', topicChoice: 't-a1', notice: null, kind: 'feature',
  onProjectChange() {}, onTopicChange() {}, onKindChange() {}, ...over,
})
// The body of one exported function, cut from the source by its declaration.
const fnBody = (srcText, decl) => {
  const i = srcText.indexOf(decl)
  assert.ok(i >= 0, `${decl} exists`)
  const j = srcText.indexOf('\nexport function ', i + decl.length)
  return srcText.slice(i, j < 0 ? srcText.length : j)
}

// ---- 1. New task: project and topic -----------------------------------------------------------------------

test('#101 new task: the topic list holds only topics of the chosen project, plus 新建话题', async () => {
  assert.deepEqual(tv.topicsForProject?.(TOPICS, 'p-a').map(t => t.id), ['t-a1', 't-a2'], 'other project, unbound and archived topics are out')
  const { render } = await loadBundle()
  const opts = optionsOf(render('TaskOwnerFields', ownerProps()), 'select-task-topic')
  assert.deepEqual(opts.map(o => o.value), ['t-a1', 't-a2', tv.NEW_TOPIC_CHOICE])
  assert.ok(!opts.some(o => o.text.includes('乙的话题') || o.text.includes('没绑项目')), 'no cross-project title is offered')
  assert.match(opts.at(-1).text, /新建话题/)
})

test('#101 new task: changing the project resets the topic to one of the new project', () => {
  assert.equal(tv.pickTaskTopic?.({ topics: TOPICS, projectId: 'p-a', preferredTopicId: 't-a2' }), 't-a2', 'open topic of the same project is kept')
  assert.equal(tv.pickTaskTopic?.({ topics: TOPICS, projectId: 'p-b', preferredTopicId: 't-a2' }), 't-b1', 'the previous project\'s topic is never carried over')
  const dlg = fnBody(read('src/client/components/Dialogs.jsx'), 'export function CreateTaskDialog(')
  assert.match(dlg, /const changeProject = nextId => \{\s*setProjectId\(nextId\)\s*setTopicChoice\(pickTaskTopic\(\{ topics, projectId: nextId, preferredTopicId: defaultTopicId \}\)\)/)
  assert.match(dlg, /onProjectChange=\{changeProject\}/)
})

test('#101 new task: a project without topics can only create one', async () => {
  assert.equal(tv.pickTaskTopic?.({ topics: TOPICS, projectId: 'p-c', preferredTopicId: 't-a1' }), tv.NEW_TOPIC_CHOICE)
  const { render } = await loadBundle()
  const opts = optionsOf(render('TaskOwnerFields', ownerProps({ projectId: 'p-c', topicChoice: tv.NEW_TOPIC_CHOICE })), 'select-task-topic')
  assert.equal(opts.length, 1)
  assert.equal(opts[0].value, tv.NEW_TOPIC_CHOICE)
  assert.match(opts[0].text, /这个项目还没有话题/)
  assert.deepEqual(tv.resolveTaskTopic?.({ topics: TOPICS, projectId: 'p-c', topicChoice: tv.NEW_TOPIC_CHOICE }), { topicId: '', createTopic: true })
})

test('#101 new task: every open starts from the current default project', () => {
  const first = tv.newTaskDraft?.({ projects: PROJECTS, topics: TOPICS, defaultProjectId: 'p-a', activeTopicId: 't-a2' })
  assert.deepEqual(first, { projectId: 'p-a', topicChoice: 't-a2' })
  const reopened = tv.newTaskDraft?.({ projects: PROJECTS, topics: TOPICS, defaultProjectId: 'p-b', activeTopicId: 't-a2' })
  assert.deepEqual(reopened, { projectId: 'p-b', topicChoice: 't-b1' }, 'a second open with another context does not keep p-a')
  assert.equal(tv.newTaskDraft?.({ projects: PROJECTS, topics: TOPICS, defaultProjectId: 'gone' }).projectId, 'p-a', 'unknown default falls to the first project')
  const dlg = fnBody(read('src/client/components/Dialogs.jsx'), 'export function CreateTaskDialog(')
  assert.doesNotMatch(dlg, /useState\(defaultProjectId/, 'the project is not read once at mount')
  assert.match(dlg, /useEffect\(\(\) => \{\s*if \(!open\) return\s*const draft = newTaskDraft\([^)]*\)\s*setProjectId\(draft\.projectId\)\s*setTopicChoice\(draft\.topicChoice\)\s*\}, \[open\]\)/)
})

test('#101 new task: the submit never falls back to another project\'s topic', async () => {
  // A stale choice (topic of p-b while the card is for p-a) is refused, not sent.
  assert.deepEqual(tv.resolveTaskTopic?.({ topics: TOPICS, projectId: 'p-a', topicChoice: 't-b1' }), { topicId: '', createTopic: true })
  assert.deepEqual(tv.resolveTaskTopic?.({ topics: TOPICS, projectId: 'p-a', topicChoice: 't-free' }), { topicId: '', createTopic: true })
  assert.deepEqual(tv.resolveTaskTopic?.({ topics: TOPICS, projectId: 'p-a', topicChoice: 't-a2' }), { topicId: 't-a2', createTopic: false })
  const dlg = fnBody(read('src/client/components/Dialogs.jsx'), 'export function CreateTaskDialog(')
  assert.doesNotMatch(dlg, /topics\[0\]/, 'the topics[0] fallback is gone')

  const calls = []
  const input = { projectId: 'p-c', topicId: '', createTopic: true, title: '丙的第一张卡', kind: 'feature' }
  const ok = async (name, payload) => {
    calls.push({ name, payload })
    if (name === 'create-topic') return { topics: [...TOPICS, { id: 't-other-new', title: 'x', projectId: 'p-b' }, { id: 't-c-new', title: '丙的第一张卡', projectId: 'p-c' }] }
    return { projects: [] }
  }
  await tv.createTaskWithTopic?.({ input, topics: TOPICS, callRpc: ok })
  assert.deepEqual(calls.map(c => c.name), ['create-topic', 'create-todo'])
  assert.deepEqual(calls[0].payload, { projectId: 'p-c', title: '丙的第一张卡', autopilot: false })
  assert.equal(calls[1].payload.topicId, 't-c-new', 'the card goes to the topic just created for its project')
  assert.equal('createTopic' in calls[1].payload, false, 'the page-only flag is not sent (createTodoInput has additionalProperties: false)')

  const failed = []
  await assert.rejects(async () => tv.createTaskWithTopic({ input, topics: TOPICS, callRpc: async name => { failed.push(name); return null } }), new RegExp(tv.TOPIC_NOT_CREATED))
  assert.deepEqual(failed, ['create-topic'], 'no card is sent with an empty topicId when the topic could not be created')

  const direct = []
  await tv.createTaskWithTopic?.({ input: { projectId: 'p-a', topicId: 't-a1', createTopic: false, title: '甲的卡' }, topics: TOPICS, callRpc: async (n, p) => { direct.push([n, p.topicId]) } })
  assert.deepEqual(direct, [['create-todo', 't-a1']])
  assert.match(read('src/client/App.jsx'), /onCreate=\{\(input, hooks\) => createTaskWithTopic\(\{ input, topics: state\.topics, callRpc, onTopicCreated: hooks\?\.onTopicCreated \}\)\}/)
})

test('#101 new task: a default project that differs from the open topic is said out loud', async () => {
  const other = tv.taskTopicNotice?.({ activeTopic: TOPICS[2], projectId: 'p-a', projects: PROJECTS })
  assert.match(other || '', /乙的话题/)
  assert.match(other || '', /乙项目/)
  assert.match(other || '', /甲项目/)
  const unbound = tv.taskTopicNotice?.({ activeTopic: TOPICS[1], projectId: 'p-a', projects: PROJECTS })
  assert.match(unbound || '', /没绑项目的话题」没有绑定项目/)
  assert.equal(tv.taskTopicNotice?.({ activeTopic: TOPICS[0], projectId: 'p-a', projects: PROJECTS }), null, 'same project: nothing to say')
  assert.equal(tv.taskTopicNotice?.({ activeTopic: null, projectId: 'p-a', projects: PROJECTS }), null)
  const { render } = await loadBundle()
  assert.match(render('TaskOwnerFields', ownerProps({ notice: other })), /data-testid="task-topic-notice"[\s\S]*乙的话题/)
  assert.doesNotMatch(render('TaskOwnerFields', ownerProps()), /task-topic-notice/)
})

// ---- 2. Chief reasoning effort ----------------------------------------------------------------------------

test('#101 effort: a level above the cap shows the level that really runs', () => {
  const capped = tv.chiefEffortView?.({ chiefStrictOrchestration: true, chiefEffortCap: 'medium' }, 'high')
  assert.equal(capped?.requested, 'high')
  assert.equal(capped?.effective, 'medium')
  assert.equal(capped?.limited, true)
  assert.equal(capped?.text, '生效：中（受上限限制）')
  assert.match(capped?.reason || '', /思考上限是「中」/)
  for (const lvl of ['xhigh', 'max']) assert.equal(tv.chiefEffortView({ chiefEffortCap: 'medium' }, lvl).effective, 'medium', `${lvl} is capped too (default: strict on)`)
  assert.equal(tv.chiefEffortView({}, 'max').text, '生效：中（受上限限制）', 'missing cap means the server default, medium')

  const unset = tv.chiefEffortView({ chiefEffortCap: 'medium' }, '')
  assert.equal(unset.effective, 'medium', 'an unset level is pinned to the cap')
  assert.equal(unset.limited, true)

  assert.equal(tv.chiefEffortToast?.({ chiefEffortCap: 'medium' }, 'max').includes('已切换'), false)
  assert.match(tv.chiefEffortToast({ chiefEffortCap: 'medium' }, 'max'), /已请求「最大」，生效：中（受上限限制）/)
})

test('#101 effort: within the cap, without a cap, or with strict mode off nothing is limited', () => {
  for (const [settings, lvl] of [
    [{ chiefEffortCap: 'medium' }, 'low'],
    [{ chiefEffortCap: 'medium' }, 'medium'],
    [{ chiefEffortCap: '' }, 'max'],
    [{ chiefEffortCap: 'max' }, 'max'],
    [{ chiefStrictOrchestration: false, chiefEffortCap: 'low' }, 'xhigh'],
  ]) {
    const v = tv.chiefEffortView?.(settings, lvl)
    assert.equal(v?.limited, false, JSON.stringify([settings, lvl]))
    assert.equal(v?.effective, lvl)
    assert.equal(v?.reason, '')
  }
  assert.match(tv.chiefEffortToast({ chiefEffortCap: '' }, 'high'), /^总管思考等级已设为「高」/)
})

test('#101 effort: ⌘K and the settings page both read the same view; the cap offers 最大', () => {
  assert.deepEqual(tv.EFFORT_CAP_OPTIONS?.map(o => o[0]), ['low', 'medium', 'high', 'xhigh', 'max', ''])
  assert.deepEqual(tv.EFFORT_LEVELS?.map(o => o[0]), ['low', 'medium', 'high', 'xhigh', 'max'])
  const palette = read('src/client/components/CommandPalette.jsx')
  assert.match(palette, /const effort = chiefEffortView\(state\.settings, curEffort\)/)
  assert.match(palette, /heading=\{`快速切换总管思考等级 · \$\{effort\.text\}`\}/)
  assert.match(palette, /effort\.limited && \(\s*<Command\.Item[\s\S]{0,80}onOpenSettingsTab\('chief'\)/, 'a limited level links to the cap setting')
  assert.doesNotMatch(palette, /<span>当前<\/span>/, 'the bare 当前 mark is gone')
  const settings = read('src/client/components/SettingsPanel.jsx')
  assert.match(settings, /const chiefEffort = chiefEffortView\(state\.settings, chiefAgent\?\.reasoningEffort \|\| ''\)/)
  assert.match(settings, /data-testid="chief-effort-effective"/)
  assert.match(settings, /EFFORT_CAP_OPTIONS\.map\(/)
  assert.match(read('src/client/App.jsx'), /chiefEffortToast\(state\.settings, lvl\)/)
  assert.doesNotMatch(read('src/client/App.jsx'), /总管思考等级已切换为/)
})

// ---- 3. Stall thresholds ----------------------------------------------------------------------------------

test('#101 stall thresholds: contradictory sets are refused with a message per field', () => {
  const same = tv.validateStallDraft?.({ warn: '30', heal: '30', cooldown: '5' })
  assert.equal(same?.ok, false)
  assert.equal(same?.patch, null)
  assert.match(same?.errors.warn || '', /提示阈值必须小于自动退回阈值/)
  assert.match(same?.errors.heal || '', /自动退回阈值必须大于提示阈值/)
  assert.equal(tv.validateStallDraft({ warn: '40', heal: '20', cooldown: '5' }).ok, false)

  for (const cooldown of ['0', '0.5', '-1']) {
    const c = tv.validateStallDraft({ warn: '10', heal: '30', cooldown })
    assert.equal(c.ok, false, `cooldown ${cooldown}`)
    assert.match(c.errors.cooldown, /不能小于 60 秒/)
    assert.equal(c.errors.warn, undefined)
  }
  assert.equal(tv.validateStallDraft({ warn: '', heal: '30', cooldown: '5' }).ok, false)
  assert.equal(tv.validateStallDraft({ warn: '10', heal: '9999', cooldown: '5' }).ok, false)
  assert.equal(tv.validateStallDraft({ warn: '10.5', heal: '30', cooldown: '5' }).ok, false)
})

test('#101 stall thresholds: a consistent set is saved as typed, and the save re-checks', () => {
  const ok = tv.validateStallDraft?.({ warn: '10', heal: '30', cooldown: '1' })
  assert.deepEqual(ok, { ok: true, errors: {}, patch: { buildStallWarnMs: 600000, buildStallHealMs: 1800000, buildStallCooldownMs: 60000 } })
  assert.equal(tv.validateStallDraft({ warn: '29', heal: '30', cooldown: '60' }).ok, true)
  const settings = read('src/client/components/SettingsPanel.jsx')
  assert.match(settings, /const saveStall = \(\) => \{[\s\S]{0,200}const check = validateStallDraft\([^)]*\)\s*if \(!check\.ok\) return\s*void onSaveSettings\(check\.patch\)/)
  assert.match(settings, /<DraftActions id="build-stall" dirty=\{stallDirty\} invalid=\{!stallCheck\.ok\} onSave=\{saveStall\}/)
  for (const key of ['warn', 'heal', 'cooldown']) assert.match(settings, new RegExp(`data-testid="error-build-stall-${key}"`))
  assert.doesNotMatch(settings, /Math\.max\(5, Math\.floor\(Number\(stallHealDraft\)/, 'the silent clamp-and-save path is gone')
})

// ---- 4. Settings: one way to save, and when it applies -----------------------------------------------------

test('#101 settings: drafts share one 未保存 / 保存 / 重置 control and each setting says when it applies', async () => {
  const { render } = await loadBundle()
  const dirty = render('DraftActions', { id: 'x', dirty: true, onSave() {}, onReset() {} })
  assert.match(dirty, /data-testid="unsaved-x"[^>]*>未保存</)
  assert.doesNotMatch(dirty, /disabled/)
  const clean = render('DraftActions', { id: 'x', dirty: false, onSave() {}, onReset() {} })
  assert.doesNotMatch(clean, /未保存/)
  assert.equal((clean.match(/disabled=""/g) || []).length, 2, 'nothing to save or reset')
  const invalid = render('DraftActions', { id: 'x', dirty: true, invalid: true, onSave() {}, onReset() {} })
  assert.match(invalid, /<button[^>]*disabled=""[^>]*data-testid="btn-save-x"/, 'an invalid draft cannot be saved')
  assert.doesNotMatch(invalid, /<button[^>]*disabled=""[^>]*data-testid="btn-reset-x"/, 'but it can be reset')

  const settings = read('src/client/components/SettingsPanel.jsx')
  const ids = [...settings.matchAll(/<DraftActions\s+id="([^"]+)"/g)].map(m => m[1]).sort()
  assert.deepEqual(ids, ['build-stall', 'charter', 'clone-root', 'session-category'])
  const notes = [...settings.matchAll(/<EffectNote id="([^"]+)"/g)].map(m => m[1])
  for (const id of notes) assert.ok(String(tv.SETTING_EFFECT?.[id] || '').length > 8, `effect note ${id} has a text`)
  assert.deepEqual([...new Set(notes)].sort(), Object.keys(tv.SETTING_EFFECT || {}).sort(), 'every note is used and every use has a note')
  for (const id of ['charter', 'cloneRoot', 'sessionCategory', 'stall']) assert.match(tv.SETTING_EFFECT[id], /^点「保存」后写入/)
  for (const id of ['chiefModel', 'chiefStrict', 'concurrency', 'notify', 'stallSwitch']) assert.match(tv.SETTING_EFFECT[id], /^即改即存/)
  assert.match(render('EffectNote', { id: 'charter' }), /下一轮总管回复起生效/)
  const cloneInput = /placeholder="例如：\/path\/to\/projects[\s\S]*?\/>/.exec(settings)
  assert.ok(cloneInput)
  assert.doesNotMatch(cloneInput[0], /onBlur/, 'the clone root no longer saves by itself when the field loses focus')
})

// ---- 5. Lane name, count and card status ------------------------------------------------------------------

test('#101 board: the lane name, its count and the card status use one wording', async () => {
  assert.deepEqual(tv.LANE_LABEL, { todo: '待开始', doing: '执行中', confirm: '待处理', done: '已完成' })
  const cards = [{ gateOwner: 'human' }, { gateOwner: 'chief' }, { gateOwner: 'chief' }]
  assert.deepEqual(tv.confirmLaneCounts?.(cards, [{ id: 'tp' }]), { total: 4, human: 2, chief: 2 })
  assert.deepEqual(tv.confirmLaneCounts([], []), { total: 0, human: 0, chief: 0 })

  const board = read('src/client/components/KanbanBoard.jsx')
  assert.match(board, /\{ id: 'confirm', label: LANE_LABEL\.confirm,/)
  assert.match(board, /shownCount: totalInLane,/, 'phone tab count = cards in the lane')
  assert.match(board, /data-testid=\{`lane-count-\$\{col\.id\}`\}\s*>\s*\{totalInLane\}/, 'head count = cards in the lane')
  assert.doesNotMatch(board, /chiefPlusCount/, 'the separate +N is gone')
  assert.doesNotMatch(board, /待你处理/)
  assert.match(board, /\{ value: 'todo', label: LANE_LABEL\.todo \}/, 'the stage filter uses the lane word')

  const utils = await import(pathToFileURL(join(pkgRoot, 'src/client/utils.js')).href)
  assert.equal(utils.getTodoCardStateMeta({ phase: 'todo', evidence: {} }).statusText, '待开始')
  for (const f of ['src/client/utils.js', 'src/client/components/KanbanBoard.jsx', 'src/client/components/ProjectWorkspace.jsx']) {
    assert.doesNotMatch(read(f), /待派发/, `${f} has no second word for the same state`)
  }
})

// ---- 6. First-run guide -----------------------------------------------------------------------------------

test('#101 guide: an engine that is not installed blocks 下一步 until the consequence is accepted', () => {
  const engines = [{ id: 'hermes', installed: true }, { id: 'codex', installed: false }, { id: 'grok', installed: false }]
  assert.equal(tv.onboardingEngineGate?.({ engines, engineId: 'hermes' }).blocked, false)
  const gate = tv.onboardingEngineGate?.({ engines, engineId: 'codex' })
  assert.equal(gate?.blocked, true)
  assert.match(gate?.guide || '', /安装/)
  assert.match(gate?.consequence || '', /总管每次启动都会失败/)
  assert.equal(tv.onboardingEngineGate({ engines, engineId: 'codex', acknowledgedId: 'codex' }).blocked, false)
  assert.equal(tv.onboardingEngineGate({ engines, engineId: 'grok', acknowledgedId: 'codex' }).blocked, true, 'accepting one engine does not unlock another')
  assert.equal(tv.onboardingEngineGate({ engines, engineId: 'unknown' }).blocked, true)

  const wiz = read('src/client/components/OnboardingWizard.jsx')
  assert.match(wiz, /const goNext = \(\) => \{[\s\S]{0,160}if \(engineGate\.blocked\) return\s*setStep\(s => s \+ 1\)/)
  assert.match(wiz, /onClick=\{goNext\}\s*disabled=\{engineGate\.blocked\}/)
  assert.match(wiz, /disabled=\{saving \|\| busy \|\| engineGate\.blocked\}/, 'finish is blocked as well')
  assert.match(wiz, /disabled=\{s\.id > step && engineGate\.blocked\}/, 'and so is jumping ahead in the stepper')
  assert.match(wiz, /data-testid="btn-onboard-engine-ack"/)
  const close = /<button[^>]*onClick=\{\(\) => finishOnboarding\(true\)\}[^>]*aria-label="([^"]+)"/.exec(wiz.replace(/\n\s*/g, ' '))
  assert.equal(close?.[1], '跳过引导并标记为已完成', 'the close button is named after what it does')
})

test('#101 guide: a failed model catalog is an error with a retry, never 可选 0 个', () => {
  // The catalog error + retry itself is #100's (LoadError); this card only keeps it through the merge and
  // resets the retry counter when another engine is picked.
  const wiz = read('src/client/components/OnboardingWizard.jsx')
  assert.doesNotMatch(wiz, /\.catch\(\(\) => \{\}\)/, 'the catalog error is not swallowed')
  assert.match(wiz, /data-testid="onboard-catalog-status">首选模型（\{loadingCat \? '读取中…' : catalogError \? '读取失败' :/)
  assert.match(wiz, /<LoadError message=\{catalogError\} onRetry=\{\(\) => setCatalogTry\(n => n \+ 1\)\}[^>]*testId="onboarding-catalog-error"/)
  assert.equal((wiz.match(/setCatalogError\(/g) || []).length, 2, 'one reset and one failure path: no second error mechanism')
  assert.match(fnBody(wiz, 'const selectEngine = engId => {').slice(0, 400), /setUninstalledAck\(''\)\s*setCatalogTry\(0\)/)
})

// ---- 7. Empty states --------------------------------------------------------------------------------------

test('#101 empty states: board lanes, the conversation and the search each offer something to click', async () => {
  const { render } = await loadBundle()
  const todoLane = render('LaneEmpty', { laneId: 'todo', hasFilters: false, boardEmpty: true, onCreate() {}, onClearFilters() {} })
  assert.match(todoLane, /看板还是空的/)
  assert.match(todoLane, /<button[^>]*data-testid="lane-empty-action-todo"[^>]*>[\s\S]*新建任务/)
  const filtered = render('LaneEmpty', { laneId: 'done', hasFilters: true, boardEmpty: false, onCreate() {}, onClearFilters() {} })
  assert.match(filtered, /<button[^>]*data-testid="lane-empty-action-done"[^>]*>[\s\S]*清除筛选/)
  for (const laneId of ['todo', 'doing', 'confirm', 'done']) {
    const v = tv.laneEmptyView({ laneId, hasFilters: false, boardEmpty: false })
    assert.ok(v.text.length > 8 && !/^暂无/.test(v.text), `${laneId}: more than 暂无`)
  }
  assert.doesNotMatch(read('src/client/components/KanbanBoard.jsx'), /暂无任务/)

  const chat = render('EmptyChatNext', { onPickExample() {}, onOpenCreateTask() {} })
  assert.match(chat, /下一步：在下方说一句目标/)
  assert.equal((chat.match(/data-testid="empty-chat-example"/g) || []).length, 2)
  assert.match(chat, /data-testid="empty-chat-new-task"/)
  assert.match(read('src/client/components/ChatPane.jsx'), /<EmptyChatNext\s+onPickExample=\{text => \{ setDraft\(text\); textareaRef\.current\?\.focus\(\) \}\}/)

  const view = tv.paletteEmptyView?.({ query: ' 找不到的词 ', mode: 'all', topicLimit: 10, todoLimit: 12 })
  assert.equal(view?.title, '没有找到「找不到的词」')
  assert.match(view?.scope || '', /最近 10 个话题的标题、最近 12 张任务的标题和编号/)
  assert.match(tv.paletteEmptyView({ query: 'x', mode: 'tasks', topicLimit: 10, todoLimit: 60 }).scope, /最近 60 张任务/)
  const palette = read('src/client/components/CommandPalette.jsx')
  assert.doesNotMatch(palette, /未找到匹配项/)
  for (const id of ['cmdk-empty-new-task', 'cmdk-empty-new-topic', 'cmdk-empty-clear']) assert.match(palette, new RegExp(`data-testid="${id}"`))
})

// ---- 8. Search entries ------------------------------------------------------------------------------------

test('#101 search: touch screens get no ⌘ hint; desktop keeps its shortcuts', () => {
  for (const mode of ['all', 'tasks', 'topics']) {
    const t = tv.paletteHints?.({ touch: true, mode })
    assert.ok(t, 'paletteHints exists')
    assert.doesNotMatch([t.placeholder, t.searchLabel, ...t.foot].join(' '), /⌘|ESC|↵|↑↓/, `${mode}: no keyboard hint on touch`)
    assert.ok(t.foot.some(x => x.includes('点此搜索')))
    const d = tv.paletteHints({ touch: false, mode })
    assert.match(d.placeholder, /⌘[KPJ]/)
    assert.ok(d.foot.includes('⌘P 任务'))
  }
  assert.equal(tv.isTouchDevice?.({ matchMedia: q => ({ matches: q === '(pointer: coarse)' }) }), true)
  assert.equal(tv.isTouchDevice({ matchMedia: () => ({ matches: false }) }), false)
  assert.equal(tv.isTouchDevice({}), false)
  assert.equal(tv.isTouchDevice({ matchMedia() { throw new Error('x') } }), false)
  const palette = read('src/client/components/CommandPalette.jsx')
  assert.match(palette, /\{hints\.foot\.map\(text => <span key=\{text\}>\{text\}<\/span>\)\}/)
  assert.match(palette, /placeholder=\{hints\.placeholder\}/)
  assert.match(palette, /\{!isTouch && <kbd className="ot-kbd">ESC<\/kbd>\}/)
})

test('#101 search: the board head always shows a search box and the phone bar has a search button', () => {
  const board = read('src/client/components/KanbanBoard.jsx')
  const head = board.slice(board.indexOf('data-testid="board-search"'), board.indexOf('<TodosFilterPopover\n            open={filterOpen}'))
  assert.ok(head.length > 0, 'the box sits in the board head, before the filter popover')
  assert.match(head, /value=\{filters\.search\}\s*onChange=\{e => updateFilter\('search', e\.target\.value\)\}/, 'it drives the existing filter')
  const app = read('src/client/App.jsx')
  const bar = app.slice(app.indexOf('className="ot-mobile-bar"'), app.indexOf('<HomeQuotaStrip'))
  assert.match(bar, /onClick=\{\(\) => \{ setCmdkMode\('all'\); setCmdkOpen\(true\) \}\}[\s\S]*?data-testid="btn-mobile-search"/)
})

// ---- Round 2: #100's "close only after the card exists" survives the topic step ---------------------------

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
// A callRpc with the contract of App.callRpc: a refused call resolves null and reports through onError.
const fakeCallRpc = script => {
  const calls = []
  const callRpc = async (name, input, toast, { onError } = {}) => {
    calls.push({ name, input, toast })
    const step = script.shift()
    if (!step) throw new Error('unexpected call ' + name)
    assert.equal(step.name, name, 'call order')
    if (step.error) { onError?.(new Error(step.error)); return null }
    return step.result
  }
  return { calls, callRpc }
}
async function mountTaskDialog(script, topics = TOPICS) {
  const mod = await loadClient({ CreateTaskDialog: 'components/Dialogs.jsx' })
  const state = { closed: 0, topics }
  const rpc = fakeCallRpc(script)
  const element = () => mod.React.createElement(mod.CreateTaskDialog, {
    open: true, busy: false, projects: PROJECTS, agents: [], topics: state.topics,
    defaultProjectId: 'p-c', defaultTopicId: 't-a1',
    onClose: () => { state.closed += 1 }, onNeedProject() {},
    onCreate: (input, hooks) => tv.createTaskWithTopic({ input, topics: state.topics, callRpc: rpc.callRpc, onTopicCreated: hooks?.onTopicCreated }),
  })
  const v = await mountElement(mod, element())
  const form = walk(v.container).find(n => n.localName === 'form')
  return { mod, v, form, state, rpc, rerender: () => v.rerender(element()) }
}
// The minimal DOM has no select.value: React marks the chosen <option> with `selected`.
const picked = sel => walk(sel).find(o => o.localName === 'option' && o.selected === true)?.getAttribute('value')
const C_TOPIC = { id: 't-c-new', title: '丙的第一张卡', projectId: 'p-c' }

test('#101 r2: 新建话题 chosen and the topic cannot be created → dialog stays open, input kept, reason shown', async () => {
  const d = await mountTaskDialog([
    { name: 'create-topic', error: '数据库忙，话题没有写入' },
    { name: 'create-topic', result: { topics: [...TOPICS] } },
  ])
  try {
    assert.equal(picked(d.v.q('select-task-topic')), tv.NEW_TOPIC_CHOICE, 'project 丙 has no topic: 新建话题 is selected')
    await d.v.input(d.v.q('input-task-title'), '丙的第一张卡')
    await d.v.input(d.v.q('input-task-spec'), '只改 README')
    await d.v.submit(d.form)
    assert.deepEqual(d.rpc.calls.map(c => c.name), ['create-topic'], 'no card is sent after a failed topic')
    assert.equal(d.state.closed, 0, 'a failed topic does not close the dialog')
    assert.equal(d.v.q('input-task-title').value, '丙的第一张卡')
    assert.equal(d.v.q('input-task-spec').value, '只改 README')
    assert.match(d.v.q('create-task-error').textContent, /数据库忙，话题没有写入/)
    assert.equal(d.v.q('btn-submit-task').disabled, false, 'the user can retry')

    // The call answers, but no topic of this project came back: still a failure, with its own reason.
    await d.v.submit(d.form)
    assert.deepEqual(d.rpc.calls.map(c => c.name), ['create-topic', 'create-topic'])
    assert.equal(d.state.closed, 0)
    assert.equal(d.v.q('input-task-title').value, '丙的第一张卡')
    assert.equal(d.v.q('create-task-error').textContent.includes(tv.TOPIC_NOT_CREATED), true)
  } finally { await d.v.unmount() }
})

test('#101 r2: 新建话题 chosen and the topic is created → the card is created on it and the dialog closes', async () => {
  const d = await mountTaskDialog([
    { name: 'create-topic', result: { topics: [...TOPICS, C_TOPIC] } },
    { name: 'create-todo', result: { projects: [] } },
  ])
  try {
    await d.v.input(d.v.q('input-task-title'), '丙的第一张卡')
    await d.v.submit(d.form)
    assert.deepEqual(d.rpc.calls.map(c => c.name), ['create-topic', 'create-todo'])
    assert.equal(d.rpc.calls[1].input.topicId, 't-c-new')
    assert.equal(d.rpc.calls[1].input.projectId, 'p-c')
    assert.equal('createTopic' in d.rpc.calls[1].input, false)
    assert.equal(d.state.closed, 1, 'closed once the card exists')
    assert.equal(d.v.q('input-task-title').value, '', 'form cleared after success')
    assert.equal(d.v.q('create-task-error'), null)
  } finally { await d.v.unmount() }
})

test('#101 r2: topic created but the card is refused → stays open, and the retry reuses that topic', async () => {
  const d = await mountTaskDialog([
    { name: 'create-topic', result: { topics: [...TOPICS, C_TOPIC] } },
    { name: 'create-todo', error: '项目仓库不可用' },
    { name: 'create-todo', result: { projects: [] } },
  ])
  try {
    await d.v.input(d.v.q('input-task-title'), '丙的第一张卡')
    await d.v.submit(d.form)
    assert.equal(d.state.closed, 0)
    assert.match(d.v.q('create-task-error').textContent, /项目仓库不可用/)
    assert.equal(d.v.q('input-task-title').value, '丙的第一张卡')
    d.state.topics = [...TOPICS, C_TOPIC] // the snapshot of create-topic reached the page
    await d.rerender()
    assert.equal(picked(d.v.q('select-task-topic')), 't-c-new', 'the select moved to the topic that now exists')
    await d.v.submit(d.form)
    assert.deepEqual(d.rpc.calls.map(c => c.name), ['create-topic', 'create-todo', 'create-todo'], 'no second topic')
    assert.equal(d.rpc.calls[2].input.topicId, 't-c-new')
    assert.equal(d.state.closed, 1)
  } finally { await d.v.unmount() }
})

test('#101 r2: an existing topic and a refused card → #100 behaviour unchanged; the dialog waits for the answer', async () => {
  const mod = await loadClient({ CreateTaskDialog: 'components/Dialogs.jsx' })
  let closed = 0
  const pending = []
  const seen = []
  const callRpc = async (name, input, toast, { onError } = {}) => {
    seen.push([name, input.topicId])
    const gate = deferred(); pending.push(gate)
    const out = await gate.promise
    if (out.error) { onError?.(new Error(out.error)); return null }
    return out.result
  }
  const v = await mountElement(mod, mod.React.createElement(mod.CreateTaskDialog, {
    open: true, busy: false, projects: PROJECTS, agents: [], topics: TOPICS, defaultProjectId: 'p-a', defaultTopicId: 't-a2',
    onClose: () => { closed += 1 }, onNeedProject() {},
    onCreate: (input, hooks) => tv.createTaskWithTopic({ input, topics: TOPICS, callRpc, onTopicCreated: hooks?.onTopicCreated }),
  }))
  try {
    await v.input(v.q('input-task-title'), '甲的卡')
    const form = walk(v.container).find(n => n.localName === 'form')
    await v.submit(form)
    assert.deepEqual(seen, [['create-todo', 't-a2']])
    assert.equal(closed, 0, 'not closed before the server answered')
    assert.equal(v.q('btn-submit-task').disabled, true)
    assert.equal(v.q('input-task-title').value, '甲的卡', 'input kept while creating')
    await mod.React.act(async () => { pending[0].resolve({ error: '并发槽位异常' }) })
    await v.settle()
    assert.equal(closed, 0)
    assert.match(v.q('create-task-error').textContent, /并发槽位异常/)
    assert.equal(v.q('input-task-title').value, '甲的卡')
    await v.submit(form)
    await mod.React.act(async () => { pending[1].resolve({ result: { projects: [] } }) })
    await v.settle()
    assert.equal(closed, 1)
  } finally { await v.unmount() }
})

test('#101 r2: createTaskWithTopic never resolves for a card that was not created', async () => {
  const base = { projectId: 'p-c', topicId: '', createTopic: true, title: '丙的第一张卡' }
  const run = script => { const r = fakeCallRpc(script); return [r, tv.createTaskWithTopic({ input: base, topics: TOPICS, callRpc: r.callRpc })] }
  await assert.rejects(run([{ name: 'create-topic', error: '被拒' }])[1], /被拒/)
  await assert.rejects(run([{ name: 'create-topic', result: null }])[1], new RegExp(tv.TOPIC_NOT_CREATED), 'a null answer (repeated click dropped by the gate) is not a success')
  await assert.rejects(run([{ name: 'create-topic', result: { topics: [...TOPICS, { id: 'x', projectId: 'p-b' }] } }])[1], new RegExp(tv.TOPIC_NOT_CREATED), 'a new topic of another project is not used')
  await assert.rejects(run([{ name: 'create-topic', result: { topics: [...TOPICS, C_TOPIC] } }, { name: 'create-todo', error: '卡被拒' }])[1], /卡被拒/)
  const [okRpc, okP] = run([{ name: 'create-topic', result: { topics: [...TOPICS, C_TOPIC] } }, { name: 'create-todo', result: { projects: [] } }])
  assert.deepEqual(await okP, { projects: [] })
  assert.equal(okRpc.calls[1].input.topicId, 't-c-new')
  const dlg = fnBody(read('src/client/components/Dialogs.jsx'), 'export function CreateTaskDialog(')
  assert.match(dlg, /const out = await settleAction\(\(\) => onCreate\(\{[\s\S]*?\}, \{ onTopicCreated: setTopicChoice \}\), '任务没有创建成功，请重试。'\)\s*setSubmitting\(false\)\s*if \(!out\.ok\) \{ setCreateError\(out\.error\); return \}\s*setTitle\(''\)\s*setSpec\(''\)\s*onClose\(\)/)
})

test('#101 r2: the effective-effort rule names the server lines it mirrors', () => {
  const src = read('src/client/trust-view.js')
  const i = src.indexOf('export function chiefEffortView')
  const doc = src.slice(src.lastIndexOf('/**', i), i)
  assert.match(doc, /规则复制自服务端，服务端变更需同步/)
  assert.match(doc, /src\/server\/orchestrator\.mjs:\d+/)
  assert.match(doc, /src\/shared\/chief-guard\.mjs:\d+/)
  // The named symbols still exist on the server side; if one is renamed or removed this fails and the copy is re-read.
  assert.match(read('src/server/orchestrator.mjs'), /const capChiefCfg = cfg => \(settings\.chiefStrictOrchestration !== false && settings\.chiefEffortCap\s*\? \{ \.\.\.cfg, reasoningEffort: capReasoningEffort\(cfg\.reasoningEffort, settings\.chiefEffortCap\) \}/)
  assert.match(read('src/server/db.mjs'), /chiefEffortCap: normalizeEffortCap\(row\.chief_effort_cap \?\? 'medium'\)/)
})
