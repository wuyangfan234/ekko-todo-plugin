import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v0.9.13: opening a repository page never filters the board; the board keeps its own project filter', () => {
  const app = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /const \[boardProjectId, setBoardProjectId\] = useState\('all'\)/)
  const board = app.slice(app.indexOf('<KanbanBoard'), app.indexOf('/>', app.indexOf('onOpenQuotaHub', app.indexOf('<KanbanBoard'))))
  assert.match(board, /selectedProjectId=\{boardProjectId\}/)
  assert.match(board, /onSelectProject=\{pid => setBoardProjectId\(pid \|\| 'all'\)\}/)
  assert.match(board, /onClearProjectFilter=\{\(\) => setBoardProjectId\('all'\)\}/)
  assert.doesNotMatch(board, /setSelectedProjectId/)
  // New task / topic defaults come from the open repo page or the current topic, not a previously visited repo.
  assert.match(app, /const contextProjectId = \(\(\) => \{/)
  assert.doesNotMatch(app, /selectedProjectId !== 'all' \? selectedProjectId : ''/)
})
