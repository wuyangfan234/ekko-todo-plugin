/** Parse a unified diff hunk body (starting at the first `@@`) into typed rows with old/new line numbers. */
export function parseDiffHunk(hunk) {
  const rows = []
  let oldNo = 0
  let newNo = 0
  for (const raw of String(hunk || '').split('\n')) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[2])
      rows.push({ type: 'hunk', text: raw, ctx: m[3].trim() })
      continue
    }
    if (/^\.\.\. \(\d+ more lines truncated\)$/.test(raw)) {
      rows.push({ type: 'note', text: raw.replace(/^\.\.\. \((\d+) more lines truncated\)$/, '其余 $1 行已省略') })
      continue
    }
    if (raw.startsWith('\\ No newline')) {
      rows.push({ type: 'note', text: '文件末尾无换行' })
      continue
    }
    if (raw.startsWith('+')) {
      rows.push({ type: 'add', oldNo: null, newNo: newNo || null, text: raw.slice(1) })
      if (newNo) newNo += 1
    } else if (raw.startsWith('-')) {
      rows.push({ type: 'del', oldNo: oldNo || null, newNo: null, text: raw.slice(1) })
      if (oldNo) oldNo += 1
    } else {
      if (!raw && rows.length && rows[rows.length - 1].type === 'note') continue
      rows.push({ type: 'ctx', oldNo: oldNo || null, newNo: newNo || null, text: raw.startsWith(' ') ? raw.slice(1) : raw })
      if (oldNo) oldNo += 1
      if (newNo) newNo += 1
    }
  }
  // Drop a trailing empty context row produced by the final newline
  while (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '') rows.pop()
  return rows
}
