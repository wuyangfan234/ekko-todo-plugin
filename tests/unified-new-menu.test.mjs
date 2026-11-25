import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const sidebar = read('../src/client/components/Sidebar.jsx')
const menuStart = sidebar.indexOf('data-testid="unified-new-menu"')
const menuEnd = sidebar.indexOf('</Popover.Content>', menuStart)
const menu = sidebar.slice(menuStart, menuEnd)

test('unified new menu keeps all titles, icons and handlers but renders no subtitles', () => {
  assert.ok(menuStart >= 0 && menuEnd > menuStart, 'unified new menu exists')
  assert.doesNotMatch(menu, /<small[\s>]/, 'menu items have no small subtitle element')
  assert.doesNotMatch(menu, /ot-unified-new-copy/, 'two-line copy wrapper is removed')
  for (const subtitle of ['总管对话', '看板建单', '关联仓库', '配置成员', '周期重跑']) {
    assert.ok(!menu.includes(subtitle), `subtitle removed: ${subtitle}`)
  }
  for (const title of ['新建话题', '新建任务', '新建项目', '新建 Agent', '新建定时']) {
    assert.match(menu, new RegExp(`<strong>${title}</strong>`), `title retained: ${title}`)
  }
  assert.equal((menu.match(/<strong>/g) || []).length, 5, 'only the five titles remain')
  for (const testid of ['btn-new-topic', 'btn-unified-new-task', 'btn-unified-new-project', 'btn-unified-new-agent', 'btn-unified-new-schedule']) {
    assert.match(menu, new RegExp(`data-testid="${testid}"`), `menu item retained: ${testid}`)
  }
  for (const handler of [
    "setCreateMenuOpen(false); onNewTopic?.()",
    "setCreateMenuOpen(false); onNewTask?.()",
    "setCreateMenuOpen(false); onAddProject?.('github')",
    "setCreateMenuOpen(false); (onNewAgent ? onNewAgent() : onOpenSettings?.('agents'))",
    'setCreateMenuOpen(false); onNewSchedule?.()',
  ]) {
    assert.ok(menu.includes(handler), `click behavior retained: ${handler}`)
  }
})

test('unified new menu uses compact single-row styles without changing the command palette', () => {
  const css = read('../src/client/styles.css')
  assert.doesNotMatch(css, /ot-unified-new-copy/, 'subtitle-only styles are removed')
  assert.match(css, /\.ot-unified-new-item \{ align-items: center !important; height: 34px !important;/)
  assert.doesNotMatch(css, /\.ot-unified-new-item\s+small/)
  assert.match(read('../src/client/components/CommandPalette.jsx'), /新建总管话题（模型自动命名）/)
})
