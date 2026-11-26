// C02: a GitHub PAT used for cloning must never reach git's argv, nor any error text built from a failed clone
// (err.message / err.cmd / err.stderr are written to the plugin log, the HTTP response and the UI toast).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneGithubRepo } from '../src/server/git-engine.mjs'

const FAKE_PAT = 'ghp_FakeLeakProbe0123456789abcdefABCDEF'
const B64 = Buffer.from('x-access-token:' + FAKE_PAT).toString('base64')
const FORMS = [B64, 'x-access-token:' + FAKE_PAT, FAKE_PAT]

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function withEnv(vars, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  return fn().finally(restore)
}

test('C02: failed PAT clone throws, but err.message/err.cmd/err.stderr carry no form of the token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-pat-leak-fail-'))
  try {
    // Non-empty, non-git target: git refuses before touching the network.
    const target = join(root, 'occupied')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'not a repo\n')

    let caught = null
    try {
      await cloneGithubRepo({ githubRepo: 'owner/private-repo', targetPath: target, pat: FAKE_PAT })
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'clone into a non-empty dir must still throw to the caller')
    assert.match(String(caught.message), /Command failed/, 'error still describes the failed git command')
    for (const field of ['message', 'cmd', 'stderr']) {
      const text = String(caught[field] ?? '')
      for (const form of FORMS) {
        assert.ok(!text.includes(form), `err.${field} leaks token form ${JSON.stringify(form.slice(0, 18))}…: ${text.slice(0, 300)}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('C02: successful PAT clone passes the header via env, not argv, and leaves .git/config clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-pat-leak-ok-'))
  try {
    // Local bare repo standing in for github.com/owner/repo (via url.insteadOf in an isolated global config).
    const src = join(root, 'src.git')
    git(root, ['init', '-q', '--bare', src])
    const work = join(root, 'work')
    git(root, ['clone', '-q', src, work])
    git(work, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    git(work, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    git(src, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    const globalCfg = join(root, 'gitconfig')
    writeFileSync(globalCfg, `[url "${src}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`)
    const trace = join(root, 'trace2.json')

    const target = join(root, 'dst')
    await withEnv({
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_TRACE2_EVENT: trace,
      // Ask trace2 to report the effective value of the header key, proving it is still delivered.
      GIT_TRACE2_CONFIG_PARAMS: 'http.https://github.com/.extraheader',
    }, () => cloneGithubRepo({ githubRepo: 'owner/repo', targetPath: target, pat: FAKE_PAT }))

    assert.ok(existsSync(join(target, '.git')), 'clone succeeded')
    const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const top = events.find(e => e.event === 'start' && Array.isArray(e.argv) && e.argv.includes('clone'))
    assert.ok(top, 'trace2 recorded the clone argv')
    const argv = top.argv.join(' ')
    for (const form of FORMS) assert.ok(!argv.includes(form), `argv leaks token: ${argv}`)
    assert.ok(!argv.includes('extraheader'), `argv must not carry the auth header: ${argv}`)

    const param = events.find(e => e.event === 'def_param' && /extraheader/i.test(e.param || ''))
    assert.ok(param, 'header config is still delivered to git (via env)')
    assert.equal(param.value, `AUTHORIZATION: basic ${B64}`)

    const cfg = readFileSync(join(target, '.git', 'config'), 'utf8')
    assert.ok(!/extraheader/i.test(cfg), '.git/config has no extraheader')
    for (const form of FORMS) assert.ok(!cfg.includes(form), '.git/config has no token')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
