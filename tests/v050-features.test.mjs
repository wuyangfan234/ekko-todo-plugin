import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import {
  AGENT_AVATAR_PRESETS,
  validateAvatarValue,
  extractMonogram,
} from '../src/server/avatars.mjs'

function makeTempGitRepo(root) {
  const repoDir = join(root, 'alpha-portal')
  execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'pipe' })
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'ci@example.com'])
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'CI'])
  writeFileSync(join(repoDir, 'README.md'), '# Alpha Portal\n')
  execFileSync('git', ['-C', repoDir, 'add', '.'])
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'pipe' })
  return repoDir
}

test('avatar validator enforces preset whitelist, raster MIME, 128KB cap, and blocks SVG XSS', () => {
  assert.equal(validateAvatarValue(''), '')
  assert.equal(validateAvatarValue(AGENT_AVATAR_PRESETS[0]), AGENT_AVATAR_PRESETS[0])
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  assert.equal(validateAvatarValue(tinyPng, { allowPreset: false }), tinyPng)

  assert.throws(() => validateAvatarValue('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), /不支持 SVG/)
  assert.throws(() => validateAvatarValue('https://evil.example/a.png'), /仅支持 PNG/)
  assert.throws(() => validateAvatarValue('preset:nonexistent'), /不支持的默认头像/)
  assert.throws(() => validateAvatarValue('preset:chief-compass', { allowPreset: false }), /不支持的默认头像/)
  const huge = 'data:image/png;base64,' + 'A'.repeat(140000)
  assert.throws(() => validateAvatarValue(huge), /128 KB/)

  assert.equal(extractMonogram('星海官网'), '星')
  assert.equal(extractMonogram('alpha-portal'), 'A')
  assert.equal(extractMonogram('  '), 'P')
})

test('project display alias, avatar, custom non-coding Agent roles, concurrency update, and non-Hermes onboarding', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ekko-v050-'))
  try {
    const repoDir = makeTempGitRepo(tmp)
    const db = createDatabase(join(tmp, 'data'))
    const sentInputs = []
    const orch = createOrchestrator({ db, dataDir: join(tmp, 'data') })

    const run = {
      identity: { userId: 7, profile: 'default' },
      host: {
        agents: {
          async list() {
            return {
              agents: [
                { id: 'claude-code', name: 'Claude Code', status: { installed: true, version: '2.1' }, modes: ['global', 'scoped'] },
                { id: 'codex', name: 'Codex', status: { installed: true, version: '0.9' }, modes: ['global', 'scoped'] },
              ],
            }
          },
        },
        sessions: {
          async create(body) { return { id: `sess-${body.agent}-${Date.now()}` } },
          async setWorkspace() {},
          async setModel() {},
          async run(sid, input, opts) { sentInputs.push({ sid, input, opts }); return { run_id: 'r-1' } },
          async stop() {},
        },
      },
      messages: { emit() {}, notify() {} },
    }

    // 1. Fresh workspace signals needsOnboarding = true
    const initSnap = await orch.getSnapshot(run)
    assert.equal(initSnap.runtime.needsOnboarding, true)

    // 2. Onboarding allows picking NON-Hermes engine (Claude Code) as primary Chief + newmedia preset!
    const afterOnboard = await orch.completeOnboarding(run, {
      chiefName: '内容大总管',
      chiefAvatar: 'preset:media-spark',
      chiefEngine: 'claude-code',
      chiefMode: 'global',
      chiefReasoningEffort: 'xhigh',
      fallbackEngine: 'codex',
      teamPreset: 'newmedia',
      applyTeamPreset: true,
    })
    assert.equal(afterOnboard.settings.onboardingCompleted, true)
    assert.equal(afterOnboard.settings.teamPreset, 'newmedia')
    assert.equal(afterOnboard.runtime.needsOnboarding, false)
    const chief = afterOnboard.agents.find(a => a.id === afterOnboard.settings.chiefAgentId)
    assert.equal(chief.name, '内容大总管')
    assert.equal(chief.engine, 'claude-code')
    assert.equal(chief.avatar, 'preset:media-spark')
    assert.equal(chief.modelConfigs.length, 2)
    assert.equal(chief.modelConfigs[1].engine, 'codex')
    assert.ok(afterOnboard.agents.some(a => a.roleLabel === '选题策划' && a.role === 'custom'))
    assert.ok(afterOnboard.agents.some(a => a.roleLabel === '内容主编'))

    // 3. Concurrency limit updates & persists cleanly (bug #2)
    const afterConc = await orch.saveSettings(run, { maxConcurrentBuilds: 5 })
    assert.equal(afterConc.settings.maxConcurrentBuilds, 5)
    assert.equal(afterConc.concurrency.limit, 5)

    // 4. Project displayName alias & custom avatar & monogram sync
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const added = await orch.addProject(run, {
      name: 'alpha-portal',
      displayName: '星海门户',
      accent: 'violet',
      repoPath: repoDir,
    })
    assert.equal(added.project.displayName, '星海门户')
    assert.equal(added.project.monogram, '星')
    assert.equal(added.project.accent, 'violet')
    const updatedProj = await orch.updateProject(run, {
      id: added.project.id,
      displayName: '极光门户',
      avatar: tinyPng,
    })
    assert.equal(updatedProj.project.displayName, '极光门户')
    assert.equal(updatedProj.project.monogram, '极')
    assert.equal(updatedProj.project.avatar, tinyPng)

    // 5. Chat all-format file upload + @Agent mention multimodal dispatch (Hermes-WebUI spec)
    const uploadedDoc = await orch.uploadChatFile(run, {
      name: 'campaign-brief.md',
      mediaType: 'text/markdown',
      dataBase64: Buffer.from('# Q4 Launch Plan\nTarget: 100k reads').toString('base64'),
    })
    assert.equal(uploadedDoc.type, 'file')
    assert.ok(existsSync(uploadedDoc.path))

    const uploadedImg = await orch.uploadChatFile(run, {
      name: 'cover.png',
      mediaType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    })
    assert.equal(uploadedImg.type, 'image')
    assert.ok(existsSync(uploadedImg.path))

    // Switch chief back to hermes scoped to verify multimodal array format, then also test external CLI text format
    await orch.quickConfigureChief(run, { engine: 'hermes', mode: 'scoped' })
    const { topic } = await orch.createTopic(run, { projectId: added.project.id })
    const planner = afterOnboard.agents.find(a => a.roleLabel === '选题策划')

    const afterMsg = await orch.sendTopicMessage(run, {
      topicId: topic.id,
      text: `请 @${planner.name} 参考这两份资料出 5 个爆款选题`,
      attachments: [uploadedDoc, uploadedImg],
      mentionedAgentIds: [planner.id],
    })
    const savedTopic = afterMsg.topics.find(t => t.id === topic.id)
    assert.equal(savedTopic.messages[0].attachments.length, 2)
    assert.equal(sentInputs.length, 1)
    assert.ok(Array.isArray(sentInputs[0].input), 'Hermes scoped chief must receive Hermes-WebUI multimodal array input')
    assert.equal(sentInputs[0].input[0].type, 'text')
    assert.ok(sentInputs[0].input[0].text.includes('用户 @ 提及的 Agent'))
    assert.ok(sentInputs[0].input[0].text.includes(planner.name))
    assert.equal(sentInputs[0].input[1].type, 'file')
    assert.equal(sentInputs[0].input[2].type, 'image')

    // 6. MCP configure_agent supports custom role_label & avatar preset
    const tools = new Map()
    registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
    const mcpRes = await tools.get('configure_agent').execute({
      name: '小红书视觉编导',
      role: 'custom',
      role_label: '视觉编导',
      avatar: 'preset:designer-palette',
      engine: 'claude-code',
      description: '负责图文封面配色与分镜脚本',
    }, run)
    assert.equal(mcpRes.ok, true)
    assert.equal(mcpRes.data.agent.roleLabel, '视觉编导')
    assert.equal(mcpRes.data.agent.avatar, 'preset:designer-palette')

    // 7. GitHub PAT is stored securely server-side and NEVER leaked into state snapshot
    const fakePat = ['test', 'pat', 'secret', 'never', 'leak', '999'].join('_')
    db.setGithubToken(7, 'default', { token: fakePat, username: 'octocat' })
    const snapWithPat = await orch.getSnapshot(run)
    const serialized = JSON.stringify(snapWithPat)
    assert.ok(!serialized.includes(fakePat), 'raw PAT must NEVER appear in snapshot')
    assert.equal(snapWithPat.settings.hasGithubToken, true)
    assert.equal(snapWithPat.settings.githubTokenUser, 'octocat')

    db.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
