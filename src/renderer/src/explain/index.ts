// Plain-English explanations and one-click fixes for the problems list under the editor.
// main.ts calls decorateProblems() after it draws the list, and statusInWords() after a compile.
// The knowledge itself is in rules.ts (messages) and data.ts (packages, symbols, …).
import './explain.css'
import type { Problem } from '../../../shared/types'
import { RULES } from './rules'
import { Ctx, Explanation, ExplainHost, Fix, select, Spot } from './tools'

export type { ExplainHost } from './tools'
export { RULES } from './rules'

const cache = new WeakMap<Problem, Promise<Explanation | null>>()

/** The message without TeX's "LaTeX Error:" / "Package x Error:" / "pkg: " prefix and the "(l.N excerpt)" suffix. */
function core(p: Problem): { text: string; shown: string } {
  const m = p.message.match(/^([\s\S]*?)  \(([\s\S]*)\)$/)
  let text = (m ? m[1] : p.message).trim()
  text = text.replace(/^(?:LaTeX|Package \S+|Class \S+) Error: /, '')
  if (p.severity === 'warning' && !/^(BibTeX|Biber):/.test(text)) text = text.replace(/^[\w.-]+: (?=\S)/, '')
  return { text, shown: m ? m[2].replace(/^\.\.\./, '') : '' }
}

async function build(p: Problem, index: number, all: Problem[], host: ExplainHost, read: (f: string) => Promise<string | null>): Promise<Explanation | null> {
  const { text, shown } = core(p)
  const files = host.files()
  // (macOS doesn't mind the case of file names, so TeX may report Sub.tex for sub.tex.)
  const known = p.file ? (files.includes(p.file) ? p.file : files.find((f) => f.toLowerCase() === p.file!.toLowerCase())) : null
  const file = known ?? (!p.file && p.line ? host.target() : null)
  const src = file ? await read(file) : null
  const lineText = src != null && p.line ? (src.split('\n')[p.line - 1] ?? null) : null
  let col: number | null = null
  if (lineText != null && shown) {
    const i = lineText.indexOf(shown)
    if (i >= 0) col = i + shown.length
  }
  const c: Ctx = { p, host, all, index, file, line: p.line, lineText, shown, col, log: p.context ?? '', read }
  for (const rule of RULES) {
    const m = text.match(rule.match)
    if (!m) continue
    const ex = await rule.explain(m, c)
    if (ex) return ex
  }
  return null
}

/** The explanation for a problem (cached per compile), or null when none is known. */
export function explain(p: Problem, index: number, all: Problem[], host: ExplainHost, read?: (f: string) => Promise<string | null>): Promise<Explanation | null> {
  let e = cache.get(p)
  if (!e) {
    e = build(p, index, all, host, read ?? ((f) => host.readText(f))).catch((err) => {
      console.warn('Could not explain', p.message, err)
      return null
    })
    cache.set(p, e)
  }
  return e
}

/** Text with `code` in backticks, as DOM nodes. */
function rich(text: string): Node[] {
  return text.split(/`([^`]*)`/).map((part, i) => {
    if (i % 2 === 0) return document.createTextNode(part)
    const code = document.createElement('code')
    code.textContent = part
    return code
  })
}

/** A short excerpt of the line with the spot marked. */
function excerpt(line: string, at: Spot): HTMLElement {
  const from = Math.max(0, at.col - 14) // keep the mark visible in a narrow panel
  const to = Math.min(line.length, at.col + at.len + 40)
  const el = document.createElement('code')
  el.className = 'ex-line'
  const mark = document.createElement('mark')
  mark.textContent = line.slice(at.col, at.col + at.len) || ' '
  el.append((from > 0 ? '…' : '') + line.slice(from, at.col).trimStart(), mark, line.slice(at.col + at.len, to).trimEnd() + (to < line.length ? '…' : ''))
  return el
}

let generation = 0

/** Add explanations and fix buttons to the problems list main.ts just drew (one li per problem). */
export async function decorateProblems(ul: HTMLElement, list: Problem[], host: ExplainHost): Promise<void> {
  const gen = ++generation
  const texts = new Map<string, Promise<string | null>>()
  const read = (f: string): Promise<string | null> => {
    if (!texts.has(f)) texts.set(f, host.readText(f).catch(() => null))
    return texts.get(f)!
  }
  const items = [...ul.children] as HTMLElement[]
  for (let i = 0; i < list.length && i < items.length; i++) {
    const ex = await explain(list[i], i, list, host, read)
    if (gen !== generation) return // a newer compile redrew the list
    if (ex) await render(items[i], ex, ul, host, read)
  }
}

async function render(li: HTMLElement, ex: Explanation, ul: HTMLElement, host: ExplainHost, read: (f: string) => Promise<string | null>): Promise<void> {
  li.classList.add('explained')
  if (ex.followOn) li.classList.add('follow-on')
  const box = document.createElement('div')
  box.className = 'explain'
  const p = document.createElement('div')
  p.className = 'ex-text'
  p.append(...rich(ex.text))
  box.append(p)
  if (ex.at) {
    const src = await read(ex.at.file)
    const line = src?.split('\n')[ex.at.line - 1]
    if (line != null && ex.at.len > 0) {
      const at = ex.at
      const row = document.createElement('div')
      row.className = 'ex-at'
      const where = document.createElement('span')
      where.className = 'ex-where'
      where.textContent = `${at.file.split('/').pop()}:${at.line}`
      row.append(where, excerpt(line, at))
      row.title = 'Show this in the editor'
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        void select(host, at)
      })
      box.append(row)
    }
  }
  if (ex.fixes?.length) {
    const row = document.createElement('div')
    row.className = 'ex-fixes'
    for (const fix of ex.fixes) row.append(fixButton(fix, row, ul, host))
    box.append(row)
  }
  li.append(box)
}

function fixButton(fix: Fix, row: HTMLElement, ul: HTMLElement, host: ExplainHost): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'ex-fix'
  b.append(...rich(fix.label))
  if (fix.key) b.dataset.key = fix.key
  b.addEventListener('click', async (e) => {
    e.stopPropagation()
    b.disabled = true
    let ok: boolean | void = false
    try {
      ok = await fix.run()
    } catch (err) {
      console.warn('Fix failed', err)
    }
    if (ok === false) {
      b.disabled = false
      host.status('That change couldn’t be made: the line has changed since the last compile. Compile again to refresh the list.', 'warn')
      return
    }
    // Same change offered on other problems (e.g. one package for several commands): mark those done too.
    const rows = fix.key ? [...ul.querySelectorAll<HTMLElement>('.ex-fixes')].filter((r) => r.querySelector(`[data-key="${CSS.escape(fix.key!)}"]`)) : [row]
    if (!rows.includes(row)) rows.push(row)
    for (const r of rows) done(r, fix.recompile !== false, host)
  })
  return b
}

function done(row: HTMLElement, recompile: boolean, host: ExplainHost): void {
  const note = document.createElement('span')
  note.className = 'ex-done'
  note.textContent = recompile ? '✓ Changed. ' : '✓ Done.'
  row.replaceChildren(note)
  row.closest('li')?.classList.add('fixed')
  if (recompile) {
    const again = document.createElement('button')
    again.className = 'ex-fix primary'
    again.textContent = 'Compile again'
    again.addEventListener('click', (e) => {
      e.stopPropagation()
      host.compile()
    })
    row.append(again)
  }
}

/** Add the first error, in plain words, to the status bar text (if nothing has replaced it meanwhile). */
export async function statusInWords(list: Problem[], host: ExplainHost, el: HTMLElement): Promise<void> {
  const before = el.textContent
  for (let i = 0; i < list.length; i++) {
    if (list[i].severity !== 'error') continue
    const ex = await explain(list[i], i, list, host)
    if (ex?.followOn) continue
    if (ex?.short && el.textContent === before) el.textContent = `${before} · ${ex.short}`
    return
  }
}
