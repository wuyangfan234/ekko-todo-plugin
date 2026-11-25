import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

test('v0.9.5: chief config lives above the composer and opens as a sheet, not inside the composer bar', () => {
  const chat = read('../src/client/components/ChatPane.jsx')
  const bar = chat.slice(chat.indexOf('<div className="ot-composer-bar">'), chat.indexOf('{chiefRunning ? ('))
  assert.ok(!bar.includes('QuickChiefPopover'), 'composer bar no longer hosts the chief pill')
  assert.ok(!bar.includes('btn-toggle-auto'), 'AUTO moved out of the composer bar')
  assert.match(chat, /ot-composer-context[\s\S]*QuickChiefPopover[\s\S]*btn-toggle-auto/)
  const sheet = read('../src/client/components/QuickChiefPopover.jsx')
  assert.match(sheet, /@radix-ui\/react-dialog/)
  assert.doesNotMatch(sheet, /react-popover/)
  const css = read('../src/client/styles.css')
  assert.match(css, /\.ot-chief-sheet \{[\s\S]*?width: min\(440px, 100vw\)/)
  assert.match(css, /@media \(max-width: 600px\) \{[\s\S]*?\.ot-chief-sheet \{[\s\S]*?max-height: 90vh/)
})

test('v0.9.5: Agent configuration is a full page reachable from sidebar, settings and the chief sheet', () => {
  const app = read('../src/client/App.jsx')
  assert.match(app, /activeView === 'agents' \? \(\s*<AgentsView/)
  assert.match(app, /if \(tabName === 'agents' && !isSettingsSlot\) \{ openAgents\(\); return \}/)
  assert.match(read('../src/client/components/Sidebar.jsx'), /data-testid="btn-open-agents"/)
  assert.match(read('../src/client/components/SettingsPanel.jsx'), /settings-agents-moved/)
  const am = read('../src/client/components/AgentManager.jsx')
  assert.match(am, /layout = 'dialog'/)
  assert.match(am, /btn-agent-mobile-back/)
})
