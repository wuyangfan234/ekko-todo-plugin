import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

test('v0.9.7: Ekko Calm design layer defines one radius family, ring borders, tinted elevation and focus', () => {
  const css = read('../src/client/styles.css')
  for (const t of ['--ek-r-sm', '--ek-r-md', '--ek-r-lg', '--ek-r-xl', '--ek-ring', '--ek-elev-1', '--ek-elev-2', '--ek-elev-3', '--ek-focus', '--ek-surface-dim', '--ek-user-bubble']) {
    assert.match(css, new RegExp(`${t}:`), `${t} token defined`)
  }
  const layer = css.slice(css.indexOf('Ekko Calm design layer (v0.9.7)\n'))
  // v0.9.40 (Todo #20): the sidebar surface moved to its own --ek-nav-bg step (see v0940-sidebar-nav-contrast)
  assert.match(layer, /\.ot-left \{ background: var\(--ek-nav-bg\)/, 'navigation recedes')
  assert.match(layer, /\.ot-btn--primary, \.ot-btn--accent, \.ot-btn--indigo \{[\s\S]*?background: var\(--ek-brand-solid\)/, 'primary actions use the Ekko accent, not host black')
  assert.match(layer, /\.ot-card \{[\s\S]*?box-shadow: var\(--ek-elev-1\)/, 'cards use ring elevation')
  assert.match(layer, /prefers-reduced-motion/)
})

test('v0.9.7: 配置中心 stays in the sidebar; Agent has its own entry and is no longer a settings tab', () => {
  const sidebar = read('../src/client/components/Sidebar.jsx')
  assert.match(sidebar, /data-testid="btn-open-settings"/)
  assert.match(sidebar, /配置中心/)
  assert.match(sidebar, /btn-open-agents/)
  const settings = read('../src/client/components/SettingsPanel.jsx')
  assert.match(settings, /\{!onOpenAgents && <Tabs\.Trigger value="agents"/)
  assert.match(read('../src/client/App.jsx'), /e\.key === ','/)
})
