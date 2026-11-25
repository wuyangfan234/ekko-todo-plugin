import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { transform } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const pkgRoot = new URL('../', import.meta.url).pathname
const read = path => readFileSync(join(pkgRoot, path), 'utf8')

function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([:\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]))
}

const FORBIDDEN_DRAWING = ['circle', 'ellipse', 'line', 'polygon', 'polyline', 'use', 'text']
const ALLOWED_ELEMENTS = new Set(['svg', 'title', 'desc', 'g', 'path', 'rect'])
const OLD_CHECKMARK = '<path d="M34 52.5L45.5 64L67.5 37.5" stroke="currentColor" stroke-width="11.2"/>'

// Whole-document element lock: geometry checks below only read the group and rect,
// so anything drawn beside them (e.g. the old checkmark as a sibling path) must fail here.
function assertIntervalElementWhitelist(svg) {
  const tags = [...svg.matchAll(/<([a-zA-Z][\w:-]*)\b/g)].map(match => match[1].toLowerCase())
  for (const tag of FORBIDDEN_DRAWING) {
    assert.ok(!tags.includes(tag), `Interval must not contain <${tag}>`)
  }
  for (const tag of tags) {
    assert.ok(ALLOWED_ELEMENTS.has(tag), `Interval contains unexpected element <${tag}>`)
  }
  assert.equal(tags.filter(tag => tag === 'svg').length, 1, 'exactly one <svg> root')
  assert.equal(tags.filter(tag => tag === 'g').length, 1, 'exactly one stroke <g>')
  assert.equal(tags.filter(tag => tag === 'path').length, 2, 'only the two bracket paths are allowed')
  assert.equal(tags.filter(tag => tag === 'rect').length, 1, 'exactly one centre rect')
  const groupBody = svg.match(/<g\b[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? ''
  const outside = svg.replace(/<g\b[^>]*>[\s\S]*?<\/g>/, '')
  assert.equal((groupBody.match(/<path\b/g) || []).length, 2, 'both bracket paths live inside the stroke group')
  assert.equal((outside.match(/<path\b/g) || []).length, 0, 'no path may sit outside the stroke group')
}

function withSiblingCheckmark(svg) {
  const injected = svg.replace('</g>', `</g>${OLD_CHECKMARK}`)
  assert.notEqual(injected, svg, 'mutation must inject the old checkmark')
  return injected
}

function intervalGeometry(svg) {
  assertIntervalElementWhitelist(svg)
  const root = svg.match(/<svg\b([^>]*)>/)
  const group = svg.match(/<g\b([^>]*)>([\s\S]*?)<\/g>/)
  assert.ok(root, 'SVG root is required')
  assert.ok(group, 'Interval brackets must share one stroke group')
  const rects = [...svg.matchAll(/<rect\b([^>]*?)(?:\/>|><\/rect>)/g)].map(match => attributes(match[1]))
  assert.equal(rects.length, 1, 'Interval has exactly one centre rect')
  return {
    viewBox: attributes(root[1]).viewBox,
    group: attributes(group[1]),
    paths: [...group[2].matchAll(/<path\b([^>]*?)(?:\/>|><\/path>)/g)].map(match => attributes(match[1]).d),
    rect: rects[0],
  }
}

const approvedGeometry = {
  viewBox: '0 0 100 100',
  group: {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '8',
    'stroke-linecap': 'square',
    'stroke-linejoin': 'miter',
  },
  paths: ['M33 18H19V82H33', 'M67 18H81V82H67'],
  rect: { x: '43', y: '43', width: '14', height: '14', fill: 'currentColor' },
}

function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature')
  let offset = 8
  let header
  let ended = false
  const compressed = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') header = {
      width: body.readUInt32BE(0),
      height: body.readUInt32BE(4),
      depth: body[8],
      colorType: body[9],
      compression: body[10],
      filter: body[11],
      interlace: body[12],
    }
    else if (type === 'IDAT') compressed.push(body)
    else if (type === 'IEND') { ended = true; break }
  }
  assert.ok(header, 'PNG IHDR is required')
  assert.ok(ended, 'PNG IEND is required')
  assert.equal(header.width, 128)
  assert.equal(header.height, 128)
  assert.equal(header.depth, 8)
  assert.ok(header.colorType === 2 || header.colorType === 6, 'Chromium may export opaque RGB or RGBA')
  assert.equal(header.compression, 0)
  assert.equal(header.filter, 0)
  assert.equal(header.interlace, 0)
  const raw = inflateSync(Buffer.concat(compressed))
  const channels = header.colorType === 6 ? 4 : 3
  const stride = header.width * channels
  const rows = []
  let previous = Buffer.alloc(stride)
  let cursor = 0
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < header.height; y += 1) {
    const mode = raw[cursor]
    cursor += 1
    const row = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const source = raw[cursor]
      cursor += 1
      const left = x >= channels ? row[x - channels] : 0
      const up = previous[x]
      const upperLeft = x >= channels ? previous[x - channels] : 0
      const predictor = mode === 0 ? 0 : mode === 1 ? left : mode === 2 ? up : mode === 3 ? Math.floor((left + up) / 2) : mode === 4 ? paeth(left, up, upperLeft) : -1
      assert.ok(predictor >= 0, `unsupported PNG filter ${mode}`)
      row[x] = (source + predictor) & 255
    }
    rows.push(row)
    previous = row
  }
  assert.equal(cursor, raw.length, 'PNG stream must end after the declared pixels')
  const pixel = (row, x) => {
    const values = [...row.subarray(x * channels, (x + 1) * channels)]
    return channels === 3 ? [...values, 255] : values
  }
  return {
    ...header,
    pixel(x, y) { return pixel(rows[y], x) },
    colors() {
      const colors = new Set()
      for (const row of rows) for (let x = 0; x < header.width; x += 1) colors.add(pixel(row, x).join(','))
      return colors
    },
  }
}

const ink = [25, 28, 25, 255]
const paper = [242, 240, 233, 255]
const sample = (png, x, y) => png.pixel(Math.floor(x * png.width / 100), Math.floor(y * png.height / 100))

test('assets/logo.svg preserves the approved 01 Interval master geometry', () => {
  const master = read('brand/v2/masters/ekko-v2-01.svg')
  const asset = read('assets/logo.svg')
  assert.deepEqual(intervalGeometry(master), approvedGeometry, 'approved archive must remain unchanged')
  assert.deepEqual(intervalGeometry(asset), approvedGeometry)
  assert.doesNotMatch(asset, /<(?:defs|linearGradient|radialGradient|filter|image)\b/)
  assert.match(asset, /<title\b[^>]*>.*间隔.*<\/title>/s)
})

test('logo.svg geometry lock rejects a sibling old checkmark and extra drawing elements', () => {
  const asset = read('assets/logo.svg')
  assert.throws(() => intervalGeometry(withSiblingCheckmark(asset)), /path/)
  for (const tag of FORBIDDEN_DRAWING) {
    const mutated = asset.replace('</g>', `</g><${tag} x="1" y="1"/>`)
    assert.throws(() => intervalGeometry(mutated), new RegExp(`<${tag}>`), `extra <${tag}> must fail`)
  }
})

test('BrandLogo server-renders Interval with currentColor and no gradient elements', async () => {
  const source = read('src/client/components/BrandLogo.jsx')
  const transformed = await transform(source, { loader: 'jsx', jsx: 'automatic', format: 'esm', target: 'node22' })
  const temporary = mkdtempSync(join(pkgRoot, 'tests/.interval-brand-'))
  try {
    const output = join(temporary, 'BrandLogo.mjs')
    writeFileSync(output, transformed.code)
    const { BrandLogo } = await import(pathToFileURL(output).href)
    const markup = renderToStaticMarkup(React.createElement(BrandLogo, { size: 32, className: 'interval-probe' }))
    assert.deepEqual(intervalGeometry(markup), approvedGeometry)
    assert.throws(() => intervalGeometry(withSiblingCheckmark(markup)), /path/, 'sibling old checkmark in rendered markup must fail')
    for (const tag of FORBIDDEN_DRAWING) {
      assert.throws(() => intervalGeometry(markup.replace('</g>', `</g><${tag}></${tag}>`)), new RegExp(`<${tag}>`), `rendered extra <${tag}> must fail`)
    }
    assert.doesNotMatch(markup, /<(?:defs|linearGradient|radialGradient|filter|image)\b|url\(#/)
    assert.match(markup, /width="32"/)
    assert.match(markup, /height="32"/)
    assert.match(markup, /class="interval-probe"/)
    assert.match(markup, /aria-hidden="true"/)
    const defaultMarkup = renderToStaticMarkup(React.createElement(BrandLogo))
    assert.match(defaultMarkup, /width="20"/)
    assert.match(defaultMarkup, /height="20"/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('assets/logo.png is a valid flat paper-tile raster of the Interval geometry', () => {
  const bytes = readFileSync(join(pkgRoot, 'assets/logo.png'))
  assert.ok(bytes.length > 500 && bytes.length < 256000, 'PNG must fit the Studio 256 KB icon limit')
  const png = decodePng(bytes)
  assert.deepEqual(png.pixel(0, 0), paper, 'flat paper tile, not a transparent or gradient squircle')
  for (const [x, y] of [[50, 50], [19, 50], [81, 50], [25, 18], [75, 82]]) {
    assert.deepEqual(sample(png, x, y), ink, `Interval ink at viewBox ${x},${y}`)
  }
  for (const [x, y] of [[50, 20], [35, 50], [65, 50], [5, 5]]) {
    assert.deepEqual(sample(png, x, y), paper, `flat paper negative space at viewBox ${x},${y}`)
  }
  const colors = png.colors()
  assert.ok(colors.size <= 16, `flat export may contain antialiasing, not a gradient: ${colors.size} colors`)
  for (const encoded of colors) {
    const color = encoded.split(',').map(Number)
    assert.equal(color[3], 255, 'paper tile is fully opaque')
    const ratio = (paper[0] - color[0]) / (paper[0] - ink[0])
    assert.ok(ratio >= -0.02 && ratio <= 1.02, 'pixel must stay on the ink/paper color axis')
    for (let channel = 1; channel < 3; channel += 1) {
      const expected = paper[channel] - ratio * (paper[channel] - ink[channel])
      assert.ok(Math.abs(color[channel] - expected) <= 2, 'antialiasing may only blend the two flat brand colors')
    }
  }
})

test('Interval release metadata is aligned across every manifest copy (version derived from package.json)', () => {
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const manifest = JSON.parse(read('plugin.json'))
  const contract = JSON.parse(read('contracts/plugin.json'))
  const version = pkg.version
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const escaped = version.replace(/\./g, '\\.')
  assert.equal(manifest.version, version)
  assert.equal(lock.version, version)
  assert.equal(lock.packages[''].version, version)
  assert.match(contract.description, new RegExp(`v${escaped}\\b`))
  const changelog = read('CHANGELOG.md')
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(match => match[1])
  assert.equal(headings[0], version, 'newest CHANGELOG entry is the package version')
  assert.equal(new Set(headings).size, headings.length, 'CHANGELOG versions are unique')
  // The brand landed in 0.9.17; later releases add their own entries above it, so check that entry, not the newest.
  const brandIdx = headings.indexOf('0.9.17')
  assert.ok(brandIdx >= 0, 'CHANGELOG keeps the 0.9.17 brand release entry')
  const brandEntry = changelog.slice(changelog.indexOf('## [0.9.17]'), changelog.indexOf(`## [${headings[brandIdx + 1]}]`))
  assert.match(brandEntry, /01.*间隔.*Interval/)
  assert.equal((changelog.match(/01 间隔 \/ Interval/g) || []).length, 1, 'only one Interval brand entry')
  assert.deepEqual([
    manifest.icon,
    manifest.views.find(view => view.id === 'chief').icon,
    manifest.navigation.main.find(item => item.viewId === 'chief').icon,
  ], ['assets/logo.png', 'assets/logo.png', 'assets/logo.png'])
})
