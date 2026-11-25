import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('v0.9.18: card and file chips in the composer stay on one line and truncate long titles', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.ot-attached-chip \{ max-width: 100%; min-width: 0; white-space: nowrap; flex: 0 1 auto; \}/)
  assert.match(css, /\.ot-attached-chip-label \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/)
  const chat = readFileSync(new URL('../src/client/components/ChatPane.jsx', import.meta.url), 'utf8')
  assert.match(chat, /className="ot-attached-chip is-card" title=\{`#\$\{c\.number\} \$\{c\.title \|\| ''\}`\}/, 'full title in tooltip')
  assert.match(chat, /<span className="ot-attached-chip-label">#\{c\.number\} \{c\.title\}<\/span>/)
})
