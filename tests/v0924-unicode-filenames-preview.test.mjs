import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProjectTree, readProjectFile } from '../src/server/git-engine.mjs'

// Git prints non-ASCII names as C-quoted octal ("2025\345\271\264...md") unless -z is used.
// The workspace used that quoted text as the path, so opening a Chinese-named file failed with
// "fatal: path ... does not exist" and the raw git error overflowed the preview pane.

const CN_DIR = 'deliveries/202611'
const CN_NAME = '2025年度中国展览数据杭州相关情况汇报-来源说明.md'
const QUOTE_NAME = 'a "quoted" file name.txt'
const CN_BODY = '# 来源说明\n\n数据来源：中国展览数据统计报告。\n'
const QUOTE_BODY = 'quoted ok\n'

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-cn-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, CN_DIR), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test User')
  git('config', 'user.email', 'test@example.com')
  git('config', 'core.quotepath', 'true')
  writeFileSync(join(repo, CN_DIR, CN_NAME), CN_BODY, 'utf8')
  writeFileSync(join(repo, CN_DIR, QUOTE_NAME), QUOTE_BODY, 'utf8')
  writeFileSync(join(repo, '中文目录.md'), 'root\n', 'utf8')
  git('add', '-A')
  git('commit', '-m', 'init')
  return { root, repo }
}

test('v0.9.24: directory listing keeps Chinese, space and quote file names verbatim', async () => {
  const { root, repo } = initRepo()
  try {
    const top = await listProjectTree(repo, 'main', '')
    assert.ok(top.entries.some(e => e.name === '中文目录.md' && e.path === '中文目录.md'), JSON.stringify(top.entries))

    const sub = await listProjectTree(repo, 'main', CN_DIR)
    const paths = sub.entries.map(e => e.path).sort()
    assert.deepEqual(paths, [`${CN_DIR}/${QUOTE_NAME}`, `${CN_DIR}/${CN_NAME}`].sort())
    for (const e of sub.entries) {
      assert.doesNotMatch(e.path, /\\\d{3}/, `octal escape leaked into path: ${e.path}`)
      assert.ok(!e.path.startsWith('"') && !e.name.startsWith('"'), `C quoting leaked: ${e.path}`)
      assert.equal(e.type, 'file')
      assert.ok(e.size > 0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v0.9.24: the listed path reads back the real file content', async () => {
  const { root, repo } = initRepo()
  try {
    const sub = await listProjectTree(repo, 'main', CN_DIR)
    const cn = sub.entries.find(e => e.name === CN_NAME)
    const qt = sub.entries.find(e => e.name === QUOTE_NAME)
    assert.ok(cn && qt, JSON.stringify(sub.entries))
    const cnFile = await readProjectFile(repo, 'main', cn.path)
    assert.equal(cnFile.kind, 'markdown')
    assert.equal(cnFile.content, CN_BODY)
    assert.equal(cnFile.path, `${CN_DIR}/${CN_NAME}`)
    const qtFile = await readProjectFile(repo, 'main', qt.path)
    assert.equal(qtFile.content, QUOTE_BODY)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v0.9.24: a missing file returns a short Chinese error without git command, fatal text or absolute path', async () => {
  const { root, repo } = initRepo()
  try {
    let caught = null
    try {
      await readProjectFile(repo, 'main', `${CN_DIR}/"2025\\345\\271\\264.md"`)
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'missing file must reject')
    const msg = String(caught.message)
    assert.equal(msg, '这个文件打不开')
    assert.doesNotMatch(msg, /Command failed|git show|fatal|\//)
    assert.ok(!msg.includes(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v0.9.24: a file larger than the read buffer is reported as unsupported, not as a raw error', async () => {
  const { root, repo } = initRepo()
  try {
    writeFileSync(join(repo, 'big.log'), 'x'.repeat(5 * 1024 * 1024), 'utf8')
    execFileSync('git', ['add', 'big.log'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'big'], { cwd: repo })
    const big = await readProjectFile(repo, 'main', 'big.log')
    assert.equal(big.kind, 'binary')
    assert.equal(big.size, 5 * 1024 * 1024)
    assert.equal(big.content, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v0.9.24: preview pane shows only short Chinese text for any RPC failure', async () => {
  const { previewErrorText } = await import('../src/client/preview-errors.js')
  const raw = 'API Error 500: Command failed: /opt/homebrew/bin/git show main:deliveries/202611/"2025/345/271/264.md"\nfatal: path does not exist in \'main\''
  assert.equal(previewErrorText(new Error(raw)), '这个文件打不开')
  assert.equal(previewErrorText(new Error('API Error 500: {"error":"这个文件不支持预览"}')), '这个文件不支持预览')
  assert.equal(previewErrorText('这个文件打不开'), '这个文件打不开')
  assert.equal(previewErrorText(undefined), '这个文件打不开')

  const jsx = readFileSync(new URL('../src/client/components/ProjectWorkspace.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(jsx, /setFilePreview\(\{\s*error:\s*err\?\.message/, 'raw RPC message must not reach the preview pane')
  assert.match(jsx, /previewErrorText\(err\)/)
})

test('v0.9.24: preview error text wraps inside the pane instead of overflowing sideways', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.ot-proj-preview-empty\s*\{([^}]*)\}/)
  assert.ok(rule, 'missing .ot-proj-preview-empty rule')
  const body = rule[1]
  assert.match(body, /max-width:\s*100%/)
  assert.match(body, /min-width:\s*0/)
  assert.match(body, /overflow-wrap:\s*anywhere/)
  assert.match(body, /word-break:\s*break-word/)
})
