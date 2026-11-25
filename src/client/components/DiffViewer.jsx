import React, { useMemo, useRef, useState } from 'react'
import { parseDiffHunk } from '../diff-parse.js'
import { CaretDown, CaretRight, FilePlus, FileText, FileMinus, TextAlignLeft, ArrowsInLineVertical, ArrowsOutLineVertical } from '@phosphor-icons/react'

function fileStatus(d) {
  const h = String(d.hunk || '')
  if (/^@@ -0,0 /m.test(h)) return 'added'
  if (/^@@ -\d+(?:,\d+)? \+0,0 /m.test(h)) return 'deleted'
  return 'modified'
}

function splitPath(p) {
  const s = String(p || '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? { dir: s.slice(0, i + 1), name: s.slice(i + 1) } : { dir: '', name: s }
}

function ChangeBar({ additions, deletions }) {
  const total = additions + deletions
  const blocks = 5
  const addBlocks = total ? Math.round((additions / total) * blocks) : 0
  const delBlocks = total ? Math.min(blocks - addBlocks, Math.round((deletions / total) * blocks)) : 0
  return (
    <span className="ek-diff-bar" aria-hidden="true">
      {Array.from({ length: blocks }).map((_, i) => (
        <i key={i} className={i < addBlocks ? 'is-add' : i < addBlocks + delBlocks ? 'is-del' : ''} />
      ))}
    </span>
  )
}

const STATUS_META = {
  added: { label: '新增', Icon: FilePlus },
  deleted: { label: '删除', Icon: FileMinus },
  modified: { label: '修改', Icon: FileText },
}

export function DiffViewer({ diffs = [] }) {
  const files = useMemo(() => diffs.map((d, idx) => ({
    ...d,
    idx,
    additions: Number(d.additions || 0),
    deletions: Number(d.deletions || 0),
    status: fileStatus(d),
  })), [diffs])
  const [collapsed, setCollapsed] = useState(() => {
    const init = {}
    files.forEach((f, i) => { init[f.idx] = i >= 3 })
    return init
  })
  const [wrap, setWrap] = useState(false)
  const refs = useRef({})

  const totals = files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 })
  const allCollapsed = files.every(f => collapsed[f.idx])

  const jumpTo = idx => {
    setCollapsed(c => ({ ...c, [idx]: false }))
    requestAnimationFrame(() => refs.current[idx]?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  if (!files.length) {
    return <div className="ek-diff-empty">当前工作树暂无代码差异。</div>
  }

  return (
    <div className={`ek-diff ${wrap ? 'is-wrap' : ''}`} data-testid="diff-viewer">
      <div className="ek-diff-toolbar">
        <span className="ek-diff-summary">
          <strong>{files.length}</strong> 个文件
          <span className="ek-diff-num is-add">+{totals.add}</span>
          <span className="ek-diff-num is-del">−{totals.del}</span>
        </span>
        <span className="ek-diff-tools">
          <button type="button" className="ot-btn ot-btn--sm" onClick={() => setWrap(w => !w)} aria-pressed={wrap} title="长行自动换行">
            <TextAlignLeft size={13} />
            <span>{wrap ? '取消换行' : '自动换行'}</span>
          </button>
          <button
            type="button"
            className="ot-btn ot-btn--sm"
            onClick={() => setCollapsed(Object.fromEntries(files.map(f => [f.idx, !allCollapsed])))}
          >
            {allCollapsed ? <ArrowsOutLineVertical size={13} /> : <ArrowsInLineVertical size={13} />}
            <span>{allCollapsed ? '全部展开' : '全部收起'}</span>
          </button>
        </span>
      </div>

      <nav className="ek-diff-index" aria-label="变更文件">
        {files.map(f => {
          const { dir, name } = splitPath(f.path)
          const meta = STATUS_META[f.status]
          return (
            <button key={f.idx} type="button" className="ek-diff-index-row" onClick={() => jumpTo(f.idx)} title={f.path}>
              <meta.Icon size={13} className={`ek-diff-status is-${f.status}`} />
              <span className="ek-diff-index-path"><span className="ek-diff-dir">{dir}</span>{name}</span>
              <span className="ek-diff-num is-add">+{f.additions}</span>
              <span className="ek-diff-num is-del">−{f.deletions}</span>
            </button>
          )
        })}
      </nav>

      {files.map(f => {
        const isCollapsed = Boolean(collapsed[f.idx])
        const { dir, name } = splitPath(f.path)
        const meta = STATUS_META[f.status]
        return (
          <section key={f.idx} className="ek-diff-file" ref={el => { refs.current[f.idx] = el }} data-testid="diff-file-card">
            <button
              type="button"
              className="ek-diff-file-head"
              onClick={() => setCollapsed(c => ({ ...c, [f.idx]: !isCollapsed }))}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <CaretRight size={12} /> : <CaretDown size={12} />}
              <span className={`ek-diff-badge is-${f.status}`}>{meta.label}</span>
              <span className="ek-diff-path" title={f.path}><span className="ek-diff-dir">{dir}</span><strong>{name}</strong></span>
              <span className="ek-diff-file-stat">
                <span className="ek-diff-num is-add">+{f.additions}</span>
                <span className="ek-diff-num is-del">−{f.deletions}</span>
                <ChangeBar additions={f.additions} deletions={f.deletions} />
              </span>
            </button>
            {!isCollapsed && (f.generated || f.hunkOmitted || !f.hunk
              ? <div className="ek-diff-skip">{f.generated ? '生成或压缩文件，差异不展示' : f.hunkOmitted ? '正在加载差异…' : '无可展示的差异'}</div>
              : <DiffTable hunk={f.hunk} />)}
          </section>
        )
      })}
    </div>
  )
}

function DiffTable({ hunk }) {
  const rows = useMemo(() => parseDiffHunk(hunk), [hunk])
  return (
    <div className="ek-diff-scroll">
      <table className="ek-diff-table">
        <tbody>
          {rows.map((r, i) => {
            if (r.type === 'hunk') {
              return (
                <tr key={i} className="ek-row-hunk">
                  <td className="ek-ln" colSpan={2} />
                  <td className="ek-code" colSpan={2}>{r.text.replace(/^(@@[^@]+@@).*$/, '$1')}{r.ctx ? <span className="ek-hunk-ctx">{r.ctx}</span> : null}</td>
                </tr>
              )
            }
            if (r.type === 'note') {
              return (
                <tr key={i} className="ek-row-note">
                  <td className="ek-ln" colSpan={2} />
                  <td className="ek-code" colSpan={2}>{r.text}</td>
                </tr>
              )
            }
            return (
              <tr key={i} className={`ek-row-${r.type}`}>
                <td className="ek-ln">{r.oldNo ?? ''}</td>
                <td className="ek-ln">{r.newNo ?? ''}</td>
                <td className="ek-sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}</td>
                <td className="ek-code">{r.text || ' '}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
