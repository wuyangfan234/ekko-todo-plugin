import React, { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import {
  X,
  FolderOpen,
  GithubLogo,
  LockSimple,
  MagnifyingGlass,
  ArrowsClockwise,
  GitBranch,
  LinkSimple,
  CloudArrowDown,
  CheckCircle,
} from '@phosphor-icons/react'
import { AvatarPicker } from './AvatarKit.jsx'
import { GithubAuthCard } from './GithubAuthCard.jsx'
import { getProjectLabel, getProjectMonogram, getAgentRoleLabel } from '../utils.js'

export function AddProjectDialog({
  open,
  initialMode = 'github',
  defaultCloneRoot = '',
  githubStatus = null,
  ctx,
  busy,
  onClose,
  onInspectRepo,
  onListGithubRepos,
  onRefreshGithubAuth,
  onStartGithubDevice,
  onSaveGithubToken,
  onLogoutGithub,
  onCreateLocal,
  onImportGithub,
}) {
  const [tab, setTab] = useState(initialMode === 'local' ? 'local' : 'github')

  // GitHub tab state
  const [ghQuery, setGhQuery] = useState('')
  const [ghLoading, setGhLoading] = useState(false)
  const [ghInfo, setGhInfo] = useState({ ghAvailable: false, authenticated: false, username: '', repos: [], error: '' })
  const [ghRepoInput, setGhRepoInput] = useState('')
  const [ghSelectedPrivate, setGhSelectedPrivate] = useState(false)
  const [ghBindMode, setGhBindMode] = useState('link') // 'link' | 'clone'
  const [ghLocalPath, setGhLocalPath] = useState('')
  const [ghCloneParent, setGhCloneParent] = useState(defaultCloneRoot || '')
  const [ghName, setGhName] = useState('')
  const [ghDisplayName, setGhDisplayName] = useState('')
  const [ghAvatar, setGhAvatar] = useState('')
  const [ghAccent, setGhAccent] = useState('blue')
  const [ghBranch, setGhBranch] = useState('main')
  const [ghTestCmd, setGhTestCmd] = useState('')
  const [ghStatus, setGhStatus] = useState('')
  const [ghError, setGhError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Local tab state
  const [repoPath, setRepoPath] = useState('')
  const [name, setName] = useState('')
  const [localDisplayName, setLocalDisplayName] = useState('')
  const [localAvatar, setLocalAvatar] = useState('')
  const [localAccent, setLocalAccent] = useState('blue')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [testCommand, setTestCommand] = useState('')
  const [detectedGithub, setDetectedGithub] = useState('')
  const [inspectStatus, setInspectStatus] = useState('')
  const [inspectError, setInspectError] = useState('')

  useEffect(() => {
    if (!open) return
    setTab(initialMode === 'local' ? 'local' : 'github')
    if (defaultCloneRoot && !ghCloneParent) setGhCloneParent(defaultCloneRoot)
  }, [open, initialMode, defaultCloneRoot])

  const loadGithubRepos = async (query = '') => {
    if (!onListGithubRepos) return
    setGhLoading(true)
    try {
      const res = await onListGithubRepos({ query, limit: 50 })
      setGhInfo(res || { ghAvailable: false, authenticated: false, username: '', repos: [] })
    } catch (err) {
      setGhInfo({ ghAvailable: false, authenticated: false, username: '', repos: [], error: err?.message || '读取失败' })
    } finally {
      setGhLoading(false)
    }
  }

  useEffect(() => {
    if (open && tab === 'github' && ghInfo.repos.length === 0 && !ghLoading) {
      void loadGithubRepos('')
    }
  }, [open, tab])

  const runLocalInspect = async (pathToCheck, forGithubLink = false) => {
    const clean = String(pathToCheck || '').trim()
    if (!clean) return
    if (forGithubLink) {
      setGhError('')
      setGhStatus('正在校验本地 Git 目录...')
    } else {
      setInspectError('')
      setInspectStatus('正在检查 Git 仓库...')
    }
    try {
      const info = await onInspectRepo(clean)
      if (forGithubLink) {
        setGhLocalPath(info.repoPath)
        setGhBranch(info.defaultBranch || ghBranch || 'main')
        if (!ghRepoInput.trim() && info.githubRepo) setGhRepoInput(info.githubRepo)
        if (!ghName.trim()) {
          const base = info.repoPath.split(/[\\/]/).filter(Boolean).pop() || 'Project'
          setGhName(base)
        }
        setGhStatus(`本地目录已验证（${info.defaultBranch} · ${info.headSha || 'HEAD'}${info.githubRepo ? ` · 远端 ${info.githubRepo}` : ''}）`)
      } else {
        setRepoPath(info.repoPath)
        setDefaultBranch(info.defaultBranch || 'main')
        setDetectedGithub(info.githubRepo || '')
        if (!name.trim()) {
          const base = info.repoPath.split(/[\\/]/).filter(Boolean).pop() || 'Project'
          setName(base)
        }
        setInspectStatus(`已验证 Git 仓库（分支 ${info.defaultBranch} · ${info.headSha || 'HEAD'}${info.githubRepo ? ` · GitHub ${info.githubRepo}` : ''}）`)
      }
    } catch (err) {
      if (forGithubLink) {
        setGhStatus('')
        setGhError(err?.message || String(err))
      } else {
        setInspectStatus('')
        setInspectError(err?.message || String(err))
      }
    }
  }

  const pickDirectory = async target => {
    try {
      const current = target === 'local' ? repoPath : target === 'gh-link' ? ghLocalPath : ghCloneParent
      const picked = await ctx.ui?.selectWorkspace?.({ current: current || '' })
      if (!picked?.workspace) return
      if (target === 'local') {
        setRepoPath(picked.workspace)
        await runLocalInspect(picked.workspace, false)
      } else if (target === 'gh-link') {
        setGhLocalPath(picked.workspace)
        await runLocalInspect(picked.workspace, true)
      } else {
        setGhCloneParent(picked.workspace)
      }
    } catch (err) {
      ctx.ui?.notify?.(err?.message || '目录选择器不可用', 'error')
    }
  }

  const selectGithubRepoItem = repo => {
    setGhRepoInput(repo.nameWithOwner)
    setGhName(repo.name)
    setGhBranch(repo.defaultBranch || 'main')
    setGhSelectedPrivate(Boolean(repo.isPrivate))
    setGhError('')
  }

  const submitLocal = async e => {
    e.preventDefault()
    if (!repoPath.trim() || !name.trim() || busy || submitting) return
    setSubmitting(true)
    try {
      const res = await onCreateLocal({
        name: name.trim(),
        displayName: localDisplayName.trim(),
        avatar: localAvatar,
        accent: localAccent,
        repoPath: repoPath.trim(),
        githubRepo: detectedGithub || '',
        defaultBranch: defaultBranch.trim() || 'main',
        testCommand: testCommand.trim(),
      })
      if (res) {
        setRepoPath('')
        setName('')
        setLocalDisplayName('')
        setLocalAvatar('')
        setTestCommand('')
        setDetectedGithub('')
        setInspectStatus('')
        setInspectError('')
        onClose()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const submitGithub = async e => {
    e.preventDefault()
    if (!ghRepoInput.trim() || busy || submitting) return
    if (ghBindMode === 'link' && !ghLocalPath.trim()) {
      setGhError('请选择或填写要关联的本地 Git 目录')
      return
    }
    if (ghBindMode === 'clone' && !ghCloneParent.trim()) {
      setGhError('请选择或填写克隆目标父目录')
      return
    }
    setSubmitting(true)
    setGhError('')
    try {
      const res = await onImportGithub({
        githubRepo: ghRepoInput.trim(),
        mode: ghBindMode,
        repoPath: ghBindMode === 'link' ? ghLocalPath.trim() : '',
        cloneParentDir: ghBindMode === 'clone' ? ghCloneParent.trim() : '',
        name: ghName.trim(),
        displayName: ghDisplayName.trim(),
        avatar: ghAvatar,
        accent: ghAccent,
        defaultBranch: ghBranch.trim() || 'main',
        testCommand: ghTestCmd.trim(),
        isPrivate: ghSelectedPrivate,
      })
      if (res) {
        setGhRepoInput('')
        setGhLocalPath('')
        setGhName('')
        setGhDisplayName('')
        setGhAvatar('')
        setGhTestCmd('')
        setGhStatus('')
        onClose()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const filteredGhRepos = (ghInfo.repos || []).filter(r => {
    const q = ghQuery.trim().toLowerCase()
    if (!q) return true
    return r.nameWithOwner.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)
  })

  const inferredRepoFolder = (ghRepoInput.trim().split('/').pop() || '').replace(/\.git$/i, '')

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal" style={{ width: 'min(580px, 94vw)' }} onOpenAutoFocus={e => e.preventDefault()} data-testid="add-project-dialog">
          <div className="ot-dialog-head">
            <div>
              <Dialog.Title className="ot-dialog-title">添加项目</Dialog.Title>
              <p className="ot-dialog-sub">从 GitHub 导入或关联本地 Git 仓库</p>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
            </Dialog.Close>
          </div>

          <Tabs.Root value={tab} onValueChange={setTab} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <Tabs.List className="ot-tabs-list">
              <Tabs.Trigger value="github" className="ot-tabs-trigger" data-testid="add-proj-tab-github">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <GithubLogo size={14} />
                  <span>从 GitHub 导入</span>
                </span>
              </Tabs.Trigger>
              <Tabs.Trigger value="local" className="ot-tabs-trigger" data-testid="add-proj-tab-local">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <FolderOpen size={14} />
                  <span>本地 Git 仓库</span>
                </span>
              </Tabs.Trigger>
            </Tabs.List>

            {/* ===== GITHUB IMPORT TAB ===== */}
            <Tabs.Content value="github" className="ot-tab-panel">
              <form onSubmit={submitGithub} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <div className="ot-dialog-body">
                  {/* Unified GitHub Authorization & Repo Picker */}
                  <GithubAuthCard
                    compact
                    status={ghInfo.authenticated ? ghInfo : (githubStatus || ghInfo)}
                    onRefreshStatus={async opts => {
                      const next = await onRefreshGithubAuth?.(opts)
                      if (next?.authenticated) void loadGithubRepos(ghQuery)
                      return next
                    }}
                    onStartDeviceLogin={onStartGithubDevice}
                    onSaveToken={onSaveGithubToken}
                    onLogout={async opts => {
                      const next = await onLogoutGithub?.(opts)
                      setGhInfo({ ghAvailable: Boolean(next?.ghAvailable), authenticated: false, username: '', repos: [] })
                      return next
                    }}
                    onAuthenticated={() => void loadGithubRepos(ghQuery)}
                  />

                  {ghInfo.authenticated && (
                    <div className="ot-setting-card" style={{ padding: 10, gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <GithubLogo size={13} />
                          <span>你的 GitHub 仓库（{ghInfo.repos.length} 个）</span>
                        </span>
                        <button
                          type="button"
                          className="ot-icon-btn"
                          title="刷新 GitHub 仓库列表"
                          onClick={() => loadGithubRepos(ghQuery)}
                        >
                          <ArrowsClockwise size={12} className={ghLoading ? 'ot-spin' : ''} />
                        </button>
                      </div>
                      <div style={{ position: 'relative' }}>
                        <MagnifyingGlass size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--ot-muted)' }} />
                        <input
                          className="ot-input ot-input--sm"
                          style={{ paddingLeft: 28 }}
                          placeholder="筛选你的 GitHub 仓库..."
                          value={ghQuery}
                          onChange={e => setGhQuery(e.target.value)}
                          data-testid="input-github-search"
                        />
                      </div>
                      <div className="ot-gh-list" data-testid="github-repo-list">
                        {ghLoading ? (
                          <div style={{ padding: 12, textAlign: 'center', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>正在拉取仓库列表...</div>
                        ) : filteredGhRepos.length === 0 ? (
                          <div style={{ padding: 12, textAlign: 'center', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>未匹配到仓库</div>
                        ) : (
                          filteredGhRepos.slice(0, 30).map(r => {
                            const picked = ghRepoInput.trim() === r.nameWithOwner
                            return (
                              <button
                                key={r.nameWithOwner}
                                type="button"
                                className={`ot-gh-item ${picked ? 'is-selected' : ''}`}
                                onClick={() => selectGithubRepoItem(r)}
                              >
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--ot-fs-sm)', fontWeight: 500 }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nameWithOwner}</span>
                                    {r.isPrivate && <LockSimple size={11} style={{ color: 'var(--ot-muted)', flex: 'none' }} />}
                                  </div>
                                  {r.description && (
                                    <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {r.description}
                                    </div>
                                  )}
                                </div>
                                <span style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', flex: 'none' }}>
                                  {r.defaultBranch}
                                </span>
                                {picked && <CheckCircle size={14} weight="fill" style={{ color: 'var(--ot-dot-done)', flex: 'none' }} />}
                              </button>
                            )
                          })
                        )}
                      </div>
                    </div>
                  )}

                  {/* Direct GitHub repo / URL field */}
                  <label className="ot-field-label">
                    <span>GitHub 仓库标识或 URL</span>
                    <input
                      className="ot-input"
                      required
                      value={ghRepoInput}
                      onChange={e => setGhRepoInput(e.target.value)}
                      placeholder="例如：owner/repo 或 https://github.com/owner/repo"
                      data-testid="input-github-repo"
                    />
                  </label>

                  {/* Local Directory Association Mode */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>本地目录关联方式</span>
                    <div className="ot-seg" style={{ width: 'fit-content' }}>
                      <button
                        type="button"
                        className={`ot-seg-btn ${ghBindMode === 'link' ? 'is-active' : ''}`}
                        onClick={() => setGhBindMode('link')}
                        data-testid="btn-gh-mode-link"
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <LinkSimple size={12} />
                          <span>关联已有本地目录</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`ot-seg-btn ${ghBindMode === 'clone' ? 'is-active' : ''}`}
                        onClick={() => setGhBindMode('clone')}
                        data-testid="btn-gh-mode-clone"
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <CloudArrowDown size={12} />
                          <span>克隆到本地目录</span>
                        </span>
                      </button>
                    </div>
                  </div>

                  {ghBindMode === 'link' ? (
                    <div className="ot-field-label">
                      <span>已有本地 Git 仓库目录</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="ot-input"
                          required
                          value={ghLocalPath}
                          onChange={e => setGhLocalPath(e.target.value)}
                          onBlur={() => ghLocalPath.trim() && runLocalInspect(ghLocalPath, true)}
                          placeholder="/path/to/local/repo"
                          data-testid="input-gh-local-path"
                        />
                        <button type="button" className="ot-btn" onClick={() => pickDirectory('gh-link')}>
                          <FolderOpen size={14} />
                          <span>浏览</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ot-field-label">
                      <span>克隆存放父目录</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="ot-input"
                          required
                          value={ghCloneParent}
                          onChange={e => setGhCloneParent(e.target.value)}
                          placeholder="/path/to/workspace-root"
                          data-testid="input-gh-clone-parent"
                        />
                        <button type="button" className="ot-btn" onClick={() => pickDirectory('gh-clone')}>
                          <FolderOpen size={14} />
                          <span>浏览</span>
                        </button>
                      </div>
                      {ghCloneParent.trim() && inferredRepoFolder && (
                        <span style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                          目标路径：{ghCloneParent.replace(/\/$/, '')}/{inferredRepoFolder}
                        </span>
                      )}
                    </div>
                  )}

                  {ghStatus && <span style={{ color: 'var(--ot-diff-add-edge)', fontSize: 'var(--ot-fs-xs)' }}>{ghStatus}</span>}
                  {ghError && <span style={{ color: 'var(--ot-tag-bug-fg)', fontSize: 'var(--ot-fs-xs)' }}>{ghError}</span>}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px', gap: 8 }}>
                    <label className="ot-field-label">
                      <span>显示别称（推荐，便于发现）</span>
                      <input
                        className="ot-input"
                        value={ghDisplayName}
                        onChange={e => setGhDisplayName(e.target.value)}
                        placeholder="例如：星海官网、运营中心"
                        data-testid="input-github-display-name"
                      />
                    </label>
                    <label className="ot-field-label">
                      <span>仓库原名</span>
                      <input
                        className="ot-input"
                        value={ghName}
                        onChange={e => setGhName(e.target.value)}
                        placeholder={inferredRepoFolder || '自动使用仓库名'}
                      />
                    </label>
                    <label className="ot-field-label">
                      <span>默认分支</span>
                      <input className="ot-input" value={ghBranch} onChange={e => setGhBranch(e.target.value)} placeholder="main" />
                    </label>
                  </div>

                  <AvatarPicker
                    mode="project"
                    compact
                    value={ghAvatar}
                    accent={ghAccent}
                    monogram={getProjectMonogram({ displayName: ghDisplayName, name: ghName || inferredRepoFolder || 'P' })}
                    onChange={setGhAvatar}
                    onAccentChange={setGhAccent}
                  />

                  <label className="ot-field-label">
                    <span>验收命令（可选，构建后运行）</span>
                    <input
                      className="ot-input"
                      value={ghTestCmd}
                      onChange={e => setGhTestCmd(e.target.value)}
                      placeholder="例如：npm test 或 pytest -q"
                    />
                  </label>
                </div>

                <div className="ot-dialog-foot">
                  <button type="button" className="ot-btn" onClick={onClose}>取消</button>
                  <button
                    type="submit"
                    className="ot-btn ot-btn--primary"
                    disabled={busy || submitting || !ghRepoInput.trim() || (ghBindMode === 'link' ? !ghLocalPath.trim() : !ghCloneParent.trim())}
                    data-testid="btn-submit-github-project"
                  >
                    {submitting ? '正在处理...' : (ghBindMode === 'clone' ? '克隆并导入项目' : '导入并关联目录')}
                  </button>
                </div>
              </form>
            </Tabs.Content>

            {/* ===== LOCAL GIT REPO TAB ===== */}
            <Tabs.Content value="local" className="ot-tab-panel">
              <form onSubmit={submitLocal} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <div className="ot-dialog-body">
                  <div className="ot-field-label">
                    <span>本地仓库目录</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="ot-input"
                        required
                        value={repoPath}
                        onChange={e => setRepoPath(e.target.value)}
                        onBlur={() => repoPath.trim() && runLocalInspect(repoPath, false)}
                        placeholder="/path/to/your/git-repo"
                        data-testid="input-project-path"
                      />
                      <button type="button" className="ot-btn" onClick={() => pickDirectory('local')}>
                        <FolderOpen size={14} />
                        <span>浏览</span>
                      </button>
                    </div>
                    {inspectStatus && <span style={{ color: 'var(--ot-diff-add-edge)', fontSize: 'var(--ot-fs-xs)' }}>{inspectStatus}</span>}
                    {inspectError && <span style={{ color: 'var(--ot-tag-bug-fg)', fontSize: 'var(--ot-fs-xs)' }}>{inspectError}</span>}
                  </div>

                  {detectedGithub && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                      <GithubLogo size={13} />
                      <span>已自动识别 GitHub 远端：</span>
                      <code style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)' }}>{detectedGithub}</code>
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px', gap: 8 }}>
                    <label className="ot-field-label">
                      <span>显示别称（推荐，便于发现）</span>
                      <input
                        className="ot-input"
                        value={localDisplayName}
                        onChange={e => setLocalDisplayName(e.target.value)}
                        placeholder="例如：星海官网、前端站"
                        data-testid="input-project-display-name"
                      />
                    </label>
                    <label className="ot-field-label">
                      <span>项目原名</span>
                      <input className="ot-input" required value={name} onChange={e => setName(e.target.value)} placeholder="仓库目录名称" data-testid="input-project-name" />
                    </label>
                    <label className="ot-field-label">
                      <span>默认分支</span>
                      <input className="ot-input" value={defaultBranch} onChange={e => setDefaultBranch(e.target.value)} placeholder="main" />
                    </label>
                  </div>

                  <AvatarPicker
                    mode="project"
                    compact
                    value={localAvatar}
                    accent={localAccent}
                    monogram={getProjectMonogram({ displayName: localDisplayName, name: name || 'P' })}
                    onChange={setLocalAvatar}
                    onAccentChange={setLocalAccent}
                  />

                  <label className="ot-field-label">
                    <span>验收命令（可选，构建后运行）</span>
                    <input
                      className="ot-input"
                      value={testCommand}
                      onChange={e => setTestCommand(e.target.value)}
                      placeholder="例如：npm test 或 pytest -q"
                    />
                  </label>
                </div>
                <div className="ot-dialog-foot">
                  <button type="button" className="ot-btn" onClick={onClose}>取消</button>
                  <button type="submit" className="ot-btn ot-btn--primary" disabled={busy || submitting || !repoPath.trim() || !name.trim()} data-testid="btn-submit-project">
                    <GitBranch size={13} />
                    <span>添加项目</span>
                  </button>
                </div>
              </form>
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// 0.9.44: a topic's project is changed here, or cleared. Nothing but the topic's projectId is written; its
// cards, watches and Chief session stay as they are.
export function TopicProjectDialog({ topic, projects = [], onClose, onSave }) {
  const [projectId, setProjectId] = useState(topic?.projectId || '')
  useEffect(() => { setProjectId(topic?.projectId || '') }, [topic?.id, topic?.projectId])
  if (!topic) return null
  const current = projects.find(p => p.id === topic.projectId)
  const currentLabel = topic.projectId ? (current?.name || `${topic.projectId}（项目已不存在）`) : '不归属项目'
  const submit = e => {
    e.preventDefault()
    if (projectId !== (topic.projectId || '')) onSave?.(projectId)
    onClose?.()
  }
  return (
    <Dialog.Root open onOpenChange={v => { if (!v) onClose?.() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--sm" data-testid="topic-project-dialog" onOpenAutoFocus={e => e.preventDefault()}>
          <div className="ot-dialog-head">
            <Dialog.Title className="ot-dialog-title">改挂项目</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
            </Dialog.Close>
          </div>
          <form onSubmit={submit}>
            <div className="ot-dialog-body">
              <Dialog.Description className="ot-field-label" style={{ marginBottom: 10 }}>
                <span data-testid="topic-project-current">话题「{topic.title}」当前：{currentLabel}</span>
              </Dialog.Description>
              <label className="ot-field-label">
                <span>改挂到</span>
                <select className="ot-input" value={projectId} onChange={e => setProjectId(e.target.value)} data-testid="topic-project-select">
                  <option value="">不归属项目（可跨项目使用）</option>
                  {topic.projectId && !current && <option value={topic.projectId}>{currentLabel}</option>}
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <p className="ot-field-label" style={{ marginTop: 10 }}>只改话题的项目归属；话题里的卡片、对话和总管会话不变。</p>
            </div>
            <div className="ot-dialog-foot">
              <button type="button" className="ot-btn" onClick={onClose}>取消</button>
              <button type="submit" className="ot-btn ot-btn--primary" disabled={projectId === (topic.projectId || '')} data-testid="btn-topic-project-save">保存</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function CreateTopicDialog({ open, projects, defaultProjectId, busy, onClose, onCreate }) {
  const [projectId, setProjectId] = useState(defaultProjectId || '')
  const [title, setTitle] = useState('')
  const [autopilot, setAutopilot] = useState(true)

  const submit = e => {
    e.preventDefault()
    if (!title.trim() || busy) return
    onCreate({ projectId: projectId || '', title: title.trim(), autopilot })
    setTitle('')
    onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--sm" onOpenAutoFocus={e => e.preventDefault()}>
          <div className="ot-dialog-head">
            <Dialog.Title className="ot-dialog-title">新建话题</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
            </Dialog.Close>
          </div>
          <form onSubmit={submit}>
            <div className="ot-dialog-body">
              {projects.length > 0 && (
                <label className="ot-field-label">
                  <span>主关联项目（可选）</span>
                  <select className="ot-input" value={projectId} onChange={e => setProjectId(e.target.value)}>
                    <option value="">不归属项目（可跨项目使用）</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
              )}
              <label className="ot-field-label">
                <span>话题名称</span>
                <input className="ot-input" required value={title} onChange={e => setTitle(e.target.value)} placeholder="输入当前推进的主题名称..." />
              </label>
              <label className="ot-check-row" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--ot-fs-sm)', cursor: 'pointer' }}>
                <input type="checkbox" checked={autopilot} onChange={e => setAutopilot(e.target.checked)} />
                <span>开启 AUTO 自动推进（关口自动唤醒总管）</span>
              </label>
            </div>
            <div className="ot-dialog-foot">
              <button type="button" className="ot-btn" onClick={onClose}>取消</button>
              <button type="submit" className="ot-btn ot-btn--primary" disabled={busy || !title.trim()}>创建话题</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function CreateTaskDialog({ open, projects, agents, topics, defaultProjectId, defaultTopicId, busy, onClose, onCreate, onNeedProject }) {
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || '')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('feature')
  const [agentId, setAgentId] = useState('')
  const [spec, setSpec] = useState('')
  const [withPlan, setWithPlan] = useState(false)
  const [startImmediately, setStartImmediately] = useState(false)

  const effectiveProjectId = projectId && projects.some(p => p.id === projectId) ? projectId : (projects[0]?.id || '')

  const submit = e => {
    e.preventDefault()
    if (!effectiveProjectId || !title.trim() || busy) return
    const topic = topics.find(t => t.id === defaultTopicId) || topics.find(t => t.projectId === effectiveProjectId) || topics[0]
    onCreate({
      projectId: effectiveProjectId,
      topicId: topic?.id || '',
      title: title.trim(),
      kind,
      agentId: agentId || '',
      spec: spec.trim(),
      withPlan,
      startImmediately,
    })
    setTitle('')
    setSpec('')
    onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--sm" onOpenAutoFocus={e => e.preventDefault()}>
          <div className="ot-dialog-head">
            <Dialog.Title className="ot-dialog-title">新建任务</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
            </Dialog.Close>
          </div>
          {projects.length === 0 ? (
            <div className="ot-dialog-body" style={{ alignItems: 'center', textAlign: 'center', padding: '24px 18px' }}>
              <div style={{ fontSize: 'var(--ot-fs-sm)' }}>创建任务前请先导入 GitHub 仓库或添加本地 Git 项目。</div>
              <button type="button" className="ot-btn ot-btn--primary" onClick={() => { onClose(); onNeedProject() }}>
                去导入项目
              </button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="ot-dialog-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
                  <label className="ot-field-label">
                    <span>所属项目</span>
                    <select className="ot-input" value={effectiveProjectId} onChange={e => setProjectId(e.target.value)}>
                      {projects.map(p => <option key={p.id} value={p.id}>{getProjectLabel(p)}</option>)}
                    </select>
                  </label>
                  <label className="ot-field-label">
                    <span>类型</span>
                    <select className="ot-input" value={kind} onChange={e => setKind(e.target.value)}>
                      <option value="feature">功能</option>
                      <option value="bug">缺陷</option>
                      <option value="content">内容 / 运营</option>
                      <option value="question">调研 / 方案（不改代码）</option>
                      <option value="deploy">部署</option>
                    </select>
                  </label>
                </div>

                <label className="ot-field-label">
                  <span>任务标题</span>
                  <input className="ot-input" required minLength={2} value={title} onChange={e => setTitle(e.target.value)} placeholder="清晰可执行的一句话目标" />
                </label>

                <label className="ot-field-label">
                  <span>指派 Agent（可选）</span>
                  <select className="ot-input" value={agentId} onChange={e => setAgentId(e.target.value)}>
                    <option value="">使用项目默认执行 Agent</option>
                    {agents.filter(a => a.role !== 'chief').map(a => (
                      <option key={a.id} value={a.id}>{a.name} · {getAgentRoleLabel(a)} ({a.engine})</option>
                    ))}
                  </select>
                </label>

                <label className="ot-field-label">
                  <span>规格说明与验收边界</span>
                  <textarea className="ot-input" rows={3} value={spec} onChange={e => setSpec(e.target.value)} placeholder="输入已知文件位置、约束与测试要求..." />
                </label>

                <label className="ot-check-row" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--ot-fs-sm)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={startImmediately} onChange={e => setStartImmediately(e.target.checked)} />
                  <span>创建后立即在隔离 Worktree 启动执行</span>
                </label>
                {startImmediately && (
                  <label className="ot-check-row" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--ot-fs-sm)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={withPlan} onChange={e => setWithPlan(e.target.checked)} />
                    <span>先出方案待确认，再写代码</span>
                  </label>
                )}
              </div>
              <div className="ot-dialog-foot">
                <button type="button" className="ot-btn" onClick={onClose}>取消</button>
                <button type="submit" className="ot-btn ot-btn--primary" disabled={busy || title.trim().length < 2}>创建</button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
