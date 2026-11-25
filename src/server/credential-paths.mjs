/**
 * Cross-platform credential locations for the quota panel (macOS / Windows / Linux).
 *
 * Order for every provider: the CLI's own env override → the CLI's per-OS default → Ekko Studio (Hermes home).
 * Locations follow each official CLI's documented config dirs, the same tables ccusage and CodexBar use:
 *   Codex        $CODEX_HOME | ~/.codex/auth.json                      (all OS; ~ = %USERPROFILE% on Windows)
 *   Claude Code  $CLAUDE_CONFIG_DIR | ~/.claude/.credentials.json | $XDG_CONFIG_HOME/claude ; macOS keychain extra
 *   Gemini CLI   $GEMINI_CLI_HOME/.gemini | ~/.gemini/oauth_creds.json
 *   Grok CLI     $GROK_HOME | ~/.grok/auth.json
 *   Kimi CLI     $KIMI_SHARE_DIR | ~/.kimi ; config also $XDG_CONFIG_HOME/kimi, %APPDATA%\kimi
 *   Hermes home  $HERMES_HOME | Windows %LOCALAPPDATA%\hermes | ~/.hermes  (+ profiles/<name> for non-default)
 *
 * Every reader here is total: a missing, unreadable or malformed file yields null, never a throw.
 * Paths are built with the platform's own path module so a win32 layout is correct even when tested on POSIX.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function platformInfo(over = {}) {
  const platform = over.platform || process.platform
  const env = over.env || process.env
  const home = over.home || homedir()
  const p = platform === 'win32' ? path.win32 : path.posix
  return { platform, env, home, join: (...a) => p.join(...a) }
}

const clean = v => String(v || '').trim()
const uniq = list => [...new Set(list.filter(Boolean))]

/** Hermes (Ekko Studio) home directories, most specific first. */
export function hermesHomes({ profile = '', ...over } = {}) {
  const { platform, env, home, join } = platformInfo(over)
  const suffix = clean(env.HERMES_DATA_DIR_SUFFIX)
  const roots = []
  if (clean(env.HERMES_HOME)) roots.push(clean(env.HERMES_HOME))
  if (platform === 'win32') {
    const local = clean(env.LOCALAPPDATA) || join(home, 'AppData', 'Local')
    roots.push(join(local, `hermes${suffix}`))
  }
  roots.push(join(home, `.hermes${suffix}`))
  const prof = clean(profile).replace(/[^A-Za-z0-9._-]/g, '')
  const out = []
  for (const r of uniq(roots)) {
    // HERMES_HOME may already point at a profile dir; only nest when it is a root.
    if (prof && prof !== 'default' && !/[\\/]profiles[\\/][^\\/]+[\\/]?$/.test(r)) out.push(join(r, 'profiles', prof))
    out.push(r)
  }
  return uniq(out)
}

/** Candidate credential files per provider for the current (or given) OS. */
export function credentialCandidates(provider, over = {}) {
  const { platform, env, home, join } = platformInfo(over)
  const xdg = clean(env.XDG_CONFIG_HOME) || join(home, '.config')
  const appData = clean(env.APPDATA) || join(home, 'AppData', 'Roaming')
  switch (provider) {
    case 'codex':
      return uniq([clean(env.CODEX_HOME) && join(clean(env.CODEX_HOME), 'auth.json'), join(home, '.codex', 'auth.json')])
    case 'claude':
      return uniq([
        clean(env.CLAUDE_CONFIG_DIR) && join(clean(env.CLAUDE_CONFIG_DIR), '.credentials.json'),
        join(home, '.claude', '.credentials.json'),
        platform === 'linux' && join(xdg, 'claude', '.credentials.json'),
      ])
    case 'gemini':
      return uniq([
        clean(env.GEMINI_CLI_HOME) && join(clean(env.GEMINI_CLI_HOME), '.gemini', 'oauth_creds.json'),
        join(home, '.gemini', 'oauth_creds.json'),
      ])
    case 'grok':
      return uniq([clean(env.GROK_HOME) && join(clean(env.GROK_HOME), 'auth.json'), join(home, '.grok', 'auth.json')])
    case 'kimi':
      return uniq([
        clean(env.KIMI_SHARE_DIR) && join(clean(env.KIMI_SHARE_DIR), 'credentials', 'kimi-code.json'),
        join(home, '.kimi', 'credentials', 'kimi-code.json'),
      ])
    case 'kimi-config':
      return uniq([
        clean(env.KIMI_SHARE_DIR) && join(clean(env.KIMI_SHARE_DIR), 'config.toml'),
        join(home, '.kimi', 'config.toml'),
        join(xdg, 'kimi', 'config.toml'),
        platform === 'win32' && join(appData, 'kimi', 'config.toml'),
      ])
    default:
      return []
  }
}

/** Only darwin has the login keychain the Claude Code CLI writes to. */
export function usesMacKeychain(over = {}) {
  return platformInfo(over).platform === 'darwin'
}

export function readJsonFirst(paths, { exists = existsSync, read = p => readFileSync(p, 'utf8') } = {}) {
  for (const p of paths) {
    try {
      if (!exists(p)) continue
      const parsed = JSON.parse(read(p))
      if (parsed && typeof parsed === 'object') return { path: p, data: parsed }
    } catch {
      // unreadable / malformed: try the next candidate
    }
  }
  return null
}

/** `.env` lines (`KEY=value`, optional quotes / `export`), first non-empty hit across files. */
export function readDotEnvFirst(paths, keys, { exists = existsSync, read = p => readFileSync(p, 'utf8') } = {}) {
  for (const p of paths) {
    try {
      if (!exists(p)) continue
      const raw = read(p)
      for (const key of keys) {
        const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm')
        const m = raw.match(re)
        const v = clean(m?.[1]).replace(/^(['"])(.*)\1$/, '$2').trim()
        if (v) return v
      }
    } catch {
      // ignore
    }
  }
  return ''
}

/**
 * Ekko Studio fallback: the credentials Studio itself logged in with, read from Hermes `auth.json`
 * (`credential_pool.<id>[]` first, then `providers.<id>`) or Hermes `.env` for API-key providers.
 */
const STUDIO_OAUTH_IDS = {
  codex: ['openai-codex'],
  claude: ['anthropic'],
  grok: ['xai-oauth'],
  antigravity: ['google-gemini-cli', 'gemini'],
}
const STUDIO_ENV_KEYS = {
  kimi: ['KIMI_CODE_API_KEY', 'KIMI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
}

export function discoverStudioCredential(provider, { profile = '', io, ...over } = {}) {
  const homes = hermesHomes({ profile, ...over })
  const { join } = platformInfo(over)
  const envKeys = STUDIO_ENV_KEYS[provider]
  if (envKeys) {
    const v = readDotEnvFirst(homes.map(h => join(h, '.env')), envKeys, io)
    return v ? { secret: v, sourceLabel: 'Ekko Studio 凭据' } : null
  }
  const ids = STUDIO_OAUTH_IDS[provider]
  if (!ids) return null
  for (const h of homes) {
    const hit = readJsonFirst([join(h, 'auth.json')], io)
    if (!hit) continue
    const store = hit.data
    for (const id of ids) {
      const pool = Array.isArray(store?.credential_pool?.[id]) ? store.credential_pool[id] : []
      const entries = pool
        .filter(e => e && typeof e === 'object' && clean(e.access_token))
        .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
      const state = store?.providers?.[id]
      const fromState = clean(state?.tokens?.access_token || state?.access_token)
      const pick = entries[0]
      const token = clean(pick?.access_token) || fromState
      if (!token) continue
      // Claude's usage endpoint only accepts OAuth tokens; a plain console API key there is a 401, not a quota.
      if (provider === 'claude' && !token.startsWith('sk-ant-oat')) continue
      // The Cloud Code quota call needs a Google OAuth access token, not a Gemini API key.
      if (provider === 'antigravity' && !token.startsWith('ya29.')) continue
      return {
        secret: token,
        accountId: clean(pick?.account_id || state?.tokens?.account_id || state?.account_id),
        sourceLabel: 'Ekko Studio 凭据',
      }
    }
  }
  return null
}
