import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v0.9.15: opening a topic jumps to the newest message instantly and stays pinned while content grows', () => {
  const chat = readFileSync(new URL('../src/client/components/ChatPane.jsx', import.meta.url), 'utf8')
  assert.match(chat, /el\.scrollTo\(\{ top: el\.scrollHeight, behavior: 'instant' \}\)/, 'no animated scroll')
  assert.match(chat, /useLayoutEffect\(\(\) => \{\s*autoScrollRef\.current = true\s*pinToBottom\(\)\s*\}, \[topic\?\.id\]\)/, 'topic switch resets pin before paint')
  assert.match(chat, /new ResizeObserver\(\(\) => \{ if \(autoScrollRef\.current\) pinToBottom\(\) \}\)/, 'late content keeps the view pinned unless the user scrolled up')
  assert.doesNotMatch(chat, /streamRef\.current\.scrollTop = streamRef\.current\.scrollHeight/)
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.ot-chat-stream \{[^}]*\}/)[0]
  assert.doesNotMatch(rule, /scroll-behavior:\s*smooth/)
})
