import { simpleGit } from 'simple-git'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { clampDiffs } from './diff-budget.mjs'

const execFileAsync = promisify(execFile)

export const GITHUB_TOKEN_CREATE_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=Ekko-ToDo'
export const GITHUB_DEVICE_VERIFY_URL = 'https://github.com/login/device'

const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local/bin'),
  '/usr/bin',
  '/bin',
]

function buildAugmentedEnv(extraEnv = {}) {
  const curPath = String(process.env.PATH || '')
  const parts = curPath.split(':').filter(Boolean)
  for (const dir of EXTRA_BIN_DIRS) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return { ...process.env, PATH: parts.join(':'), ...extraEnv }
}

function resolveBinary(name) {
  for (const dir of EXTRA_BIN_DIRS) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return name
}

async function runCmd(cmd, args, options = {}) {
  const resolved = cmd === 'gh' || cmd === 'git' ? resolveBinary(cmd) : cmd
  const { stdout } = await execFileAsync(resolved, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs || 60000,
    ...options,
    env: buildAugmentedEnv(options.env || {}),
  })
  return stdout
}

async function runGitRaw(cwd, args, extraEnv = {}) {
  return runCmd('git', args, {
    cwd,
    env: extraEnv,
  })
}

/**
 * Parses `owner/repo`, HTTPS, or SSH GitHub URLs into canonical metadata.
 * Returns null if the input is not a valid GitHub repository identifier.
 */
export function parseGithubRepoInput(raw) {
  const text = String(raw || '').trim()
  if (!text) return null

  const patterns = [
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  ]

  for (const re of patterns) {
    const m = text.match(re)
    if (!m) continue
    const owner = m[1]
    const repo = m[2].replace(/\.git$/i, '')
    if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      return null
    }
    return {
      owner,
      repo,
      nameWithOwner: `${owner}/${repo}`,
      httpsUrl: `https://github.com/${owner}/${repo}.git`,
      webUrl: `https://github.com/${owner}/${repo}`,
      sshUrl: `git@github.com:${owner}/${repo}.git`,
    }
  }
  return null
}

export async function detectGithubRemote(repoPath) {
  try {
    const remoteUrl = (await runGitRaw(repoPath, ['remote', 'get-url', 'origin'])).trim()
    const parsed = parseGithubRepoInput(remoteUrl)
    return {
      remoteUrl,
      githubRepo: parsed?.nameWithOwner || '',
    }
  } catch {
    return { remoteUrl: '', githubRepo: '' }
  }
}

export async function inspectRepo(repoPath) {
  const abs = resolve(String(repoPath || '').trim())
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`Directory does not exist: ${abs}`)
  }
  const git = simpleGit({ baseDir: abs })
  const isRepo = await git.checkIsRepo()
  if (!isRepo) {
    throw new Error(`Not a Git repository: ${abs}`)
  }
  const branchSummary = await git.branchLocal()
  const status = await git.status()
  let headSha = ''
  try {
    headSha = (await git.revparse(['--short', 'HEAD'])).trim()
  } catch {
    headSha = ''
  }
  const remote = await detectGithubRemote(abs)
  const branches = branchSummary.all || []
  const defaultBranch = branches.includes('main')
    ? 'main'
    : branches.includes('master')
      ? 'master'
      : (branchSummary.current || 'main')
  return {
    repoPath: abs,
    currentBranch: branchSummary.current || defaultBranch,
    defaultBranch,
    branches,
    headSha,
    isClean: status.isClean(),
    githubRepo: remote.githubRepo,
    remoteUrl: remote.remoteUrl,
  }
}

// Singleton active gh CLI web device login state (short-lived, auto-expires in 15 min)
let activeDeviceLogin = null

function getPublicDeviceState() {
  if (!activeDeviceLogin) {
    return { active: false, status: 'idle', userCode: '', verificationUri: GITHUB_DEVICE_VERIFY_URL, error: '' }
  }
  if (Date.now() - activeDeviceLogin.startedAt > 15 * 60 * 1000 && activeDeviceLogin.status === 'pending') {
    try { activeDeviceLogin.child?.kill('SIGTERM') } catch {}
    activeDeviceLogin.status = 'expired'
    activeDeviceLogin.error = '授权码已过期，请重新发起 GitHub 登录'
  }
  return {
    active: activeDeviceLogin.status === 'pending',
    status: activeDeviceLogin.status,
    userCode: activeDeviceLogin.userCode || '',
    verificationUri: activeDeviceLogin.verificationUri || GITHUB_DEVICE_VERIFY_URL,
    error: activeDeviceLogin.error || '',
  }
}

export function getGithubDeviceLoginStatus() {
  return getPublicDeviceState()
}

export function cancelGithubDeviceLogin() {
  if (activeDeviceLogin?.child) {
    try { activeDeviceLogin.child.kill('SIGTERM') } catch {}
  }
  activeDeviceLogin = null
  return getPublicDeviceState()
}

export async function probeGithubCli() {
  try {
    const login = (await runCmd('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 8000 })).trim()
    return { ghAvailable: true, authenticated: Boolean(login), username: login }
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '')
    const missing = err?.code === 'ENOENT' || /not found/i.test(msg)
    return { ghAvailable: !missing, authenticated: false, username: '', error: missing ? '未检测到 gh CLI' : 'GitHub CLI 未登录' }
  }
}

/**
 * Verifies a user-supplied GitHub Personal Access Token (PAT) via GitHub REST API.
 * Never logs or echoes back the raw token.
 */
export async function verifyGithubToken(rawToken) {
  const token = String(rawToken || '').trim()
  if (!token || token.length < 10) {
    throw new Error('请输入有效的 GitHub Personal Access Token（如 ghp_... 或 github_pat_...）')
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Ekko-ToDo/0.5.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: ctrl.signal,
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error('GitHub 访问令牌无效或权限不足，请检查是否已过期并勾选 repo 权限')
    }
    if (!res.ok) {
      throw new Error(`GitHub 接口校验失败（HTTP ${res.status}）`)
    }
    const data = await res.json()
    const username = String(data?.login || '').trim()
    if (!username) throw new Error('未能识别该令牌对应的 GitHub 账号')
    return {
      ok: true,
      username,
      name: String(data?.name || username),
      avatarUrl: String(data?.avatar_url || ''),
      scopes: String(res.headers.get('x-oauth-scopes') || ''),
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('连接 GitHub 超时，请检查本机网络或代理设置后重试')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Unified GitHub auth probe covering both saved PAT (zero-CLI friendly) and local `gh` CLI.
 */
export async function probeGithubAuth({ pat = '', patUser = '' } = {}) {
  const gh = await probeGithubCli()
  const cleanPat = String(pat || '').trim()
  let patAuthenticated = false
  let patUsername = String(patUser || '').trim()

  if (cleanPat) {
    if (patUsername) {
      patAuthenticated = true
    } else {
      try {
        const verified = await verifyGithubToken(cleanPat)
        patAuthenticated = true
        patUsername = verified.username
      } catch {
        patAuthenticated = false
      }
    }
  }

  const authSource = patAuthenticated ? 'pat' : (gh.authenticated ? 'gh-cli' : 'none')
  const authenticated = authSource !== 'none'
  const username = authSource === 'pat' ? patUsername : (authSource === 'gh-cli' ? gh.username : '')

  return {
    ghAvailable: gh.ghAvailable,
    authenticated,
    username,
    authSource,
    ghAuthenticated: gh.authenticated,
    ghUsername: gh.username || '',
    patAuthenticated,
    patUsername,
    tokenCreateUrl: GITHUB_TOKEN_CREATE_URL,
    deviceFlow: getPublicDeviceState(),
    error: authenticated ? '' : (gh.error || '尚未登录 GitHub'),
  }
}

/**
 * Starts a guided GitHub OAuth Device Login using local `gh auth login --web`.
 * Captures the one-time 8-char code & verification URL cleanly without spawning stray popups.
 */
export async function startGithubDeviceLogin() {
  const gh = await probeGithubCli()
  if (!gh.ghAvailable) {
    throw new Error('当前机器未安装 GitHub CLI (gh)，请直接使用下方的「GitHub 访问令牌 (PAT)」一键连接，无需安装任何命令行工具。')
  }
  cancelGithubDeviceLogin()

  const bin = resolveBinary('gh')
  const child = spawn(bin, [
    'auth',
    'login',
    '--hostname',
    'github.com',
    '--git-protocol',
    'https',
    '--web',
  ], {
    env: buildAugmentedEnv({
      BROWSER: 'false',
      GH_BROWSER: 'false',
      GH_PROMPT_DISABLED: '0',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const state = {
    child,
    status: 'pending',
    userCode: '',
    verificationUri: GITHUB_DEVICE_VERIFY_URL,
    error: '',
    startedAt: Date.now(),
    output: '',
    sentEnter: false,
  }
  activeDeviceLogin = state

  return new Promise((resolveStart, rejectStart) => {
    let settled = false
    const finish = (ok, errMsg = '') => {
      if (settled) return
      settled = true
      clearTimeout(codeTimer)
      if (ok) resolveStart(getPublicDeviceState())
      else rejectStart(new Error(errMsg || '启动 GitHub 网页授权失败'))
    }

    const handleChunk = chunk => {
      const text = chunk.toString('utf8')
      state.output += text
      const codeMatch = state.output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)
      const urlMatch = state.output.match(/https:\/\/github\.com\/login\/device/i)
      if (urlMatch) state.verificationUri = urlMatch[0]
      if (codeMatch && codeMatch[1]) {
        state.userCode = codeMatch[1].toUpperCase()
        if (!state.sentEnter) {
          state.sentEnter = true
          try { child.stdin.write('\n') } catch {}
        }
        finish(true)
      }
    }

    child.stdout.on('data', handleChunk)
    child.stderr.on('data', handleChunk)

    child.on('error', err => {
      state.status = 'failed'
      state.error = err?.message || '无法启动 gh auth login'
      finish(false, state.error)
    })

    child.on('exit', code => {
      if (code === 0) {
        state.status = 'authenticated'
        state.error = ''
        finish(true)
      } else if (state.status === 'pending') {
        state.status = 'failed'
        state.error = state.userCode
          ? '授权未完成或已取消，可重新发起授权或改用访问令牌登录'
          : 'GitHub 设备授权启动失败，可改用下方的访问令牌方式连接'
        finish(false, state.error)
      }
    })

    const codeTimer = setTimeout(() => {
      if (!settled) {
        if (state.userCode) {
          finish(true)
        } else {
          cancelGithubDeviceLogin()
          finish(false, '等待 GitHub 授权码超时，请直接改用「访问令牌 (PAT)」一键连接')
        }
      }
    }, 10000)
  })
}

export async function logoutGithubCli() {
  cancelGithubDeviceLogin()
  try {
    await runCmd('gh', ['auth', 'logout', '--hostname', 'github.com'], { timeoutMs: 8000 })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export async function listGithubRepos({ query = '', limit = 50, pat = '', patUser = '' } = {}) {
  const status = await probeGithubAuth({ pat, patUser })
  if (!status.authenticated) {
    return {
      ...status,
      repos: [],
    }
  }
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50))
  const q = String(query || '').trim().toLowerCase()

  // Channel A: Direct GitHub HTTPS REST API via PAT (works even without `gh` CLI installed!)
  if (status.authSource === 'pat' && String(pat || '').trim()) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 18000)
    try {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=${Math.min(100, safeLimit)}&sort=updated&affiliation=owner,collaborator,organization_member`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${String(pat).trim()}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Ekko-ToDo/0.5.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: ctrl.signal,
        },
      )
      if (!res.ok) throw new Error(`GitHub 仓库列表拉取失败（HTTP ${res.status}）`)
      const parsed = await res.json()
      const repos = (Array.isArray(parsed) ? parsed : [])
        .map(r => ({
          name: String(r.name || ''),
          nameWithOwner: String(r.full_name || ''),
          description: String(r.description || ''),
          isPrivate: Boolean(r.private),
          defaultBranch: String(r.default_branch || 'main'),
          url: String(r.html_url || ''),
          sshUrl: String(r.ssh_url || ''),
          updatedAt: String(r.updated_at || ''),
        }))
        .filter(r => !q || r.nameWithOwner.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))

      return { ...status, repos }
    } catch (err) {
      return {
        ...status,
        repos: [],
        error: err?.name === 'AbortError' ? '连接 GitHub 拉取仓库超时' : (err?.message || '读取 GitHub 仓库列表失败'),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // Channel B: Local authenticated `gh` CLI
  try {
    const raw = await runCmd(
      'gh',
      [
        'repo',
        'list',
        '--limit',
        String(safeLimit),
        '--json',
        'name,nameWithOwner,description,isPrivate,defaultBranchRef,url,sshUrl,updatedAt',
      ],
      { timeoutMs: 20000 },
    )
    const parsed = JSON.parse(raw || '[]')
    const repos = (Array.isArray(parsed) ? parsed : [])
      .map(r => ({
        name: String(r.name || ''),
        nameWithOwner: String(r.nameWithOwner || ''),
        description: String(r.description || ''),
        isPrivate: Boolean(r.isPrivate),
        defaultBranch: String(r.defaultBranchRef?.name || 'main'),
        url: String(r.url || ''),
        sshUrl: String(r.sshUrl || ''),
        updatedAt: String(r.updatedAt || ''),
      }))
      .filter(r => !q || r.nameWithOwner.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))

    return {
      ...status,
      repos,
    }
  } catch (err) {
    return {
      ...status,
      repos: [],
      error: err?.message || '读取 GitHub 仓库列表失败',
    }
  }
}

/**
 * Clones a GitHub repository into a local directory (or binds if already cloned there).
 * Supports PAT private-repo cloning via ephemeral per-command Authorization header
 * so tokens are NEVER persisted in `.git/config`.
 */
export async function cloneGithubRepo({ githubRepo, cloneUrl = '', targetPath, branch = '', pat = '' }) {
  const parsed = parseGithubRepoInput(githubRepo || cloneUrl)
  const rawCloneUrl = String(cloneUrl || '').trim()
  if (!parsed && !rawCloneUrl) {
    throw new Error('请提供有效的 GitHub 仓库名（owner/repo）或仓库 URL')
  }
  const absTarget = resolve(String(targetPath || '').trim())
  if (!absTarget) {
    throw new Error('请提供目标本地目录路径')
  }

  // If directory already exists and is a valid Git repo, inspect and link directly
  if (existsSync(absTarget)) {
    const st = statSync(absTarget)
    if (!st.isDirectory()) {
      throw new Error(`目标路径已存在且不是目录: ${absTarget}`)
    }
    const existingGit = simpleGit({ baseDir: absTarget })
    const isAlreadyRepo = await existingGit.checkIsRepo().catch(() => false)
    if (isAlreadyRepo) {
      const inspected = await inspectRepo(absTarget)
      return {
        ...inspected,
        githubRepo: inspected.githubRepo || parsed?.nameWithOwner || '',
        remoteUrl: inspected.remoteUrl || rawCloneUrl || parsed?.httpsUrl || '',
        cloned: false,
      }
    }
  }

  mkdirSync(dirname(absTarget), { recursive: true })

  const cleanPat = String(pat || '').trim()
  const effectiveUrl = rawCloneUrl || parsed.httpsUrl
  if (cleanPat && !rawCloneUrl.startsWith('file://') && /^https?:\/\/github\.com\//i.test(effectiveUrl)) {
    // Ephemeral Basic Auth header: leaves .git/config completely clean of any token
    const basic = Buffer.from(`x-access-token:${cleanPat}`).toString('base64')
    const gitArgs = ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`, 'clone']
    if (branch) gitArgs.push('--branch', branch)
    gitArgs.push(effectiveUrl, absTarget)
    await runCmd('git', gitArgs, { timeoutMs: 180000 })
  } else {
    const ghStatus = parsed ? await probeGithubCli() : { authenticated: false }
    if (parsed && ghStatus.authenticated && !rawCloneUrl.startsWith('file://')) {
      const ghArgs = ['repo', 'clone', parsed.nameWithOwner, absTarget]
      if (branch) ghArgs.push('--', '--branch', branch)
      await runCmd('gh', ghArgs, { timeoutMs: 180000 })
    } else {
      const gitArgs = ['clone']
      if (branch) gitArgs.push('--branch', branch)
      gitArgs.push(effectiveUrl, absTarget)
      await runCmd('git', gitArgs, { timeoutMs: 180000 })
    }
  }

  const inspected = await inspectRepo(absTarget)
  return {
    ...inspected,
    githubRepo: inspected.githubRepo || parsed?.nameWithOwner || '',
    remoteUrl: inspected.remoteUrl || effectiveUrl,
    cloned: true,
  }
}

const WORKTREE_BOOTSTRAP_CANDIDATES = [
  '.venv',
  'venv',
  'node_modules',
  '.env',
  '.env.local',
  'backend/.venv',
  'backend/venv',
  'backend/node_modules',
  'backend/.env',
  'frontend/node_modules',
  'frontend/.env.local',
  'web/node_modules',
  'apps/web/node_modules',
  'server/node_modules',
]

function symlinkManifestPath(worktreePath) {
  return join(dirname(resolve(worktreePath)), `.wt-links-${basename(resolve(worktreePath))}.json`)
}

function readRecordedSymlinks(worktreePath) {
  const absWt = resolve(worktreePath)
  const manifestPath = symlinkManifestPath(absWt)
  if (!existsSync(manifestPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function ensureGitInfoExcludes(repoPath, relPaths = []) {
  if (!relPaths.length) return
  try {
    const absRepo = resolve(repoPath)
    const excludeRel = (await runGitRaw(absRepo, ['rev-parse', '--git-path', 'info/exclude'])).trim()
    const excludeFile = resolve(absRepo, excludeRel)
    mkdirSync(dirname(excludeFile), { recursive: true })
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    const existingLines = new Set(existing.split('\n').map(l => l.trim()))
    const additions = []
    for (const rel of relPaths) {
      const normalized = `/${String(rel).replace(/^\/+/, '').replace(/\/+$/, '')}`
      if (!existingLines.has(normalized)) {
        additions.push(normalized)
        existingLines.add(normalized)
      }
    }
    if (additions.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
      const header = existing.includes('# ekko-todo-worktree-symlinks') ? '' : '# ekko-todo-worktree-symlinks\n'
      writeFileSync(excludeFile, `${existing}${prefix}${header}${additions.join('\n')}\n`, 'utf8')
    }
  } catch {
    // best-effort local exclude
  }
}

/**
 * Safely symlinks gitignored local dependencies (.venv, node_modules, .env) from the main
 * repository into a fresh isolated Git worktree so project test suites (pytest, npm test,
 * ./scripts/test.sh) work out of the box without copying gigabytes or breaking git status.
 */
export async function bootstrapWorktreeDependencies(repoPath, worktreePath) {
  const absRepo = resolve(repoPath)
  const absWt = resolve(worktreePath)
  const linked = []
  for (const rel of WORKTREE_BOOTSTRAP_CANDIDATES) {
    const src = join(absRepo, rel)
    const dst = join(absWt, rel)
    if (!existsSync(src) || existsSync(dst)) continue
    // Only link gitignored paths (never shadow tracked source files!)
    const isIgnored = await runGitRaw(absRepo, ['check-ignore', '-q', rel])
      .then(() => true)
      .catch(() => false)
    if (!isIgnored) continue
    try {
      mkdirSync(dirname(dst), { recursive: true })
      const st = statSync(src)
      symlinkSync(src, dst, st.isDirectory() ? 'dir' : 'file')
      linked.push(rel)
    } catch {
      // ignore if filesystem disallows symlink
    }
  }
  if (linked.length > 0) {
    // Trailing-slash patterns in .gitignore (e.g. `node_modules/`) do not ignore symlinks in Git;
    // register symlink paths in local `.git/info/exclude` so `git status` stays 100% clean!
    await ensureGitInfoExcludes(absRepo, linked)
    try {
      writeFileSync(symlinkManifestPath(absWt), JSON.stringify(linked), 'utf8')
    } catch {}
  }
  return linked
}

/**
 * Removes ONLY recorded bootstrap symlinks before deleting a worktree so we never traverse
 * into or delete the main repository's real .venv / node_modules directories.
 */
export function cleanupBootstrapSymlinks(worktreePath) {
  const absWt = resolve(worktreePath)
  const manifestPath = symlinkManifestPath(absWt)
  let rels = []
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (Array.isArray(parsed)) rels = parsed
    } catch {}
  }
  const toCheck = rels.length ? rels : WORKTREE_BOOTSTRAP_CANDIDATES
  for (const rel of toCheck) {
    const p = join(absWt, rel)
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink()) unlinkSync(p)
    } catch {}
  }
  try { rmSync(manifestPath, { force: true }) } catch {}
}

/**
 * Self-heals stale `.git/worktrees/<id>/index.lock` files older than 60s (Todos worktree pattern).
 */
export async function removeStaleIndexLock(worktreePath) {
  try {
    const absWt = resolve(worktreePath)
    const idxRel = (await runGitRaw(absWt, ['rev-parse', '--git-path', 'index.lock'])).trim()
    const lockPath = resolve(absWt, idxRel)
    if (existsSync(lockPath)) {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs
      if (ageMs > 60000) unlinkSync(lockPath)
    }
  } catch {
    // best effort
  }
}

export async function ensureWorktree({ repoPath, worktreesDir, worktreeName, branchName, baseBranch }) {
  const absRepo = resolve(repoPath)
  mkdirSync(worktreesDir, { recursive: true })
  const worktreePath = join(worktreesDir, worktreeName)
  const git = simpleGit({ baseDir: absRepo })

  const baseCommit = (await git.revparse([baseBranch || 'HEAD'])).trim()

  if (existsSync(worktreePath)) {
    const wtGit = simpleGit({ baseDir: worktreePath })
    const valid = await wtGit.checkIsRepo().catch(() => false)
    if (valid) {
      await removeStaleIndexLock(worktreePath)
      const linkedDeps = await bootstrapWorktreeDependencies(absRepo, worktreePath)
      return { worktreePath, branchName, baseCommit, linkedDeps }
    }
    cleanupBootstrapSymlinks(worktreePath)
    rmSync(worktreePath, { recursive: true, force: true })
  }

  await git.raw(['worktree', 'prune']).catch(() => {})

  const localBranches = (await git.branchLocal()).all || []
  if (localBranches.includes(branchName)) {
    await git.raw(['worktree', 'add', worktreePath, branchName])
  } else {
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, baseBranch || 'HEAD'])
  }

  const linkedDeps = await bootstrapWorktreeDependencies(absRepo, worktreePath)
  return { worktreePath, branchName, baseCommit, linkedDeps }
}

// The tree of the worktree as it is on disk (committed + staged + unstaged + untracked, minus the bootstrap
// symlinks), written through a shadow index so the real .git/index is never touched. The same content gives
// the same sha whatever the file mtimes are.
async function writeWorktreeTree(absWt, shadowIndexPath) {
  // Seed shadow index from HEAD tree (no stale stat-cache mtimes -> eliminates racy-git missed edits)
  await runGitRaw(absWt, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: shadowIndexPath })
  await runGitRaw(absWt, ['add', '-A'], { GIT_INDEX_FILE: shadowIndexPath })
  const linkedRels = readRecordedSymlinks(absWt)
  if (linkedRels.length > 0) {
    await runGitRaw(absWt, ['rm', '--cached', '--ignore-unmatch', '--', ...linkedRels], { GIT_INDEX_FILE: shadowIndexPath }).catch(() => {})
  }
  return (await runGitRaw(absWt, ['write-tree'], { GIT_INDEX_FILE: shadowIndexPath })).trim()
}

/**
 * 0.9.47: where a worktree stands right now: `headSha` (full sha of HEAD) and `treeSha` (the tree of the
 * files on disk, uncommitted changes included). Read-only: no ref is written, no diff is computed. A build
 * round records this when it starts; captureWorktreeSnapshot returns the same two values when it ends.
 * Throws when the path is not a usable worktree.
 */
export async function readWorktreeState({ worktreePath }) {
  const absWt = resolve(worktreePath)
  if (!existsSync(absWt)) throw new Error(`Worktree path does not exist: ${absWt}`)
  const headSha = (await runGitRaw(absWt, ['rev-parse', 'HEAD'])).trim()
  const shadowIndexPath = join(absWt, '..', `.shadow-index-${randomUUID().slice(0, 8)}`)
  try {
    return { headSha, treeSha: await writeWorktreeTree(absWt, shadowIndexPath) }
  } finally {
    rmSync(shadowIndexPath, { force: true })
  }
}

/**
 * Shadow GIT_INDEX_FILE snapshot:
 * Captures committed + staged + untracked files in the isolated worktree
 * WITHOUT touching the worktree's real .git/index or the main repository tree.
 */
export async function captureWorktreeSnapshot({ repoPath, worktreePath, baseCommit, baseBranch, snapshotRefName }) {
  const absRepo = resolve(repoPath)
  const absWt = resolve(worktreePath)
  if (!existsSync(absWt)) {
    throw new Error(`Worktree path does not exist: ${absWt}`)
  }

  const headFull = (await runGitRaw(absWt, ['rev-parse', 'HEAD'])).trim()
  const gitIndexRel = (await runGitRaw(absWt, ['rev-parse', '--git-path', 'index'])).trim()
  const realIndexPath = resolve(absWt, gitIndexRel)
  const shadowIndexPath = join(absWt, '..', `.shadow-index-${randomUUID().slice(0, 8)}`)

  let snapshotCommit = headFull
  // Declared outside the try so it can be returned; stays '' when the tree could not be written.
  let treeSha = ''
  try {
    treeSha = await writeWorktreeTree(absWt, shadowIndexPath)
    const headTreeSha = (await runGitRaw(absWt, ['rev-parse', 'HEAD^{tree}'])).trim()
    if (treeSha !== headTreeSha) {
      snapshotCommit = (await runGitRaw(absWt, [
        'commit-tree',
        treeSha,
        '-p',
        headFull,
        '-m',
        `ekko-todo snapshot (${snapshotRefName})`,
      ])).trim()
    }
    if (snapshotRefName) {
      await runGitRaw(absRepo, ['update-ref', `refs/ekko-todo/snapshots/${snapshotRefName}`, snapshotCommit])
    }
  } finally {
    rmSync(shadowIndexPath, { force: true })
  }

  // Diff from the merge-base of the base branch tip and the snapshot, so a task branch that has
  // merged main only shows its own changes. For an ordinary fork this equals baseCommit.
  // merge-base(baseCommit, snapshot) alone would not help: baseCommit is already an ancestor.
  // Falls back to the original base when merge-base cannot be resolved.
  const fallbackBase = baseCommit || baseBranch || 'HEAD'
  let diffBase = fallbackBase
  for (const upstream of [baseBranch, baseCommit]) {
    if (!upstream) continue
    const mergeBase = (await runGitRaw(absRepo, ['merge-base', upstream, snapshotCommit]).catch(() => '')).trim()
    if (mergeBase) {
      diffBase = mergeBase
      break
    }
  }
  const numstatRaw = await runGitRaw(absRepo, ['diff', '--numstat', diffBase, snapshotCommit]).catch(() => '')
  const statsByPath = new Map()
  let totalAdditions = 0
  let totalDeletions = 0

  for (const line of numstatRaw.split('\n')) {
    if (!line.trim()) continue
    const [addStr, delStr, ...rest] = line.split('\t')
    const filePath = rest.join('\t').trim()
    if (!filePath) continue
    const additions = addStr === '-' ? 0 : Number(addStr) || 0
    const deletions = delStr === '-' ? 0 : Number(delStr) || 0
    totalAdditions += additions
    totalDeletions += deletions
    statsByPath.set(filePath, { path: filePath, additions, deletions })
  }

  const unifiedRaw = await runGitRaw(absRepo, ['diff', '--unified=3', '--no-color', diffBase, snapshotCommit]).catch(() => '')
  const diffs = parseUnifiedDiffByFile(unifiedRaw, statsByPath)

  return {
    snapshotSha: snapshotCommit.slice(0, 12),
    snapshotFullSha: snapshotCommit,
    // 0.9.47: the two values a build round is compared by (see readWorktreeState).
    headSha: headFull,
    worktreeTreeSha: treeSha,
    filesChanged: statsByPath.size,
    additions: totalAdditions,
    deletions: totalDeletions,
    diffs,
  }
}

const DIFF_MAX_LINE_CHARS = 2000
const DIFF_MAX_HUNK_CHARS = 20000
const DIFF_MAX_JSON_BYTES = 200000

function truncateDiffLine(line) {
  if (line.length <= DIFF_MAX_LINE_CHARS) return line
  return `${line.slice(0, DIFF_MAX_LINE_CHARS)}…(line truncated, ${line.length} chars)`
}

function truncateDiffHunk(hunk) {
  if (hunk.length <= DIFF_MAX_HUNK_CHARS) return hunk
  const note = `... (diff truncated at ${DIFF_MAX_HUNK_CHARS} chars; stats preserved; full diff available via git in the worktree)`
  return `${hunk.slice(0, DIFF_MAX_HUNK_CHARS - note.length - 1)}\n${note}`
}

/** Bound capture JSON while reserving enough space for every tail file's minimal stats. */
export function applyDiffJsonBudget(entries) {
  const out = []
  const minimal = entries.map(entry => ({
    path: entry.path,
    additions: entry.additions,
    deletions: entry.deletions,
    hunk: '',
  }))
  let budgetReached = false
  for (const [index, entry] of entries.entries()) {
    const candidate = [...out, entry, ...minimal.slice(index + 1)]
    if (!budgetReached && Buffer.byteLength(JSON.stringify(candidate)) <= DIFF_MAX_JSON_BYTES) {
      out.push(entry)
      continue
    }
    budgetReached = true
    out.push(minimal[index])
  }
  return out
}

function parseUnifiedDiffByFile(rawDiff, statsByPath, maxFiles = 20, maxLinesPerFile = 180) {
  if (!rawDiff.trim()) return []
  const chunks = rawDiff.split(/^diff --git /m).filter(Boolean)
  const out = []

  for (const chunk of chunks.slice(0, maxFiles)) {
    const lines = chunk.split('\n')
    const header = lines[0] || ''
    const match = header.match(/a\/(.+?)\s+b\/(.+)$/)
    const filePath = (match?.[2] || match?.[1] || 'unknown').trim()
    const stat = statsByPath.get(filePath) || { additions: 0, deletions: 0 }
    const entry = {
      path: filePath,
      additions: stat.additions,
      deletions: stat.deletions,
      hunk: '',
    }
    const hunkStart = lines.findIndex(l => l.startsWith('@@'))
    const bodyLines = hunkStart >= 0 ? lines.slice(hunkStart, hunkStart + maxLinesPerFile) : lines.slice(1, 30)
    if (hunkStart >= 0 && lines.length - hunkStart > maxLinesPerFile) {
      bodyLines.push(`... (${lines.length - hunkStart - maxLinesPerFile} more lines truncated)`)
    }
    entry.hunk = truncateDiffHunk(bodyLines.map(truncateDiffLine).join('\n'))
    out.push(entry)
  }
  return clampDiffs(applyDiffJsonBudget(out))
}

export async function mergeWorktreeBranch({ repoPath, worktreePath, branchName, baseBranch, commitMessage }) {
  const absRepo = resolve(repoPath)
  const absWt = worktreePath ? resolve(worktreePath) : ''
  const repoGit = simpleGit({ baseDir: absRepo })

  // 1. Auto-commit any uncommitted changes inside the isolated worktree first
  if (absWt && existsSync(absWt)) {
    const wtGit = simpleGit({ baseDir: absWt })
    const wtStatus = await wtGit.status()
    if (!wtStatus.isClean()) {
      await wtGit.add(['-A'])
      await wtGit.commit(commitMessage || `chore(ekko-todo): finalize ${branchName}`)
    }
  }

  // 2. Refuse merge if main repository working tree is dirty
  const mainStatus = await repoGit.status()
  if (!mainStatus.isClean()) {
    throw new Error(`Main repository working tree at ${absRepo} has uncommitted changes. Commit or stash before merging.`)
  }

  // Remember exactly where the user's main checkout was (branch name, or commit when detached)
  const prevRef = (await runGitRaw(absRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim()
  const prevBranch = prevRef && prevRef !== 'HEAD'
    ? prevRef
    : (await runGitRaw(absRepo, ['rev-parse', 'HEAD']).catch(() => '')).trim()
  try {
    if (prevBranch !== baseBranch) {
      await repoGit.checkout(baseBranch)
    }
    await repoGit.merge(['--no-ff', branchName, '-m', commitMessage || `Merge ${branchName} into ${baseBranch}`])
  } catch (err) {
    await repoGit.raw(['merge', '--abort']).catch(() => {})
    if (prevBranch && prevBranch !== baseBranch) {
      await repoGit.checkout(prevBranch).catch(() => {})
    }
    throw new Error(`Merge conflict merging ${branchName} into ${baseBranch}: ${err.message}`)
  }

  const mergedSha = (await repoGit.revparse(['--short', baseBranch])).trim()

  // Put the user's main checkout back where it was; merging must not silently switch their branch.
  if (prevBranch && prevBranch !== baseBranch) {
    await repoGit.checkout(prevBranch).catch(() => {})
  }

  // 3. Clean up isolated worktree & temporary branch (unlink bootstrap symlinks first!)
  if (absWt && existsSync(absWt)) {
    cleanupBootstrapSymlinks(absWt)
    await repoGit.raw(['worktree', 'remove', '--force', absWt]).catch(() => {})
    await repoGit.raw(['worktree', 'prune']).catch(() => {})
  }
  if (branchName && branchName !== baseBranch) {
    await repoGit.deleteLocalBranch(branchName, true).catch(() => {})
  }

  return { mergedSha, baseBranch }
}

export async function removeWorktree({ repoPath, worktreePath, branchName, deleteBranch = false }) {
  const absRepo = resolve(repoPath)
  const repoGit = simpleGit({ baseDir: absRepo })
  if (worktreePath && existsSync(worktreePath)) {
    cleanupBootstrapSymlinks(worktreePath)
    await repoGit.raw(['worktree', 'remove', '--force', worktreePath]).catch(() => {})
    await repoGit.raw(['worktree', 'prune']).catch(() => {})
  }
  if (deleteBranch && branchName) {
    await repoGit.deleteLocalBranch(branchName, true).catch(() => {})
  }
}

/**
 * True only when the worktree exists and `git status --porcelain` is empty, i.e. every change is
 * committed on its branch (ignored files such as bootstrap dependency links do not count).
 * Any error answers false so callers keep the worktree.
 */
export async function isWorktreeClean(worktreePath) {
  try {
    const absWt = resolve(worktreePath)
    if (!existsSync(absWt)) return false
    return (await runGitRaw(absWt, ['status', '--porcelain'])).trim() === ''
  } catch {
    return false
  }
}

/** Delete a local branch only if it is fully merged (`git branch -d`). Returns false when kept. */
export async function deleteMergedBranch(repoPath, branchName) {
  if (!branchName) return true
  try {
    await runGitRaw(resolve(repoPath), ['branch', '-d', branchName])
    return true
  } catch {
    return false
  }
}

/**
 * Lightweight repository fingerprint (HEAD SHA + porcelain status) for Chief strict-orchestration audit.
 */
export async function captureRepoFingerprint(repoPath) {
  try {
    const absRepo = resolve(repoPath)
    if (!existsSync(absRepo)) return null
    const [head, status] = await Promise.all([
      runGitRaw(absRepo, ['rev-parse', 'HEAD']).then(s => s.trim()).catch(() => ''),
      runGitRaw(absRepo, ['status', '--porcelain']).then(s => s.trim()).catch(() => ''),
    ])
    return { repoPath: absRepo, head, status }
  } catch {
    return null
  }
}

/**
 * Strictly read-only Git repository inspection tool for Chief Orchestrator.
 * Lets Chief inspect branches, unmerged commits, working tree cleanliness, and recent log
 * without ever opening a shell inside the project repo.
 */
export async function inspectProjectRepoReadOnly(repoPath, defaultBranch = 'main') {
  const absRepo = resolve(repoPath)
  if (!existsSync(absRepo)) throw new Error(`Repository path does not exist: ${absRepo}`)
  const [currentBranch, headSha, statusRaw, logRaw, branchesRaw, unmergedRaw] = await Promise.all([
    runGitRaw(absRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim()).catch(() => ''),
    runGitRaw(absRepo, ['rev-parse', '--short', 'HEAD']).then(s => s.trim()).catch(() => ''),
    runGitRaw(absRepo, ['status', '--porcelain']).then(s => s.trim()).catch(() => ''),
    runGitRaw(absRepo, ['log', '-n', '12', '--pretty=format:%h %ad %s', '--date=short']).then(s => s.trim()).catch(() => ''),
    runGitRaw(absRepo, ['branch', '--format=%(refname:short) %(objectname:short)']).then(s => s.trim()).catch(() => ''),
    runGitRaw(absRepo, ['branch', '--no-merged', defaultBranch || 'HEAD', '--format=%(refname:short)']).then(s => s.trim()).catch(() => ''),
  ])
  const dirtyFiles = statusRaw ? statusRaw.split('\n').filter(Boolean).slice(0, 40) : []
  const recentCommits = logRaw ? logRaw.split('\n').filter(Boolean) : []
  const branches = branchesRaw ? branchesRaw.split('\n').filter(Boolean) : []
  const unmergedList = unmergedRaw ? unmergedRaw.split('\n').filter(Boolean) : []
  const unmergedBranches = []
  for (const br of unmergedList.slice(0, 12)) {
    const aheadCount = await runGitRaw(absRepo, ['rev-list', '--count', `${defaultBranch || 'HEAD'}..${br}`])
      .then(s => Number(s.trim()) || 0)
      .catch(() => 0)
    const tipMsg = await runGitRaw(absRepo, ['log', '-1', '--pretty=format:%h %s', br])
      .then(s => s.trim())
      .catch(() => '')
    unmergedBranches.push({ branch: br, aheadCount, tip: tipMsg })
  }
  return {
    repoPath: absRepo,
    defaultBranch: defaultBranch || currentBranch || 'main',
    currentBranch,
    headSha,
    isClean: dirtyFiles.length === 0,
    dirtyFiles,
    recentCommits,
    branches,
    unmergedBranches,
  }
}

/* ---------- Pure Read-Only Repository Browser (v0.8.0 Todos Project Workspace) ---------- */

function sanitizeGitRef(ref, fallback = 'HEAD') {
  const s = String(ref || '').trim()
  if (!s) return fallback
  if (/[\x00-\x1f\x7f~^:?*[\]\\]/.test(s) || s.startsWith('-') || s.includes('..') || s.includes('@{')) {
    throw new Error(`Invalid Git ref: ${s}`)
  }
  return s
}

function sanitizeRepoRelativePath(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!raw) return ''
  const parts = raw.split('/').filter(Boolean)
  if (parts.some(p => p === '..' || p === '.' || p.includes('\0'))) {
    throw new Error(`Invalid repository path: ${relPath}`)
  }
  return parts.join('/')
}

async function runGitBuffer(cwd, args) {
  const { stdout } = await execFileAsync(resolveBinary('git'), args, {
    cwd,
    env: buildAugmentedEnv(),
    encoding: 'buffer',
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

/**
 * List local branches of a project repository and annotate branches created for Todos
 * with their #number & title (matching Todos branch dropdown UX).
 */
export async function listProjectBranches(repoPath, defaultBranch = 'main', todos = []) {
  const absRepo = resolve(repoPath)
  if (!existsSync(absRepo)) throw new Error(`Repository path does not exist: ${absRepo}`)
  const currentBranch = await runGitRaw(absRepo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    .then(s => s.trim())
    .catch(() => defaultBranch || 'main')
  const raw = await runGitRaw(absRepo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)\t%(objectname:short)\t%(committerdate:unix)\t%(subject)',
    'refs/heads',
  ]).catch(() => '')

  const todoByBranch = new Map()
  for (const td of todos || []) {
    if (td.branch) todoByBranch.set(td.branch, td)
  }

  const branches = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, sha, unixSec, ...subjParts] = line.split('\t')
      const td = todoByBranch.get(name) || null
      return {
        name,
        sha: sha || '',
        committedAt: Number(unixSec || 0) * 1000,
        subject: subjParts.join('\t') || '',
        isCurrent: name === currentBranch,
        isDefault: name === (defaultBranch || currentBranch),
        todoNumber: td ? td.number : 0,
        todoTitle: td ? td.title : '',
        todoId: td ? td.id : '',
        todoPhase: td ? td.phase : '',
      }
    })

  // Keep default/current branch pinned at top
  branches.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return (b.committedAt || 0) - (a.committedAt || 0)
  })

  return {
    currentBranch: currentBranch || defaultBranch || 'main',
    defaultBranch: defaultBranch || currentBranch || 'main',
    branches,
  }
}

/**
 * Read directory entries at a specific ref & subPath purely via `git ls-tree`
 * (never touches or checks out the working tree). Folders sorted first, then files alphabetically.
 */
export async function listProjectTree(repoPath, ref = '', subPath = '') {
  const absRepo = resolve(repoPath)
  if (!existsSync(absRepo)) throw new Error(`Repository path does not exist: ${absRepo}`)
  const safeRef = sanitizeGitRef(ref, 'HEAD')
  const cleanSub = sanitizeRepoRelativePath(subPath)
  const treeSpec = cleanSub ? `${safeRef}:${cleanSub}` : safeRef
  // -z: NUL-terminated records with verbatim paths. Without it Git C-quotes non-ASCII,
  // quote and control characters ("2025\345\271...md"), which are not real paths.
  const out = await runGitRaw(absRepo, ['ls-tree', '-l', '-z', treeSpec]).catch(err => {
    if (String(err?.message || '').includes('Not a valid object name')) return ''
    throw err
  })

  const entries = []
  for (const record of out.split('\0')) {
    if (!record) continue
    const tabIdx = record.indexOf('\t')
    if (tabIdx < 0) continue
    const meta = record.slice(0, tabIdx).trim().split(/\s+/)
    const name = record.slice(tabIdx + 1)
    if (!name) continue
    const type = meta[1] === 'tree' ? 'dir' : 'file'
    const sha = meta[2] || ''
    const size = meta[3] && meta[3] !== '-' ? Number(meta[3]) || 0 : 0
    const path = cleanSub ? `${cleanSub}/${name}` : name
    entries.push({ name, path, type, sha, size })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
  })

  return { ref: safeRef, path: cleanSub, entries }
}

const PREVIEW_ERROR_UNREADABLE = '这个文件打不开'
const PREVIEW_ERROR_UNSUPPORTED = '这个文件不支持预览'
// runGitBuffer's maxBuffer; larger blobs are reported as unsupported instead of failing mid-read.
const MAX_PREVIEW_READ_BYTES = 4 * 1024 * 1024

const IMAGE_EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * Read a single file at `ref:filePath` purely via `git show` (zero checkout, 512KB text cap,
 * safe binary detection, and inline base64 preview for small raster images <= 2MB).
 */
export async function readProjectFile(repoPath, ref = '', filePath = '') {
  const absRepo = resolve(repoPath)
  if (!existsSync(absRepo)) throw new Error(`Repository path does not exist: ${absRepo}`)
  const safeRef = sanitizeGitRef(ref, 'HEAD')
  const cleanPath = sanitizeRepoRelativePath(filePath)
  if (!cleanPath) throw new Error('filePath is required')

  // Paths go to Git as argv entries (never a shell string). Raw Git errors carry the command line,
  // absolute binary path and "fatal:" text; the preview pane only gets a short Chinese message.
  const objectSpec = `${safeRef}:${cleanPath}`
  const sizeText = await runGitRaw(absRepo, ['cat-file', '-s', objectSpec]).catch(() => '')
  const declaredSize = /^\d+$/.test(String(sizeText).trim()) ? Number(String(sizeText).trim()) : NaN
  if (!Number.isFinite(declaredSize)) throw new Error(PREVIEW_ERROR_UNREADABLE)
  if (declaredSize > MAX_PREVIEW_READ_BYTES) {
    const bigExt = (cleanPath.split('.').pop() || '').toLowerCase()
    return {
      ref: safeRef,
      path: cleanPath,
      ext: bigExt,
      size: declaredSize,
      kind: 'binary',
      mime: IMAGE_EXT_MIME[bigExt] || 'application/octet-stream',
      content: '',
      truncated: true,
    }
  }
  let buf
  try {
    buf = await runGitBuffer(absRepo, ['show', objectSpec])
  } catch (err) {
    const tooBig = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(err?.message || ''))
    throw new Error(tooBig ? PREVIEW_ERROR_UNSUPPORTED : PREVIEW_ERROR_UNREADABLE)
  }
  const ext = (cleanPath.split('.').pop() || '').toLowerCase()
  const totalBytes = buf.length
  const mime = IMAGE_EXT_MIME[ext] || ''

  // Raster images (exclude SVG to render SVG safely as text/code instead of raw markup)
  if (mime && ext !== 'svg') {
    if (totalBytes <= 2 * 1024 * 1024) {
      return {
        ref: safeRef,
        path: cleanPath,
        ext,
        size: totalBytes,
        kind: 'image',
        mime,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        content: '',
        truncated: false,
      }
    }
    return {
      ref: safeRef,
      path: cleanPath,
      ext,
      size: totalBytes,
      kind: 'binary',
      mime,
      content: '',
      truncated: true,
    }
  }

  // Binary heuristic: check first 4KB for NUL bytes
  const sampleLen = Math.min(4096, buf.length)
  let isBinary = false
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) { isBinary = true; break }
  }
  if (isBinary) {
    return {
      ref: safeRef,
      path: cleanPath,
      ext,
      size: totalBytes,
      kind: 'binary',
      mime: 'application/octet-stream',
      content: '',
      truncated: false,
    }
  }

  const MAX_TEXT_BYTES = 512 * 1024
  const truncated = totalBytes > MAX_TEXT_BYTES
  const text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8')
  const lineCount = text ? text.split('\n').length : 0

  return {
    ref: safeRef,
    path: cleanPath,
    ext,
    size: totalBytes,
    lineCount,
    kind: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text',
    content: text,
    truncated,
  }
}

export async function listProjectCommits(repoPath, ref = '', limit = 30) {
  const absRepo = resolve(repoPath)
  if (!existsSync(absRepo)) throw new Error(`Repository path does not exist: ${absRepo}`)
  const safeRef = sanitizeGitRef(ref, 'HEAD')
  const maxN = Math.max(1, Math.min(80, Number(limit) || 30))
  const out = await runGitRaw(absRepo, [
    'log',
    `-n`,
    String(maxN),
    '--pretty=format:%H\t%h\t%an\t%at\t%s',
    safeRef,
  ]).catch(() => '')

  const commits = out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [sha, shortSha, author, unixSec, ...subj] = line.split('\t')
      return {
        sha,
        shortSha,
        author: author || '',
        committedAt: Number(unixSec || 0) * 1000,
        subject: subj.join('\t') || '',
      }
    })

  return { ref: safeRef, commits }
}

export async function readProjectCommitDiff(repoPath, sha) {
  const absRepo = resolve(repoPath)
  if (!existsSync(absRepo)) throw new Error(`Repository path does not exist: ${absRepo}`)
  const safeSha = sanitizeGitRef(sha)
  const [headerRaw, numstatRaw, patchRaw] = await Promise.all([
    runGitRaw(absRepo, ['show', '-s', '--pretty=format:%H\t%h\t%an\t%at\t%s\n%b', safeSha]).catch(() => ''),
    runGitRaw(absRepo, ['show', '--numstat', '--format=', safeSha]).catch(() => ''),
    runGitRaw(absRepo, ['show', '--format=', '--unified=3', safeSha]).catch(() => ''),
  ])

  const firstNewline = headerRaw.indexOf('\n')
  const metaLine = firstNewline >= 0 ? headerRaw.slice(0, firstNewline) : headerRaw
  const body = firstNewline >= 0 ? headerRaw.slice(firstNewline + 1).trim() : ''
  const [fullSha, shortSha, author, unixSec, ...subj] = metaLine.split('\t')

  const files = []
  for (const line of numstatRaw.split('\n')) {
    if (!line.trim()) continue
    const [a, d, ...p] = line.split('\t')
    const path = p.join('\t')
    if (!path) continue
    files.push({
      path,
      additions: a === '-' ? 0 : Number(a) || 0,
      deletions: d === '-' ? 0 : Number(d) || 0,
    })
  }

  const MAX_DIFF_CHARS = 180_000
  const truncated = patchRaw.length > MAX_DIFF_CHARS
  return {
    sha: fullSha || safeSha,
    shortSha: shortSha || safeSha.slice(0, 7),
    author: author || '',
    committedAt: Number(unixSec || 0) * 1000,
    subject: subj.join('\t') || '',
    body,
    files,
    patch: truncated ? patchRaw.slice(0, MAX_DIFF_CHARS) : patchRaw,
    truncated,
  }
}
