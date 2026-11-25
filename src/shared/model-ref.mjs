/**
 * 0.9.57: provider / model pairs written by the Chief (configure_agent) or pasted by a user often repeat
 * the provider inside the model id. Hermes then asks Studio for `kimi-coding/kimi-coding/k3.1-pro` or
 * provider `custom` + `custom:magpie-jp/kiro/claude-opus-5.5`, gets HTTP 404 model_not_found, and the run
 * ends with nothing but the host's "Your request was not processed" row. Seen on a real board: five build
 * rounds failed this way within twenty minutes.
 *
 * No imports: bundled into both dist/server.mjs and dist/client.mjs.
 */
export function normalizeModelRef({ provider = '', model = '' } = {}) {
  let p = String(provider || '').trim()
  let m = String(model || '').trim()
  // `custom` + `custom:<pool>/<id>` → provider `custom:<pool>`, model `<id>`.
  const pooled = /^(custom:[^/\s]+)\/(.+)$/.exec(m)
  if (pooled && (!p || p === 'custom' || p === pooled[1])) {
    p = pooled[1]
    m = pooled[2]
  }
  // `<provider>/<provider>/<id>` or `<provider>/<id>` with that provider already set.
  while (p && m.startsWith(`${p}/`) && m.length > p.length + 1) m = m.slice(p.length + 1)
  return { provider: p, model: m }
}

/**
 * Is the pair in the host catalog? `catalog.models` entries carry `{ provider, id }`. Returns
 *   { known: false } when the catalog cannot answer (empty / error), else { known: true, ok, suggestions }.
 */
export function checkModelInCatalog(catalog, { provider = '', model = '' } = {}) {
  const list = Array.isArray(catalog?.models) ? catalog.models : []
  if (!list.length || catalog?.status === 'error') return { known: false, ok: true, suggestions: [] }
  const ok = list.some(x => String(x.id) === model && (!provider || String(x.provider) === provider))
  if (ok) return { known: true, ok: true, suggestions: [] }
  const tail = String(model).split('/').pop().toLowerCase()
  const suggestions = list
    .filter(x => tail && String(x.id).toLowerCase().includes(tail))
    .slice(0, 5)
    .map(x => `${x.provider}/${x.id}`)
  return { known: true, ok: false, suggestions }
}
