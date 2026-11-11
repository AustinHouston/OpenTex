// Comments, Word-style. The .tex files stay untouched: every comment lives in
// comments.opentex.json in the project folder, anchored to its text by
//   - the commented text itself (empty for a comment at a single point),
//   - ~40 characters before and after it, and
//   - its last known position.
// Inside OpenTex the anchors are tracked live through every edit (a CodeMirror field that maps
// the ranges through each change) and written back when the file is saved. When a file changes
// outside OpenTex, the anchors are matched again by text; a comment whose text can't be found is
// "detached" and can be re-linked by selecting its new spot.

import { EditorState, RangeSet, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view'

export const COMMENTS_FILE = 'comments.opentex.json'
const CONTEXT = 40

export interface Reply {
  author: string
  date: string
  text: string
}

export interface Thread {
  id: string
  file: string
  quote: string
  prefix: string
  suffix: string
  pos: number
  author: string
  date: string
  text: string
  replies: Reply[]
  resolved: boolean
}

export interface StoreFile {
  version: 1
  threads: Thread[]
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Anchor data for the range from..to in text. */
export function anchorAt(text: string, from: number, to: number): Pick<Thread, 'quote' | 'prefix' | 'suffix' | 'pos'> {
  return { quote: text.slice(from, to), prefix: text.slice(Math.max(0, from - CONTEXT), from), suffix: text.slice(to, to + CONTEXT), pos: from }
}

/** How many characters agree, counting from the end (for text before) or the start (for text after). */
function agreeEnd(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}
function agreeStart(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

function contextScore(text: string, from: number, to: number, t: Thread): number {
  return agreeEnd(t.prefix, text.slice(Math.max(0, from - CONTEXT), from)) + agreeStart(t.suffix, text.slice(to, to + CONTEXT))
}

/** Find where a thread belongs in text, or null if it can't be found. */
export function locate(text: string, t: Thread): { from: number; to: number } | null {
  if (t.quote) {
    // 1. Still exactly where it was.
    if (text.startsWith(t.quote, t.pos)) return { from: t.pos, to: t.pos + t.quote.length }
    // 2. The same text elsewhere: pick the copy whose surroundings match best (ties: closest to the old spot).
    let best: { from: number; score: number } | null = null
    let count = 0
    for (let i = text.indexOf(t.quote); i >= 0 && count < 500; i = text.indexOf(t.quote, i + 1), count++) {
      const score = contextScore(text, i, i + t.quote.length, t) * 1000 - Math.min(999, Math.abs(i - t.pos) / 100)
      if (!best || score > best.score) best = { from: i, score }
    }
    // Short or very common quotes need some matching context to be trusted.
    if (best && (count === 1 ? t.quote.trim().length >= 3 || best.score >= 6000 : best.score >= 6000)) return { from: best.from, to: best.from + t.quote.length }
    // 3. Same words, different line breaks or spacing.
    const words = t.quote.split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g')
      let m: RegExpExecArray | null
      let bestRe: { from: number; to: number; score: number } | null = null
      while ((m = re.exec(text))) {
        const score = contextScore(text, m.index, m.index + m[0].length, t)
        if (!bestRe || score > bestRe.score) bestRe = { from: m.index, to: m.index + m[0].length, score }
      }
      if (bestRe) return { from: bestRe.from, to: bestRe.to }
    }
    return null
  }
  // A comment at a single point: find the place where its before/after text meet.
  const joined = t.prefix + t.suffix
  if (joined.length >= 12) {
    const i = text.indexOf(joined)
    if (i >= 0) return { from: i + t.prefix.length, to: i + t.prefix.length }
  }
  for (const [needle, after] of [
    [t.prefix.slice(-24), true],
    [t.suffix.slice(0, 24), false]
  ] as const) {
    if (needle.trim().length < 10) continue
    const i = text.indexOf(needle)
    if (i >= 0) {
      const at = after ? i + needle.length : i
      return { from: at, to: at }
    }
  }
  return null
}

// ---------- Editor highlights ----------

export interface Placed {
  id: string
  from: number
  to: number
  resolved: boolean
}

export const setComments = StateEffect.define<Placed[]>()

class PointWidget extends WidgetType {
  constructor(readonly id: string, readonly resolved: boolean) {
    super()
  }
  eq(o: PointWidget): boolean {
    return o.id === this.id && o.resolved === this.resolved
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = `cm-ot-cpoint${this.resolved ? ' resolved' : ''}`
    s.dataset.cid = this.id
    s.title = 'Comment'
    s.innerHTML = '<svg viewBox="0 0 20 20"><path d="M3.5 4.5h13v9h-7l-4 3v-3h-2z"/></svg>'
    return s
  }
  ignoreEvent(): boolean {
    return false
  }
}

function deco(p: Placed) {
  const spec = { cid: p.id, resolved: p.resolved }
  if (p.from === p.to) return Decoration.widget({ widget: new PointWidget(p.id, p.resolved), side: 1, ...spec }).range(p.from)
  return Decoration.mark({ class: p.resolved ? 'cm-ot-cmt resolved' : 'cm-ot-cmt', attributes: { 'data-cid': p.id }, inclusiveStart: false, inclusiveEnd: false, ...spec }).range(p.from, p.to)
}

export const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr: Transaction) {
    set = set.map(tr.changes)
    for (const e of tr.effects) if (e.is(setComments)) set = RangeSet.of(e.value.map(deco), true)
    return set
  },
  provide: (f) => EditorView.decorations.from(f)
})

/** Current positions of the comments in an editor state. Comments whose text was deleted are gone. */
export function placedIn(state: EditorState): Placed[] {
  const out: Placed[] = []
  const set = state.field(commentField, false)
  if (!set) return out
  const iter = set.iter()
  while (iter.value) {
    const spec = iter.value.spec as { cid: string; resolved: boolean }
    out.push({ id: spec.cid, from: iter.from, to: iter.to, resolved: spec.resolved })
    iter.next()
  }
  return out
}

/** Clicking a highlighted passage or a point marker reports which comment it is. */
export function commentClicks(onClick: (id: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cid]')
      if (el && (el.classList.contains('cm-ot-cpoint') || e.detail === 1)) setTimeout(() => onClick(el.dataset.cid!), 0)
      return false
    }
  })
}
