// Comments live inside the .tex source as special LaTeX comment lines, so they travel with the
// file (email, Dropbox, git), survive edits in any editor, and never reach the PDF:
//
//   %@comment[Austin Houston, 2026-11-11]: Is this the right reference?
//   %@reply[Jane Doe, 2026-11-12]: Fixed, thanks.
//   %@resolved
//   The line being commented on comes right after the thread.

import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'

export interface CommentEntry {
  author: string
  date: string
  text: string
  line: number
}
export interface CommentThread extends CommentEntry {
  file: string
  endLine: number // last line of the thread (replies / resolved marker)
  replies: CommentEntry[]
  resolved: boolean
  indent: string
  context: string // the line the thread is attached to
}

const ENTRY = /^(\s*)%@(comment|reply)\[([^\],]*)(?:,\s*([^\]]*))?\]:\s?(.*)$/
const RESOLVED = /^\s*%@resolved\b/

export function parseComments(text: string, file: string): CommentThread[] {
  const lines = text.split('\n')
  const out: CommentThread[] = []
  let cur: CommentThread | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = l.match(ENTRY)
    if (m && m[2] === 'comment') {
      cur = { file, line: i + 1, endLine: i + 1, indent: m[1], author: m[3].trim(), date: (m[4] ?? '').trim(), text: m[5], replies: [], resolved: false, context: '' }
      out.push(cur)
    } else if (cur && m && m[2] === 'reply') {
      cur.replies.push({ author: m[3].trim(), date: (m[4] ?? '').trim(), text: m[5], line: i + 1 })
      cur.endLine = i + 1
    } else if (cur && RESOLVED.test(l)) {
      cur.resolved = true
      cur.endLine = i + 1
    } else {
      if (cur) cur.context = l.trim()
      cur = null
    }
  }
  return out
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const cleanName = (s: string): string => s.replace(/[\],\n]/g, ' ').trim()
export const cleanText = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()

export function entryLine(kind: 'comment' | 'reply', author: string, text: string, indent = ''): string {
  return `${indent}%@${kind}[${cleanName(author)}, ${today()}]: ${cleanText(text)}`
}

/** Editor styling: comment threads get a tinted card look; the commented line gets a margin bar. */
export const commentHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const doc = view.state.doc
      const b = new RangeSetBuilder<Decoration>()
      if (!doc.toString().includes('%@')) return b.finish()
      const threads = parseComments(doc.toString(), '')
      for (const t of threads) {
        const cls = t.resolved ? 'ot-c-line ot-c-resolved' : 'ot-c-line'
        for (let n = t.line; n <= t.endLine; n++) {
          const line = doc.line(n)
          b.add(line.from, line.from, Decoration.line({ class: cls + (n === t.line ? ' ot-c-first' : '') + (n === t.endLine ? ' ot-c-last' : '') }))
          const head = line.text.match(/^\s*%@(?:comment|reply)\[[^\]]*\]:|^\s*%@resolved/)
          if (head) b.add(line.from, line.from + head[0].length, Decoration.mark({ class: 'ot-c-head' }))
        }
        if (!t.resolved && t.endLine < doc.lines) {
          const target = doc.line(t.endLine + 1)
          b.add(target.from, target.from, Decoration.line({ class: 'ot-c-target' }))
        }
      }
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)
