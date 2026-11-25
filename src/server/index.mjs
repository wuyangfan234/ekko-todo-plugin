import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertContracts } from '../../sdk/harness/contracts.mjs'
import { createDatabase } from './db.mjs'
import { createOrchestrator } from './orchestrator.mjs'
import { registerMcpTools } from './mcp-tools.mjs'
import { registerAllRpcs } from './rpc-handlers.mjs'

function loadContract() {
  // Works both from dist/server.mjs (../contracts/plugin.json) and src/server/index.mjs (../../contracts/plugin.json)
  const candidates = [
    new URL('../contracts/plugin.json', import.meta.url),
    new URL('../../contracts/plugin.json', import.meta.url),
  ]
  for (const url of candidates) {
    if (existsSync(url)) {
      return assertContracts(JSON.parse(readFileSync(url, 'utf8')))
    }
  }
  throw new Error('Could not locate contracts/plugin.json')
}

const contract = loadContract()

/** @param {import('@ekko-studio/plugin-sdk').PluginContext} ctx */
export function apply(ctx) {
  const dataDir = ctx.paths?.dataDir || join(tmpdir(), 'ekko-todo-data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: ctx.config?.maxConcurrentBuilds, log: ctx.log })
  const orchestrator = createOrchestrator({
    db,
    dataDir,
    config: ctx.config || {},
    log: ctx.log,
  })

  const disposers = []

  // 1. Register UI RPC handlers
  disposers.push(...registerAllRpcs(ctx, contract, orchestrator))

  // 2. Register the 31 MCP tools on the dedicated `ekko-todo` server
  disposers.push(...registerMcpTools(ctx, { db, orchestrator }))

  // 3. Subscribe to real-time host session events (instant build/chief settlement)
  if (ctx.events?.on) {
    disposers.push(
      ctx.events.on('chat.*', async (event, run) => {
        try {
          await orchestrator.handleHostEvent(event, run)
        } catch (err) {
          ctx.log?.warn?.('Event reconciliation error', { type: event?.type, error: err?.message })
        }
      }),
    )
  }

  // 4. Register background reconciliation action & periodic crash-safe scheduler
  if (ctx.extensions?.actions?.register) {
    disposers.push(
      ctx.extensions.actions.register({
        name: 'reconcile',
        description: 'Reconcile active Ekko ToDo build, review, and Chief sessions and trigger idempotent wakes.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        async execute(_input, run) {
          return orchestrator.reconcileActiveRuns(run)
        },
      }),
    )
    // Follow-up syncs after a Chief turn ends. A scheduler action gets its own host handle on every tick;
    // a timer started inside an event or RPC callback would lose the host once that callback returns.
    disposers.push(
      ctx.extensions.actions.register({
        name: 'settle',
        description: 'Copy the last messages of Chief turns that just ended into their topics and clear stale running flags.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        async execute(_input, run) {
          return orchestrator.settlePendingTopics(run)
        },
      }),
    )
    if (ctx.scheduler?.every) {
      const intervalMs = Math.max(2000, Math.min(60000, Number(ctx.config?.reconcileIntervalMs) || 6000))
      disposers.push(ctx.scheduler.every('reconcile-loop', intervalMs, 'reconcile', {}))
      disposers.push(ctx.scheduler.every('settle-loop', 2000, 'settle', {}))
    }
  }

  const cleanup = () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch {}
    }
    try { orchestrator.dispose() } catch {}
    try { db.close() } catch {}
  }

  ctx.lifecycle?.add?.(cleanup)
  return cleanup
}
