// 0.9.71 (#94): worktree dependency bootstrap links nested dependency directories
// (static `backend/engines/node/node_modules` + bounded auto-discovery, depth <= 4, at most 12 links).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKTREE_BOOTSTRAP_LIMITS,
  bootstrapWorktreeDependencies,
  cleanupBootstrapSymlinks,
  readWorktreeState,
} from '../src/server/git-engine.mjs'

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

function put(root, rel, content = 'x') {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

/**
 * Builds a main repo with `.gitignore` (node_modules/, .venv/, venv/), commits `trackedFiles`,
 * creates the gitignored `deps` (each gets a marker file) and adds a worktree. Returns paths.
 */
function fixture({ trackedFiles = [], deps = [], forceTracked = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'v0971-deps-'))
  const repo = join(root, 'main')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  put(repo, '.gitignore', 'node_modules/\n.venv/\nvenv/\n')
  put(repo, 'README.md', 'fixture\n')
  for (const rel of trackedFiles) put(repo, rel, `tracked ${rel}\n`)
  for (const rel of forceTracked) put(repo, rel, `force ${rel}\n`)
  git(repo, 'add', '-A')
  for (const rel of forceTracked) git(repo, 'add', '-f', rel)
  git(repo, 'commit', '-q', '-m', 'init')
  for (const rel of deps) put(repo, `${rel}/marker.txt`, `marker ${rel}\n`)
  const wt = join(root, 'wts', 'wt1')
  mkdirSync(join(root, 'wts'))
  git(repo, 'worktree', 'add', '-q', '-b', 'wt1', wt, 'main')
  return { root, repo, wt, done: () => rmSync(root, { recursive: true, force: true }) }
}

const isLink = (p) => {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

test('#94-1 static list has backend/engines/node/node_modules and links it into the worktree', async () => {
  assert.ok(WORKTREE_BOOTSTRAP_LIMITS.candidates.includes('backend/engines/node/node_modules'))
  const f = fixture({ trackedFiles: ['backend/engines/node/package.json'], deps: ['backend/engines/node/node_modules'] })
  try {
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.ok(linked.includes('backend/engines/node/node_modules'), JSON.stringify(linked))
    const p = join(f.wt, 'backend/engines/node/node_modules')
    assert.equal(isLink(p), true)
    assert.equal(readFileSync(join(p, 'marker.txt'), 'utf8'), 'marker backend/engines/node/node_modules\n')
  } finally {
    f.done()
  }
})

test('#94-2 auto-discovery links a nested dependency directory that is not in the static list', async () => {
  assert.ok(!WORKTREE_BOOTSTRAP_LIMITS.candidates.includes('a/b/c/node_modules'))
  const f = fixture({ trackedFiles: ['a/b/c/package.json'], deps: ['a/b/c/node_modules'] })
  try {
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.deepEqual(linked, ['a/b/c/node_modules'])
    assert.equal(readFileSync(join(f.wt, 'a/b/c/node_modules/marker.txt'), 'utf8'), 'marker a/b/c/node_modules\n')
  } finally {
    f.done()
  }
})

test('#94-3 depth limit: a fifth-level dependency directory is not linked', async () => {
  assert.equal(WORKTREE_BOOTSTRAP_LIMITS.maxDepth, 4)
  const f = fixture({ trackedFiles: ['a/b/c/d/package.json'], deps: ['a/b/c/d/node_modules'] })
  try {
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.deepEqual(linked, [])
    assert.equal(existsSync(join(f.wt, 'a/b/c/d/node_modules')), false)
  } finally {
    f.done()
  }
})

test('#94-4 safety: a tracked directory named node_modules is never linked', async () => {
  // both dirs match the ignore pattern but have committed files (git add -f), at depth 2 and depth 4
  const f = fixture({
    trackedFiles: ['pkg/package.json', 'x/y/plain/package.json'],
    forceTracked: ['pkg/node_modules/keep.js', 'x/y/plain/node_modules/keep.js'],
  })
  try {
    // simulate a worktree where the tracked dirs are missing on disk: only the git guards may stop the link
    rmSync(join(f.wt, 'pkg/node_modules'), { recursive: true, force: true })
    rmSync(join(f.wt, 'x/y/plain/node_modules'), { recursive: true, force: true })
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.deepEqual(linked, [])
    assert.equal(isLink(join(f.wt, 'pkg/node_modules')), false)
    assert.equal(isLink(join(f.wt, 'x/y/plain/node_modules')), false)
  } finally {
    f.done()
  }
})

test('#94-5 discovery cap: more nested dependency dirs than the cap never exceed it and do not throw', async () => {
  const cap = WORKTREE_BOOTSTRAP_LIMITS.maxDiscovered
  assert.equal(cap, 12)
  const names = Array.from({ length: cap + 5 }, (_, i) => `pkgs/p${String(i).padStart(2, '0')}`)
  const f = fixture({ trackedFiles: names.map(n => `${n}/package.json`), deps: names.map(n => `${n}/node_modules`) })
  try {
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.equal(linked.length, cap)
    assert.deepEqual(linked, names.slice(0, cap).map(n => `${n}/node_modules`))
  } finally {
    f.done()
  }
})

test('#94-6 git status stays clean and the worktree tree snapshot ignores the links', async () => {
  const f = fixture({
    trackedFiles: ['backend/engines/node/package.json', 'a/b/c/package.json'],
    deps: ['backend/engines/node/node_modules', 'a/b/c/node_modules'],
  })
  try {
    const before = await readWorktreeState({ worktreePath: f.wt })
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.equal(linked.length, 2)
    assert.equal(git(f.wt, 'status', '--porcelain'), '')
    const s1 = await readWorktreeState({ worktreePath: f.wt })
    const s2 = await readWorktreeState({ worktreePath: f.wt })
    assert.equal(s1.treeSha, s2.treeSha)
    assert.equal(s1.treeSha, before.treeSha)
    assert.equal(s1.treeSha, git(f.wt, 'rev-parse', 'HEAD^{tree}').trim())
  } finally {
    f.done()
  }
})

test('#94-7 cleanup removes only the links; the main repository dependency dirs survive', async () => {
  const f = fixture({
    trackedFiles: ['backend/engines/node/package.json', 'a/b/c/package.json'],
    deps: ['backend/engines/node/node_modules', 'a/b/c/node_modules'],
  })
  try {
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.equal(linked.length, 2)
    cleanupBootstrapSymlinks(f.wt)
    for (const rel of linked) {
      assert.equal(existsSync(join(f.wt, rel)), false, `${rel} link should be gone`)
      assert.equal(readFileSync(join(f.repo, rel, 'marker.txt'), 'utf8'), `marker ${rel}\n`)
    }
  } finally {
    f.done()
  }
})

test('#94-8 regression: frontend/node_modules and backend/.venv are still linked', async () => {
  const f = fixture({
    trackedFiles: ['frontend/package.json', 'backend/pyproject.toml'],
    deps: ['frontend/node_modules', 'backend/.venv'],
  })
  try {
    const linked = await bootstrapWorktreeDependencies(f.repo, f.wt)
    assert.deepEqual([...linked].sort(), ['backend/.venv', 'frontend/node_modules'])
    assert.equal(isLink(join(f.wt, 'frontend/node_modules')), true)
    assert.equal(isLink(join(f.wt, 'backend/.venv')), true)
    // static entries are not linked a second time by the discovery pass
    assert.equal(new Set(linked).size, linked.length)
  } finally {
    f.done()
  }
})

test('#94-9 reused worktree: a second bootstrap keeps earlier links in the manifest', async () => {
  const f = fixture({ trackedFiles: ['frontend/package.json', 'a/b/c/package.json'], deps: ['frontend/node_modules'] })
  try {
    assert.deepEqual(await bootstrapWorktreeDependencies(f.repo, f.wt), ['frontend/node_modules'])
    put(f.repo, 'a/b/c/node_modules/marker.txt', 'late\n')
    assert.deepEqual(await bootstrapWorktreeDependencies(f.repo, f.wt), ['a/b/c/node_modules'])
    const manifest = JSON.parse(readFileSync(join(f.root, 'wts', '.wt-links-wt1.json'), 'utf8'))
    assert.deepEqual([...manifest].sort(), ['a/b/c/node_modules', 'frontend/node_modules'])
    assert.equal(git(f.wt, 'status', '--porcelain'), '')
  } finally {
    f.done()
  }
})
