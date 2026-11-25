import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v0.9.12: the sidebar topic list does not depend on the selected repository', () => {
  const src = readFileSync(new URL('../src/client/components/Sidebar.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /scopedTopics/)
  assert.doesNotMatch(src, /topics\.filter\(t => !t\.projectId \|\| t\.projectId === selectedProjectId\)/)
  assert.match(src, /const liveTopics = topics\.filter\(t => !t\.archived\)/)
  assert.match(src, /const archivedTopics = topics\.filter\(t => t\.archived\)/)
})
