import React, { useEffect, useState } from 'react'
import {
  GithubLogo,
  CheckCircle,
  Key,
  ArrowSquareOut,
  Copy,
  Check,
  SignOut,
  ArrowsClockwise,
  Browser,
  WarningCircle,
} from '@phosphor-icons/react'

const DEFAULT_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:user&description=Ekko-ToDo'

/**
 * Beginner-friendly GitHub Account & Authorization Card.
 * Works for ANY user regardless of whether `gh` CLI is pre-authenticated:
 * 1) Guided OAuth Device Login (`gh auth login --web`) with one-click copy code & open browser
 * 2) Direct Personal Access Token (PAT) connection (works even without `gh` CLI installed!)
 * 3) Clear connected badge with account switch / disconnect controls
 */
export function GithubAuthCard({
  status,
  compact = false,
  onRefreshStatus,
  onStartDeviceLogin,
  onSaveToken,
  onLogout,
  onAuthenticated,
}) {
  const [authState, setAuthState] = useState(status || null)
  const [loading, setLoading] = useState(false)
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [patOpen, setPatOpen] = useState(false)
  const [patValue, setPatValue] = useState('')
  const [patSaving, setPatSaving] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (status) setAuthState(status)
  }, [status])

  const effective = authState || {
    ghAvailable: false,
    authenticated: false,
    username: '',
    authSource: 'none',
    tokenCreateUrl: DEFAULT_TOKEN_URL,
    deviceFlow: { active: false, status: 'idle', userCode: '', verificationUri: 'https://github.com/login/device' },
  }

  const deviceActive = Boolean(effective.deviceFlow?.active && effective.deviceFlow?.userCode)

  // Poll automatically while user finishes GitHub OAuth device authorization in browser
  useEffect(() => {
    if (!deviceActive || !onRefreshStatus) return
    const timer = setInterval(async () => {
      try {
        const next = await onRefreshStatus({ refresh: true })
        if (next) {
          setAuthState(next)
          if (next.authenticated) {
            onAuthenticated?.(next)
          }
        }
      } catch {}
    }, 2500)
    return () => clearInterval(timer)
  }, [deviceActive, onRefreshStatus, onAuthenticated])

  const handleRefresh = async () => {
    if (!onRefreshStatus) return
    setLoading(true)
    setError('')
    try {
      const next = await onRefreshStatus({ refresh: true })
      if (next) setAuthState(next)
    } catch (err) {
      setError(err?.message || '检查 GitHub 状态失败')
    } finally {
      setLoading(false)
    }
  }

  const handleStartDevice = async () => {
    if (!onStartDeviceLogin) return
    setDeviceLoading(true)
    setError('')
    try {
      const next = await onStartDeviceLogin()
      if (next) setAuthState(next)
    } catch (err) {
      setError(err?.message || '无法启动 GitHub 网页授权，请改用访问令牌 (PAT) 连接')
      setPatOpen(true)
    } finally {
      setDeviceLoading(false)
    }
  }

  const handleCopyAndOpenDevice = async () => {
    const code = effective.deviceFlow?.userCode
    const url = effective.deviceFlow?.verificationUri || 'https://github.com/login/device'
    if (code) {
      try {
        await navigator.clipboard.writeText(code)
        setCopiedCode(true)
        setTimeout(() => setCopiedCode(false), 2200)
      } catch {}
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  // The card is also rendered inside the import dialog's own <form>. A nested <form> is invalid HTML, so the
  // browser runs a native submit (page reload = blank plugin, token never sent). The PAT box is therefore a plain
  // group: the button and the Enter key call this directly, and the event never reaches an enclosing form.
  const handleSavePat = async e => {
    e?.preventDefault?.()
    e?.stopPropagation?.()
    if (patSaving || patValue.trim().length < 10 || !onSaveToken) return
    setPatSaving(true)
    setError('')
    try {
      const next = await onSaveToken({ token: patValue.trim() })
      if (next) {
        setAuthState(next)
        setPatValue('')
        setPatOpen(false)
        if (next.authenticated) onAuthenticated?.(next)
      }
    } catch (err) {
      setError(err?.message || '令牌验证失败')
    } finally {
      setPatSaving(false)
    }
  }

  const handleDisconnect = async (includeCli = false) => {
    if (!onLogout) return
    setLoading(true)
    setError('')
    try {
      const next = await onLogout({ includeCli })
      if (next) setAuthState(next)
    } catch (err) {
      setError(err?.message || '断开连接失败')
    } finally {
      setLoading(false)
    }
  }

  const authLabel = effective.authSource === 'pat'
    ? '访问令牌 (PAT)'
    : effective.authSource === 'gh-cli'
      ? '本机 GitHub CLI'
      : '未连接'

  return (
    <div className={`ot-gh-auth-card ${compact ? 'is-compact' : ''}`} data-testid="github-auth-card">
      <div className="ot-gh-auth-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
          <span className={`ot-gh-auth-icon ${effective.authenticated ? 'is-on' : ''}`}>
            <GithubLogo size={15} weight="bold" />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>
                {effective.authenticated ? `已连接 GitHub：@${effective.username}` : '连接你的 GitHub 账号'}
              </strong>
              {effective.authenticated && (
                <span className="ot-pill-soft" style={{ fontSize: 'var(--ot-fs-xs)' }}>
                  <CheckCircle size={10} weight="fill" style={{ color: 'var(--ot-dot-done)', marginRight: 3, verticalAlign: '-1px' }} />
                  {authLabel}
                </span>
              )}
            </div>
            <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', marginTop: 1 }}>
              {effective.authenticated
                ? '可检索并克隆公开/私有仓库。'
                : '授权后可导入私有仓库；公开库或本地目录无需登录。'}
            </div>
          </div>
        </div>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' }}>
          <button
            type="button"
            className="ot-icon-btn"
            title="重新检测 GitHub 状态"
            onClick={handleRefresh}
            disabled={loading}
          >
            <ArrowsClockwise size={13} className={loading ? 'ot-spin' : ''} />
          </button>
          {effective.authenticated && (
            <>
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                onClick={() => setPatOpen(v => !v)}
                data-testid="btn-github-switch-account"
              >
                <Key size={12} />
                <span>{patOpen ? '收起' : '换绑令牌'}</span>
              </button>
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                title={effective.authSource === 'pat' ? '移除已保存的 GitHub 令牌' : '退出本机 GitHub CLI 登录'}
                onClick={() => handleDisconnect(effective.authSource === 'gh-cli')}
                disabled={loading}
                data-testid="btn-github-logout"
              >
                <SignOut size={12} />
                <span>断开</span>
              </button>
            </>
          )}
        </div>
      </div>

      {!effective.authenticated && (
        <div className="ot-gh-auth-actions">
          {effective.ghAvailable && (
            <button
              type="button"
              className="ot-btn ot-btn--sm ot-btn--primary"
              disabled={deviceLoading}
              onClick={handleStartDevice}
              data-testid="btn-github-device-login"
            >
              <Browser size={13} />
              <span>{deviceLoading ? '正在获取授权码…' : '通过 GitHub 网页授权登录'}</span>
            </button>
          )}
          <button
            type="button"
            className={`ot-btn ot-btn--sm ${!effective.ghAvailable ? 'ot-btn--primary' : ''}`}
            onClick={() => setPatOpen(v => !v)}
            data-testid="btn-github-pat-toggle"
          >
            <Key size={13} />
            <span>{effective.ghAvailable ? '使用访问令牌 (PAT) 登录' : '配置 GitHub 访问令牌（不需要安装 gh）'}</span>
          </button>
        </div>
      )}

      {deviceActive && (
        <div className="ot-gh-device-box" data-testid="github-device-code-box">
          <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
            打开 GitHub 验证页输入下方授权码：
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <code className="ot-gh-device-code">{effective.deviceFlow.userCode}</code>
            <button
              type="button"
              className="ot-btn ot-btn--sm ot-btn--primary"
              onClick={handleCopyAndOpenDevice}
            >
              {copiedCode ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedCode ? '已复制并打开验证页' : '复制授权码并打开 GitHub'}</span>
              <ArrowSquareOut size={12} />
            </button>
          </div>
        </div>
      )}

      {patOpen && (
        <div className="ot-gh-pat-form" role="group" aria-label="GitHub 访问令牌" data-testid="github-pat-form">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
              仅存本机，勾选 <code className="ot-inline-code">repo</code> 权限即可。
            </span>
            <a
              href={effective.tokenCreateUrl || DEFAULT_TOKEN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ot-link-inline"
            >
              <span>去 GitHub 生成令牌</span>
              <ArrowSquareOut size={11} />
            </a>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="password"
              className="ot-input ot-input--sm"
              style={{ flex: 1 }}
              value={patValue}
              onChange={e => setPatValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) handleSavePat(e) }}
              placeholder="粘贴 ghp_... 或 github_pat_..."
              autoComplete="off"
              data-testid="input-github-pat"
            />
            <button
              type="button"
              onClick={handleSavePat}
              className="ot-btn ot-btn--sm ot-btn--primary"
              disabled={patSaving || patValue.trim().length < 10}
              data-testid="btn-submit-github-pat"
            >
              {patSaving ? '校验中…' : '校验并连接'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="ot-avatar-spec-err" style={{ marginTop: 2 }}>
          <WarningCircle size={12} weight="fill" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
