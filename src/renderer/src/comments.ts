// Comments live inside the .tex source as special LaTeX comment lines, so they travel with the
// file (email, Dropbox, git), survive edits in any editor, and never reach the PDF:
//
//   %@comment[Austin Houston, 2026-11-11]{the quoted text}: Is this the right reference?
//   %@reply[Jane Doe, 2026-11-12]: Fixed, thanks.
//   %@resolved
//   The line being commented on comes right after the thread. The {quoted text} part is
//   optional; when present, that text is highlighted in the lines below the thread.

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
  targetLine: number // the line the thread is about: the first non-comment line below it
  replies: CommentEntry[]
  resolved: boolean
  indent: string
  context: string // the line the thread is attached to
  quote: string // selected text the comment is about ('' if none)
}

const ENTRY = /^(\s*)%@(comment|reply)\[([^\],]*)(?:,\s*([^\]]*))?\](?:\{([^}]*)\})?:\s?(.*)$/
const RESOLVED = /^\s*%@resolved\b/

export function parseComments(text: string, file: string): CommentThread[] {
  const lines = text.split('\n')
  const out: CommentThread[] = []
  let cur: CommentThread | null = null
  let stacked: CommentThread[] = [] // consecutive threads all belong to the next ordinary line
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = l.match(ENTRY)
    if (m && m[2] === 'comment') {
      cur = { file, line: i + 1, endLine: i + 1, targetLine: i + 2, indent: m[1], author: m[3].trim(), date: (m[4] ?? '').trim(), quote: (m[5] ?? '').trim(), text: m[6], replies: [], resolved: false, context: '' }
      out.push(cur)
      stacked.push(cur)
    } else if (cur && m && m[2] === 'reply') {
      cur.replies.push({ author: m[3].trim(), date: (m[4] ?? '').trim(), text: m[6], line: i + 1 })
      cur.endLine = i + 1
    } else if (cur && RESOLVED.test(l)) {
      cur.resolved = true
      cur.endLine = i + 1
    } else {
      for (const t of stacked) {
        t.context = l.trim()
        t.targetLine = i + 1
      }
      stacked = []
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

/** Selected text stored with a comment: one line, no braces, at most 160 characters. */
export const cleanQuote = (s: string): string => s.replace(/[{}%]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)

export function entryLine(kind: 'comment' | 'reply', author: string, text: string, indent = '', quote = ''): string {
  const q = quote ? `{${cleanQuote(quote)}}` : ''
  return `${indent}%@${kind}[${cleanName(author)}, ${today()}]${q}: ${cleanText(text)}`
}

/** Find a quote in the text after a thread, letting any run of whitespace (including line breaks) match. */
export function findQuote(text: string, quote: string): [number, number] | null {
  const words = quote.split(' ').filter(Boolean)
  if (!words.length) return null
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'))
  const m = re.exec(text)
  return m ? [m.index, m.index + m[0].length] : null
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
        if (!t.resolved && t.targetLine <= doc.lines) {
          const target = doc.line(t.targetLine)
          b.add(target.from, target.from, Decoration.line({ class: 'ot-c-target' }))
        }
      }
      // Quoted text is highlighted in the lines below its thread (ranges must be added in order).
      const quotes: [number, number][] = []
      for (const t of threads) {
        if (t.resolved || !t.quote || t.targetLine > doc.lines) continue
        const from = doc.line(t.targetLine).from
        const to = doc.line(Math.min(doc.lines, t.targetLine + 30)).to
        const hit = findQuote(doc.sliceString(from, to), t.quote)
        if (hit) quotes.push([from + hit[0], from + hit[1]])
      }
      const all: [number, number, Decoration][] = []
      for (const [a, z] of quotes) all.push([a, z, Decoration.mark({ class: 'cm-ot-quote' })])
      return mergeInOrder(b.finish(), all)
    }
  },
  { decorations: (v) => v.decorations }
)

function mergeInOrder(set: DecorationSet, extra: [number, number, Decoration][]): DecorationSet {
  return extra.length ? set.update({ add: extra.map(([a, z, d]) => d.range(a, z)), sort: true }) : set
}
