// When the page is opened through a tunnel / reverse proxy (e.g. 节点小宝), the edge sometimes drops the
// backend mapping for a moment and answers with its own Go-style "404 page not found". The request never
// reached Studio, so retrying is safe even for writes. Real plugin errors are never retried.
// Only answers that prove the request was not applied: the edge's own 404 and 502 (backend unreachable) and
// 429 (a rate limiter such as the VPS nginx limit_req rejected it before it was handled).
// Timeouts / dropped connections are NOT retried because a write may already have been applied.
const EDGE_MISS = /404 page not found|API Error 502\b|API Error 429\b/i

export function isEdgeMiss(err) {
  return EDGE_MISS.test(String(err?.message || err || ''))
}

const wait = ms => new Promise(r => setTimeout(r, ms))

export function withEdgeRetry(call, { retries = 3, baseDelay = 400, sleep = wait } = {}) {
  return async (...args) => {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await call(...args)
      } catch (err) {
        lastErr = err
        if (!isEdgeMiss(err) || attempt === retries) break
        await sleep(baseDelay * (attempt + 1))
      }
    }
    if (isEdgeMiss(lastErr)) {
      const e = new Error('网络连接短暂中断（远程访问通道没有转发请求），已自动重试仍失败，请稍后再试')
      e.cause = lastErr
      throw e
    }
    throw lastErr
  }
}

export function wrapClientContext(ctx) {
  if (!ctx?.rpc?.call || ctx.rpc.__edgeRetry) return ctx
  const call = withEdgeRetry(ctx.rpc.call.bind(ctx.rpc))
  const rpc = Object.assign(Object.create(Object.getPrototypeOf(ctx.rpc)), ctx.rpc, { call, __edgeRetry: true })
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { rpc })
}
