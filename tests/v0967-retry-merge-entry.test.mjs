// Todo #63 (C09): a card whose merge failed is told 「处理后可调用 retry_merge 回到合并关口，审查结论保留」
// (orchestrator.mjs mergeBuild failText), but the drawer offered only 标记完成 / 从头重跑 / 原地继续重试, and
// 从头重跑 (retry_fresh) throws the review verdict away. The drawer now offers 「回到合并关口（保留审查结论）」,
// which calls the existing retry-merge RPC.
//
// Visibility follows the server's real preconditions (orchestrator.mjs retryMerge): phase failed, gateKind
// failed, lastError starting with 合并失败, branch and worktreePath set. The worktree directory check can only be
// made on the server; its refusal reason is shown in the drawer.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = new URL('../', import.meta.url).pathname

function clientFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...clientFiles(p))
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(p)
  }
  return out
}
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('src/client calls the retry-merge RPC', () => {
  const hits = clientFiles(join(pkgRoot, 'src/client'))
    .filter(f => /callRpc\(\s*'retry-merge'|rpc\.call\(\s*'retry-merge'/.test(stripComments(readFileSync(f, 'utf8'))))
  assert.ok(hits.length >= 1, 'no call to retry-merge in src/client')
  const app = stripComments(readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8'))
  assert.match(app, /onRetryMerge=\{/, 'App passes onRetryMerge to TodoDrawer')
})

let mod = null
let workDir = ''
async function load() {
  if (mod) return mod
  workDir = mkdtempSync(join(tmpdir(), 'ekko-retry-merge-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import * as Drawer from ${JSON.stringify(join(pkgRoot, 'src/client/components/TodoDrawer.jsx'))}`,
    `export { React, renderToStaticMarkup, Drawer }`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'text' }, nodePaths: [join(pkgRoot, 'node_modules')], logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  mod = await import(pathToFileURL(out).href)
  return mod
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

const MERGE_FAILED = {
  id: 't1', number: 63, phase: 'failed', gateKind: 'failed', branch: 'ekko-todo/p-63', worktreePath: '/tmp/wt-63',
  lastError: '合并失败（冲突文件：CHANGELOG.md；处理后可调用 retry_merge 回到合并关口，审查结论保留）：conflict',
  evidence: { reviewVerdict: 'approved' },
}
const BUILD_FAILED = { ...MERGE_FAILED, lastError: '本轮没有产生任何提交', evidence: { reviewVerdict: 'none' } }

function renderFooter(m, todo, extra = {}) {
  const { React, renderToStaticMarkup, Drawer } = m
  assert.equal(typeof Drawer.RetryMergeAction, 'function', 'TodoDrawer exports RetryMergeAction')
  return renderToStaticMarkup(React.createElement(Drawer.RetryMergeAction, {
    todo, actionsDisabled: false, pendingAction: '', onRetryMerge() {}, ...extra,
  }))
}

test('the button renders on a merge-failed card (verdict kept) and says it keeps the verdict', async () => {
  const m = await load()
  assert.equal(m.Drawer.canRetryMerge(MERGE_FAILED), true)
  const html = renderFooter(m, MERGE_FAILED)
  const btn = html.match(/<button[^>]*data-testid="btn-retry-merge"[^>]*>([\s\S]*?)<\/button>/)
  assert.ok(btn, 'btn-retry-merge rendered')
  const label = btn[1].replace(/<[^>]+>/g, '')
  assert.match(label, /保留/, 'label says the verdict is kept')
  assert.notEqual(label, '从头重跑')
  // Wired into the failed footer, next to (not instead of) 从头重跑 / 原地继续重试.
  const drawer = stripComments(readFileSync(join(pkgRoot, 'src/client/components/TodoDrawer.jsx'), 'utf8'))
  const i = drawer.indexOf("todo.phase === 'failed' && (")
  const block = drawer.slice(i, drawer.indexOf('data-testid="btn-retry-continue"', i))
  assert.match(block, /从头重跑[\s\S]*<RetryMergeAction [^>]*onRetryMerge=\{onRetryMerge \? triggerRetryMerge : null\}/)
  assert.match(btn[0], /title="[^"]*审查结论[^"]*"/, 'tooltip explains the difference')
})

test('the button does not render where the server would refuse', async () => {
  const m = await load()
  const cases = [
    BUILD_FAILED,
    { ...MERGE_FAILED, branch: '' },
    { ...MERGE_FAILED, worktreePath: '' },
    { ...MERGE_FAILED, gateKind: 'merge' },
    { ...MERGE_FAILED, phase: 'review' },
  ]
  for (const todo of cases) {
    assert.equal(m.Drawer.canRetryMerge(todo), false, JSON.stringify(todo))
    assert.ok(!renderFooter(m, todo).includes('btn-retry-merge'), JSON.stringify(todo))
  }
})

test('busy state: pending retry_merge disables the footer and shows progress; refusal reason is shown', async () => {
  const m = await load()
  const pending = renderFooter(m, MERGE_FAILED, { actionsDisabled: true, pendingAction: 'retry_merge' })
  const btn = pending.match(/<button[^>]*data-testid="btn-retry-merge"[^>]*>([\s\S]*?)<\/button>/)
  assert.match(btn[0], /disabled=""/)
  assert.match(btn[1], /回到合并关口中…/)
  const { React, renderToStaticMarkup, Drawer } = m
  const refused = renderToStaticMarkup(React.createElement(Drawer.RetryMergeError, { message: '#63 不能重试合并：工作树已不存在' }))
  assert.match(refused, /role="alert"[^>]*data-testid="retry-merge-error"[^>]*>[^<]*工作树已不存在/)
  assert.equal(renderToStaticMarkup(React.createElement(Drawer.RetryMergeError, { message: '' })), '')
  const drawer = stripComments(readFileSync(join(pkgRoot, 'src/client/components/TodoDrawer.jsx'), 'utf8'))
  assert.match(drawer, /const triggerRetryMerge = async \(\) => \{\s*if \(!todo \|\| busy \|\| pendingAction\) return\s*setPendingAction\('retry_merge'\)/, 'retry merge has the same busy guard')
  assert.match(drawer, /catch \(err\) \{\s*setRetryMergeError\(err\?\.message/, 'refusal reason is kept for display')
  assert.match(drawer, /<RetryMergeError message=\{retryMergeError\} \/>/)
})
