import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Todo #26: a long line inside a fenced code block (Markdown ``` → <pre><code>) must wrap inside the chat
// bubble. Before the fix `.ot-md code { white-space: nowrap }` also applied to <pre><code>, there was no
// `.ot-md pre` rule at all, and the chat stream could be swiped sideways by more than a thousand pixels.
//
// These tests render the real `renderChatMarkdown()` output and resolve the cascade of the real
// `src/client/styles.css` for the elements in that output. Node has no DOM, so DOMPurify is replaced by a
// pass-through here; the sanitised output and the pixel widths are measured in a real browser for the release.

const pkgRoot = new URL('../', import.meta.url).pathname
const read = p => readFileSync(join(pkgRoot, p), 'utf8')
const css = read('src/client/styles.css')

// ---------------------------------------------------------------- real renderer
let workDir = ''
let renderer = null
async function renderChatMarkdown(text) {
  if (!renderer) {
    workDir = mkdtempSync(join(tmpdir(), 'ekko-codewrap-'))
    const purifyStub = join(workDir, 'purify-stub.mjs')
    writeFileSync(purifyStub, 'export default { addHook() {}, sanitize: html => String(html) }\n')
    const entry = join(workDir, 'entry.jsx')
    writeFileSync(entry, `export { renderChatMarkdown } from ${JSON.stringify(join(pkgRoot, 'src/client/components/LocalFilePreview.jsx'))}\n`)
    const out = join(workDir, 'bundle.mjs')
    await build({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      loader: { '.css': 'text' },
      alias: { dompurify: purifyStub },
      nodePaths: [join(pkgRoot, 'node_modules')],
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    })
    renderer = (await import(pathToFileURL(out).href)).renderChatMarkdown
  }
  return renderer(text)
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

// ---------------------------------------------------------------- tiny HTML tree
const VOID = new Set(['br', 'hr', 'img', 'input'])
function parseHtml(html, rootChain) {
  // rootChain: the fixed ancestors the chat puts around a Chief message.
  let cur = null
  for (const [tag, cls] of rootChain) {
    const node = { tag, classes: cls ? cls.split(' ') : [], parent: cur, children: [] }
    if (cur) cur.children.push(node)
    cur = node
  }
  const top = cur
  const all = []
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const tag = m[2].toLowerCase()
    if (m[1]) { if (cur !== top && cur.tag === tag) cur = cur.parent; continue }
    const cls = /\sclass="([^"]*)"/.exec(m[3])
    const node = { tag, classes: cls ? cls[1].split(/\s+/).filter(Boolean) : [], parent: cur, children: [] }
    cur.children.push(node)
    all.push(node)
    if (!VOID.has(tag)) cur = node
  }
  return { top, all }
}
const CHIEF_CHAIN = [['html'], ['body'], ['div', 'ot-shell'], ['section', 'ot-chat'], ['div', 'ot-chat-stream'], ['div', 'ot-msg-chief-row'], ['div', 'ot-msg-chief'], ['div', 'ot-md-wrap'], ['div', 'ot-md']]
const find = (tree, pred) => tree.all.filter(pred)
const hasAncestor = (n, tag) => { for (let p = n.parent; p; p = p.parent) if (p.tag === tag) return true; return false }

// ---------------------------------------------------------------- tiny cascade
function parseRules(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let order = 0
  const walk = (body, media) => {
    let i = 0
    while (i < body.length) {
      const open = body.indexOf('{', i)
      if (open < 0) break
      let depth = 1, j = open + 1
      while (j < body.length && depth > 0) { if (body[j] === '{') depth++; else if (body[j] === '}') depth--; j++ }
      const prelude = body.slice(i, open).trim()
      const inner = body.slice(open + 1, j - 1)
      if (prelude.startsWith('@media')) walk(inner, prelude)
      else if (!prelude.startsWith('@')) {
        const decls = {}
        for (const d of inner.split(';')) {
          const k = d.indexOf(':')
          if (k < 0) continue
          let value = d.slice(k + 1).trim()
          const important = /!important$/.test(value)
          if (important) value = value.replace(/\s*!important$/, '')
          decls[d.slice(0, k).trim()] = { value, important }
        }
        for (const selector of prelude.split(',')) rules.push({ selector: selector.trim(), decls, media, order: order++ })
      }
      i = j
    }
  }
  walk(src, null)
  return rules
}
const RULES = parseRules(css)

function mediaApplies(media, width) {
  if (!media) return true
  const max = /\(max-width:\s*(\d+)px\)/.exec(media)
  const min = /\(min-width:\s*(\d+)px\)/.exec(media)
  if (!max && !min) return false // hover / reduced-motion / print: not the default screen
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]))
}

// A compound selector we can decide statically: tag, classes, `*`, `:first-child`, `:last-child`. Anything else
// returns null (= unknown).
function parseCompound(text) {
  const m = /^(\*|[a-zA-Z][a-zA-Z0-9]*)?((?:\.[\w-]+)*)((?::(?:first|last)-child)*)$/.exec(text)
  if (!m) return null
  return {
    tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : '',
    classes: m[2] ? m[2].slice(1).split('.') : [],
    pseudos: m[3] ? m[3].slice(1).split(':') : [],
  }
}
// Text nodes do not count for :first-child / :last-child, and the tiny tree holds elements only.
const pseudoMatches = (name, n) => {
  const siblings = n.parent ? n.parent.children : [n]
  return name === 'first-child' ? siblings[0] === n : siblings[siblings.length - 1] === n
}
const compoundMatches = (c, n) => (!c.tag || c.tag === n.tag) && c.classes.every(k => n.classes.includes(k)) && c.pseudos.every(k => pseudoMatches(k, n))
function matchSelector(selector, node) {
  const parts = selector.replace(/\s*>\s*/g, ' > ').split(/\s+/)
  const compounds = []
  const combinators = []
  for (const p of parts) {
    if (p === '>') { combinators[combinators.length - 1] = '>'; continue }
    if (p === '+' || p === '~') return null
    compounds.push(parseCompound(p))
    combinators.push(' ')
  }
  if (compounds.some(c => !c)) return null
  const step = (idx, n) => {
    if (!n || !compoundMatches(compounds[idx], n)) return false
    if (idx === 0) return true
    if (combinators[idx - 1] === '>') return step(idx - 1, n.parent)
    for (let p = n.parent; p; p = p.parent) if (step(idx - 1, p)) return true
    return false
  }
  if (!step(compounds.length - 1, node)) return false
  return compounds.reduce((s, c) => [s[0] + c.classes.length + c.pseudos.length, s[1] + (c.tag ? 1 : 0)], [0, 0])
}

const INHERITED = new Set(['white-space', 'overflow-wrap', 'word-break', 'font-size'])
const SHORTHAND = { 'overflow-x': 'overflow', 'font-size': 'font' }
const compareKeys = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }
/** Specificity [classes, tags] of `rule` on `node` at a viewport width, or false when the rule does not apply. */
function ruleSpecificity(rule, node, prop, width) {
  if (!mediaApplies(rule.media, width)) return false
  const spec = matchSelector(rule.selector, node)
  if (spec !== null) return spec
  // A selector this helper cannot decide (pseudo-class, attribute, sibling). Skip it when its last compound
  // cannot be this element or it only applies to an interaction state; otherwise fail loudly, because none
  // of the properties checked here may hide behind a selector the helper does not understand.
  const last = rule.selector.split(/[\s>+~]+/).pop()
  const bare = parseCompound(last.replace(/(:[\w-]+(\([^)]*\))?|\[[^\]]*\])+$/, ''))
  if (bare && !compoundMatches(bare, node)) return false
  if (last.includes('[')) return false // attribute selectors: rendered Markdown carries none of these attributes
  if (/:(hover|focus|focus-visible|focus-within|active|disabled|checked)|::/.test(rule.selector)) return false
  assert.fail(`cannot decide whether "${rule.selector}" sets ${prop} on <${node.tag}>; extend the test helper`)
}

/** Declared value that wins for `prop` on `node` at a viewport width; inherited properties walk up. */
function computed(node, prop, width = 1440) {
  let best = null
  for (const rule of RULES) {
    const own = rule.decls[prop]
    const short = SHORTHAND[prop] ? rule.decls[SHORTHAND[prop]] : null
    if (!own && !short) continue
    const spec = ruleSpecificity(rule, node, prop, width)
    if (spec === false) continue
    const decl = own || short
    if (short && !own && prop === 'font-size') assert.fail(`"${rule.selector}" uses the font shorthand on <${node.tag}>`)
    const value = own ? own.value : short.value.split(/\s+/)[0]
    const key = [decl.important ? 1 : 0, spec[0], spec[1], rule.order]
    if (!best || compareKeys(key, best.key) > 0) best = { key, value }
  }
  if (best && best.value !== 'inherit') return best.value
  if ((best || INHERITED.has(prop)) && node.parent) return computed(node.parent, prop, width)
  return ''
}

// ---------------------------------------------------------------- margins (Todo #27)
const MARGIN_SIDES = ['top', 'right', 'bottom', 'left']
const expandMargin = (value) => {
  const v = value.split(/\s+/)
  return { top: v[0], right: v[1] ?? v[0], bottom: v[2] ?? v[0], left: v[3] ?? v[1] ?? v[0] }
}
/**
 * The margin declaration that wins on one side of `node`: `margin` and `margin-<side>` compete in one cascade
 * ((!important, specificity, order) decides). Returns { value, rule } or null when no rule sets it.
 */
function marginWinner(node, side, width = 1440) {
  assert.ok(MARGIN_SIDES.includes(side))
  let best = null
  for (const rule of RULES) {
    const long = rule.decls[`margin-${side}`]
    const short = rule.decls.margin
    const logical = Object.keys(rule.decls).filter(k => /^margin-(block|inline)/.test(k))
    if (!long && !short && !logical.length) continue
    const spec = ruleSpecificity(rule, node, `margin-${side}`, width)
    if (spec === false) continue
    assert.deepEqual(logical, [], `"${rule.selector}" sets a logical margin on <${node.tag}>; extend the test helper`)
    assert.ok(!(long && short), `"${rule.selector}" sets margin and margin-${side} together; extend the test helper`)
    const decl = long || short
    const value = long ? long.value : expandMargin(short.value)[side]
    const key = [decl.important ? 1 : 0, spec[0], spec[1], rule.order]
    if (!best || compareKeys(key, best.key) > 0) best = { key, value, rule }
  }
  return best
}
/** Used margin of one side in px; margins are not inherited, so no winner means 0. */
function marginPx(node, side, width = 1440) {
  const won = marginWinner(node, side, width)
  if (!won) return 0
  if (won.value === '0') return 0
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(won.value)
  assert.ok(m, `margin-${side} of <${node.tag}> is "${won.value}" (from "${won.rule.selector}"); expected a px length`)
  return Number(m[1])
}
/**
 * Vertical distance between the border box of the previous / next sibling of the table container and the
 * border box of the <table> inside it. The container is a scroll container (`overflow-x: auto`), which makes it
 * a block formatting context: the table's own margins stay inside it and ADD to the container's margin, while
 * the container's margin collapses with the neighbouring sibling's margin (the larger one wins).
 */
function tableGap(table, where, width) {
  const box = table.parent
  assert.equal(computed(box, 'overflow-x', width), 'auto', 'the container is a scroll container, so margins inside it do not collapse through')
  const siblings = box.parent.children
  const i = siblings.indexOf(box)
  if (where === 'above') {
    const prev = siblings[i - 1]
    return Math.max(prev ? marginPx(prev, 'bottom', width) : 0, marginPx(box, 'top', width)) + marginPx(table, 'top', width)
  }
  const next = siblings[i + 1]
  return Math.max(next ? marginPx(next, 'top', width) : 0, marginPx(box, 'bottom', width)) + marginPx(table, 'bottom', width)
}

const F = '```'
// The line the user reported, as the Chief wrote it in the chat.
const REPORTED = "const mine = changelog.split('').find(sec => sec.startsWith(`## [${pkg.version}]`))\nassert.match(mine, /检测到重复输出/)"
const LONG_URL = `https://example.com/${'a'.repeat(100)}`
const WIDTHS = [1440, 390] // desktop and phone; the phone width is below every mobile breakpoint in styles.css

test('helper sanity: the cascade resolver reads the existing human bubble and inline code rules', async () => {
  const human = { tag: 'div', classes: ['ot-msg-human'], parent: null, children: [] }
  for (const w of WIDTHS) assert.equal(computed(human, 'white-space', w), 'pre-wrap', 'user bubble keeps pre-wrap')
  assert.equal(LONG_URL.length, 120)
})

test('fenced code block: the reported long line wraps inside the bubble', async () => {
  const html = await renderChatMarkdown(`${F}js\n${REPORTED}\n${F}`)
  assert.match(html, /<pre><code class="language-js">/, 'real render output is <pre><code>')
  assert.match(html, /const mine = changelog\.split\(/)
  assert.match(html, /\)\)\nassert\.match\(mine/, 'the line break between the two statements is kept in the markup')
  const tree = parseHtml(html, CHIEF_CHAIN)
  const [pre] = find(tree, n => n.tag === 'pre')
  const [code] = find(tree, n => n.tag === 'code')
  assert.ok(pre && code && code.parent === pre)
  for (const w of WIDTHS) {
    assert.equal(computed(pre, 'white-space', w), 'pre-wrap', `<pre> wraps at ${w}px`)
    assert.equal(computed(code, 'white-space', w), 'pre-wrap', `<pre><code> wraps at ${w}px (not the nowrap of inline code)`)
    assert.equal(computed(pre, 'max-width', w), '100%', `<pre> never exceeds the bubble at ${w}px`)
    assert.equal(computed(pre, 'overflow-x', w), 'auto', `<pre> scrolls inside itself as a second line of defence at ${w}px`)
  }
})

test('fenced code block: a 120 character URL without spaces can break', async () => {
  const html = await renderChatMarkdown(`${F}\n${LONG_URL}\n${F}`)
  const tree = parseHtml(html, CHIEF_CHAIN)
  const [pre] = find(tree, n => n.tag === 'pre')
  const [code] = find(tree, n => n.tag === 'code')
  for (const w of WIDTHS) {
    assert.equal(computed(pre, 'overflow-wrap', w), 'anywhere')
    assert.equal(computed(code, 'overflow-wrap', w), 'anywhere')
    assert.notEqual(computed(code, 'word-break', w), 'keep-all')
  }
})

test('fenced code block inside a list item keeps its lines and wraps', async () => {
  const html = await renderChatMarkdown(`- 第一步\n  ${F}sh\n  npm test\n  npm run harness:check\n  ${F}\n- 第二步`)
  const tree = parseHtml(html, CHIEF_CHAIN)
  const [code] = find(tree, n => n.tag === 'code')
  assert.ok(code && code.parent.tag === 'pre' && hasAncestor(code, 'li'))
  for (const w of WIDTHS) {
    assert.equal(computed(code, 'white-space', w), 'pre-wrap', '`.ot-md li code` must not flatten a code block')
    assert.notEqual(computed(code, 'word-break', w), 'keep-all')
  }
})

test('code block text is not smaller than the existing small type size, on phones too', async () => {
  const html = await renderChatMarkdown(`${F}\nx\n${F}`)
  const tree = parseHtml(html, CHIEF_CHAIN)
  const [code] = find(tree, n => n.tag === 'code')
  for (const w of WIDTHS) assert.equal(computed(code, 'font-size', w), 'var(--ot-fs-xs)')
})

test('inline code in paragraphs and list items is unchanged', async () => {
  const html = await renderChatMarkdown('行内 `npm run harness:check` 结束。\n\n- 列表 `dist/client.mjs`')
  assert.doesNotMatch(html, /<pre>/)
  const tree = parseHtml(html, CHIEF_CHAIN)
  const codes = find(tree, n => n.tag === 'code')
  assert.deepEqual(codes.map(c => c.parent.tag), ['p', 'li'])
  for (const code of codes) for (const w of WIDTHS) {
    assert.equal(computed(code, 'white-space', w), 'normal')
    assert.equal(computed(code, 'overflow-wrap', w), 'anywhere')
    assert.equal(computed(code, 'word-break', w), 'keep-all')
  }
})

test('tables: wrapped in a container that scrolls inside the bubble, and code in cells can wrap', async () => {
  const html = await renderChatMarkdown('| 文件 | 命令 |\n|---|---|\n| src/client/styles.css | `npm run harness:check && npm test` |')
  const tree = parseHtml(html, CHIEF_CHAIN)
  const [table] = find(tree, n => n.tag === 'table')
  assert.ok(table, 'table rendered')
  assert.ok(table.parent.tag === 'div' && table.parent.classes.includes('ot-md-table'), 'table sits in .ot-md-table')
  assert.equal((html.match(/<table/g) || []).length, (html.match(/class="ot-md-table"/g) || []).length)
  assert.equal((html.match(/<\/table>\s*<\/div>/g) || []).length, 1)
  const [cellCode] = find(tree, n => n.tag === 'code')
  assert.ok(hasAncestor(cellCode, 'td'))
  for (const w of WIDTHS) {
    assert.equal(computed(table.parent, 'overflow-x', w), 'auto')
    assert.equal(computed(table.parent, 'max-width', w), '100%')
    assert.equal(computed(cellCode, 'white-space', w), 'normal', 'inline code in a table cell wraps')
    assert.equal(computed(cellCode, 'overflow-wrap', w), 'anywhere')
  }
  // A table written inside a code block stays text.
  const fenced = await renderChatMarkdown(`${F}html\n<table><tr><td>x</td></tr></table>\n${F}`)
  assert.doesNotMatch(fenced, /ot-md-table/)
})

// ---------------------------------------------------------------- Todo #27: table spacing
const TABLE_MD = '| 文件 | 命令 |\n|---|---|\n| src/client/styles.css | `npm run harness:check && npm test` |'

test('helper sanity: margin shorthand, longhand and :first-child are resolved like a browser does', async () => {
  assert.deepEqual(expandMargin('1px'), { top: '1px', right: '1px', bottom: '1px', left: '1px' })
  assert.deepEqual(expandMargin('1px 2px'), { top: '1px', right: '2px', bottom: '1px', left: '2px' })
  assert.deepEqual(expandMargin('1px 2px 3px'), { top: '1px', right: '2px', bottom: '3px', left: '2px' })
  assert.deepEqual(expandMargin('1px 2px 3px 4px'), { top: '1px', right: '2px', bottom: '3px', left: '4px' })
  const tree = parseHtml(await renderChatMarkdown('第一段\n\n第二段\n\n第三段'), CHIEF_CHAIN)
  const [first, middle, last] = find(tree, n => n.tag === 'p')
  for (const w of WIDTHS) {
    assert.equal(marginPx(middle, 'top', w), 0)
    assert.equal(marginPx(middle, 'bottom', w), 8, '`.ot-md p { margin: 0 0 8px }`')
    assert.equal(marginPx(first, 'bottom', w), 8)
    assert.equal(marginPx(last, 'bottom', w), 0, '`.ot-md > *:last-child` (0,2,0) beats `.ot-md p` (0,1,1)')
    assert.equal(marginWinner(last, 'bottom', w).rule.selector, '.ot-md > *:last-child')
  }
})

test('table between two paragraphs: 8px above and 8px below, the container and the table do not both add a margin', async () => {
  const html = await renderChatMarkdown(`上一段文字。\n\n${TABLE_MD}\n\n下一段文字。`)
  const tree = parseHtml(html, CHIEF_CHAIN)
  const [table] = find(tree, n => n.tag === 'table')
  const box = table.parent
  assert.ok(box.classes.includes('ot-md-table'))
  assert.deepEqual(box.parent.children.map(n => n.tag), ['p', 'div', 'p'])
  for (const w of WIDTHS) {
    assert.equal(marginPx(table, 'top', w), 0, `<table> inside the container has no top margin at ${w}px`)
    assert.equal(marginPx(table, 'bottom', w), 0, `<table> inside the container has no bottom margin at ${w}px`)
    assert.equal(marginPx(box, 'top', w), 8, `the container carries the 8px top margin at ${w}px`)
    assert.equal(marginPx(box, 'bottom', w), 8, `the container carries the 8px bottom margin at ${w}px`)
    assert.equal(tableGap(table, 'above', w), 8, `paragraph → table distance at ${w}px`)
    assert.equal(tableGap(table, 'below', w), 8, `table → paragraph distance at ${w}px`)
    // The winner is decided without !important.
    for (const side of ['top', 'bottom']) assert.equal(marginWinner(table, side, w).key[0], 0, 'no !important')
    assert.equal(marginPx(table, 'left', w), 0)
    assert.equal(marginPx(table, 'right', w), 0)
  }
})

test('a message that is only a table starts and ends flush, like a message that is only a paragraph', async () => {
  const tree = parseHtml(await renderChatMarkdown(TABLE_MD), CHIEF_CHAIN)
  const [table] = find(tree, n => n.tag === 'table')
  assert.deepEqual(table.parent.parent.children.map(n => n.tag), ['div'])
  for (const w of WIDTHS) {
    assert.equal(tableGap(table, 'above', w), 0, `no space above the table at ${w}px`)
    assert.equal(tableGap(table, 'below', w), 0, `no space below the table at ${w}px`)
  }
})

test('wide table: still scrolls inside its container, and the other table styles are unchanged', async () => {
  const tree = parseHtml(await renderChatMarkdown(`上一段文字。\n\n${TABLE_MD}`), CHIEF_CHAIN)
  const [table] = find(tree, n => n.tag === 'table')
  const [th] = find(tree, n => n.tag === 'th')
  const cells = find(tree, n => n.tag === 'td')
  assert.equal(cells.length, 2)
  for (const w of WIDTHS) {
    assert.equal(computed(table.parent, 'overflow-x', w), 'auto', 'second line of defence: the container scrolls')
    assert.equal(computed(table.parent, 'max-width', w), '100%')
    assert.equal(computed(table, 'width', w), '100%')
    assert.equal(computed(table, 'border-collapse', w), 'collapse')
    assert.equal(computed(table, 'font-size', w), 'var(--ot-fs-xs)')
    assert.equal(computed(th, 'white-space', w), 'nowrap', 'first column does not wrap, so a long first column needs the container')
    assert.equal(computed(cells[0], 'white-space', w), 'nowrap')
    assert.notEqual(computed(cells[1], 'white-space', w), 'nowrap')
    for (const cell of [th, ...cells]) {
      assert.equal(computed(cell, 'border-bottom', w), '1px solid var(--ot-border-soft)')
      assert.equal(computed(cell, 'text-align', w), 'left')
      assert.equal(computed(cell, 'vertical-align', w), 'top')
    }
    assert.equal(computed(cells[1], 'padding', w), '6px 8px')
    assert.equal(computed(cells[0], 'padding-left', w), '0', 'first column keeps padding-left: 0')
  }
})

test('a table without the container (file preview in the project page) keeps its own 8px margin', () => {
  // ProjectWorkspace renders Markdown with plain marked, so its tables are direct children of `.ot-md`.
  const md = { tag: 'div', classes: ['ot-md', 'ot-preview-md'], parent: null, children: [] }
  const mk = tag => { const n = { tag, classes: [], parent: md, children: [] }; md.children.push(n); return n }
  mk('p'); const table = mk('table'); mk('p')
  for (const w of WIDTHS) {
    assert.equal(marginPx(table, 'top', w), 8)
    assert.equal(marginPx(table, 'bottom', w), 8)
  }
})

test('no margin declaration of the chat Markdown rules is dead: each one wins on some element', async () => {
  // The bug of Todo #27 was a declaration that could never win (same specificity as a later rule). Every
  // margin declaration of a rule written for `.ot-md` content must decide the margin of at least one element
  // of a message that uses every kind of block.
  const full = `### 标题\n\n段落 \`code\`\n\n- 列表\n- 列表\n\n1. 有序\n\n${F}js\nconst a = 1\n${F}\n\n${TABLE_MD}\n\n#### 小标题\n\n结尾`
  const trees = [parseHtml(await renderChatMarkdown(full), CHIEF_CHAIN), parseHtml(await renderChatMarkdown(TABLE_MD), CHIEF_CHAIN)]
  // plus one table that is a direct child of `.ot-md` (file preview)
  const bare = parseHtml('<p>x</p><table><tr><td>x</td></tr></table><p>y</p>', CHIEF_CHAIN)
  trees.push(bare)
  const nodes = trees.flatMap(t => t.all)
  const checked = []
  for (const rule of RULES) {
    if (!rule.selector.startsWith('.ot-md') || rule.media) continue
    const sides = MARGIN_SIDES.filter(side => rule.decls.margin || rule.decls[`margin-${side}`])
    if (!sides.length) continue
    const targets = nodes.filter(n => matchSelector(rule.selector, n))
    assert.ok(targets.length, `fixture has an element for "${rule.selector}"`)
    const wins = sides.filter(side => targets.some(n => marginWinner(n, side).rule === rule))
    assert.ok(wins.length, `"${rule.selector}" sets a margin that never takes effect: a rule with the same or higher specificity always overrides it`)
    checked.push(rule.selector)
  }
  for (const expected of ['.ot-md p', '.ot-md pre', '.ot-md table', '.ot-md-table', '.ot-md > *:first-child']) {
    assert.ok(checked.includes(expected), `checked ${expected}`)
  }
  assert.ok(checked.some(sel => /\.ot-md-table > table$/.test(sel)), 'checked the rule that resets the table margin inside the container')
})

test('release: shipped bundle carries the rules, versions agree, changelog describes the fix once', () => {
  const dist = read('dist/client.mjs')
  assert.ok(/\.ot-md pre \{[^}]*white-space: pre-wrap/.test(dist), 'dist/client.mjs has the .ot-md pre rule')
  assert.ok(/\.ot-md pre code \{[^}]*white-space: inherit/.test(dist), 'dist/client.mjs has the .ot-md pre code rule')
  assert.ok(dist.includes('ot-md-table'), 'dist/client.mjs has the table container')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(JSON.parse(read('contracts/plugin.json')).description.includes(`v${pkg.version}`))
  // Located by wording, not by version number: later releases may sit above this entry.
  const sections = read('CHANGELOG.md').split(/^(?=## \[)/m).filter(sec => /fenced code block/i.test(sec) && /swiped sideways/i.test(sec))
  assert.equal(sections.length, 1, 'exactly one changelog section describes this fix')
})

test('release (Todo #27): shipped bundle resolves the table margin the same way, changelog describes it once', () => {
  // Same cascade check against the stylesheet text that is inside dist/client.mjs.
  const dist = read('dist/client.mjs')
  const order = sel => {
    const at = dist.indexOf(`${sel} {`)
    assert.ok(at >= 0, `dist/client.mjs has "${sel}"`)
    return at
  }
  const reset = RULES.find(r => /\.ot-md-table > table$/.test(r.selector) && r.decls.margin)
  assert.ok(reset, 'source has the reset rule')
  order(reset.selector)
  order('.ot-md table')
  const spec = sel => matchSelector(sel, parseHtml('<div class="ot-md-table"><table></table></div>', CHIEF_CHAIN).all[1])
  const a = spec(reset.selector), b = spec('.ot-md table')
  assert.ok(a && b)
  const cmp = compareKeys([...a, order(reset.selector)], [...b, order('.ot-md table')])
  assert.ok(cmp > 0, 'in the shipped stylesheet the reset rule beats `.ot-md table`')
  const sections = read('CHANGELOG.md').split(/^(?=## \[)/m).filter(sec => /table/i.test(sec) && /16px/.test(sec) && /8px/.test(sec))
  assert.equal(sections.length, 1, 'exactly one changelog section describes this fix')
})
