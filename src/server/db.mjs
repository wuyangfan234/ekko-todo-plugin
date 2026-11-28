import { MAX_CHARTER_CHARS, MAX_LAST_ERROR_CHARS, MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_TITLE_CHARS, MAX_QUEUED_TEXT_CHARS, clampBrief, clampQuestion, clampOptions, clampTags, echoesShortenedView, MAX_LOGGED_HEAD_CHARS, MAX_SYSTEM_PROMPT_CHARS, assertMaxLength, MAX_AGENT_REF_CHARS, MAX_TOPIC_TITLE_CHARS, MAX_CLONE_ROOT_CHARS, MODEL_CONFIG_LIMITS, PROJECT_DESCRIPTIVE_FIELDS, PROJECT_TEXT_LIMITS, MAX_PLAN_BYTES, MAX_SPEC_CHARS, MAX_TIMELINE_EVENT_CHARS, MAX_TITLE_CHARS, MAX_TOPIC_MESSAGE_CHARS, omittedProjectAvatarMarker, clampBuildChat, clampDiffs, clampText, clampTimeline, clampUtf8 } from './diff-budget.mjs'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_AGENT_TURNS } from '../shared/turn-budget.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeModelConfigs } from './failover.mjs'
import { createSearchEngine } from './search.mjs'
import { matchesQuery, normalizeSearchQuery } from '../shared/search-text.mjs'
import { DEFAULT_QUOTA_PROVIDERS, maskSecret } from './quota-engine.mjs'
import { MAX_SCHEDULES, computeNextRunAt, normalizeScheduleInput } from './schedule-engine.mjs'
import {
  PROJECT_ACCENTS,
  defaultAvatarForRole,
  defaultRoleLabelForRole,
  extractMonogram,
  validateAvatarValue,
} from './avatars.mjs'

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

function nowMs() {
  return Date.now()
}

export const DEFAULT_CHIEF_AUTHORITY = Object.freeze({
  canConfigureAgents: true,
  canSwitchModels: true,
  canManageMemories: true,
  canManageProjects: true,
  canAdjustConcurrency: true,
  injectHostMemory: true,
})

const DEFAULT_AGENT_SPECS = {
  chief: {
    name: '大总管',
    description: '单入口统筹全部项目，负责需求拆解、任务调度、独立审查把关及全局 Agent 与记忆治理。',
    systemPrompt: '你是 Ekko ToDo 的大总管，作为用户跨项目的统一编排入口。负责拆解目标、在隔离 Git Worktree 中调度开发 Agent 执行、安排跨引擎独立审查，并可在授权范围内管理 Agent 配置、主备模型链、总管章程与持久记忆；仅在真正需要人工决策或部署红线处暂停询问用户。',
  },
  builder: {
    name: '开发 Agent',
    description: '在隔离 Git Worktree 中完成方案规划、代码实现、自动化测试与可核验变更交付。',
    systemPrompt: '你是开发执行 Agent。严格在分配的隔离 Git Worktree 中实现需求，编写并运行针对性测试，汇报精确的变更文件、测试退出码与验证结果，严禁污染主工作树。',
  },
  reviewer: {
    name: '审查 Agent',
    description: '跨引擎只读审计代码 Diff、回归风险与测试证据，严禁直接修改仓库文件。',
    systemPrompt: '你是独立代码审查 Agent。仅以只读方式严格审计本次提交的精确 Diff、边界条件与测试门禁结果，严禁修改文件或执行破坏性命令。审查结尾必须单独输出一行 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。',
  },
}

const LEGACY_NAME_MIGRATIONS = {
  'Chief Orchestrator': DEFAULT_AGENT_SPECS.chief,
  'Lead Builder': DEFAULT_AGENT_SPECS.builder,
  'Independent Reviewer': DEFAULT_AGENT_SPECS.reviewer,
  '核心主程': DEFAULT_AGENT_SPECS.builder,
  '独立审查员': DEFAULT_AGENT_SPECS.reviewer,
}

// Nonce made by the page for one send: printable ASCII without spaces, at most 64 characters, else ''.
const MAX_SEND_ERROR_CHARS = 500
function cleanClientNonce(value) {
  const text = String(value || '')
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : ''
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

const CHIEF_EFFORT_CAPS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

/** '' = no cap; anything unknown falls back to the default 'medium'. */
function normalizeEffortCap(v) {
  const x = String(v ?? '').trim().toLowerCase()
  if (x === 'off' || x === 'none') return ''
  return CHIEF_EFFORT_CAPS.includes(x) ? x : 'medium'
}

function clampInvestigationLimit(v) {
  return Math.max(3, Math.min(40, Math.floor(Number(v) || 8)))
}

// 0.9.70 (#85): stall watchdog thresholds. Soft (warn) 1 min – 4 h, hard (heal) 5 min – 12 h, in ms. The
// orchestrator keeps the hard one at least one minute above the soft one.
export function clampStallWarnMs(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.max(60000, Math.min(14400000, n)) : 600000
}
export function clampStallHealMs(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.max(300000, Math.min(43200000, n)) : 1800000
}
// 0.9.70 (#91): minimum gap between two automatic stops of the stall watchdog (all cards), 1 min – 1 h, in ms.
export function clampStallCooldownMs(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.max(60000, Math.min(3600000, n)) : 300000
}
// #105: how long a card may wait at a gate owned by the Chief before one reminder is written. 0 = off;
// otherwise 5 min – 24 h, in ms. Default 20 minutes.
export const DEFAULT_CHIEF_GATE_STALE_MS = 1200000
export function normalizeChiefIdle(v) {
  const o = v && typeof v === 'object' ? v : {}
  const int = x => Math.max(0, Math.min(1000, Math.floor(Number(x) || 0)))
  return { count: int(o.count), resumes: int(o.resumes), exhaustedNoticed: Boolean(o.exhaustedNoticed), updatedAt: Math.max(0, Number(o.updatedAt) || 0) }
}
export function clampChiefGateStaleMs(v) {
  const n = Math.floor(Number(v))
  if (n === 0) return 0
  return Number.isFinite(n) && n > 0 ? Math.max(300000, Math.min(86400000, n)) : DEFAULT_CHIEF_GATE_STALE_MS
}

// ── #117 one managing topic per card ─────────────────────────────────────────────────────────────────
// The managing topic of a card is todos.topic_id. todo_watches may hold at most one active row per card, and
// that row is of the managing topic. Stored by the schema itself (index + triggers below), so no code path
// and no prompt can make a second topic receive a card's progress.
export const WATCH_NOT_MANAGER = 'WATCH_NOT_MANAGING_TOPIC'

/**
 * What convergeTodoWatches would do, reading only. `deactivate`: active watches that are not of the card's
 * managing topic (another topic, or the card is gone). `repoint`: unfinished cards that lose every watch that
 * way although their managing topic exists; that topic gets the watch instead, so the card keeps reporting.
 */
export function planWatchConvergence(raw) {
  const deactivate = raw.prepare(`
    SELECT w.id AS id, w.topic_id AS topicId, w.todo_id AS todoId, w.reason AS reason,
           COALESCE(t.topic_id, '') AS managingTopicId, COALESCE(t.number, 0) AS number, COALESCE(t.phase, '') AS phase,
           CASE WHEN t.id IS NULL THEN 1 ELSE 0 END AS todoMissing
    FROM todo_watches w LEFT JOIN todos t ON t.id = w.todo_id
    WHERE w.active = 1 AND (t.id IS NULL OR t.topic_id != w.topic_id)
    ORDER BY w.todo_id, w.created_at
  `).all().map(r => ({ ...r, todoMissing: Boolean(r.todoMissing) }))
  const repoint = raw.prepare(`
    SELECT t.id AS todoId, t.topic_id AS topicId, t.user_id AS userId, t.profile AS profile, t.number AS number, t.phase AS phase
    FROM todos t JOIN topics tp ON tp.id = t.topic_id AND tp.user_id = t.user_id AND tp.profile = t.profile
    WHERE t.phase NOT IN ('done', 'closed') AND t.topic_id != ''
      AND EXISTS (SELECT 1 FROM todo_watches w WHERE w.todo_id = t.id AND w.active = 1 AND w.topic_id != t.topic_id)
      AND NOT EXISTS (SELECT 1 FROM todo_watches w WHERE w.todo_id = t.id AND w.active = 1 AND w.topic_id = t.topic_id)
    ORDER BY t.id
  `).all()
  return { deactivate, repoint }
}

/** Applies planWatchConvergence in one transaction and returns the plan it applied. Repeating it changes nothing. */
export function convergeTodoWatches(raw) {
  const plan = planWatchConvergence(raw)
  if (!plan.deactivate.length && !plan.repoint.length) return plan
  raw.exec('BEGIN')
  try {
    const off = raw.prepare('UPDATE todo_watches SET active = 0 WHERE id = ?')
    for (const row of plan.deactivate) off.run(row.id)
    const on = raw.prepare(`
      INSERT INTO todo_watches (id, user_id, profile, topic_id, todo_id, reason, active, created_at)
      VALUES (?, ?, ?, ?, ?, 'Managing topic (#117)', 1, ?)
      ON CONFLICT(topic_id, todo_id) DO UPDATE SET active = 1
    `)
    for (const row of plan.repoint) on.run(`w-${randomUUID().slice(0, 8)}`, row.userId, row.profile, row.topicId, row.todoId, Date.now())
    raw.exec('COMMIT')
  } catch (err) {
    try { raw.exec('ROLLBACK') } catch { /* the transaction is already gone */ }
    throw err
  }
  return plan
}

// The stored rule. Index: one active watch per card. Triggers: an active watch is of the card's managing
// topic; moving a card to another topic ends the watches of every other topic in the same statement.
export function ensureSingleManagingTopic(raw) {
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_watches_one_active ON todo_watches(todo_id) WHERE active = 1;
    CREATE TRIGGER IF NOT EXISTS trg_todo_watch_manager_insert BEFORE INSERT ON todo_watches
    WHEN NEW.active = 1 AND EXISTS (SELECT 1 FROM todos WHERE id = NEW.todo_id AND topic_id != NEW.topic_id)
    BEGIN SELECT RAISE(ABORT, '${WATCH_NOT_MANAGER}: a card is watched only from its managing topic (todos.topic_id)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_todo_watch_manager_update BEFORE UPDATE ON todo_watches
    WHEN NEW.active = 1 AND EXISTS (SELECT 1 FROM todos WHERE id = NEW.todo_id AND topic_id != NEW.topic_id)
    BEGIN SELECT RAISE(ABORT, '${WATCH_NOT_MANAGER}: a card is watched only from its managing topic (todos.topic_id)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_todo_topic_moves_watch AFTER UPDATE OF topic_id ON todos
    WHEN NEW.topic_id != OLD.topic_id
    BEGIN UPDATE todo_watches SET active = 0 WHERE todo_id = NEW.id AND topic_id != NEW.topic_id AND active = 1; END;
  `)
}

export function createDatabase(dataDir, options = {}) {
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'ekko-todo.sqlite')
  const defaultMaxConcurrent = Math.max(1, Math.min(8, Number(options.maxConcurrentBuilds) || 2))
  // 0.9.70 (#85): plugin config (configSchema) seeds the stall watchdog settings of a new settings row.
  const defaultStall = {
    enabled: options.buildStallWatchdog !== false,
    warnMs: clampStallWarnMs(options.buildStallWarnMs ?? 600000),
    healMs: clampStallHealMs(options.buildStallHealMs ?? 1800000),
    cooldownMs: clampStallCooldownMs(options.buildStallCooldownMs ?? 300000),
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      max_concurrent_builds INTEGER NOT NULL DEFAULT 2,
      chief_agent_id TEXT NOT NULL DEFAULT '',
      chief_authority_json TEXT NOT NULL DEFAULT '{}',
      default_clone_root TEXT NOT NULL DEFAULT '',
      charter TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, profile)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      name TEXT NOT NULL,
      monogram TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      github_repo TEXT NOT NULL DEFAULT '',
      remote_url TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'local',
      is_private INTEGER NOT NULL DEFAULT 0,
      default_branch TEXT NOT NULL DEFAULT 'main',
      test_command TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      accent TEXT NOT NULL DEFAULT 'blue',
      owner_agent_id TEXT NOT NULL DEFAULT '',
      reviewer_agent_id TEXT NOT NULL DEFAULT '',
      auto_dispatch INTEGER NOT NULL DEFAULT 1,
      auto_answer_routine INTEGER NOT NULL DEFAULT 1,
      auto_merge_after_review INTEGER NOT NULL DEFAULT 0,
      require_human_for_deploy INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'global',
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      api_mode TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      custom_model INTEGER NOT NULL DEFAULT 0,
      reasoning_effort TEXT NOT NULL DEFAULT '',
      model_configs_json TEXT NOT NULL DEFAULT '[]',
      auto_fallback INTEGER NOT NULL DEFAULT 1,
      approval_policy TEXT NOT NULL DEFAULT 'on-request',
      sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write',
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      max_turns INTEGER NOT NULL DEFAULT 500,
      system_prompt TEXT NOT NULL DEFAULT '',
      read_only INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config_cooldowns (
      agent_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      failed_at INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (agent_id, config_id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'chief',
      scope_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'convention',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      is_user_named INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      brief_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT NOT NULL DEFAULT '',
      active_config_id TEXT NOT NULL DEFAULT '',
      autopilot INTEGER NOT NULL DEFAULT 1,
      chief_session_id TEXT NOT NULL DEFAULT '',
      active_run_id TEXT NOT NULL DEFAULT '',
      is_running INTEGER NOT NULL DEFAULT 0,
      last_digest_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topic_messages (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      todo_id TEXT NOT NULL DEFAULT '',
      question_todo_id TEXT NOT NULL DEFAULT '',
      progress_notice TEXT NOT NULL DEFAULT '',
      tools_json TEXT NOT NULL DEFAULT '[]',
      host_message_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      project_id TEXT NOT NULL,
      topic_id TEXT NOT NULL DEFAULT '',
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'feature',
      phase TEXT NOT NULL DEFAULT 'todo',
      gate_owner TEXT NOT NULL DEFAULT 'none',
      gate_kind TEXT NOT NULL DEFAULT 'none',
      with_plan INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT NOT NULL DEFAULT '',
      reviewer_id TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL DEFAULT '',
      active_config_id TEXT NOT NULL DEFAULT '',
      fallback_history_json TEXT NOT NULL DEFAULT '[]',
      branch TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL DEFAULT '',
      base_commit TEXT NOT NULL DEFAULT '',
      snapshot_sha TEXT NOT NULL DEFAULT '',
      build_session_id TEXT NOT NULL DEFAULT '',
      build_run_id TEXT NOT NULL DEFAULT '',
      review_session_id TEXT NOT NULL DEFAULT '',
      review_run_id TEXT NOT NULL DEFAULT '',
      spec TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      question_json TEXT NOT NULL DEFAULT '{}',
      diffs_json TEXT NOT NULL DEFAULT '[]',
      build_chat_json TEXT NOT NULL DEFAULT '[]',
      timeline_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todo_watches (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      wake_on_json TEXT NOT NULL DEFAULT '["gate","done","failed"]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (topic_id, todo_id)
    );

    CREATE TABLE IF NOT EXISTS wake_log (
      wake_key TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      fired_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projects_scope ON projects(user_id, profile);
    CREATE INDEX IF NOT EXISTS idx_agents_scope ON agents(user_id, profile);
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(user_id, profile, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topics_scope ON topics(user_id, profile, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_todos_scope ON todos(user_id, profile, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topic_msgs ON topic_messages(topic_id, created_at ASC);
  `)

  // Safe incremental column migrations (v0.1.0 / v0.2.0 -> v0.3.0)
  ensureColumn(db, 'settings', 'chief_authority_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(db, 'settings', 'default_clone_root', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'settings', 'charter', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'projects', 'github_repo', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'projects', 'remote_url', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'projects', 'source_type', "TEXT NOT NULL DEFAULT 'local'")
  ensureColumn(db, 'projects', 'is_private', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'agents', 'description', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'agents', 'api_mode', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'agents', 'base_url', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'agents', 'custom_model', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'agents', 'model_configs_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'agents', 'auto_fallback', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'agents', 'approval_policy', "TEXT NOT NULL DEFAULT 'on-request'")
  ensureColumn(db, 'agents', 'sandbox_mode', "TEXT NOT NULL DEFAULT 'workspace-write'")
  ensureColumn(db, 'agents', 'memory_enabled', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'agents', 'max_turns', 'INTEGER NOT NULL DEFAULT 500')
  ensureColumn(db, 'topics', 'is_user_named', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'topics', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'topics', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'topics', 'brief_json', "TEXT NOT NULL DEFAULT '{}'")
  ensureColumn(db, 'topics', 'last_error', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'topics', 'active_config_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'todos', 'active_config_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'todos', 'fallback_history_json', "TEXT NOT NULL DEFAULT '[]'")
  // v0.5.0 additive migrations (100% backwards-compatible with existing live DBs)
  ensureColumn(db, 'settings', 'onboarding_completed', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'settings', 'team_preset', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'settings', 'github_pat', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'settings', 'github_token_user', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'projects', 'display_name', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'projects', 'avatar', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'agents', 'role_label', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'agents', 'avatar', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'topic_messages', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'")
  // 0.9.42: a message typed in the plugin carries the nonce the page made for it (one row per nonce in a
  // topic) and, when the Chief could not be started for it, a readable reason. Rows stored before have ''.
  ensureColumn(db, 'topic_messages', 'client_nonce', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, 'topic_messages', 'send_error', "TEXT NOT NULL DEFAULT ''")
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_topic_msgs_nonce ON topic_messages(topic_id, client_nonce) WHERE client_nonce != ''")
  // One row per host message in a topic. Overlapping syncs could store the same host message twice
  // before this; those extra copies (same topic, same host_message_id) are removed once, keeping the first
  // row, and a unique index then refuses new ones. Rows without a host id are not touched.
  try {
    const hasIndex = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'idx_topic_msgs_host'").get()
    if (!hasIndex) {
      db.exec('BEGIN')
      try {
        db.exec(`
          DELETE FROM topic_messages
          WHERE host_message_id != ''
            AND rowid NOT IN (SELECT MIN(rowid) FROM topic_messages WHERE host_message_id != '' GROUP BY topic_id, host_message_id);
          CREATE UNIQUE INDEX idx_topic_msgs_host ON topic_messages(topic_id, host_message_id) WHERE host_message_id != '';
        `)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  } catch (err) {
    // The insert below also checks for an existing row, so a missing index does not bring duplicates back.
    options.log?.warn?.('Could not add the unique host message index', { error: err?.message })
  }
  ensureColumn(db, 'todos', 'created_by', "TEXT NOT NULL DEFAULT 'chief'")
  ensureColumn(db, 'todos', 'tags_json', "TEXT NOT NULL DEFAULT '[]'")
  // #103: full sha of the worktree HEAD the current review was dispatched on (additive; '' on existing rows =
  // no review snapshot).
  ensureColumn(db, 'todos', 'reviewed_sha', "TEXT NOT NULL DEFAULT ''")
  // v0.6.0 additive migrations: Web-UI session isolation + unrestricted turn budget support
  ensureColumn(db, 'settings', 'session_isolation_mode', "TEXT NOT NULL DEFAULT 'category'")
  ensureColumn(db, 'settings', 'session_category_name', "TEXT NOT NULL DEFAULT 'Ekko ToDo'")
  // v0.7.0 additive migrations: Chief strict orchestration guard + persistent topic follow-up/wake queue
  ensureColumn(db, 'settings', 'chief_strict_orchestration', 'INTEGER NOT NULL DEFAULT 1')
  // 0.9.54: strict orchestration also caps the Chief's reasoning effort and its read-only calls per turn.
  ensureColumn(db, 'settings', 'chief_effort_cap', "TEXT NOT NULL DEFAULT 'medium'")
  ensureColumn(db, 'settings', 'chief_investigation_limit', 'INTEGER NOT NULL DEFAULT 8')
  // v0.8.0 additive migrations: notification preferences, quota auto-refresh, schedules, and quota_providers
  ensureColumn(db, 'settings', 'notify_popup', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'settings', 'notify_sound', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'settings', 'notify_browser', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'settings', 'quota_auto_refresh_min', 'INTEGER NOT NULL DEFAULT 15')
  // 0.9.70 (#85): stall watchdog of building / reviewing cards (additive; existing rows get the defaults).
  ensureColumn(db, 'settings', 'build_stall_watchdog', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'settings', 'build_stall_warn_ms', 'INTEGER NOT NULL DEFAULT 600000')
  ensureColumn(db, 'settings', 'build_stall_heal_ms', 'INTEGER NOT NULL DEFAULT 1800000')
  // 0.9.70 (#91): cooldown between two automatic stops (additive; existing rows get 5 minutes).
  ensureColumn(db, 'settings', 'build_stall_cooldown_ms', 'INTEGER NOT NULL DEFAULT 300000')
  // #105: reminder for cards waiting at a Chief-owned gate (additive; existing rows get 20 minutes).
  ensureColumn(db, 'settings', 'chief_gate_stale_ms', 'INTEGER NOT NULL DEFAULT 1200000')
  // #105: idle Chief rounds of a topic, persisted so a plugin reload does not reset them (additive; '{}' = 0).
  ensureColumn(db, 'topics', 'chief_idle_json', "TEXT NOT NULL DEFAULT '{}'")
  // #103: a merge of a card without a review snapshot (todos.reviewed_sha empty) asks the user first
  // (additive; existing rows get 1 = ask).
  ensureColumn(db, 'settings', 'confirm_unreviewed_merge', 'INTEGER NOT NULL DEFAULT 1')
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_counters (
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      project_id TEXT NOT NULL,
      last_number INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, profile, project_id)
    );

    CREATE TABLE IF NOT EXISTS topic_queue (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user',
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      mentioned_agent_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topic_queue_topic ON topic_queue(topic_id, created_at);

    -- 0.9.42: worker instructions that arrived while the todo's build session was busy; drained in order
    -- when that run finishes (see orchestrator settleWorkerRunInner).
    CREATE TABLE IF NOT EXISTS todo_queue (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      text TEXT NOT NULL,
      client_nonce TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todo_queue_todo ON todo_queue(todo_id, created_at);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      project_id TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'daily',
      hour INTEGER NOT NULL DEFAULT 9,
      minute INTEGER NOT NULL DEFAULT 0,
      weekday INTEGER NOT NULL DEFAULT 1,
      run_at_iso TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      agent_id TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      last_status TEXT NOT NULL DEFAULT '',
      last_message TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_scope ON schedules(user_id, profile, enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS quota_providers (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      name TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'subscription',
      accent TEXT NOT NULL DEFAULT 'blue',
      enabled INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 10,
      source_mode TEXT NOT NULL DEFAULT 'auto',
      endpoint TEXT NOT NULL DEFAULT '',
      secret_value TEXT NOT NULL DEFAULT '',
      credential_label TEXT NOT NULL DEFAULT '',
      credential_placeholder TEXT NOT NULL DEFAULT '',
      last_snapshot_json TEXT NOT NULL DEFAULT '{}',
      last_checked_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (id, user_id, profile)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_providers_scope ON quota_providers(user_id, profile, sort_order);

    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_records_scope ON usage_records(user_id, profile, created_at DESC);
  `)
  ensureColumn(db, 'topic_queue', 'client_nonce', "TEXT NOT NULL DEFAULT ''")
  // 0.9.42: one queued follow-up per send nonce in a topic. A retried send could be queued twice before
  // this; those copies (same topic, same non-empty nonce) are removed once, keeping the earliest, and the
  // unique index then refuses new ones. Rows without a nonce are not touched.
  try {
    const hasIndex = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'idx_topic_queue_nonce'").get()
    if (!hasIndex) {
      db.exec('BEGIN')
      try {
        db.exec(`
          DELETE FROM topic_queue
          WHERE client_nonce != ''
            AND rowid NOT IN (
              SELECT rowid FROM (
                SELECT rowid, ROW_NUMBER() OVER (PARTITION BY topic_id, client_nonce ORDER BY created_at ASC, rowid ASC) AS rn
                FROM topic_queue WHERE client_nonce != ''
              ) WHERE rn = 1
            );
          CREATE UNIQUE INDEX idx_topic_queue_nonce ON topic_queue(topic_id, client_nonce) WHERE client_nonce != '';
        `)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  } catch (err) {
    // sendTopicMessage also checks the nonce before it queues, so a missing index does not bring doubles back.
    options.log?.warn?.('Could not add the unique queue nonce index', { error: err?.message })
  }

  // #117: one managing topic per card. Watches stored before it (a card watched from a second topic of its
  // project) are converged once, then the index and the triggers refuse new ones. Convergence writes only
  // todo_watches (active 1 -> 0, and the managing topic's watch for an unfinished card); todos are not touched.
  let watchConvergence = { deactivate: [], repoint: [], error: '' }
  try {
    watchConvergence = { ...convergeTodoWatches(db), error: '' }
    ensureSingleManagingTopic(db)
    if (watchConvergence.deactivate.length || watchConvergence.repoint.length) {
      options.log?.info?.('Card watches converged to the managing topic', { deactivated: watchConvergence.deactivate.length, repointed: watchConvergence.repoint.length })
    }
  } catch (err) {
    // The orchestrator decides by todos.topic_id as well (topicManagesTodo), so a missing index does not
    // bring a second managing topic back.
    watchConvergence = { deactivate: [], repoint: [], error: err?.message || String(err) }
    options.log?.warn?.('Could not store the one-managing-topic rule for card watches', { error: err?.message })
  }

  // Clean up legacy Magpie / external CodexBar entries on startup (v0.9.0 native quota migration)
  db.exec(`
    DELETE FROM quota_providers WHERE id = 'magpie' OR (provider_type = 'magpie' AND endpoint LIKE '%/v1/magpie%');
    UPDATE quota_providers SET provider_type = 'custom' WHERE provider_type = 'magpie';
    UPDATE quota_providers SET source_mode = 'auto' WHERE source_mode IN ('magpie', 'codexbar');
  `)
  {
    const updMeta = db.prepare(`
      UPDATE quota_providers
      SET subtitle = ?, endpoint = CASE WHEN endpoint = '' OR endpoint LIKE '%grok.com/rest/rate-limits%' THEN ? ELSE endpoint END,
          credential_label = ?, credential_placeholder = ?
      WHERE id = ?
        AND (credential_placeholder LIKE '%CodexBar%' OR credential_placeholder LIKE '%Magpie%' OR subtitle LIKE '%Magpie%' OR subtitle LIKE '%CodexBar%' OR endpoint = 'https://grok.com/rest/rate-limits')
    `)
    for (const p of DEFAULT_QUOTA_PROVIDERS) {
      updMeta.run(p.subtitle, p.endpoint, p.credentialLabel, p.credentialPlaceholder, p.id)
    }
    // Clear stale snapshots that came from removed external CodexBar/Magpie sources so native probe refreshes them cleanly
    db.exec(`
      UPDATE quota_providers
      SET last_snapshot_json = '{}', last_checked_at = 0
      WHERE last_snapshot_json LIKE '%"source":"codexbar"%'
         OR last_snapshot_json LIKE '%"source":"magpie%'
    `)
  }

  db.exec("UPDATE agents SET sandbox_mode = 'read-only' WHERE read_only = 1 AND sandbox_mode = 'workspace-write'")

  const defaultEvidence = () => ({
    commitSha: '',
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    testCmd: '',
    testRc: -1,
    testSummary: '',
    testFailures: [],
    testFailureCount: 0,
    reviewVerdict: 'none',
    reviewSummary: '',
    // 0.9.49 (#47): requests for a missing verdict sent in the current review round (0 or 1).
    reviewInconclusiveRetries: 0,
    // 0.9.52 (#50): id of the review message that request was sent for ('' = none, or the message had no id).
    reviewInconclusiveTurn: '',
  })

  const defaultQuestion = () => ({
    active: false,
    version: 0,
    title: '',
    why: '',
    options: [],
    answeredText: '',
  })

  const defaultBrief = () => ({
    goal: '',
    progress: '',
    next: '',
    waitingOnYou: '',
    waitingTitle: '',
    waitingRecommendation: '',
    waitingOptions: [],
    blocked: '',
    updatedAt: 0,
  })

  function normalizeWaitingOptions(raw) {
    if (!Array.isArray(raw)) return []
    return raw.slice(0, 4).map((item, idx) => {
      if (typeof item === 'string') {
        const label = item.trim()
        return label ? { id: `opt-${idx + 1}`, label, recommended: idx === 0 } : null
      }
      if (item && typeof item === 'object') {
        const label = String(item.label || item.title || '').trim()
        if (!label) return null
        return {
          id: String(item.id || `opt-${idx + 1}`).trim(),
          label,
          recommended: Boolean(item.recommended),
        }
      }
      return null
    }).filter(Boolean)
  }

  function mapSettings(row) {
    const parsedAuth = safeJsonParse(row.chief_authority_json, {})
    const isoMode = ['category', 'hidden', 'default'].includes(row.session_isolation_mode)
      ? row.session_isolation_mode
      : 'category'
    const isoCategory = String(row.session_category_name || '').trim() || 'Ekko ToDo'
    return {
      maxConcurrentBuilds: row.max_concurrent_builds,
      chiefAgentId: row.chief_agent_id,
      chiefAuthority: {
        canConfigureAgents: parsedAuth.canConfigureAgents !== false,
        canSwitchModels: parsedAuth.canSwitchModels !== false,
        canManageMemories: parsedAuth.canManageMemories !== false,
        canManageProjects: parsedAuth.canManageProjects !== false,
        canAdjustConcurrency: parsedAuth.canAdjustConcurrency !== false,
        injectHostMemory: parsedAuth.injectHostMemory !== false,
      },
      defaultCloneRoot: row.default_clone_root || '',
      charter: row.charter || '',
      onboardingCompleted: Boolean(row.onboarding_completed),
      teamPreset: row.team_preset || '',
      hasGithubToken: Boolean(row.github_pat),
      githubTokenUser: row.github_token_user || '',
      sessionIsolationMode: isoMode,
      sessionCategoryName: isoCategory,
      chiefStrictOrchestration: row.chief_strict_orchestration !== 0,
      chiefEffortCap: normalizeEffortCap(row.chief_effort_cap ?? 'medium'),
      chiefInvestigationLimit: clampInvestigationLimit(row.chief_investigation_limit ?? 8),
      notifyPopup: row.notify_popup !== 0,
      notifySound: row.notify_sound !== 0,
      notifyBrowser: row.notify_browser !== 0,
      quotaAutoRefreshMin: Math.max(0, Math.min(120, Number(row.quota_auto_refresh_min ?? 15) || 0)),
      buildStallWatchdog: row.build_stall_watchdog !== 0,
      buildStallWarnMs: clampStallWarnMs(row.build_stall_warn_ms ?? 600000),
      buildStallHealMs: clampStallHealMs(row.build_stall_heal_ms ?? 1800000),
      buildStallCooldownMs: clampStallCooldownMs(row.build_stall_cooldown_ms ?? 300000),
      chiefGateStaleMs: clampChiefGateStaleMs(row.chief_gate_stale_ms ?? DEFAULT_CHIEF_GATE_STALE_MS),
      confirmUnreviewedMerge: row.confirm_unreviewed_merge !== 0,
      updatedAt: row.updated_at,
    }
  }

  function mapProject(row) {
    if (!row) return null
    const displayName = String(row.display_name || '').trim()
    const effectiveLabel = displayName || row.name
    return {
      id: row.id,
      name: row.name,
      displayName,
      monogram: row.monogram || extractMonogram(effectiveLabel),
      avatar: row.avatar || '',
      repoPath: row.repo_path,
      githubRepo: row.github_repo || '',
      remoteUrl: row.remote_url || '',
      sourceType: row.source_type || 'local',
      isPrivate: Boolean(row.is_private),
      defaultBranch: row.default_branch,
      testCommand: row.test_command,
      description: row.description,
      accent: row.accent || 'blue',
      ownerAgentId: row.owner_agent_id,
      reviewerAgentId: row.reviewer_agent_id,
      autopilot: {
        autoDispatch: Boolean(row.auto_dispatch),
        autoAnswerRoutine: Boolean(row.auto_answer_routine),
        autoMergeAfterReview: Boolean(row.auto_merge_after_review),
        requireHumanForDeploy: Boolean(row.require_human_for_deploy),
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function mapAgent(row) {
    if (!row) return null
    const rawConfigs = safeJsonParse(row.model_configs_json, [])
    const modelConfigs = normalizeModelConfigs(rawConfigs, {
      engine: row.engine,
      mode: row.mode,
      provider: row.provider,
      model: row.model,
      apiMode: row.api_mode || '',
      baseUrl: row.base_url || '',
      customModel: Boolean(row.custom_model),
      reasoningEffort: row.reasoning_effort || '',
    })
    const primary = modelConfigs[0]
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      roleLabel: String(row.role_label || '').trim() || defaultRoleLabelForRole(row.role),
      avatar: String(row.avatar || '').trim() || defaultAvatarForRole(row.role, { seedHint: row.id }),
      description: row.description || '',
      engine: primary.engine,
      mode: primary.mode,
      provider: primary.provider,
      model: primary.model,
      apiMode: primary.apiMode,
      baseUrl: primary.baseUrl,
      customModel: primary.customModel,
      reasoningEffort: primary.reasoningEffort,
      modelConfigs,
      autoFallback: row.auto_fallback !== 0,
      approvalPolicy: row.approval_policy || 'on-request',
      sandboxMode: row.sandbox_mode || (row.read_only ? 'read-only' : 'workspace-write'),
      memoryEnabled: row.memory_enabled !== 0,
      maxTurns: row.max_turns === 0 ? 0 : (Number(row.max_turns) || 0),
      systemPrompt: row.system_prompt,
      readOnly: Boolean(row.read_only),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function mapMemory(row) {
    if (!row) return null
    return {
      id: row.id,
      scope: row.scope,
      scopeId: row.scope_id,
      category: row.category,
      title: row.title,
      content: row.content,
      pinned: Boolean(row.pinned),
      enabled: Boolean(row.enabled),
      source: row.source || 'user',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function mapMessage(row) {
    return {
      id: row.id,
      topicId: row.topic_id,
      kind: row.kind,
      text: row.text,
      attachments: safeJsonParse(row.attachments_json, []),
      durationMs: row.duration_ms,
      todoId: row.todo_id,
      questionTodoId: row.question_todo_id,
      progressNotice: row.progress_notice,
      tools: safeJsonParse(row.tools_json, []),
      hostMessageId: row.host_message_id,
      createdAt: row.created_at,
      // Present only when set, so rows stored before 0.9.42 look exactly as they did.
      ...(row.client_nonce ? { clientNonce: row.client_nonce } : {}),
      ...(row.send_error ? { sendError: row.send_error } : {}),
    }
  }

  function mapTodo(row) {
    if (!row) return null
    return {
      id: row.id,
      projectId: row.project_id,
      topicId: row.topic_id,
      number: row.number,
      title: row.title,
      kind: row.kind,
      createdBy: row.created_by || 'chief',
      tags: safeJsonParse(row.tags_json, []),
      phase: row.phase,
      gateOwner: row.gate_owner,
      gateKind: row.gate_kind,
      withPlan: Boolean(row.with_plan),
      agentId: row.agent_id,
      reviewerId: row.reviewer_id,
      engine: row.engine,
      activeConfigId: row.active_config_id || '',
      fallbackHistory: safeJsonParse(row.fallback_history_json, []),
      branch: row.branch,
      worktreePath: row.worktree_path,
      baseCommit: row.base_commit,
      snapshotSha: row.snapshot_sha,
      reviewedSha: row.reviewed_sha || '',
      buildSessionId: row.build_session_id,
      buildRunId: row.build_run_id,
      reviewSessionId: row.review_session_id,
      reviewRunId: row.review_run_id,
      spec: row.spec,
      plan: row.plan,
      evidence: { ...defaultEvidence(), ...safeJsonParse(row.evidence_json, {}) },
      question: { ...defaultQuestion(), ...safeJsonParse(row.question_json, {}) },
      diffs: clampDiffs(safeJsonParse(row.diffs_json, [])),
      buildChat: safeJsonParse(row.build_chat_json, []),
      timeline: safeJsonParse(row.timeline_json, []),
      lastError: row.last_error,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  function getSettings(userId, profile, defaults = {}) {
    const row = db.prepare('SELECT * FROM settings WHERE user_id = ? AND profile = ?').get(userId, profile)
    if (row) return mapSettings(row)
    const maxConcurrent = Math.max(1, Math.min(8, Number(defaults.maxConcurrentBuilds ?? defaultMaxConcurrent) || 2))
    const ts = nowMs()
    db.prepare(`
      INSERT INTO settings (
        user_id, profile, max_concurrent_builds, chief_agent_id, chief_authority_json, default_clone_root,
        charter, onboarding_completed, team_preset, github_pat, github_token_user,
        session_isolation_mode, session_category_name, chief_strict_orchestration,
        notify_popup, notify_sound, notify_browser, quota_auto_refresh_min,
        build_stall_watchdog, build_stall_warn_ms, build_stall_heal_ms, build_stall_cooldown_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', '', '', 'category', 'Ekko ToDo', 1, 1, 1, 1, 15, ?, ?, ?, ?, ?)
    `).run(userId, profile, maxConcurrent, '', JSON.stringify(DEFAULT_CHIEF_AUTHORITY), '', '',
      defaultStall.enabled ? 1 : 0, defaultStall.warnMs, defaultStall.healMs, defaultStall.cooldownMs, ts)
    return {
      maxConcurrentBuilds: maxConcurrent,
      chiefAgentId: '',
      chiefAuthority: { ...DEFAULT_CHIEF_AUTHORITY },
      defaultCloneRoot: '',
      charter: '',
      onboardingCompleted: false,
      teamPreset: '',
      hasGithubToken: false,
      githubTokenUser: '',
      sessionIsolationMode: 'category',
      sessionCategoryName: 'Ekko ToDo',
      chiefStrictOrchestration: true,
      chiefEffortCap: 'medium',
      chiefInvestigationLimit: 8,
      notifyPopup: true,
      notifySound: true,
      notifyBrowser: true,
      quotaAutoRefreshMin: 15,
      buildStallWatchdog: defaultStall.enabled,
      buildStallWarnMs: defaultStall.warnMs,
      buildStallHealMs: defaultStall.healMs,
      buildStallCooldownMs: defaultStall.cooldownMs,
      chiefGateStaleMs: DEFAULT_CHIEF_GATE_STALE_MS,
      confirmUnreviewedMerge: true,
      updatedAt: ts,
    }
  }

  /**
   * Internal server-only accessor for the stored GitHub Personal Access Token.
   * NEVER serialized to UI snapshots or logs.
   */
  function getGithubToken(userId, profile) {
    const row = db.prepare('SELECT github_pat, github_token_user FROM settings WHERE user_id = ? AND profile = ?').get(userId, profile)
    return {
      token: String(row?.github_pat || ''),
      username: String(row?.github_token_user || ''),
    }
  }

  function setGithubToken(userId, profile, { token = '', username = '' } = {}) {
    getSettings(userId, profile)
    const ts = nowMs()
    db.prepare(`
      UPDATE settings SET github_pat = ?, github_token_user = ?, updated_at = ?
      WHERE user_id = ? AND profile = ?
    `).run(String(token || '').trim(), String(username || '').trim(), ts, userId, profile)
    return getSettings(userId, profile)
  }

  /** `dryRun` validates the patch exactly like a real save and writes nothing. */
  function updateSettings(userId, profile, patch, { dryRun = false } = {}) {
    const cur = getSettings(userId, profile)
    const nextMax = Math.max(1, Math.min(8, Number(patch.maxConcurrentBuilds ?? cur.maxConcurrentBuilds) || 2))
    // The Chief agent id is used as given: an over-long new one is refused before anything is written.
    // An unchanged value, or the shortened form the board shows for an older over-long one, keeps the stored id.
    // An over-long id that is a stored agent row (written before the limit) may still be bound.
    let nextChief = cur.chiefAgentId
    if (patch.chiefAgentId !== undefined) {
      const raw = String(patch.chiefAgentId)
      if (raw !== cur.chiefAgentId && !echoesShortenedView(cur.chiefAgentId, raw, MAX_AGENT_REF_CHARS)) {
        nextChief = boundedAgentRef(userId, profile, 'chiefAgentId', raw)
      }
    }
    const nextAuth = patch.chiefAuthority
      ? { ...cur.chiefAuthority, ...patch.chiefAuthority }
      : cur.chiefAuthority
    // A clone destination is used as given, so an over-long path is refused rather than cut.
    // An unchanged value (a settings form saving everything back) is not re-validated.
    let nextCloneRoot = cur.defaultCloneRoot
    if (patch.defaultCloneRoot !== undefined) {
      const raw = String(patch.defaultCloneRoot).trim()
      const echoesView = echoesShortenedView(cur.defaultCloneRoot, raw, MAX_CLONE_ROOT_CHARS)
      if (raw !== cur.defaultCloneRoot && !echoesView) nextCloneRoot = assertMaxLength('defaultCloneRoot', raw, MAX_CLONE_ROOT_CHARS)
    }
    const nextCharter = patch.charter !== undefined ? clampText(String(patch.charter), MAX_CHARTER_CHARS) : cur.charter
    const nextOnboarding = patch.onboardingCompleted !== undefined ? (patch.onboardingCompleted ? 1 : 0) : (cur.onboardingCompleted ? 1 : 0)
    const nextPreset = patch.teamPreset !== undefined ? String(patch.teamPreset).trim() : cur.teamPreset
    const nextIsoMode = patch.sessionIsolationMode !== undefined && ['category', 'hidden', 'default'].includes(patch.sessionIsolationMode)
      ? patch.sessionIsolationMode
      : cur.sessionIsolationMode
    const nextIsoCat = patch.sessionCategoryName !== undefined
      ? (String(patch.sessionCategoryName || '').trim().slice(0, 40) || 'Ekko ToDo')
      : cur.sessionCategoryName
    const nextStrictOrch = patch.chiefStrictOrchestration !== undefined
      ? (patch.chiefStrictOrchestration ? 1 : 0)
      : (cur.chiefStrictOrchestration !== false ? 1 : 0)
    const nextEffortCap = patch.chiefEffortCap !== undefined ? normalizeEffortCap(patch.chiefEffortCap) : (cur.chiefEffortCap ?? 'medium')
    const nextInvestigation = patch.chiefInvestigationLimit !== undefined
      ? clampInvestigationLimit(patch.chiefInvestigationLimit)
      : (cur.chiefInvestigationLimit ?? 8)
    const nextNotifyPopup = patch.notifyPopup !== undefined ? (patch.notifyPopup ? 1 : 0) : (cur.notifyPopup !== false ? 1 : 0)
    const nextNotifySound = patch.notifySound !== undefined ? (patch.notifySound ? 1 : 0) : (cur.notifySound !== false ? 1 : 0)
    const nextNotifyBrowser = patch.notifyBrowser !== undefined ? (patch.notifyBrowser ? 1 : 0) : (cur.notifyBrowser !== false ? 1 : 0)
    const nextQuotaRefresh = patch.quotaAutoRefreshMin !== undefined
      ? Math.max(0, Math.min(120, Math.floor(Number(patch.quotaAutoRefreshMin) || 0)))
      : (cur.quotaAutoRefreshMin ?? 15)
    const nextStallOn = patch.buildStallWatchdog !== undefined ? (patch.buildStallWatchdog ? 1 : 0) : (cur.buildStallWatchdog !== false ? 1 : 0)
    const nextStallWarn = patch.buildStallWarnMs !== undefined ? clampStallWarnMs(patch.buildStallWarnMs) : clampStallWarnMs(cur.buildStallWarnMs ?? 600000)
    const nextStallHeal = patch.buildStallHealMs !== undefined ? clampStallHealMs(patch.buildStallHealMs) : clampStallHealMs(cur.buildStallHealMs ?? 1800000)
    const nextStallCooldown = patch.buildStallCooldownMs !== undefined ? clampStallCooldownMs(patch.buildStallCooldownMs) : clampStallCooldownMs(cur.buildStallCooldownMs ?? 300000)
    const nextGateStale = patch.chiefGateStaleMs !== undefined ? clampChiefGateStaleMs(patch.chiefGateStaleMs) : clampChiefGateStaleMs(cur.chiefGateStaleMs ?? DEFAULT_CHIEF_GATE_STALE_MS)
    const nextConfirmUnreviewed = patch.confirmUnreviewedMerge !== undefined ? (patch.confirmUnreviewedMerge ? 1 : 0) : (cur.confirmUnreviewedMerge !== false ? 1 : 0)
    if (dryRun) return cur
    const ts = nowMs()
    db.prepare(`
      UPDATE settings SET
        max_concurrent_builds = ?,
        chief_agent_id = ?,
        chief_authority_json = ?,
        default_clone_root = ?,
        charter = ?,
        onboarding_completed = ?,
        team_preset = ?,
        session_isolation_mode = ?,
        session_category_name = ?,
        chief_strict_orchestration = ?,
        notify_popup = ?,
        notify_sound = ?,
        notify_browser = ?,
        quota_auto_refresh_min = ?,
        chief_effort_cap = ?,
        chief_investigation_limit = ?,
        build_stall_watchdog = ?,
        build_stall_warn_ms = ?,
        build_stall_heal_ms = ?,
        build_stall_cooldown_ms = ?,
        chief_gate_stale_ms = ?,
        confirm_unreviewed_merge = ?,
        updated_at = ?
      WHERE user_id = ? AND profile = ?
    `).run(
      nextMax, nextChief, JSON.stringify(nextAuth), nextCloneRoot, nextCharter,
      nextOnboarding, nextPreset, nextIsoMode, nextIsoCat, nextStrictOrch,
      nextNotifyPopup, nextNotifySound, nextNotifyBrowser, nextQuotaRefresh,
      nextEffortCap, nextInvestigation,
      nextStallOn, nextStallWarn, nextStallHeal, nextStallCooldown, nextGateStale,
      nextConfirmUnreviewed,
      ts, userId, profile,
    )
    return getSettings(userId, profile)
  }

  function listAgents(userId, profile) {
    return db.prepare('SELECT * FROM agents WHERE user_id = ? AND profile = ? ORDER BY created_at ASC, rowid ASC').all(userId, profile).map(mapAgent)
  }

  function getAgent(userId, profile, id) {
    return mapAgent(db.prepare('SELECT * FROM agents WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, id))
  }

  function ensureDefaultAgents(userId, profile, liveEngines = []) {
    const existing = listAgents(userId, profile)
    if (existing.length > 0) {
      let migrated = false
      const upd = db.prepare(`
        UPDATE agents SET name = ?, description = ?, system_prompt = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND profile = ?
      `)
      const ts = nowMs()
      for (const a of existing) {
        const legacy = LEGACY_NAME_MIGRATIONS[a.name]
        if (legacy) {
          const isOldDefaultPrompt = !a.systemPrompt
            || a.systemPrompt.startsWith('Coordinate projects, decompose requirements')
            || a.systemPrompt.startsWith('Implement assigned todos inside')
            || a.systemPrompt.startsWith('Perform a strict read-only review')
            || a.systemPrompt.startsWith('你是核心主程')
            || a.systemPrompt.startsWith('你是独立审查员')
          upd.run(
            legacy.name,
            legacy.description,
            isOldDefaultPrompt ? legacy.systemPrompt : a.systemPrompt,
            ts,
            a.id,
            userId,
            profile,
          )
          migrated = true
        }
      }
      return migrated ? listAgents(userId, profile) : existing
    }

    const installedIds = liveEngines.filter(e => e.installed).map(e => e.id)
    const pickFirst = candidates => candidates.find(c => installedIds.includes(c)) || 'hermes'
    const builderEngine = pickFirst(['claude-code', 'codex', 'dsh', 'qwen', 'grok', 'hermes'])
    const builderFallback = installedIds.find(id => id !== builderEngine && ['codex', 'claude-code', 'grok', 'dsh'].includes(id))
    const reviewerCandidates = ['grok', 'codex', 'claude-code', 'dsh', 'qwen', 'hermes'].filter(e => e !== builderEngine)
    const reviewerEngine = pickFirst(reviewerCandidates)
    const ts = nowMs()

    const builderConfigs = [
      { id: 'cfg-primary', label: '首选配置', engine: builderEngine, mode: builderEngine === 'hermes' ? 'scoped' : 'global', provider: '', model: '', apiMode: '', baseUrl: '', customModel: false, reasoningEffort: 'high' },
      ...(builderFallback ? [{ id: 'cfg-fallback-1', label: '备选引擎', engine: builderFallback, mode: builderFallback === 'hermes' ? 'scoped' : 'global', provider: '', model: '', apiMode: '', baseUrl: '', customModel: false, reasoningEffort: 'high' }] : []),
    ]

    const defaults = [
      {
        id: `chief-${randomUUID().slice(0, 8)}`,
        name: DEFAULT_AGENT_SPECS.chief.name,
        role: 'chief',
        description: DEFAULT_AGENT_SPECS.chief.description,
        engine: 'hermes',
        mode: 'scoped',
        reasoningEffort: 'high',
        modelConfigs: [
          { id: 'cfg-primary', label: '首选配置', engine: 'hermes', mode: 'scoped', provider: '', model: '', apiMode: '', baseUrl: '', customModel: false, reasoningEffort: 'high' },
        ],
        autoFallback: true,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        memoryEnabled: true,
        maxTurns: DEFAULT_AGENT_TURNS,
        avatar: defaultAvatarForRole('chief', { randomize: true }),
        systemPrompt: DEFAULT_AGENT_SPECS.chief.systemPrompt,
        readOnly: false,
      },
      {
        id: `builder-${randomUUID().slice(0, 8)}`,
        name: DEFAULT_AGENT_SPECS.builder.name,
        role: 'builder',
        description: DEFAULT_AGENT_SPECS.builder.description,
        engine: builderEngine,
        mode: builderEngine === 'hermes' ? 'scoped' : 'global',
        reasoningEffort: 'high',
        modelConfigs: builderConfigs,
        autoFallback: true,
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        memoryEnabled: true,
        maxTurns: DEFAULT_AGENT_TURNS,
        avatar: defaultAvatarForRole('builder', { randomize: true }),
        systemPrompt: DEFAULT_AGENT_SPECS.builder.systemPrompt,
        readOnly: false,
      },
      {
        id: `reviewer-${randomUUID().slice(0, 8)}`,
        name: DEFAULT_AGENT_SPECS.reviewer.name,
        role: 'reviewer',
        description: DEFAULT_AGENT_SPECS.reviewer.description,
        engine: reviewerEngine,
        mode: reviewerEngine === 'hermes' ? 'scoped' : 'global',
        reasoningEffort: 'high',
        modelConfigs: [
          { id: 'cfg-primary', label: '首选配置', engine: reviewerEngine, mode: reviewerEngine === 'hermes' ? 'scoped' : 'global', provider: '', model: '', apiMode: '', baseUrl: '', customModel: false, reasoningEffort: 'high' },
        ],
        autoFallback: true,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        memoryEnabled: true,
        maxTurns: DEFAULT_AGENT_TURNS,
        avatar: defaultAvatarForRole('reviewer', { randomize: true }),
        systemPrompt: DEFAULT_AGENT_SPECS.reviewer.systemPrompt,
        readOnly: true,
      },
    ]

    const ins = db.prepare(`
      INSERT INTO agents (
        id, user_id, profile, name, role, role_label, avatar, description, engine, mode, provider, model, api_mode, base_url,
        custom_model, reasoning_effort, model_configs_json, auto_fallback, approval_policy, sandbox_mode,
        memory_enabled, max_turns, system_prompt, read_only, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const a of defaults) {
      ins.run(
        a.id, userId, profile, a.name, a.role, defaultRoleLabelForRole(a.role), a.avatar, a.description, a.engine, a.mode, '', '', '', '',
        0, a.reasoningEffort, JSON.stringify(a.modelConfigs), a.autoFallback ? 1 : 0, a.approvalPolicy,
        a.sandboxMode, a.memoryEnabled ? 1 : 0, a.maxTurns, a.systemPrompt, a.readOnly ? 1 : 0, ts, ts,
      )
    }
    updateSettings(userId, profile, { chiefAgentId: defaults[0].id })
    return listAgents(userId, profile)
  }

  /** `dryRun` validates the input exactly like a real save and writes nothing. */
  function upsertAgent(userId, profile, input, { dryRun = false } = {}) {
    const ts = nowMs()
    const givenId = input.id && String(input.id).trim() ? String(input.id).trim() : ''
    let id = `agent-${randomUUID().slice(0, 8)}`
    if (givenId) {
      // The shortened id the board shows for an older over-long agent id resolves to the stored row.
      // A new id over 120 characters is refused: it would be a key nobody can address. (An exact
      // stored id, as internal callers pass it, still addresses its own row.)
      id = resolveAgentId(userId, profile, givenId)
    }
    const existing = getAgent(userId, profile, id)
    if (givenId && !existing) assertMaxLength('id', givenId, MAX_AGENT_REF_CHARS)
    const role = ['chief', 'builder', 'reviewer', 'qa', 'custom'].includes(input.role)
      ? input.role
      : (existing?.role || 'custom')
    const rawRoleLabel = input.roleLabel !== undefined ? String(input.roleLabel).trim().slice(0, 80) : (existing?.roleLabel || '')
    const roleLabel = rawRoleLabel || defaultRoleLabelForRole(role)
    // A size-trimmed board shows an uploaded avatar as the built-in default marker (`avatarOmitted`).
    // Saving the agent from that view sends the marker back; it must not replace the stored upload.
    const isAvatarStandIn = Boolean(existing)
      && String(existing.avatar || '').startsWith('data:')
      && String(input.avatar ?? '').trim() === defaultAvatarForRole(existing.role, { seedHint: id })
    const avatar = input.avatar !== undefined && !isAvatarStandIn
      ? (validateAvatarValue(input.avatar, { allowPreset: true }) || defaultAvatarForRole(role, { randomize: true }))
      : (existing?.avatar || defaultAvatarForRole(role, { randomize: true }))
    const readOnly = input.readOnly !== undefined ? Boolean(input.readOnly) : (role === 'reviewer' ? true : Boolean(existing?.readOnly))
    const sandboxMode = ['read-only', 'workspace-write', 'full-access'].includes(input.sandboxMode)
      ? input.sandboxMode
      : (readOnly ? 'read-only' : (existing?.sandboxMode || 'workspace-write'))
    const approvalPolicy = ['never', 'on-failure', 'on-request', 'untrusted'].includes(input.approvalPolicy)
      ? input.approvalPolicy
      : (existing?.approvalPolicy || 'on-request')
    const rawMaxTurns = input.maxTurns !== undefined ? Number(input.maxTurns) : (existing ? existing.maxTurns : DEFAULT_AGENT_TURNS)
    const maxTurns = Number.isFinite(rawMaxTurns) ? Math.max(0, Math.min(2000, Math.round(rawMaxTurns))) : 0
    const memoryEnabled = input.memoryEnabled !== undefined ? Boolean(input.memoryEnabled) : (existing ? existing.memoryEnabled : true)
    const autoFallback = input.autoFallback !== undefined ? Boolean(input.autoFallback) : (existing ? existing.autoFallback : true)

    let nextConfigs
    if (Array.isArray(input.modelConfigs) && input.modelConfigs.length > 0) {
      nextConfigs = normalizeModelConfigs(input.modelConfigs, existing || input, { enforceLimits: true })
      // A board built from rows older than the limits shows over-long config strings shortened, and
      // the agent form sends those shortened strings back. A field that is exactly the shortened form
      // of what is stored was not edited: keep the stored text, write only real changes.
      const storedConfigs = Array.isArray(existing?.modelConfigs) ? existing.modelConfigs : []
      nextConfigs = nextConfigs.map(cfg => {
        const stored = storedConfigs.find(c => c.id === cfg.id || echoesShortenedView(c.id, cfg.id, MODEL_CONFIG_LIMITS.id))
        if (!stored) return cfg
        let out = cfg
        for (const [key, max] of Object.entries(MODEL_CONFIG_LIMITS)) {
          if (echoesShortenedView(stored[key], cfg[key], max)) {
            if (out === cfg) out = { ...cfg }
            out[key] = stored[key]
          }
        }
        return out
      })
    } else {
      const baseConfigs = normalizeModelConfigs(existing?.modelConfigs, existing || input)
      const p0 = { ...baseConfigs[0] }
      // Only a value that actually changes is validated, so a save that echoes an older over-long
      // value back (e.g. a rename) neither fails nor rewrites it.
      const setP0 = (key, raw) => {
        const value = String(raw).trim()
        if (value === p0[key] || echoesShortenedView(p0[key], value, MODEL_CONFIG_LIMITS[key])) return
        p0[key] = assertMaxLength(key, value, MODEL_CONFIG_LIMITS[key])
      }
      if (input.engine !== undefined && String(input.engine).trim()) setP0('engine', input.engine)
      if (input.mode === 'scoped' || input.mode === 'global') p0.mode = input.mode
      if (input.provider !== undefined) setP0('provider', input.provider)
      if (input.model !== undefined) setP0('model', input.model)
      if (input.apiMode !== undefined) setP0('apiMode', input.apiMode)
      if (input.baseUrl !== undefined) setP0('baseUrl', input.baseUrl)
      if (input.customModel !== undefined) p0.customModel = Boolean(input.customModel)
      if (input.reasoningEffort !== undefined) setP0('reasoningEffort', input.reasoningEffort)
      nextConfigs = [p0, ...baseConfigs.slice(1)]
    }

    // The prompt is capped only when it really changes. A save that leaves it out, sends it back unchanged,
    // or sends the shortened form the board shows for an older over-long prompt keeps the stored text.
    let systemPrompt = String(existing?.systemPrompt || '')
    if (input.systemPrompt !== undefined) {
      const raw = String(input.systemPrompt)
      const unchanged = existing && (raw === existing.systemPrompt || echoesShortenedView(existing.systemPrompt, raw, MAX_SYSTEM_PROMPT_CHARS))
      if (!unchanged) systemPrompt = raw.slice(0, MAX_SYSTEM_PROMPT_CHARS)
    }

    const primary = nextConfigs[0]
    const values = {
      name: String(input.name ?? existing?.name ?? '').trim().slice(0, 120),
      role,
      roleLabel,
      avatar,
      description: (input.description !== undefined ? String(input.description).trim() : (existing?.description || '')).slice(0, 4000),
      engine: primary.engine,
      mode: primary.mode,
      provider: primary.provider,
      model: primary.model,
      apiMode: primary.apiMode,
      baseUrl: primary.baseUrl,
      customModel: primary.customModel,
      reasoningEffort: primary.reasoningEffort,
      modelConfigs: nextConfigs,
      autoFallback,
      approvalPolicy,
      sandboxMode,
      memoryEnabled,
      maxTurns,
      systemPrompt,
      readOnly,
    }
    if (!values.name) throw new Error('Agent name is required')
    if (dryRun) return null

    if (existing) {
      db.prepare(`
        UPDATE agents SET
          name=?, role=?, role_label=?, avatar=?, description=?, engine=?, mode=?, provider=?, model=?, api_mode=?, base_url=?,
          custom_model=?, reasoning_effort=?, model_configs_json=?, auto_fallback=?, approval_policy=?,
          sandbox_mode=?, memory_enabled=?, max_turns=?, system_prompt=?, read_only=?, updated_at=?
        WHERE id=? AND user_id=? AND profile=?
      `).run(
        values.name, values.role, values.roleLabel, values.avatar, values.description, values.engine, values.mode, values.provider, values.model,
        values.apiMode, values.baseUrl, values.customModel ? 1 : 0, values.reasoningEffort,
        JSON.stringify(values.modelConfigs), values.autoFallback ? 1 : 0, values.approvalPolicy,
        values.sandboxMode, values.memoryEnabled ? 1 : 0, values.maxTurns, values.systemPrompt,
        values.readOnly ? 1 : 0, ts, id, userId, profile,
      )
    } else {
      db.prepare(`
        INSERT INTO agents (
          id, user_id, profile, name, role, role_label, avatar, description, engine, mode, provider, model, api_mode, base_url,
          custom_model, reasoning_effort, model_configs_json, auto_fallback, approval_policy, sandbox_mode,
          memory_enabled, max_turns, system_prompt, read_only, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, userId, profile, values.name, values.role, values.roleLabel, values.avatar, values.description, values.engine, values.mode,
        values.provider, values.model, values.apiMode, values.baseUrl, values.customModel ? 1 : 0,
        values.reasoningEffort, JSON.stringify(values.modelConfigs), values.autoFallback ? 1 : 0,
        values.approvalPolicy, values.sandboxMode, values.memoryEnabled ? 1 : 0, values.maxTurns,
        values.systemPrompt, values.readOnly ? 1 : 0, ts, ts,
      )
    }
    return getAgent(userId, profile, id)
  }

  /**
   * The stored id a client-supplied agent id refers to. A row written before the id limit may have an
   * over-long id that the board shows shortened; that shortened form resolves to the stored row.
   */
  function resolveAgentId(userId, profile, wanted) {
    const given = String(wanted || '')
    if (!given) return ''
    if (db.prepare('SELECT 1 FROM agents WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, given)) return given
    const longIds = db.prepare('SELECT id FROM agents WHERE user_id = ? AND profile = ? AND length(id) > ?').all(userId, profile, MAX_AGENT_REF_CHARS)
    const hit = longIds.find(r => echoesShortenedView(r.id, given, MAX_AGENT_REF_CHARS))
    return hit ? hit.id : given
  }

  /**
   * An agent reference to write (todo agent/reviewer, Chief binding). An id over 120 characters is
   * accepted only when it addresses an agent row already stored (written before the limit), given in
   * full or in its shortened board form; it is written as the stored id. Any other over-long id is refused.
   */
  function boundedAgentRef(userId, profile, field, raw) {
    const text = String(raw ?? '')
    const stored = resolveAgentId(userId, profile, text)
    if (stored.length > MAX_AGENT_REF_CHARS
      && db.prepare('SELECT 1 FROM agents WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, stored)) {
      return stored
    }
    return assertMaxLength(field, text, MAX_AGENT_REF_CHARS)
  }

  function deleteAgent(userId, profile, wanted) {
    const id = resolveAgentId(userId, profile, wanted)
    db.prepare('DELETE FROM config_cooldowns WHERE agent_id = ?').run(id)
    db.prepare('DELETE FROM agents WHERE id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
  }

  function recordConfigFailure(agentId, configId, category = '', errorText = '') {
    if (!agentId || !configId) return
    db.prepare(`
      INSERT INTO config_cooldowns (agent_id, config_id, failed_at, category, error_text)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, config_id) DO UPDATE SET
        failed_at = excluded.failed_at,
        category = excluded.category,
        error_text = excluded.error_text
    `).run(agentId, configId, nowMs(), String(category || ''), String(errorText || '').slice(0, 500))
  }

  function listAgentCooldowns(agentId) {
    return db.prepare('SELECT * FROM config_cooldowns WHERE agent_id = ?').all(agentId).map(r => ({
      agentId: r.agent_id,
      configId: r.config_id,
      failedAt: r.failed_at,
      category: r.category,
      errorText: r.error_text,
    }))
  }

  /** With `userId`/`profile`, the shortened board id of an older over-long agent resolves to the stored id first. */
  function clearAgentCooldowns(agentId, userId, profile) {
    const id = userId !== undefined ? resolveAgentId(userId, profile, agentId) : agentId
    db.prepare('DELETE FROM config_cooldowns WHERE agent_id = ?').run(id)
  }

  function listMemories(userId, profile, filter = {}) {
    let sql = 'SELECT * FROM memories WHERE user_id = ? AND profile = ?'
    const params = [userId, profile]
    if (filter.scope && filter.scope !== 'all') { sql += ' AND scope = ?'; params.push(filter.scope) }
    if (filter.scopeId !== undefined && filter.scopeId !== null && filter.scopeId !== '') { sql += ' AND scope_id = ?'; params.push(filter.scopeId) }
    if (filter.category && filter.category !== 'all') { sql += ' AND category = ?'; params.push(filter.category) }
    if (filter.onlyEnabled) { sql += ' AND enabled = 1' }
    sql += ' ORDER BY pinned DESC, updated_at DESC'
    let rows = db.prepare(sql).all(...params).map(mapMemory)
    if (filter.query && normalizeSearchQuery(filter.query)) {
      // Todo #98: same matching rule as search-workspace.
      rows = rows.filter(m => matchesQuery([m.title, m.content], filter.query))
    }
    return rows
  }

  function getMemory(userId, profile, id) {
    return mapMemory(db.prepare('SELECT * FROM memories WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, id))
  }

  /**
   * The stored id a client-supplied memory id refers to. A row written before the id limit may have an
   * over-long id that the board shows shortened; that shortened form resolves to the stored row.
   */
  function resolveMemoryId(userId, profile, id) {
    const wanted = String(id || '')
    if (!wanted) return ''
    if (db.prepare('SELECT 1 FROM memories WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, wanted)) return wanted
    const longIds = db.prepare('SELECT id FROM memories WHERE user_id = ? AND profile = ? AND length(id) > ?').all(userId, profile, MAX_AGENT_REF_CHARS)
    const hit = longIds.find(r => echoesShortenedView(r.id, wanted, MAX_AGENT_REF_CHARS))
    return hit ? hit.id : wanted
  }

  function upsertMemory(userId, profile, input) {
    const ts = nowMs()
    const givenId = input.id && String(input.id).trim() ? String(input.id).trim() : ''
    const id = givenId ? resolveMemoryId(userId, profile, givenId) : `mem-${randomUUID().slice(0, 8)}`
    const existing = getMemory(userId, profile, id)
    // The id is the primary key: an over-long new one is refused, never cut into a key nobody can address.
    if (!existing) assertMaxLength('id', id, MAX_AGENT_REF_CHARS)
    const scope = ['chief', 'project', 'agent'].includes(input.scope) ? input.scope : (existing?.scope || 'chief')
    let scopeId = ''
    if (scope !== 'chief') {
      const storedScopeId = String(existing?.scopeId ?? '')
      const rawScopeId = String(input.scopeId ?? storedScopeId).trim()
      // An over-long new scope id is refused; an unchanged stored one (or its shortened board form) is kept.
      scopeId = rawScopeId === storedScopeId || echoesShortenedView(storedScopeId, rawScopeId, MAX_AGENT_REF_CHARS)
        ? storedScopeId
        : assertMaxLength('scopeId', rawScopeId, MAX_AGENT_REF_CHARS)
    }
    const category = ['preference', 'convention', 'architecture', 'pitfall', 'decision'].includes(input.category)
      ? input.category
      : (existing?.category || 'convention')
    // Capped only when this call carries the field; pinning or disabling an older oversized memory
    // leaves its stored text alone (the board view shortens it).
    const title = input.title != null
      ? clampText(String(input.title).trim(), MAX_MEMORY_TITLE_CHARS)
      : String(existing?.title ?? '')
    const content = input.content != null
      ? clampText(String(input.content).trim(), MAX_MEMORY_CONTENT_CHARS)
      : String(existing?.content ?? '')
    if (!title.trim() || !content.trim()) throw new Error('Memory title and content are required')
    const pinned = input.pinned !== undefined ? Boolean(input.pinned) : Boolean(existing?.pinned)
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing ? existing.enabled : true)
    const source = ['user', 'chief', 'host-import'].includes(input.source) ? input.source : (existing?.source || 'user')

    if (existing) {
      db.prepare(`
        UPDATE memories SET scope=?, scope_id=?, category=?, title=?, content=?, pinned=?, enabled=?, source=?, updated_at=?
        WHERE id=? AND user_id=? AND profile=?
      `).run(scope, scopeId, category, title, content, pinned ? 1 : 0, enabled ? 1 : 0, source, ts, id, userId, profile)
    } else {
      db.prepare(`
        INSERT INTO memories (id, user_id, profile, scope, scope_id, category, title, content, pinned, enabled, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, profile, scope, scopeId, category, title, content, pinned ? 1 : 0, enabled ? 1 : 0, source, ts, ts)
    }
    return getMemory(userId, profile, id)
  }

  function deleteMemory(userId, profile, id) {
    db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ? AND profile = ?').run(resolveMemoryId(userId, profile, id), userId, profile)
  }

  function listProjects(userId, profile) {
    return db.prepare('SELECT * FROM projects WHERE user_id = ? AND profile = ? ORDER BY created_at ASC, rowid ASC').all(userId, profile).map(mapProject)
  }

  function getProject(userId, profile, id) {
    return mapProject(db.prepare('SELECT * FROM projects WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, id))
  }

  function createProject(userId, profile, input) {
    const ts = nowMs()
    const id = `proj-${randomUUID().slice(0, 8)}`
    const agents = listAgents(userId, profile)
    const defaultBuilder = agents.find(a => a.role === 'builder')?.id || agents.find(a => a.role !== 'chief')?.id || agents[0]?.id || ''
    const defaultReviewer = agents.find(a => a.role === 'reviewer')?.id || ''
    const name = clampText(String(input.name || '').trim(), PROJECT_TEXT_LIMITS.name)
    const displayName = String(input.displayName || '').trim().slice(0, 60)
    const effectiveLabel = displayName || name
    const projectText = key => assertMaxLength(key, String(input[key] || '').trim(), PROJECT_TEXT_LIMITS[key])
    const monogram = (input.monogram?.trim() || extractMonogram(effectiveLabel)).slice(0, 2)
    const avatar = validateAvatarValue(input.avatar || '', { allowPreset: false })
    const count = listProjects(userId, profile).length
    const accent = PROJECT_ACCENTS.includes(input.accent) ? input.accent : PROJECT_ACCENTS[count % PROJECT_ACCENTS.length]
    const sourceType = ['local', 'github-linked', 'github-cloned'].includes(input.sourceType)
      ? input.sourceType
      : (input.githubRepo ? 'github-linked' : 'local')

    db.prepare(`
      INSERT INTO projects (
        id, user_id, profile, name, display_name, monogram, avatar, repo_path, github_repo, remote_url, source_type, is_private,
        default_branch, test_command, description, accent,
        owner_agent_id, reviewer_agent_id, auto_dispatch, auto_answer_routine, auto_merge_after_review, require_human_for_deploy,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, profile, name, displayName, monogram, avatar, projectText('repoPath'),
      projectText('githubRepo'), projectText('remoteUrl'),
      sourceType, input.isPrivate ? 1 : 0,
      projectText('defaultBranch') || 'main', projectText('testCommand'), clampText(String(input.description || '').trim(), PROJECT_TEXT_LIMITS.description),
      accent,
      assertMaxLength('ownerAgentId', String(input.ownerAgentId || ''), MAX_AGENT_REF_CHARS) || defaultBuilder,
      assertMaxLength('reviewerAgentId', String(input.reviewerAgentId || ''), MAX_AGENT_REF_CHARS) || defaultReviewer,
      input.autoDispatch === false ? 0 : 1, input.autoAnswerRoutine === false ? 0 : 1,
      input.autoMergeAfterReview === true ? 1 : 0, input.requireHumanForDeploy === false ? 0 : 1,
      ts, ts,
    )
    return getProject(userId, profile, id)
  }

  function updateProject(userId, profile, id, patch) {
    const cur = getProject(userId, profile, id)
    if (!cur) throw new Error(`Project not found: ${id}`)
    const ts = nowMs()
    const ap = { ...cur.autopilot, ...(patch.autopilot || {}) }
    // Project text is bounded only for a field this patch really changes. A value equal to the stored
    // one, or to its shortened board form, keeps the stored text (so saving the project form from a
    // trimmed board can never replace a long test command by its cut form). Descriptive fields are
    // shortened; paths, refs, URLs and the test command are refused when over-long.
    const projectText = key => {
      if (patch[key] === undefined) return cur[key]
      const raw = String(patch[key]).trim()
      const max = PROJECT_TEXT_LIMITS[key]
      if (raw === cur[key]) return cur[key]
      if (String(cur[key]).length > max && raw === clampText(cur[key], max)) return cur[key]
      return PROJECT_DESCRIPTIVE_FIELDS.includes(key) ? clampText(raw, max) : assertMaxLength(key, raw, max)
    }
    const nextName = projectText('name') || cur.name
    // An agent reference is an id: an over-long new value is refused, an unchanged one is kept.
    const agentRef = key => {
      if (patch[key] === undefined) return cur[key]
      const raw = String(patch[key])
      return raw === cur[key] ? cur[key] : assertMaxLength(key, raw, MAX_AGENT_REF_CHARS)
    }
    const nextDisplayName = patch.displayName !== undefined ? String(patch.displayName).trim().slice(0, 60) : cur.displayName
    const nextMonogram = patch.monogram !== undefined
      ? (String(patch.monogram).trim().slice(0, 2) || extractMonogram(nextDisplayName || nextName))
      : ((patch.displayName !== undefined || patch.name !== undefined)
          ? extractMonogram(nextDisplayName || nextName)
          : cur.monogram)
    // A size-trimmed board shows an uploaded project avatar as a stand-in marker (`avatarOmitted`).
    // Saving the project from that view sends the marker back; it means "keep the stored avatar".
    const nextAvatar = patch.avatar !== undefined && String(patch.avatar).trim() !== omittedProjectAvatarMarker(id)
      ? validateAvatarValue(patch.avatar, { allowPreset: false })
      : cur.avatar
    const nextAccent = patch.accent !== undefined && PROJECT_ACCENTS.includes(patch.accent)
      ? patch.accent
      : cur.accent
    db.prepare(`
      UPDATE projects SET
        name=?, display_name=?, monogram=?, avatar=?, repo_path=?, github_repo=?, remote_url=?, source_type=?, is_private=?,
        default_branch=?, test_command=?, description=?, accent=?,
        owner_agent_id=?, reviewer_agent_id=?,
        auto_dispatch=?, auto_answer_routine=?, auto_merge_after_review=?, require_human_for_deploy=?,
        updated_at=?
      WHERE id=? AND user_id=? AND profile=?
    `).run(
      nextName,
      nextDisplayName,
      nextMonogram,
      nextAvatar,
      projectText('repoPath'),
      projectText('githubRepo'),
      projectText('remoteUrl'),
      patch.sourceType !== undefined ? String(patch.sourceType).trim() : cur.sourceType,
      patch.isPrivate !== undefined ? (patch.isPrivate ? 1 : 0) : (cur.isPrivate ? 1 : 0),
      projectText('defaultBranch'),
      projectText('testCommand'),
      projectText('description'),
      nextAccent,
      agentRef('ownerAgentId'),
      agentRef('reviewerAgentId'),
      ap.autoDispatch ? 1 : 0, ap.autoAnswerRoutine ? 1 : 0, ap.autoMergeAfterReview ? 1 : 0, ap.requireHumanForDeploy ? 1 : 0,
      ts, id, userId, profile,
    )
    return getProject(userId, profile, id)
  }

  function deleteProject(userId, profile, id) {
    db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
  }

  /**
   * Removes a project together with everything that only makes sense inside it:
   * its todos (and their watches / wake log entries) and its schedules. Topics are cross-project
   * conversations, so they are kept and simply detached from the project.
   */
  function deleteProjectCascade(userId, profile, id) {
    const todoIds = db.prepare('SELECT id FROM todos WHERE user_id = ? AND profile = ? AND project_id = ?')
      .all(userId, profile, id).map(r => r.id)
    db.exec('BEGIN')
    try {
      for (const todoId of todoIds) {
        db.prepare('DELETE FROM todo_watches WHERE user_id = ? AND profile = ? AND todo_id = ?').run(userId, profile, todoId)
        db.prepare('DELETE FROM wake_log WHERE todo_id = ?').run(todoId)
        db.prepare('DELETE FROM todo_queue WHERE user_id = ? AND profile = ? AND todo_id = ?').run(userId, profile, todoId)
      }
      db.prepare('DELETE FROM schedules WHERE user_id = ? AND profile = ? AND project_id = ?').run(userId, profile, id)
      db.prepare('DELETE FROM todo_counters WHERE user_id = ? AND profile = ? AND project_id = ?').run(userId, profile, id)
      db.prepare('DELETE FROM todos WHERE user_id = ? AND profile = ? AND project_id = ?').run(userId, profile, id)
      db.prepare("UPDATE topics SET project_id = '' WHERE user_id = ? AND profile = ? AND project_id = ?").run(userId, profile, id)
      db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return todoIds.length
  }

  /**
   * Removes a single todo card and everything that only exists for it (watches, wake log, schedules).
   * Topic messages are kept as history; their question links to this todo are cleared.
   */
  function deleteTodoCascade(userId, profile, todoId) {
    const row = db.prepare('SELECT project_id, number FROM todos WHERE id = ? AND user_id = ? AND profile = ?').get(todoId, userId, profile)
    db.exec('BEGIN')
    try {
      if (row) {
        db.prepare(`INSERT INTO todo_counters (user_id, profile, project_id, last_number) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id, profile, project_id) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`).run(userId, profile, row.project_id, row.number)
      }
      db.prepare('DELETE FROM todo_watches WHERE user_id = ? AND profile = ? AND todo_id = ?').run(userId, profile, todoId)
      db.prepare('DELETE FROM wake_log WHERE todo_id = ?').run(todoId)
      db.prepare('DELETE FROM todo_queue WHERE user_id = ? AND profile = ? AND todo_id = ?').run(userId, profile, todoId)
      db.prepare('DELETE FROM schedules WHERE user_id = ? AND profile = ? AND todo_id = ?').run(userId, profile, todoId)
      db.prepare("UPDATE topic_messages SET question_todo_id = '' WHERE user_id = ? AND profile = ? AND question_todo_id = ?").run(userId, profile, todoId)
      const res = db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ? AND profile = ?').run(todoId, userId, profile)
      db.exec('COMMIT')
      return Number(res.changes || 0)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  function mapTopicRow(r, messages, watchedTodoIds) {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      isUserNamed: Boolean(r.is_user_named),
      pinned: Boolean(r.pinned),
      archived: Boolean(r.archived),
      brief: { ...defaultBrief(), ...safeJsonParse(r.brief_json, {}) },
      lastError: r.last_error || '',
      activeConfigId: r.active_config_id || '',
      autopilot: Boolean(r.autopilot),
      chiefSessionId: r.chief_session_id,
      activeRunId: r.active_run_id,
      isRunning: Boolean(r.is_running),
      lastDigestAt: r.last_digest_at,
      // #105: read-only view of the persisted idle-round state (see setTopicChiefIdle).
      chiefIdle: normalizeChiefIdle(safeJsonParse(r.chief_idle_json, {})),
      watchedTodoIds,
      messages,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

  function listTopics(userId, profile, { includeArchived = true } = {}) {
    const sql = includeArchived
      ? 'SELECT * FROM topics WHERE user_id = ? AND profile = ? ORDER BY archived ASC, pinned DESC, updated_at DESC'
      : 'SELECT * FROM topics WHERE user_id = ? AND profile = ? AND archived = 0 ORDER BY pinned DESC, updated_at DESC'
    const rows = db.prepare(sql).all(userId, profile)
    const msgStmt = db.prepare('SELECT * FROM topic_messages WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC')
    const watchStmt = db.prepare('SELECT todo_id FROM todo_watches WHERE topic_id = ? AND active = 1 ORDER BY created_at DESC')
    return rows.map(r => mapTopicRow(
      r,
      msgStmt.all(r.id).map(mapMessage),
      watchStmt.all(r.id).map(w => w.todo_id),
    ))
  }

  function getTopic(userId, profile, id) {
    const r = db.prepare('SELECT * FROM topics WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, id)
    if (!r) return null
    const messages = db.prepare('SELECT * FROM topic_messages WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC').all(r.id).map(mapMessage)
    const watchedTodoIds = db.prepare('SELECT todo_id FROM todo_watches WHERE topic_id = ? AND active = 1 ORDER BY created_at DESC').all(r.id).map(w => w.todo_id)
    return mapTopicRow(r, messages, watchedTodoIds)
  }

  function createTopic(userId, profile, input = {}) {
    const ts = nowMs()
    const id = `topic-${randomUUID().slice(0, 8)}`
    const rawTitle = clampText(String(input.title || '').trim(), MAX_TOPIC_TITLE_CHARS)
    const title = rawTitle || '新话题'
    const isUserNamed = Boolean(input.isUserNamed && rawTitle)
    db.prepare(`
      INSERT INTO topics (
        id, user_id, profile, project_id, title, is_user_named, pinned, archived, brief_json, last_error, active_config_id,
        autopilot, chief_session_id, active_run_id, is_running, last_digest_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '{}', '', '', ?, '', '', 0, ?, ?, ?)
    `).run(id, userId, profile, input.projectId || '', title, isUserNamed ? 1 : 0, input.autopilot === false ? 0 : 1, ts, ts, ts)
    return getTopic(userId, profile, id)
  }

  function updateTopic(userId, profile, id, patch) {
    const cur = getTopic(userId, profile, id)
    if (!cur) throw new Error(`Topic not found: ${id}`)
    const ts = nowMs()
    let nextBrief = cur.brief
    if (patch.brief !== undefined) {
      // Only the brief fields this patch carries are capped (2,000 characters each).
      // Options are normalised first and capped afterwards (label 2,000, id 120), so the capped form is
      // what gets stored. Options already stored are only normalised, never cut.
      const patchBrief = patch.brief.waitingOptions !== undefined
        ? { ...patch.brief, waitingOptions: normalizeWaitingOptions(patch.brief.waitingOptions) }
        : patch.brief
      const merged = { ...defaultBrief(), ...cur.brief, ...clampBrief(patchBrief), updatedAt: ts }
      if (patch.brief.waitingOptions !== undefined) {
        merged.waitingOptions = clampOptions(merged.waitingOptions)
      } else {
        merged.waitingOptions = normalizeWaitingOptions(merged.waitingOptions)
      }
      if (!String(merged.waitingOnYou || '').trim()) {
        merged.waitingOnYou = ''
        merged.waitingTitle = ''
        merged.waitingRecommendation = ''
        merged.waitingOptions = []
      }
      nextBrief = merged
    }
    // The topic list is ordered by updated_at = "last activity". Only real activity moves a topic up: a new
    // decision/brief or a new error (messages bump it in addTopicMessage). Runtime bookkeeping (isRunning,
    // activeRunId, session/config ids, digest cursor) and housekeeping (rename, pin, archive, project) keep the
    // timestamp, so opening a topic — which re-syncs its run state — never reorders the sidebar.
    // Capped only when this patch carries it; an oversized error already stored is left as it is.
    const nextError = patch.lastError !== undefined ? clampText(String(patch.lastError), MAX_LAST_ERROR_CHARS) : cur.lastError
    const isActivity = patch.brief !== undefined || (Boolean(nextError) && nextError !== cur.lastError)
    const nextUpdatedAt = isActivity ? ts : cur.updatedAt
    db.prepare(`
      UPDATE topics SET
        project_id=?, title=?, is_user_named=?, pinned=?, archived=?, brief_json=?, last_error=?, active_config_id=?,
        autopilot=?, chief_session_id=?, active_run_id=?, is_running=?, last_digest_at=?, updated_at=?
      WHERE id=? AND user_id=? AND profile=?
    `).run(
      patch.projectId !== undefined ? String(patch.projectId) : cur.projectId,
      patch.title !== undefined ? clampText(String(patch.title).trim(), MAX_TOPIC_TITLE_CHARS) : cur.title,
      patch.isUserNamed !== undefined ? (patch.isUserNamed ? 1 : 0) : (cur.isUserNamed ? 1 : 0),
      patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (cur.pinned ? 1 : 0),
      patch.archived !== undefined ? (patch.archived ? 1 : 0) : (cur.archived ? 1 : 0),
      JSON.stringify(nextBrief),
      nextError,
      patch.activeConfigId !== undefined ? String(patch.activeConfigId) : cur.activeConfigId,
      patch.autopilot !== undefined ? (patch.autopilot ? 1 : 0) : (cur.autopilot ? 1 : 0),
      patch.chiefSessionId !== undefined ? String(patch.chiefSessionId) : cur.chiefSessionId,
      patch.activeRunId !== undefined ? String(patch.activeRunId) : cur.activeRunId,
      patch.isRunning !== undefined ? (patch.isRunning ? 1 : 0) : (cur.isRunning ? 1 : 0),
      patch.lastDigestAt !== undefined ? Number(patch.lastDigestAt) : cur.lastDigestAt,
      nextUpdatedAt, id, userId, profile,
    )
    return getTopic(userId, profile, id)
  }

  function deleteTopic(userId, profile, id) {
    db.prepare('DELETE FROM topic_queue WHERE topic_id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
    db.prepare('DELETE FROM todo_watches WHERE topic_id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
    db.prepare('DELETE FROM topics WHERE id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
  }

  function mapQueueRow(row) {
    if (!row) return null
    return {
      id: row.id,
      topicId: row.topic_id,
      kind: row.kind || 'user',
      text: row.text || '',
      attachments: safeJsonParse(row.attachments_json, []),
      mentionedAgentIds: safeJsonParse(row.mentioned_agent_ids_json, []),
      createdAt: row.created_at,
      ...(row.client_nonce ? { clientNonce: row.client_nonce } : {}),
    }
  }

  function listTopicQueue(userId, profile, topicId) {
    return db.prepare(`
      SELECT * FROM topic_queue
      WHERE user_id = ? AND profile = ? AND topic_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(userId, profile, topicId).map(mapQueueRow)
  }

  // Returns the stored item, or null when this topic already queues the same send nonce (nothing is stored).
  function enqueueTopicItem(userId, profile, topicId, item) {
    const ts = item.createdAt || nowMs()
    const id = item.id || `tq-${randomUUID().slice(0, 10)}`
    const result = db.prepare(`
      INSERT INTO topic_queue (id, topic_id, user_id, profile, kind, text, attachments_json, mentioned_agent_ids_json, client_nonce, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      id,
      topicId,
      userId,
      profile,
      item.kind === 'wake' ? 'wake' : 'user',
      // New items are capped; an item re-queued with its id (retry / promote) keeps its stored text.
      item.id ? String(item.text || '') : clampText(String(item.text || ''), MAX_QUEUED_TEXT_CHARS),
      JSON.stringify(Array.isArray(item.attachments) ? item.attachments : []),
      JSON.stringify(Array.isArray(item.mentionedAgentIds) ? item.mentionedAgentIds : []),
      cleanClientNonce(item.clientNonce),
      ts,
    )
    if (!Number(result?.changes)) return null
    return mapQueueRow(db.prepare('SELECT * FROM topic_queue WHERE id = ?').get(id))
  }

  const TODO_QUEUE_KINDS = new Set(['message', 'changes', 'answer', 'plan'])
  function mapTodoQueueRow(row) {
    return {
      id: row.id,
      todoId: row.todo_id,
      kind: row.kind || 'message',
      text: row.text || '',
      createdAt: row.created_at,
      ...(row.client_nonce ? { clientNonce: row.client_nonce } : {}),
    }
  }

  function listTodoQueue(userId, profile, todoId) {
    return db.prepare(`
      SELECT * FROM todo_queue
      WHERE user_id = ? AND profile = ? AND todo_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(userId, profile, todoId).map(mapTodoQueueRow)
  }

  function enqueueTodoItem(userId, profile, todoId, item) {
    const id = item.id || `tdq-${randomUUID().slice(0, 10)}`
    db.prepare(`
      INSERT INTO todo_queue (id, todo_id, user_id, profile, kind, text, client_nonce, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      todoId,
      userId,
      profile,
      TODO_QUEUE_KINDS.has(item.kind) ? item.kind : 'message',
      clampText(String(item.text || ''), MAX_QUEUED_TEXT_CHARS),
      cleanClientNonce(item.clientNonce),
      item.createdAt || nowMs(),
    )
    return mapTodoQueueRow(db.prepare('SELECT * FROM todo_queue WHERE id = ?').get(id))
  }

  // Cards (any user/profile) holding queued worker instructions, with the age of the oldest one.
  function listTodosWithQueue() {
    return db.prepare(`
      SELECT todo_id, user_id, profile, MIN(created_at) AS oldest FROM todo_queue
      GROUP BY todo_id, user_id, profile
    `).all().map(r => ({ todoId: r.todo_id, userId: r.user_id, profile: r.profile, oldest: r.oldest }))
  }

  function removeTodoQueueItem(userId, profile, todoId, itemId) {
    const res = db.prepare('DELETE FROM todo_queue WHERE id = ? AND todo_id = ? AND user_id = ? AND profile = ?')
      .run(itemId, todoId, userId, profile)
    return Number(res?.changes || 0) > 0
  }

  function removeTopicQueueItem(userId, profile, topicId, itemId) {
    const res = db.prepare(`
      DELETE FROM topic_queue WHERE id = ? AND topic_id = ? AND user_id = ? AND profile = ?
    `).run(itemId, topicId, userId, profile)
    return res.changes > 0
  }

  function clearTopicQueue(userId, profile, topicId) {
    db.prepare('DELETE FROM topic_queue WHERE topic_id = ? AND user_id = ? AND profile = ?').run(topicId, userId, profile)
  }

  function addTopicMessage(userId, profile, topicId, msg) {
    const ts = msg.createdAt || nowMs()
    const id = msg.id || `msg-${randomUUID().slice(0, 10)}`
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
    const hostMessageId = String(msg.hostMessageId || '')
    const clientNonce = cleanClientNonce(msg.clientNonce)
    // A host message is stored once per topic. Returns '' when it is already there.
    if (hostMessageId && db.prepare('SELECT 1 AS x FROM topic_messages WHERE topic_id = ? AND host_message_id = ?').get(topicId, hostMessageId)) return ''
    const result = db.prepare(`
      INSERT INTO topic_messages (id, topic_id, user_id, profile, kind, text, attachments_json, duration_ms, todo_id, question_todo_id, progress_notice, tools_json, host_message_id, client_nonce, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      id, topicId, userId, profile, msg.kind || 'chief', clampText(String(msg.text || ''), MAX_TOPIC_MESSAGE_CHARS), JSON.stringify(attachments), Number(msg.durationMs || 0),
      String(msg.todoId || ''), String(msg.questionTodoId || ''), String(msg.progressNotice || ''),
      JSON.stringify(msg.tools || []), hostMessageId, clientNonce, ts,
    )
    if (!Number(result?.changes)) return ''
    // Never move backwards when an older host message is back-filled during a sync.
    db.prepare('UPDATE topics SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(ts, topicId)
    return id
  }

  // True when this topic already holds the send with this nonce, as a message or as a queued follow-up.
  function hasTopicSendNonce(userId, profile, topicId, nonce) {
    const clean = cleanClientNonce(nonce)
    if (!clean) return false
    return Boolean(
      db.prepare('SELECT 1 AS x FROM topic_messages WHERE topic_id = ? AND user_id = ? AND profile = ? AND client_nonce = ?').get(topicId, userId, profile, clean)
      || db.prepare('SELECT 1 AS x FROM topic_queue WHERE topic_id = ? AND user_id = ? AND profile = ? AND client_nonce = ?').get(topicId, userId, profile, clean),
    )
  }

  function setTopicMessageSendError(userId, profile, topicId, messageId, errorText) {
    if (!messageId) return false
    const res = db.prepare('UPDATE topic_messages SET send_error = ? WHERE id = ? AND topic_id = ? AND user_id = ? AND profile = ?')
      .run(clampText(String(errorText || ''), MAX_SEND_ERROR_CHARS), messageId, topicId, userId, profile)
    return res.changes > 0
  }

  // #125: the topic messages about one card (topic_messages.todo_id), of every topic and every kind, read
  // only. Ordinary chat has todo_id '' and is never matched: an empty id returns nothing. `total` is the
  // real count; `messages` are the latest `limit` of them, oldest first.
  function listTopicMessagesForTodo(userId, profile, todoId, limit) {
    const id = String(todoId || '')
    if (!id) return { total: 0, messages: [] }
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM topic_messages WHERE user_id = ? AND profile = ? AND todo_id = ?').get(userId, profile, id)?.n || 0)
    const max = Math.max(0, Math.floor(Number(limit) || 0))
    const rows = db.prepare('SELECT * FROM topic_messages WHERE user_id = ? AND profile = ? AND todo_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, profile, id, max)
    return { total, messages: rows.reverse().map(mapMessage) }
  }

  // #125: writes the card a stored user message is about (topic_messages.todo_id). Only a message of that
  // topic, of kind human, that is not about a card yet: a message is about one card, the first one, and is
  // never moved to another. Returns whether the row was written. Nothing else of the row or topic changes.
  function linkTopicMessageToTodo(userId, profile, topicId, messageId, todoId) {
    if (!topicId || !messageId || !todoId) return false
    const res = db.prepare("UPDATE topic_messages SET todo_id = ? WHERE id = ? AND topic_id = ? AND user_id = ? AND profile = ? AND kind = 'human' AND todo_id = ''")
      .run(String(todoId), String(messageId), String(topicId), userId, profile)
    return Number(res?.changes) > 0
  }

  function removeTopicMessage(userId, profile, topicId, messageId) {
    if (!messageId) return false
    const res = db.prepare('DELETE FROM topic_messages WHERE id = ? AND topic_id = ? AND user_id = ? AND profile = ?').run(messageId, topicId, userId, profile)
    return res.changes > 0
  }

  function listTodos(userId, profile, filter = {}) {
    let sql = 'SELECT * FROM todos WHERE user_id = ? AND profile = ?'
    const params = [userId, profile]
    if (filter.projectId) { sql += ' AND project_id = ?'; params.push(filter.projectId) }
    if (filter.phase) { sql += ' AND phase = ?'; params.push(filter.phase) }
    if (filter.topicId) { sql += ' AND topic_id = ?'; params.push(filter.topicId) }
    sql += ' ORDER BY updated_at DESC, number DESC'
    return db.prepare(sql).all(...params).map(mapTodo)
  }

  function getTodo(userId, profile, id) {
    return mapTodo(db.prepare('SELECT * FROM todos WHERE user_id = ? AND profile = ? AND id = ?').get(userId, profile, id))
  }

  function findTodoBySessionId(sessionId) {
    if (!sessionId) return null
    const row = db.prepare('SELECT * FROM todos WHERE build_session_id = ? OR review_session_id = ? LIMIT 1').get(sessionId, sessionId)
    if (!row) return null
    return { userId: row.user_id, profile: row.profile, todo: mapTodo(row) }
  }

  function findTopicBySessionId(sessionId) {
    if (!sessionId) return null
    const row = db.prepare('SELECT * FROM topics WHERE chief_session_id = ? LIMIT 1').get(sessionId)
    if (!row) return null
    return { userId: row.user_id, profile: row.profile, topicId: row.id }
  }

  // #105: idle Chief rounds of one topic. `count`: consecutive idle rounds (reset only by a productive round);
  // `resumes`: automatic resumes since the last user message; `exhaustedNoticed`: the "resumes used up" notice
  // was written for this chain; `updatedAt`: ms of the last write. Written only through this function.
  function setTopicChiefIdle(userId, profile, topicId, patch) {
    const row = db.prepare('SELECT chief_idle_json FROM topics WHERE id = ? AND user_id = ? AND profile = ?').get(topicId, userId, profile)
    if (!row) return null
    const next = normalizeChiefIdle({ ...normalizeChiefIdle(safeJsonParse(row.chief_idle_json, {})), ...patch, updatedAt: nowMs() })
    db.prepare('UPDATE topics SET chief_idle_json = ? WHERE id = ? AND user_id = ? AND profile = ?')
      .run(JSON.stringify(next), topicId, userId, profile)
    return next
  }

  // #105: cards waiting at a gate the Chief owns (light rows for the reconcile tick).
  function listChiefGateTodos() {
    return db.prepare(`
      SELECT user_id, profile, id, updated_at FROM todos
      WHERE gate_owner = 'chief' AND phase IN ('review', 'confirm')
    `).all()
  }

  function listActiveRuntimeItems() {
    const activeTodos = db.prepare(`
      SELECT user_id, profile, id FROM todos
      WHERE phase IN ('building', 'reviewing') AND (build_session_id != '' OR review_session_id != '')
    `).all()
    const mergingTodosRows = db.prepare(`
      SELECT user_id, profile, id, updated_at FROM todos
      WHERE phase = 'merging'
    `).all()
    const activeTopics = db.prepare(`
      SELECT user_id, profile, id FROM topics
      WHERE is_running = 1 AND chief_session_id != ''
    `).all()
    const recentTopics = db.prepare(`
      SELECT user_id, profile, id FROM topics
      WHERE archived = 0 AND chief_session_id != ''
      ORDER BY updated_at DESC LIMIT 8
    `).all()
    const topicsWithQueue = db.prepare(`
      SELECT DISTINCT user_id, profile, topic_id AS id FROM topic_queue
    `).all()
    return { activeTodos, mergingTodosRows, activeTopics, recentTopics, topicsWithQueue }
  }

  function listQueuedTodos(userId, profile) {
    return db.prepare(`
      SELECT * FROM todos
      WHERE user_id = ? AND profile = ? AND phase = 'queued'
      ORDER BY updated_at ASC, created_at ASC
    `).all(userId, profile).map(mapTodo)
  }

  function createTodo(userId, profile, input) {
    // Ids are used as given: an over-long one is refused before anything (even the card number) is written.
    for (const key of ['agentId', 'reviewerId', 'topicId']) assertMaxLength(key, String(input[key] || ''), MAX_AGENT_REF_CHARS)
    const ts = nowMs()
    const id = `td-${randomUUID().slice(0, 8)}`
    const maxRow = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM todos WHERE user_id = ? AND profile = ? AND project_id = ?')
      .get(userId, profile, input.projectId)
    // Numbers never repeat, even after a card is deleted, so a new todo can never reuse an old task branch.
    const counterRow = db.prepare('SELECT last_number AS n FROM todo_counters WHERE user_id = ? AND profile = ? AND project_id = ?')
      .get(userId, profile, input.projectId)
    const number = Math.max(Number(maxRow?.n) || 0, Number(counterRow?.n) || 0) + 1
    db.prepare(`INSERT INTO todo_counters (user_id, profile, project_id, last_number) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, profile, project_id) DO UPDATE SET last_number = excluded.last_number`).run(userId, profile, input.projectId, number)
    const project = getProject(userId, profile, input.projectId)
    const agentId = input.agentId || project?.ownerAgentId || ''
    const reviewerId = input.reviewerId || project?.reviewerAgentId || ''
    const agent = agentId ? getAgent(userId, profile, agentId) : null
    const engine = input.engine || agent?.engine || 'hermes'
    const createdBy = input.actor === 'chief' ? 'chief' : 'human'
    const tags = clampTags(input.tags)
    const timeline = [{ time: ts, event: `创建任务 #${number}`, actor: input.actor || 'user' }]

    db.prepare(`
      INSERT INTO todos (
        id, user_id, profile, project_id, topic_id, number, title, kind, created_by, tags_json, phase, gate_owner, gate_kind, with_plan,
        agent_id, reviewer_id, engine, active_config_id, fallback_history_json, branch, worktree_path, base_commit, snapshot_sha,
        build_session_id, build_run_id, review_session_id, review_run_id,
        spec, plan, evidence_json, question_json, diffs_json, build_chat_json, timeline_json, last_error, revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', 'none', 'none', ?, ?, ?, ?, '', '[]', '', '', '', '', '', '', '', '', ?, '', ?, ?, '[]', '[]', ?, '', 1, ?, ?)
    `).run(
      id, userId, profile, input.projectId, input.topicId || '', number, clampText(String(input.title).trim(), MAX_TITLE_CHARS),
      ['feature', 'bug', 'question', 'deploy', 'content'].includes(input.kind) ? input.kind : 'feature',
      createdBy, JSON.stringify(tags),
      input.withPlan ? 1 : 0, agentId, reviewerId, engine, clampText(String(input.spec || ''), MAX_SPEC_CHARS),
      JSON.stringify(defaultEvidence()), JSON.stringify(defaultQuestion()), JSON.stringify(timeline),
      ts, ts,
    )
    return getTodo(userId, profile, id)
  }

  function updateTodo(userId, profile, id, patch) {
    const cur = getTodo(userId, profile, id)
    if (!cur) throw new Error(`Todo not found: ${id}`)
    const ts = nowMs()
    const nextRev = cur.revision + 1
    // Agent references are ids: an over-long new one is refused before anything is written; an unchanged
    // one, or the shortened board form of an older over-long one, keeps the stored value.
    const agentRef = key => {
      if (patch[key] === undefined) return cur[key]
      const raw = String(patch[key])
      if (raw === cur[key] || echoesShortenedView(cur[key], raw, MAX_AGENT_REF_CHARS)) return cur[key]
      return boundedAgentRef(userId, profile, key, raw)
    }
    const nextAgentId = agentRef('agentId')
    const nextReviewerId = agentRef('reviewerId')
    // What goes to the host log about a cut field is bounded too (id, original length, first 2,000
    // characters), and a failing log sink never fails the write.
    const warnTruncated = (message, raw) => {
      try {
        options.log?.warn?.(message, { todoId: id, length: raw.length, head: raw.slice(0, MAX_LOGGED_HEAD_CHARS) })
      } catch {
        // logging is best-effort
      }
    }
    // Free-text fields are capped here, the single write path, but only the fields this patch carries:
    // an unrelated update (a timeline entry, a phase change) must never shorten text already stored.
    // Rows written before the caps keep their full text; the board view shortens them when read.
    // Only the head of a cut error, timeline event or spec goes to the host log.
    let nextLastError = cur.lastError
    if (patch.lastError !== undefined) {
      const raw = String(patch.lastError)
      if (raw.length > MAX_LAST_ERROR_CHARS) {
        warnTruncated('Todo lastError truncated for storage', raw)
      }
      nextLastError = clampText(raw, MAX_LAST_ERROR_CHARS)
    }
    let nextTimeline = cur.timeline
    if (patch.timeline !== undefined) {
      for (const entry of Array.isArray(patch.timeline) ? patch.timeline : []) {
        const event = String(entry?.event ?? '')
        if (event.length > MAX_TIMELINE_EVENT_CHARS) {
          warnTruncated('Todo timeline event truncated for storage', event)
        }
      }
      nextTimeline = clampTimeline(patch.timeline)
    }
    const nextPlan = patch.plan !== undefined ? clampUtf8(String(patch.plan), MAX_PLAN_BYTES) : cur.plan
    const nextBuildChat = patch.buildChat !== undefined ? clampBuildChat(patch.buildChat) : cur.buildChat
    let nextSpec = cur.spec
    if (patch.spec !== undefined) {
      const raw = String(patch.spec)
      if (raw.length > MAX_SPEC_CHARS) {
        warnTruncated('Todo spec truncated for storage', raw)
      }
      nextSpec = clampText(raw, MAX_SPEC_CHARS)
    }
    const nextTitle = patch.title !== undefined ? clampText(String(patch.title).trim(), MAX_TITLE_CHARS) : cur.title
    db.prepare(`
      UPDATE todos SET
        title=?, kind=?, tags_json=?, phase=?, gate_owner=?, gate_kind=?, with_plan=?,
        agent_id=?, reviewer_id=?, engine=?, active_config_id=?, fallback_history_json=?,
        branch=?, worktree_path=?, base_commit=?, snapshot_sha=?, reviewed_sha=?,
        build_session_id=?, build_run_id=?, review_session_id=?, review_run_id=?,
        spec=?, plan=?, evidence_json=?, question_json=?, diffs_json=?, build_chat_json=?, timeline_json=?, last_error=?,
        revision=?, updated_at=?
      WHERE id=? AND user_id=? AND profile=?
    `).run(
      nextTitle,
      patch.kind !== undefined ? String(patch.kind) : cur.kind,
      JSON.stringify(Array.isArray(patch.tags) ? clampTags(patch.tags) : cur.tags),
      patch.phase !== undefined ? String(patch.phase) : cur.phase,
      patch.gateOwner !== undefined ? String(patch.gateOwner) : cur.gateOwner,
      patch.gateKind !== undefined ? String(patch.gateKind) : cur.gateKind,
      patch.withPlan !== undefined ? (patch.withPlan ? 1 : 0) : (cur.withPlan ? 1 : 0),
      nextAgentId,
      nextReviewerId,
      patch.engine !== undefined ? String(patch.engine) : cur.engine,
      patch.activeConfigId !== undefined ? String(patch.activeConfigId) : cur.activeConfigId,
      JSON.stringify(patch.fallbackHistory !== undefined ? patch.fallbackHistory : cur.fallbackHistory),
      patch.branch !== undefined ? String(patch.branch) : cur.branch,
      patch.worktreePath !== undefined ? String(patch.worktreePath) : cur.worktreePath,
      patch.baseCommit !== undefined ? String(patch.baseCommit) : cur.baseCommit,
      patch.snapshotSha !== undefined ? String(patch.snapshotSha) : cur.snapshotSha,
      patch.reviewedSha !== undefined ? String(patch.reviewedSha) : (cur.reviewedSha || ''),
      patch.buildSessionId !== undefined ? String(patch.buildSessionId) : cur.buildSessionId,
      patch.buildRunId !== undefined ? String(patch.buildRunId) : cur.buildRunId,
      patch.reviewSessionId !== undefined ? String(patch.reviewSessionId) : cur.reviewSessionId,
      patch.reviewRunId !== undefined ? String(patch.reviewRunId) : cur.reviewRunId,
      nextSpec,
      nextPlan,
      JSON.stringify(patch.evidence !== undefined ? { ...cur.evidence, ...patch.evidence } : cur.evidence),
      JSON.stringify(patch.question !== undefined ? { ...cur.question, ...clampQuestion(patch.question) } : cur.question),
      JSON.stringify(patch.diffs !== undefined ? clampDiffs(patch.diffs) : cur.diffs),
      JSON.stringify(nextBuildChat),
      JSON.stringify(nextTimeline),
      nextLastError,
      nextRev, ts, id, userId, profile,
    )
    return getTodo(userId, profile, id)
  }

  // #97: the only write of todos.topic_id after creation (repair-todo-topic). updateTodo never changes it.
  function setTodoTopic(userId, profile, id, topicId) {
    const cur = getTodo(userId, profile, id)
    if (!cur) throw new Error(`Todo not found: ${id}`)
    db.prepare('UPDATE todos SET topic_id = ?, revision = ?, updated_at = ? WHERE id = ? AND user_id = ? AND profile = ?')
      .run(String(topicId || ''), cur.revision + 1, nowMs(), id, userId, profile)
    return getTodo(userId, profile, id)
  }

  // #97: id and project of every topic of the account and profile (archived ones included), without messages.
  function listTopicProjectIds(userId, profile) {
    return db.prepare('SELECT id, project_id FROM topics WHERE user_id = ? AND profile = ?').all(userId, profile)
      .map(r => ({ id: r.id, projectId: r.project_id || '' }))
  }

  // #97: how many cards of each project every topic holds: [{ topicId, projectId, count, latest }].
  function tallyTopicTodoProjects(userId, profile) {
    return db.prepare(`
      SELECT topic_id, project_id, COUNT(*) AS n, MAX(updated_at) AS latest
      FROM todos WHERE user_id = ? AND profile = ? AND topic_id != '' GROUP BY topic_id, project_id
    `).all(userId, profile).map(r => ({ topicId: r.topic_id, projectId: r.project_id || '', count: Number(r.n) || 0, latest: Number(r.latest) || 0 }))
  }

  function appendTimeline(userId, profile, id, event, actor = 'system') {
    const cur = getTodo(userId, profile, id)
    if (!cur) return null
    const timeline = [...cur.timeline, { time: nowMs(), event, actor }].slice(-80)
    return updateTodo(userId, profile, id, { timeline })
  }

  function watchTodo(userId, profile, topicId, todoId, reason = '', wakeOn = ['gate', 'done', 'failed']) {
    if (!topicId || !todoId) return
    const ts = nowMs()
    db.prepare(`
      INSERT INTO todo_watches (id, user_id, profile, topic_id, todo_id, reason, wake_on_json, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(topic_id, todo_id) DO UPDATE SET
        reason = excluded.reason,
        wake_on_json = excluded.wake_on_json,
        active = 1
    `).run(`w-${randomUUID().slice(0, 8)}`, userId, profile, topicId, todoId, reason, JSON.stringify(wakeOn), ts)
  }

  function getActiveWatchesForTodo(userId, profile, todoId) {
    return db.prepare('SELECT * FROM todo_watches WHERE user_id = ? AND profile = ? AND todo_id = ? AND active = 1')
      .all(userId, profile, todoId)
      .map(r => ({
        id: r.id,
        topicId: r.topic_id,
        todoId: r.todo_id,
        reason: r.reason,
        wakeOn: safeJsonParse(r.wake_on_json, ['gate', 'done', 'failed']),
      }))
  }

  function clearWatch(topicId, todoId) {
    db.prepare('UPDATE todo_watches SET active = 0 WHERE topic_id = ? AND todo_id = ?').run(topicId, todoId)
  }

  // #104: ends every active watch of a card (it was completed, merged, closed or is dispatched again).
  // Returns how many were active. Rows are kept with active = 0, as clearWatch leaves them.
  function clearWatchesForTodo(userId, profile, todoId) {
    const res = db.prepare('UPDATE todo_watches SET active = 0 WHERE user_id = ? AND profile = ? AND todo_id = ? AND active = 1')
      .run(userId, profile, todoId)
    return Number(res.changes || 0)
  }

  // #108: runs fn inside one SQLite transaction and returns its result: every write of fn is stored, or, when
  // fn throws, none (ROLLBACK, the error is thrown on). fn must be synchronous. Called inside a transaction
  // that is already open it only runs fn, which then belongs to that outer transaction.
  let transactionDepth = 0
  function transaction(fn) {
    if (transactionDepth > 0) return fn()
    db.exec('BEGIN')
    transactionDepth += 1
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* the transaction is already gone */ }
      throw err
    } finally {
      transactionDepth -= 1
    }
  }

  // #97: whether a wake_log key was claimed already; reads only.
  function hasWakeKey(wakeKey) {
    return Boolean(db.prepare('SELECT 1 AS hit FROM wake_log WHERE wake_key = ?').get(wakeKey))
  }

  function claimWakeKey(wakeKey, todoId, topicId) {
    const res = db.prepare('INSERT OR IGNORE INTO wake_log (wake_key, todo_id, topic_id, fired_at) VALUES (?, ?, ?, ?)')
      .run(wakeKey, todoId, topicId, nowMs())
    return Number(res.changes || 0) > 0
  }

  function countActiveBuilds(userId, profile) {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM todos
      WHERE user_id = ? AND profile = ? AND phase IN ('building', 'reviewing')
    `).get(userId, profile)
    return Number(row?.cnt || 0)
  }

  function listActiveBuildTodoIds(userId, profile) {
    return db.prepare(`
      SELECT id FROM todos
      WHERE user_id = ? AND profile = ? AND phase IN ('building', 'reviewing')
    `).all(userId, profile).map(r => r.id)
  }

  function getRecentTodoUpdatesSince(userId, profile, sinceMs) {
    return db.prepare(`
      SELECT id, project_id, topic_id, number, title, phase, gate_owner, gate_kind, updated_at
      FROM todos WHERE user_id = ? AND profile = ? AND updated_at > ?
      ORDER BY updated_at ASC LIMIT 20
    `).all(userId, profile, sinceMs || 0)
  }

  /* ---------- Schedules CRUD (v0.8.0 Todos Schedules Parity) ---------- */

  function mapSchedule(row) {
    if (!row) return null
    return {
      id: row.id,
      userId: row.user_id,
      profile: row.profile,
      projectId: row.project_id,
      todoId: row.todo_id,
      frequency: row.frequency,
      hour: Number(row.hour || 0),
      minute: Number(row.minute || 0),
      weekday: Number(row.weekday || 0),
      runAtIso: row.run_at_iso || '',
      timezone: row.timezone || 'Asia/Shanghai',
      agentId: row.agent_id || '',
      note: row.note || '',
      enabled: Boolean(row.enabled),
      nextRunAt: Number(row.next_run_at || 0),
      lastRunAt: Number(row.last_run_at || 0),
      lastStatus: row.last_status || '',
      lastMessage: row.last_message || '',
      createdBy: row.created_by || 'user',
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }
  }

  function listSchedules(userId, profile, projectId = '') {
    if (projectId && projectId !== 'all') {
      return db.prepare(`
        SELECT * FROM schedules
        WHERE user_id = ? AND profile = ? AND project_id = ?
        ORDER BY enabled DESC, CASE WHEN next_run_at > 0 THEN next_run_at ELSE 9999999999999 END ASC, created_at DESC
      `).all(userId, profile, projectId).map(mapSchedule)
    }
    return db.prepare(`
      SELECT * FROM schedules
      WHERE user_id = ? AND profile = ?
      ORDER BY enabled DESC, CASE WHEN next_run_at > 0 THEN next_run_at ELSE 9999999999999 END ASC, created_at DESC
    `).all(userId, profile).map(mapSchedule)
  }

  function getSchedule(userId, profile, id) {
    const row = db.prepare('SELECT * FROM schedules WHERE id = ? AND user_id = ? AND profile = ?').get(id, userId, profile)
    return mapSchedule(row)
  }

  function createSchedule(userId, profile, input, actor = 'user') {
    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM schedules WHERE user_id = ? AND profile = ?').get(userId, profile)
    if (Number(countRow?.cnt || 0) >= MAX_SCHEDULES) {
      throw new Error(`最多支持创建 ${MAX_SCHEDULES} 条定时规则，请先删除不需要的规则`)
    }
    const norm = normalizeScheduleInput(input)
    if (!norm.todoId) throw new Error('请选择要定时运行的任务（todoId）')
    const todo = getTodo(userId, profile, norm.todoId)
    if (!todo) throw new Error(`未找到目标任务：${norm.todoId}`)
    const projectId = norm.projectId || todo.projectId
    const ts = nowMs()
    const id = `sch-${randomUUID().slice(0, 8)}`
    const nextRunAt = norm.enabled ? computeNextRunAt(norm, ts) : 0
    db.prepare(`
      INSERT INTO schedules (
        id, user_id, profile, project_id, todo_id, frequency, hour, minute, weekday, run_at_iso,
        timezone, agent_id, note, enabled, next_run_at, last_run_at, last_status, last_message,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?, ?)
    `).run(
      id, userId, profile, projectId, todo.id, norm.frequency, norm.hour, norm.minute, norm.weekday, norm.runAtIso,
      norm.timezone, norm.agentId, norm.note, norm.enabled ? 1 : 0, nextRunAt, actor || 'user', ts, ts,
    )
    return getSchedule(userId, profile, id)
  }

  function updateSchedule(userId, profile, id, patch = {}) {
    const cur = getSchedule(userId, profile, id)
    if (!cur) throw new Error(`未找到定时规则：${id}`)
    const norm = normalizeScheduleInput(patch, cur)
    const ts = nowMs()
    const recompute =
      patch.frequency !== undefined ||
      patch.hour !== undefined ||
      patch.minute !== undefined ||
      patch.weekday !== undefined ||
      patch.runAtIso !== undefined ||
      patch.runAt !== undefined ||
      patch.timezone !== undefined ||
      patch.enabled !== undefined
    const nextRunAt = patch.nextRunAt !== undefined
      ? Number(patch.nextRunAt || 0)
      : (recompute ? (norm.enabled ? computeNextRunAt(norm, ts) : 0) : cur.nextRunAt)
    const lastRunAt = patch.lastRunAt !== undefined ? Number(patch.lastRunAt || 0) : cur.lastRunAt
    const lastStatus = patch.lastStatus !== undefined ? String(patch.lastStatus || '') : cur.lastStatus
    const lastMessage = patch.lastMessage !== undefined ? String(patch.lastMessage || '') : cur.lastMessage
    db.prepare(`
      UPDATE schedules SET
        project_id = ?, todo_id = ?, frequency = ?, hour = ?, minute = ?, weekday = ?, run_at_iso = ?,
        timezone = ?, agent_id = ?, note = ?, enabled = ?, next_run_at = ?, last_run_at = ?,
        last_status = ?, last_message = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND profile = ?
    `).run(
      norm.projectId || cur.projectId, norm.todoId || cur.todoId,
      norm.frequency, norm.hour, norm.minute, norm.weekday, norm.runAtIso,
      norm.timezone, norm.agentId, norm.note, norm.enabled ? 1 : 0, nextRunAt, lastRunAt,
      lastStatus, lastMessage, ts, id, userId, profile,
    )
    return getSchedule(userId, profile, id)
  }

  function deleteSchedule(userId, profile, id) {
    db.prepare('DELETE FROM schedules WHERE id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
  }

  function listDueSchedules(atMs = nowMs()) {
    return db.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND next_run_at > 0 AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(atMs).map(mapSchedule)
  }

  /* ---------- Quota Providers & Native Usage Ledger CRUD ---------- */

  function mapQuotaProvider(row, includeSecret = false) {
    if (!row) return null
    const base = {
      id: row.id,
      providerType: row.provider_type === 'magpie' ? 'custom' : row.provider_type,
      name: row.name,
      subtitle: row.subtitle || '',
      kind: row.kind || 'subscription',
      accent: row.accent || 'blue',
      enabled: Boolean(row.enabled),
      pinned: Boolean(row.pinned),
      sortOrder: Number(row.sort_order || 10),
      sourceMode: ['auto', 'direct', 'local'].includes(row.source_mode) ? row.source_mode : 'auto',
      endpoint: row.endpoint || '',
      credentialLabel: row.credential_label || '',
      credentialPlaceholder: row.credential_placeholder || '',
      hasSecret: Boolean(row.secret_value),
      secretPreview: maskSecret(row.secret_value),
      lastSnapshot: safeJsonParse(row.last_snapshot_json, null),
      lastCheckedAt: Number(row.last_checked_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }
    if (includeSecret) base.secretValue = row.secret_value || ''
    return base
  }

  function ensureDefaultQuotaProviders(userId, profile) {
    const existing = db.prepare('SELECT id FROM quota_providers WHERE user_id = ? AND profile = ?').all(userId, profile)
    if (existing.length > 0) return
    const ts = nowMs()
    const ins = db.prepare(`
      INSERT OR IGNORE INTO quota_providers (
        id, user_id, profile, provider_type, name, subtitle, kind, accent, enabled, pinned,
        sort_order, source_mode, endpoint, secret_value, credential_label, credential_placeholder,
        last_snapshot_json, last_checked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '{}', 0, ?, ?)
    `)
    for (const p of DEFAULT_QUOTA_PROVIDERS) {
      ins.run(
        p.id, userId, profile, p.providerType, p.name, p.subtitle, p.kind, p.accent,
        p.enabled ? 1 : 0, p.pinned ? 1 : 0, p.sortOrder, p.sourceMode, p.endpoint,
        p.credentialLabel, p.credentialPlaceholder, ts, ts,
      )
    }
  }

  function listQuotaProviders(userId, profile) {
    ensureDefaultQuotaProviders(userId, profile)
    return db.prepare(`
      SELECT * FROM quota_providers
      WHERE user_id = ? AND profile = ?
      ORDER BY enabled DESC, pinned DESC, sort_order ASC, created_at ASC
    `).all(userId, profile).map(r => mapQuotaProvider(r, false))
  }

  function getQuotaProviderRaw(userId, profile, id) {
    ensureDefaultQuotaProviders(userId, profile)
    const row = db.prepare('SELECT * FROM quota_providers WHERE id = ? AND user_id = ? AND profile = ?').get(id, userId, profile)
    return mapQuotaProvider(row, true)
  }

  function upsertQuotaProvider(userId, profile, input = {}) {
    ensureDefaultQuotaProviders(userId, profile)
    const ts = nowMs()
    const id = String(input.id || `custom-${randomUUID().slice(0, 6)}`).trim()
    const cur = getQuotaProviderRaw(userId, profile, id)
    if (cur) {
      const nextSecret = input.clearSecret
        ? ''
        : (input.secretValue !== undefined && String(input.secretValue).trim() !== ''
            ? String(input.secretValue).trim()
            : cur.secretValue)
      const nextMode = ['auto', 'direct', 'local'].includes(input.sourceMode) ? input.sourceMode : cur.sourceMode
      db.prepare(`
        UPDATE quota_providers SET
          name = ?, subtitle = ?, kind = ?, accent = ?, enabled = ?, pinned = ?, sort_order = ?,
          source_mode = ?, endpoint = ?, secret_value = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND profile = ?
      `).run(
        input.name !== undefined ? String(input.name).trim() || cur.name : cur.name,
        input.subtitle !== undefined ? String(input.subtitle).trim() : cur.subtitle,
        input.kind !== undefined ? String(input.kind).trim() || cur.kind : cur.kind,
        input.accent !== undefined ? String(input.accent).trim() || cur.accent : cur.accent,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (cur.enabled ? 1 : 0),
        input.pinned !== undefined ? (input.pinned ? 1 : 0) : (cur.pinned ? 1 : 0),
        input.sortOrder !== undefined ? Number(input.sortOrder) || cur.sortOrder : cur.sortOrder,
        nextMode,
        input.endpoint !== undefined ? String(input.endpoint).trim() : cur.endpoint,
        nextSecret,
        ts, id, userId, profile,
      )
    } else {
      const name = String(input.name || '自定义配额源').trim()
      const providerType = String(input.providerType || 'custom').trim() === 'magpie'
        ? 'custom'
        : String(input.providerType || 'custom').trim()
      const nextMode = ['auto', 'direct', 'local'].includes(input.sourceMode) ? input.sourceMode : 'direct'
      db.prepare(`
        INSERT INTO quota_providers (
          id, user_id, profile, provider_type, name, subtitle, kind, accent, enabled, pinned,
          sort_order, source_mode, endpoint, secret_value, credential_label, credential_placeholder,
          last_snapshot_json, last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, ?, ?)
      `).run(
        id, userId, profile, providerType, name,
        String(input.subtitle || '自定义 API 余额接口').trim(),
        String(input.kind || 'balance').trim(),
        String(input.accent || 'blue').trim(),
        input.enabled !== false ? 1 : 0,
        input.pinned ? 1 : 0,
        Number(input.sortOrder || 20),
        nextMode,
        String(input.endpoint || '').trim(),
        String(input.secretValue || '').trim(),
        'API Key / Bearer Token',
        '填入对应服务的 API Key 或令牌',
        ts, ts,
      )
    }
    const row = db.prepare('SELECT * FROM quota_providers WHERE id = ? AND user_id = ? AND profile = ?').get(id, userId, profile)
    return mapQuotaProvider(row, false)
  }

  function saveQuotaProviderSnapshot(userId, profile, id, snapshot) {
    const ts = Number(snapshot?.checkedAt || nowMs())
    db.prepare(`
      UPDATE quota_providers SET last_snapshot_json = ?, last_checked_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND profile = ?
    `).run(JSON.stringify(snapshot || {}), ts, ts, id, userId, profile)
    const row = db.prepare('SELECT * FROM quota_providers WHERE id = ? AND user_id = ? AND profile = ?').get(id, userId, profile)
    return mapQuotaProvider(row, false)
  }

  function deleteQuotaProvider(userId, profile, id) {
    db.prepare('DELETE FROM quota_providers WHERE id = ? AND user_id = ? AND profile = ?').run(id, userId, profile)
  }

  function recordUsage(userId, profile, entry = {}) {
    const inp = Math.max(0, Math.round(Number(entry.inputTokens ?? entry.input_tokens ?? 0) || 0))
    const out = Math.max(0, Math.round(Number(entry.outputTokens ?? entry.output_tokens ?? 0) || 0))
    const cr = Math.max(0, Math.round(Number(entry.cacheReadTokens ?? entry.cache_read_tokens ?? 0) || 0))
    const cw = Math.max(0, Math.round(Number(entry.cacheWriteTokens ?? entry.cache_write_tokens ?? 0) || 0))
    const reas = Math.max(0, Math.round(Number(entry.reasoningTokens ?? entry.reasoning_tokens ?? 0) || 0))
    const cost = Math.max(0, Number(entry.costUsd ?? entry.cost_usd ?? 0) || 0)
    const model = String(entry.model || '').trim()
    if (inp + out + cr + cw === 0 && !model) return null
    const id = `u-${randomUUID().slice(0, 10)}`
    const ts = Number(entry.createdAt || nowMs())
    db.prepare(`
      INSERT INTO usage_records (
        id, user_id, profile, session_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, profile, String(entry.sessionId || ''), model, inp, out, cr, cw, reas, cost, ts)
    return id
  }

  function listUsageRecords(userId, profile, limit = 5000) {
    return db.prepare(`
      SELECT * FROM usage_records
      WHERE user_id = ? AND profile = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, profile, Math.max(1, Math.min(20000, Number(limit) || 5000)))
  }

  // Todo #98: search-workspace (one SQL statement per group, see search.mjs).
  const searchEngine = createSearchEngine(db)
  function searchWorkspace(userId, profile, input = {}) {
    return searchEngine.search(userId, profile, input)
  }

  return {
    dbPath,
    close: () => db.close(),
    searchWorkspace,
    getSettings,
    updateSettings,
    getGithubToken,
    setGithubToken,
    listAgents,
    getAgent,
    ensureDefaultAgents,
    upsertAgent,
    resolveAgentId,
    deleteAgent,
    recordConfigFailure,
    listAgentCooldowns,
    clearAgentCooldowns,
    listMemories,
    getMemory,
    upsertMemory,
    deleteMemory,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    deleteProjectCascade,
    deleteTodoCascade,
    listTopics,
    getTopic,
    createTopic,
    updateTopic,
    deleteTopic,
    addTopicMessage,
    hasTopicSendNonce,
    setTopicMessageSendError,
    removeTopicMessage,
    listTopicMessagesForTodo,
    linkTopicMessageToTodo,
    listTopicQueue,
    enqueueTopicItem,
    removeTopicQueueItem,
    clearTopicQueue,
    listTodoQueue,
    enqueueTodoItem,
    removeTodoQueueItem,
    listTodosWithQueue,
    listTodos,
    listQueuedTodos,
    getTodo,
    findTodoBySessionId,
    findTopicBySessionId,
    listActiveRuntimeItems,
    setTopicChiefIdle,
    listChiefGateTodos,
    createTodo,
    updateTodo,
    setTodoTopic,
    tallyTopicTodoProjects,
    listTopicProjectIds,
    appendTimeline,
    watchTodo,
    getActiveWatchesForTodo,
    clearWatch,
    clearWatchesForTodo,
    watchConvergence,
    claimWakeKey,
    hasWakeKey,
    transaction,
    countActiveBuilds,
    listActiveBuildTodoIds,
    getRecentTodoUpdatesSince,
    listSchedules,
    getSchedule,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    listDueSchedules,
    ensureDefaultQuotaProviders,
    listQuotaProviders,
    getQuotaProviderRaw,
    upsertQuotaProvider,
    saveQuotaProviderSnapshot,
    deleteQuotaProvider,
    recordUsage,
    listUsageRecords,
  }
}
