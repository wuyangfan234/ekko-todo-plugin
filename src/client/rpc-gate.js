// Todo #100 / #112: the page-wide busy lock of App.callRpc, as a module the tests call directly.
//
//  - createRpcGate: a click that arrives while another call is in flight is no longer dropped in silence:
//    the user gets a hint, and the latest different action runs when the current one ends. A repeat of the
//    action already in flight (double click) is the only thing discarded.
//  - runGatedRpc: the one decision App.callRpc makes: a `free` call runs at once, every other call takes the lock.
//  - busyHint: the text shown for a blocked click.

export const BUSY_HINT_DUPLICATE = '正在处理上一个操作，请稍候'
export const BUSY_HINT_QUEUED = '正在处理上一个操作，完成后继续执行刚才的操作'

export function rpcCallKey(name, input) {
  let body = ''
  try { body = JSON.stringify(input ?? null) } catch { body = String(input) }
  return `${name}:${body}`
}

/** The hint of a blocked click: a repeat is discarded, another action waits for the current one. */
export function busyHint({ duplicate } = {}) {
  return duplicate ? BUSY_HINT_DUPLICATE : BUSY_HINT_QUEUED
}

/**
 * Serializes the calls that take the page-wide lock.
 * run(key, exec): no call in flight → exec runs now. Otherwise `onBlocked({ key, duplicate })` fires and
 *   - same key as the call in flight or the one already waiting → resolves null (a repeated click);
 *   - another key → it replaces the waiting call (which resolves null) and runs after the current one.
 */
export function createRpcGate({ onBusyChange, onBlocked } = {}) {
  let inflightKey = null
  let waiting = null
  const drain = async (key, exec) => {
    inflightKey = key
    try {
      return await exec()
    } finally {
      const next = waiting
      waiting = null
      if (next) {
        drain(next.key, next.exec).then(next.resolve, next.reject)
      } else {
        inflightKey = null
        onBusyChange?.(false)
      }
    }
  }
  return {
    get busy() { return inflightKey !== null },
    run(key, exec) {
      if (inflightKey === null) {
        onBusyChange?.(true)
        return drain(key, exec)
      }
      const duplicate = key === inflightKey || waiting?.key === key
      onBlocked?.({ key, duplicate })
      if (duplicate) return Promise.resolve(null)
      if (waiting) waiting.resolve(null)
      return new Promise((resolve, reject) => { waiting = { key, exec, resolve, reject } })
    },
  }
}

/**
 * One RPC of the page through the lock. `free: true` (0.9.65 send path) does not take it; every other call
 * is keyed by its name and input, so only a repeat of the same action is discarded.
 */
export function runGatedRpc(gate, { name, input, free = false } = {}, exec) {
  if (free) return exec()
  return gate.run(rpcCallKey(name, input), exec)
}
