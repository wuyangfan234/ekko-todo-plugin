import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectRepo,
  parseGithubRepoInput,
  cloneGithubRepo,
  ensureWorktree,
  captureWorktreeSnapshot,
  applyDiffJsonBudget,
  mergeWorktreeBranch,
} from '../src/server/git-engine.mjs'
import { clampDiffs, fitSnapshotBudget } from '../src/server/diff-budget.mjs'

function initTempGitRepo(rootDir, folderName = 'repo') {
  const repoPath = join(rootDir, folderName)
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
  writeFileSync(join(repoPath, 'app.js'), 'export const version = 1\n', 'utf8')
  execFileSync('git', ['add', 'app.js'], { cwd: repoPath })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath })
  return repoPath
}

test('parseGithubRepoInput normalizes owner/repo, HTTPS, SSH URLs and rejects invalid paths', () => {
  assert.equal(parseGithubRepoInput('octocat/hello-world')?.nameWithOwner, 'octocat/hello-world')
  assert.equal(parseGithubRepoInput('https://github.com/octocat/hello-world.git')?.nameWithOwner, 'octocat/hello-world')
  assert.equal(parseGithubRepoInput('https://github.com/octocat/hello-world/tree/main')?.nameWithOwner, 'octocat/hello-world')
  assert.equal(parseGithubRepoInput('git@github.com:octocat/hello-world.git')?.nameWithOwner, 'octocat/hello-world')
  assert.equal(parseGithubRepoInput('../evil/repo'), null)
  assert.equal(parseGithubRepoInput('not-a-repo'), null)
})

test('git engine detects GitHub origin remote and clones or links local directory cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-gh-'))
  try {
    const bareRemote = join(root, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote])
    const srcRepo = initTempGitRepo(root, 'src')
    execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: srcRepo })
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: srcRepo })

    // Clone from file:// remote into a fresh target directory
    const clonedDir = join(root, 'cloned-app')
    const cloned = await cloneGithubRepo({
      githubRepo: 'acme/demo-app',
      cloneUrl: `file://${bareRemote}`,
      targetPath: clonedDir,
      branch: 'main',
    })
    assert.equal(cloned.cloned, true)
    assert.equal(cloned.githubRepo, 'acme/demo-app')
    assert.equal(cloned.defaultBranch, 'main')
    assert.equal(readFileSync(join(clonedDir, 'app.js'), 'utf8'), 'export const version = 1\n')

    // Re-invoking on an existing checkout links directly without failing
    const linked = await cloneGithubRepo({
      githubRepo: 'acme/demo-app',
      cloneUrl: `file://${bareRemote}`,
      targetPath: clonedDir,
    })
    assert.equal(linked.cloned, false)
    assert.equal(linked.repoPath, cloned.repoPath)

    // Detecting GitHub remote on local repo
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/demo-app.git'], { cwd: clonedDir })
    const inspected = await inspectRepo(clonedDir)
    assert.equal(inspected.githubRepo, 'acme/demo-app')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('git engine inspects repo, isolates worktree, captures shadow snapshot without dirtying main, and merges cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-git-'))
  try {
    const repoPath = initTempGitRepo(root)
    const wtRoot = join(root, 'worktrees')

    const info = await inspectRepo(repoPath)
    assert.equal(info.defaultBranch, 'main')
    assert.equal(info.isClean, true)

    const wt = await ensureWorktree({
      repoPath,
      worktreesDir: wtRoot,
      worktreeName: 'task-1',
      branchName: 'ekko-todo/task-1',
      baseBranch: 'main',
    })
    assert.ok(existsSync(wt.worktreePath))

    writeFileSync(join(wt.worktreePath, 'app.js'), 'export const version = 2\n', 'utf8')
    writeFileSync(join(wt.worktreePath, 'feature.js'), 'export const ready = true\n', 'utf8')

    const snap = await captureWorktreeSnapshot({
      repoPath,
      worktreePath: wt.worktreePath,
      baseCommit: wt.baseCommit,
      baseBranch: 'main',
      snapshotRefName: 'td-1',
    })
    assert.equal(snap.filesChanged, 2)
    assert.ok(snap.additions >= 2)
    assert.equal(snap.diffs.length, 2)

    const mainStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString().trim()
    assert.equal(mainStatus, '')
    assert.equal(readFileSync(join(repoPath, 'app.js'), 'utf8'), 'export const version = 1\n')

    const merged = await mergeWorktreeBranch({
      repoPath,
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      baseBranch: 'main',
      commitMessage: 'feat: bump version to 2',
    })
    assert.ok(merged.mergedSha.length >= 7)
    assert.equal(readFileSync(join(repoPath, 'app.js'), 'utf8'), 'export const version = 2\n')
    assert.equal(readFileSync(join(repoPath, 'feature.js'), 'utf8'), 'export const ready = true\n')
    assert.equal(existsSync(wt.worktreePath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captureWorktreeSnapshot truncates a 900k-character diff line and stays below host JSON limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-giant-line-'))
  try {
    const repoPath = initTempGitRepo(root)
    mkdirSync(join(repoPath, 'src'), { recursive: true })
    writeFileSync(join(repoPath, 'src/huge.js'), `${'a'.repeat(900000)}\n`, 'utf8')
    execFileSync('git', ['add', 'src/huge.js'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'add giant source line'], { cwd: repoPath })

    const wt = await ensureWorktree({
      repoPath,
      worktreesDir: join(root, 'worktrees'),
      worktreeName: 'giant-line',
      branchName: 'ekko-todo/giant-line',
      baseBranch: 'main',
    })
    writeFileSync(join(wt.worktreePath, 'src/huge.js'), `${'"'.repeat(900000)}\n`, 'utf8')

    const snap = await captureWorktreeSnapshot({
      repoPath,
      worktreePath: wt.worktreePath,
      baseCommit: wt.baseCommit,
      baseBranch: 'main',
      snapshotRefName: 'td-giant-line',
    })
    const diff = snap.diffs.find(d => d.path === 'src/huge.js')
    assert.ok(diff)
    assert.equal(diff.additions, 1)
    assert.equal(diff.deletions, 1)
    assert.ok(diff.hunk.length <= 20000, `hunk length was ${diff.hunk.length}`)
    assert.match(diff.hunk, /…\(line truncated, 900001 chars\)/)
    const jsonBytes = Buffer.byteLength(JSON.stringify(snap.diffs))
    assert.ok(jsonBytes < 2000000, `diff JSON was ${jsonBytes} bytes`)
    assert.ok(jsonBytes <= 200000, `diff JSON was ${jsonBytes} bytes`)

    // Capture truncation feeds, rather than bypasses, the v0.9.8 clamp and board-budget layers.
    const clamped = clampDiffs(snap.diffs)
    assert.match(clamped[0].hunk, /…\(line truncated, 900001 chars\)/)
    const board = {
      todos: [{ id: 'td-giant-line', phase: 'review', updatedAt: 1, diffs: clamped }],
      padding: 'p'.repeat(1499000),
    }
    assert.ok(Buffer.byteLength(JSON.stringify(board)) > 1500000, 'board fixture must exceed 1.5 MB')
    const fitted = fitSnapshotBudget(board)
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 1500000)
    assert.equal(fitted.todos[0].diffs[0].hunkOmitted, true)
    assert.equal(fitted.todos[0].diffs[0].additions, 1)
    assert.equal(fitted.todos[0].diffs[0].deletions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captureWorktreeSnapshot degrades giant generated bundles to readable stats-only entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-generated-'))
  try {
    const repoPath = initTempGitRepo(root)
    mkdirSync(join(repoPath, 'dist'), { recursive: true })
    writeFileSync(join(repoPath, 'dist/client.mjs'), `${'a'.repeat(900000)}\n`, 'utf8')
    execFileSync('git', ['add', 'dist/client.mjs'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'add generated bundle'], { cwd: repoPath })

    const wt = await ensureWorktree({
      repoPath,
      worktreesDir: join(root, 'worktrees'),
      worktreeName: 'generated-bundle',
      branchName: 'ekko-todo/generated-bundle',
      baseBranch: 'main',
    })
    writeFileSync(join(wt.worktreePath, 'dist/client.mjs'), `${'b'.repeat(900000)}\n`, 'utf8')

    const snap = await captureWorktreeSnapshot({
      repoPath,
      worktreePath: wt.worktreePath,
      baseCommit: wt.baseCommit,
      baseBranch: 'main',
      snapshotRefName: 'td-generated',
    })
    const diff = snap.diffs.find(d => d.path === 'dist/client.mjs')
    assert.ok(diff)
    assert.equal(diff.additions, 1)
    assert.equal(diff.deletions, 1)
    assert.equal(diff.generated, true)
    assert.equal(diff.hunk, '')
    assert.equal(diff.note, '生成或压缩文件，差异不展示')
    assert.ok(!diff.hunk.includes('b'.repeat(2001)))
    assert.ok(Buffer.byteLength(JSON.stringify(snap.diffs)) <= 200000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyDiffJsonBudget keeps all 20 minimal stats entries at the narrow byte boundary', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    path: `src/narrow-${i}-.js`,
    additions: i + 1,
    deletions: i,
    hunk: 'x'.repeat(10450),
  }))
  const out = applyDiffJsonBudget(entries)
  assert.equal(out.length, 20)
  assert.deepEqual(out[19], { path: 'src/narrow-19-.js', additions: 20, deletions: 19, hunk: '' })
  for (const [index, entry] of out.entries()) {
    assert.equal(entry.path, entries[index].path)
    assert.equal(entry.additions, entries[index].additions)
    assert.equal(entry.deletions, entries[index].deletions)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 200000)
})

test('captureWorktreeSnapshot enforces the aggregate JSON budget without losing per-file stats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-diff-budget-'))
  try {
    const repoPath = initTempGitRepo(root)
    const wt = await ensureWorktree({
      repoPath,
      worktreesDir: join(root, 'worktrees'),
      worktreeName: 'aggregate-budget',
      branchName: 'ekko-todo/aggregate-budget',
      baseBranch: 'main',
    })
    mkdirSync(join(wt.worktreePath, 'src'), { recursive: true })
    for (let file = 0; file < 20; file += 1) {
      const lines = Array.from({ length: 220 }, (_, line) => `${String(line).padStart(3, '0')}:${'x'.repeat(177)}`)
      writeFileSync(join(wt.worktreePath, `src/bulk-${file}.js`), `${lines.join('\n')}\n`, 'utf8')
    }

    const snap = await captureWorktreeSnapshot({
      repoPath,
      worktreePath: wt.worktreePath,
      baseCommit: wt.baseCommit,
      baseBranch: 'main',
      snapshotRefName: 'td-aggregate-budget',
    })
    assert.equal(snap.filesChanged, 20)
    assert.equal(snap.diffs.length, 20)
    for (const diff of snap.diffs) {
      assert.equal(diff.additions, 220)
      assert.equal(diff.deletions, 0)
      assert.ok(diff.hunk.length <= 20000, `${diff.path} hunk length was ${diff.hunk.length}`)
    }
    const jsonBytes = Buffer.byteLength(JSON.stringify(snap.diffs))
    assert.ok(jsonBytes <= 200000, `diff JSON was ${jsonBytes} bytes`)
    assert.ok(snap.diffs.some(d => d.hunk === ''), 'aggregate budget must leave a stats-only tail entry')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('captureWorktreeSnapshot diffs against the merge-base so merged-in main files are excluded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-merge-base-'))
  try {
    const repoPath = initTempGitRepo(root)
    const wt = await ensureWorktree({
      repoPath,
      worktreesDir: join(root, 'worktrees'),
      worktreeName: 'merged-main',
      branchName: 'ekko-todo/merged-main',
      baseBranch: 'main',
    })
    // main advances with a file the task branch never touched
    writeFileSync(join(repoPath, 'main-only.js'), 'export const fromMain = true\n', 'utf8')
    execFileSync('git', ['add', 'main-only.js'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'main-only change'], { cwd: repoPath })
    // task branch merges main, then the author edits one file
    execFileSync('git', ['merge', '--no-ff', '--no-edit', 'main'], { cwd: wt.worktreePath })
    writeFileSync(join(wt.worktreePath, 'app.js'), 'export const version = 2\n', 'utf8')

    const snap = await captureWorktreeSnapshot({
      repoPath,
      worktreePath: wt.worktreePath,
      baseCommit: wt.baseCommit,
      baseBranch: 'main',
      snapshotRefName: 'td-merged-main',
    })
    const paths = snap.diffs.map(d => d.path)
    assert.ok(!paths.includes('main-only.js'), `main-only file leaked into diffs: ${paths.join(', ')}`)
    assert.deepEqual(paths, ['app.js'])
    assert.equal(snap.filesChanged, 1)
    assert.equal(snap.additions, 1)
    assert.equal(snap.deletions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('git engine refuses merge when main working tree is dirty and aborts cleanly on conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-conflict-'))
  try {
    const repoPath = initTempGitRepo(root)
    const wtRoot = join(root, 'worktrees')

    const wt = await ensureWorktree({
      repoPath,
      worktreesDir: wtRoot,
      worktreeName: 'task-conflict',
      branchName: 'ekko-todo/conflict',
      baseBranch: 'main',
    })
    writeFileSync(join(wt.worktreePath, 'app.js'), 'export const version = 99\n', 'utf8')

    writeFileSync(join(repoPath, 'app.js'), 'export const version = 50\n', 'utf8')
    await assert.rejects(
      mergeWorktreeBranch({
        repoPath,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        baseBranch: 'main',
      }),
      /uncommitted changes/,
    )

    execFileSync('git', ['add', 'app.js'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'conflicting main edit'], { cwd: repoPath })

    await assert.rejects(
      mergeWorktreeBranch({
        repoPath,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        baseBranch: 'main',
      }),
      /Merge conflict/,
    )
    const afterAbort = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath }).toString().trim()
    assert.equal(afterAbort, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
