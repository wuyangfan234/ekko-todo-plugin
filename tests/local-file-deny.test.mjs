// #62 C05: host-file preview must refuse credential files before touching them.
// All fixtures are fake data under a throwaway home in $TMPDIR — never real credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { readLocalFile, checkLocalPathAllowed } from '../src/server/local-file.mjs'

// Temp roots must not sit inside a credential directory: Hermes' own default TMPDIR is
// ~/.hermes/cache/scratch, and a fixture root under .hermes would make every case meaningless.
const ROOT_DENY_SEGMENTS = ['.hermes', 'secrets', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.password-store',
  'keychains', '.claude', '.gemini', '.kimi', '.codex', '.cursor']
function hasDeniedSegment(p) {
  return String(p).split(/[\\/]+/).some(seg => ROOT_DENY_SEGMENTS.includes(seg.toLowerCase()))
}
function mkTmp(prefix) {
  for (const base of [tmpdir(), '/tmp']) {
    let real
    try { real = realpathSync(base) } catch { continue }
    if (hasDeniedSegment(real)) continue
    const dir = realpathSync(mkdtempSync(join(real, prefix)))
    assert.ok(!hasDeniedSegment(dir), `temp root ${dir} sits inside a credential directory`)
    return dir
  }
  throw new Error(`no temp base outside credential directories (tmpdir=${tmpdir()})`)
}

const CREDENTIAL_FILES = [
  '.config/gh/hosts.yml',
  '.gemini/oauth_creds.json',
  '.hermes/config.yaml',
  '.ssh/id_ed25519',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  '.credentials.json',
  'projects/app/.credentials.json',
  '.claude/.credentials.json',
  '.aws/credentials',
  '.gnupg/pubring.kbx',
  '.kube/config',
  '.kimi/config.toml',
  '.codex/auth.json',
  '.cursor/mcp.json',
  'deep/nested/.config/gh/hosts.yml',
  '.env',
  '.env.local',
  'auth.json',
  'credentials.txt',
  'github_token.txt',
]

function fakeHome() {
  const home = mkTmp('ekko-deny-home-')
  for (const rel of CREDENTIAL_FILES) {
    mkdirSync(dirname(join(home, rel)), { recursive: true })
    writeFileSync(join(home, rel), 'FAKE-NOT-A-SECRET\n')
  }
  writeFileSync(join(home, 'notes.md'), '# 正当笔记\n')
  mkdirSync(join(home, 'proj'), { recursive: true })
  writeFileSync(join(home, 'proj', 'hosts.yml'), 'inventory: []\n')
  return home
}

test('#62 C05: every credential path is denied by policy', () => {
  const home = fakeHome()
  try {
    for (const rel of CREDENTIAL_FILES) {
      const reason = checkLocalPathAllowed(join(home, rel), [home])
      assert.notEqual(reason, '', `expected deny for ${rel}`)
      assert.match(reason, /安全/, rel)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05: existing credential files are refused before any byte is read', () => {
  const home = fakeHome()
  try {
    for (const rel of CREDENTIAL_FILES) {
      for (const mode of ['meta', 'text', 'bytes']) {
        assert.throws(() => readLocalFile({ path: join(home, rel), mode }, { allowRoots: [home] }), /安全/, `${rel} ${mode}`)
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05: deny check runs before the existence check', () => {
  const home = mkTmp('ekko-deny-empty-')
  try {
    for (const rel of ['.git-credentials', '.claude/.credentials.json', '.aws/credentials', '.config/gh/hosts.yml']) {
      assert.throws(
        () => readLocalFile({ path: join(home, rel), mode: 'meta' }, { allowRoots: [home] }),
        err => /安全/.test(err.message) && !/不存在/.test(err.message),
        rel,
      )
    }
    // A missing file that hits no deny rule still reports "不存在".
    assert.throws(() => readLocalFile({ path: join(home, 'missing.md') }, { allowRoots: [home] }), /不存在/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05: legitimate files stay readable (no blanket deny)', () => {
  const home = fakeHome()
  try {
    assert.equal(checkLocalPathAllowed(join(home, 'notes.md'), [home]), '')
    const md = readLocalFile({ path: join(home, 'notes.md'), mode: 'text' }, { allowRoots: [home] })
    assert.equal(md.text, '# 正当笔记\n')
    // hosts.yml is only sensitive under .config/gh
    assert.equal(checkLocalPathAllowed(join(home, 'proj', 'hosts.yml'), [home]), '')
    assert.equal(readLocalFile({ path: join(home, 'proj', 'hosts.yml'), mode: 'meta' }, { allowRoots: [home] }).kind, 'text')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05: caller identity reaches the policy and user-visible roots are enforced when supplied', () => {
  const home = fakeHome()
  const other = mkTmp('ekko-deny-other-')
  try {
    writeFileSync(join(other, 'notes.md'), 'other user\n')
    const identity = { userId: 2, profile: 'default' }
    // No user-root mapping from the host → identity is carried but cannot narrow scope.
    assert.equal(checkLocalPathAllowed(join(other, 'notes.md'), [home, other], { identity }), '')
    // With a mapping, paths outside the caller's roots are refused before reading.
    const reason = checkLocalPathAllowed(join(other, 'notes.md'), [home, other], { identity, userRoots: [home] })
    assert.match(reason, /超出当前用户可见范围/)
    assert.throws(
      () => readLocalFile({ path: join(other, 'notes.md') }, { allowRoots: [home, other], identity, userRoots: [home] }),
      /超出当前用户可见范围/,
    )
    assert.equal(readLocalFile({ path: join(home, 'notes.md'), mode: 'text' }, { allowRoots: [home, other], identity, userRoots: [home] }).text, '# 正当笔记\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

// ~/.hermes/cache holds every agent screenshot shown in chat; it must stay readable while the
// rest of ~/.hermes stays denied. The exception is decided on the path relative to an allow root.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const HERMES_DENIED = [
  '.hermes/config.yaml',
  '.hermes/secrets/x.json',
  '.hermes/secrets/oic-auth.json',
  '.hermes/secrets/gmail-app-password',
  '.hermes/secrets/cache/token.txt', // bypass attempt: "cache" deeper than right after .hermes
  '.hermes/state.db',
  '.hermes/state.db-wal',
  '.hermes/state.db-shm',
  '.hermes/logs/agent.log',
  '.hermes/sessions/s1.json',
  '.hermes/plugins/p/settings.json',
  '.hermes/profiles/work/config.yaml',
  // bypass attempts that only the .hermes rule catches (no other deny rule matches them)
  '.hermes/logs/cache/agent.log',
  '.hermes/profiles/cache/config.yaml',
  '.hermes/cache.yaml',
  'nested/.hermes/cache/scratch/a.png', // .hermes not directly under an allow root
]

function hermesHome() {
  const home = mkTmp('ekko-hermes-home-')
  for (const rel of [...HERMES_DENIED, '.hermes/cache/scratch/a.png', '.hermes/cache/scratch/t59/note.md']) {
    mkdirSync(dirname(join(home, rel)), { recursive: true })
    writeFileSync(join(home, rel), rel.endsWith('.png') ? PNG : 'FAKE-NOT-A-SECRET\n')
  }
  return home
}

test('#62 C05: <home>/.hermes/cache/** stays readable for chat screenshots', () => {
  const home = hermesHome()
  try {
    const png = join(home, '.hermes/cache/scratch/a.png')
    assert.equal(checkLocalPathAllowed(png, [home]), '')
    const img = readLocalFile({ path: png }, { allowRoots: [home] })
    assert.equal(img.kind, 'image')
    assert.equal(img.eof, true)
    // Review round 2: only images are exempt, so a markdown file in scratch is refused.
    assert.throws(() => readLocalFile({ path: join(home, '.hermes/cache/scratch/t59/note.md'), mode: 'text' }, { allowRoots: [home] }), /安全/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05: everything else under ~/.hermes is denied, including cache-named bypasses', () => {
  const home = hermesHome()
  try {
    for (const rel of HERMES_DENIED) {
      assert.match(checkLocalPathAllowed(join(home, rel), [home]), /安全/, rel)
      assert.throws(() => readLocalFile({ path: join(home, rel), mode: 'meta' }, { allowRoots: [home] }), /安全/, rel)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05: cache exception does not disable other deny rules inside it', () => {
  const home = mkTmp('ekko-hermes-in-')
  try {
    for (const rel of ['.hermes/cache/.env', '.hermes/cache/x/.ssh/id_ed25519', '.hermes/cache/github_token.txt', '.hermes/cache/x/state.db', '.hermes/cache/.config/gh/hosts.yml']) {
      assert.match(checkLocalPathAllowed(join(home, rel), [home]), /安全/, rel)
      assert.throws(() => readLocalFile({ path: join(home, rel), mode: 'meta' }, { allowRoots: [home] }), err => /安全/.test(err.message) && !/不存在/.test(err.message), rel)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// Review round 2: the cache exemption covers only images (not svg) in scratch/images/screenshots.
// Each case below pins one way the exemption could be widened.
const CACHE_CASES = [
  ['.hermes/cache/scratch/a.png', true, 'baseline: image in scratch'],
  ['.hermes/cache/delegation/x.txt', false, 'directory outside the whitelist'],
  ['.hermes/cache/exec/stdout.txt', false, 'directory outside the whitelist'],
  ['.hermes/cache/mcp_schema_cache.json', false, 'file directly under cache'],
  ['.hermes/cache/scratch/a.md', false, 'non-image inside scratch'],
  ['.hermes/cache/scratch/a.svg', false, 'svg can carry script'],
  ['.hermes/cache/documents/a.png', false, 'image outside the whitelisted directories'],
  ['.hermes/cache/delegation/scratch/a.png', false, 'whitelisted name deeper than rel[2]'],
]
for (const [rel, allowed, why] of CACHE_CASES) {
  test(`#62 C05 r2: ${rel} → ${allowed ? 'allowed' : 'denied'} (${why})`, () => {
    const home = mkTmp('ekko-cache-case-')
    try {
      const p = join(home, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, /\.png$/.test(rel) ? PNG : 'FAKE-NOT-A-SECRET\n')
      if (allowed) {
        assert.equal(checkLocalPathAllowed(p, [home]), '')
        assert.equal(readLocalFile({ path: p, mode: 'meta' }, { allowRoots: [home] }).kind, 'image')
      } else {
        assert.match(checkLocalPathAllowed(p, [home]), /安全/)
        assert.throws(() => readLocalFile({ path: p, mode: 'meta' }, { allowRoots: [home] }), /安全/)
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
}

test('#62 C05 r2: images and screenshots directories are exempt the same way as scratch', () => {
  const home = mkTmp('ekko-cache-dirs-')
  try {
    for (const rel of ['.hermes/cache/images/b.jpg', '.hermes/cache/screenshots/c.webp', '.hermes/cache/Scratch/d.PNG']) {
      assert.equal(checkLocalPathAllowed(join(home, rel), [home]), '', rel)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('#62 C05 r2: an allow root that itself sits under .hermes cannot shift the exemption', () => {
  const base = mkTmp('ekko-cache-guard-')
  try {
    const outer = join(base, 'home')
    const inner = join(outer, '.hermes', 'cache', 'scratch', 'run1') // e.g. TMPDIR=~/.hermes/cache/scratch
    mkdirSync(inner, { recursive: true })
    // Root inside .hermes only: the outer .hermes segment is never exempted.
    for (const rel of ['notes.md', 'a.png', '.hermes/cache/scratch/a.png', '.hermes/secrets/x.json', '.hermes/config.yaml']) {
      assert.match(checkLocalPathAllowed(join(inner, rel), [inner]), /安全/, `inner-only ${rel}`)
    }
    // Both roots present, in either order: the real screenshot path is allowed, nothing else is.
    for (const roots of [[outer, inner], [inner, outer]]) {
      assert.equal(checkLocalPathAllowed(join(outer, '.hermes/cache/scratch/a.png'), roots), '')
      assert.equal(checkLocalPathAllowed(join(inner, 'a.png'), roots), '')
      for (const p of [
        join(inner, 'notes.md'),
        join(inner, '.hermes/cache/scratch/a.png'),
        join(inner, '.hermes/secrets/x.json'),
        join(outer, '.hermes/config.yaml'),
        join(outer, '.hermes/cache/delegation/x.png'),
      ]) {
        assert.match(checkLocalPathAllowed(p, roots), /安全/, `${p} with roots ${roots.join(',')}`)
      }
    }
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('#62 C05 r2: fixture temp roots never sit inside a credential directory', () => {
  const dir = mkTmp('ekko-root-check-')
  try { assert.equal(hasDeniedSegment(dir), false) } finally { rmSync(dir, { recursive: true, force: true }) }
})
