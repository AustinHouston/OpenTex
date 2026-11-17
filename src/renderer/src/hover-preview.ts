// Hover previews in the editor, the part loaded on the first hover (hover.ts is the small part
// that's always there). Rest the mouse on \ref{…} to see the figure, table, section or equation
// it points to; on \cite{…} for the reference's details; on math to see it typeset; on
// \includegraphics{…} for the picture.
//
// Speed: files are read the first time they're needed and kept until they change on disk (open
// files are read live from the editor). KaTeX, the math typesetter, is only loaded the first time
// you hover over math. Pictures are decoded at thumbnail size and at most 30 of them are kept.
import './hover.css'
import type { EditorView, Tooltip } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import * as pdfjs from 'pdfjs-dist'
import type { OpenTexApi } from '../../preload/index'
import type { ProjectInfo } from '../../shared/types'
import { allFiles } from './filetree'
import { maskComments, tidy } from './outline'

export interface HoverHost {
  project: () => ProjectInfo | null
  active: () => string | null
  /** The file shown in this editor (there can be several file windows). */
  fileOf?: (view: EditorView) => string | null
  textOf: (path: string) => string | null // text of an open file, with unsaved edits
  lastPdf: () => string | null
}

const api = (window as unknown as { opentex: OpenTexApi }).opentex
const THUMB_W = 320
const THUMB_H = 220
const MAX_THUMBS = 30

// ---------- Small helpers ----------
function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
const dirOf = (f: string): string => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')
/** Join a path written in a file ("../figs/a") onto a folder ("sections"). */
function join(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : []
  for (const seg of rel.trim().replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
const lineOf = (t: string, pos: number): number => {
  let n = 1
  for (let i = t.indexOf('\n'); i >= 0 && i < pos; i = t.indexOf('\n', i + 1)) n++
  return n
}
const wait = (ms: number): Promise<null> => new Promise((r) => setTimeout(() => r(null), ms))

/** Read `[optional]` (if allowed) then `{argument}` at `i`, with nested braces. */
function readArg(t: string, i: number, optional = true): { value: string; start: number; end: number } | null {
  while (i < t.length && /\s/.test(t[i])) i++
  if (optional && t[i] === '[') {
    let depth = 0
    for (; i < t.length; i++) {
      if (t[i] === '{') depth++
      else if (t[i] === '}') depth--
      else if (t[i] === ']' && depth <= 0) break
    }
    i++
    while (i < t.length && /\s/.test(t[i])) i++
  }
  if (t[i] !== '{') return null
  let depth = 0
  const start = i
  for (; i < t.length; i++) {
    if (t[i] === '\\') i++
    else if (t[i] === '{') depth++
    else if (t[i] === '}' && --depth === 0) return { value: t.slice(start + 1, i), start, end: i + 1 }
  }
  return null
}

// ---------- Caches (cleared when files change on disk or another folder opens) ----------
let root: string | null = null
const disk = new Map<string, Promise<string | null>>()
let auxCache: Promise<Map<string, { num: string; page: string }>> | null = null
const pages = new Map<string, Promise<number | null>>()
const thumbs = new Map<string, Promise<Thumb>>()
const bibs = new Map<string, { text: string; entries: Map<string, string> }>()
const rendered = new Map<string, string>() // typeset math, newest last
let macroSrc: string | null = null
let macros: Record<string, string> = {}
let macroGen = 0

function forgetThumb(path: string): void {
  thumbs.get(path)?.then((t) => t.bmp?.close())
  thumbs.delete(path)
}
function clearAll(): void {
  disk.clear()
  auxCache = null
  pages.clear()
  for (const p of [...thumbs.keys()]) forgetThumb(p)
  bibs.clear()
  macroSrc = null
}
/** Files changed on disk: forget what was read from them. */
export function changed(paths: string[]): void {
  for (const p of paths) {
    disk.delete(p)
    bibs.delete(p)
    if (thumbs.has(p)) forgetThumb(p)
    if (/\.aux$/i.test(p)) auxCache = null
    if (/\.(pdf|synctex\.gz)$/i.test(p)) pages.clear()
    if (/\.(tex|sty)$/i.test(p)) macroSrc = null
  }
}

let host: HoverHost
export const setHost = (h: HoverHost): void => void (host = h)
function text(path: string): Promise<string | null> {
  const live = host.textOf(path)
  if (live != null) return Promise.resolve(live)
  let p = disk.get(path)
  if (!p) {
    p = (api.readFile(path) as Promise<string>).catch(() => null)
    disk.set(path, p)
  }
  return p
}
const projectFiles = (test: (p: string) => boolean): string[] => {
  const p = host.project()
  return p ? allFiles(p.tree, test) : []
}

// ---------- \ref: where the label is and what it labels ----------
interface Target {
  kind: 'figure' | 'table' | 'section' | 'equation' | 'other'
  name: string // Figure, Section, Theorem…
  title: string // caption or heading
  graphic?: string // \includegraphics argument
  math?: string // equation source, ready for KaTeX
  file: string
  line: number
}

const commented = (t: string, at: number): boolean => /(^|[^\\])(\\\\)*%/.test(t.slice(t.lastIndexOf('\n', at - 1) + 1, at))

async function findLabel(key: string): Promise<{ file: string; text: string; at: number } | null> {
  const act = host.active()
  const files = projectFiles((f) => /\.tex$/i.test(f)).sort((a, b) => Number(b === act) - Number(a === act))
  const texts = await Promise.all(files.map(text))
  const needle = `\\label{${key}}`
  for (let i = 0; i < files.length; i++) {
    const t = texts[i]
    if (!t) continue
    for (let at = t.indexOf(needle); at >= 0; at = t.indexOf(needle, at + 1)) if (!commented(t, at)) return { file: files[i], text: t, at }
  }
  return null
}

const FLOAT_ENV = /^(figure|table|wrapfigure|wraptable|sidewaysfigure|sidewaystable|subfigure|subtable|SCfigure|SCtable)\*?$/
const MATH_ENVS = 'equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math'
const MATH_ENV = new RegExp(`^(${MATH_ENVS})\\*?$`)
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).replace(/\*$/, '')

function classify(t: string, at: number, file: string): Target {
  const from = Math.max(0, at - 20000)
  const win = maskComments(t.slice(from, Math.min(t.length, at + 20000)))
  const a = at - from
  const base = { file, line: lineOf(t, at) }

  // A heading just before the label (or holding it in its title).
  const before = win.slice(Math.max(0, a - 800), a)
  let head: RegExpMatchArray | undefined
  for (const m of before.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(?![a-zA-Z@])\*?/g)) head = m
  if (head) {
    const arg = readArg(win, a - before.length + head.index! + head[0].length)
    if (arg && (arg.end > a || !win.slice(arg.end, a).trim())) return { kind: 'section', name: cap(head[1]), title: tidy(arg.value) || '(untitled)', ...base }
  }

  // The environment around it.
  const stack: { env: string; body: number }[] = []
  for (const m of win.slice(0, a).matchAll(/\\(begin|end)\s*\{([^{}]+)\}/g)) {
    if (m[1] === 'begin') stack.push({ env: m[2], body: m.index! + m[0].length })
    else {
      const i = stack.map((s) => s.env).lastIndexOf(m[2])
      if (i >= 0) stack.length = i
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const { env, body: b } = stack[i]
    const close = win.indexOf(`\\end{${env}}`, a)
    const body = win.slice(b, close >= 0 ? close : Math.min(win.length, a + 4000))
    if (FLOAT_ENV.test(env)) {
      const own = env.startsWith('sub') ? body : body.replace(/\\begin\{(sub(?:figure|table|float))\}[\s\S]*?\\end\{\1\}/g, '')
      const c = own.indexOf('\\caption')
      const arg = c >= 0 ? readArg(own, c + '\\caption'.length) : null
      const g = body.match(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]+)\}/)
      const table = /table/i.test(env)
      return { kind: table ? 'table' : 'figure', name: table ? 'Table' : 'Figure', title: arg ? tidy(arg.value) : '', graphic: table ? undefined : g?.[1], ...base }
    }
    if (MATH_ENV.test(env)) return { kind: 'equation', name: 'Equation', title: '', math: mathSource(env, body), ...base }
    if (!/^(center|minipage|document|subequations|frame|landscape)$/.test(env)) {
      return { kind: 'other', name: cap(env), title: tidy(win.slice(a, Math.min(win.length, a + 600)).replace(/^\\label\{[^}]*\}/, '')), ...base }
    }
  }
  const ls = t.lastIndexOf('\n', at - 1) + 1
  const le = t.indexOf('\n', at)
  return { kind: 'other', name: '', title: tidy(t.slice(ls, le < 0 ? t.length : le)), ...base }
}

/** Numbers and pages from the last compile (the .aux file), e.g. fig:a -> Figure 3, page 5. */
function auxLabels(): Promise<Map<string, { num: string; page: string }>> {
  if (auxCache) return auxCache
  const main = host.project()?.mainFile
  auxCache = (async () => {
    const out = new Map<string, { num: string; page: string }>()
    if (!main) return out
    const clean = (s: string): string => s.replace(/\\[a-zA-Z@]+\s*/g, '').replace(/[{}]/g, '').trim()
    const queue = [main.replace(/\.tex$/i, '.aux')]
    const seen = new Set<string>()
    while (queue.length && seen.size < 60) {
      const f = queue.shift()!
      if (seen.has(f)) continue
      seen.add(f)
      const t = (await (api.readFile(f) as Promise<string>).catch(() => null)) ?? ''
      for (const m of t.matchAll(/\\newlabel\{([^{}]+)\}\{\{(.*?)\}\{(.*?)\}/g)) out.set(m[1], { num: clean(m[2]), page: clean(m[3]) })
      for (const m of t.matchAll(/\\@input\{([^{}]+)\}/g)) queue.push(join(dirOf(main), m[1]))
    }
    return out
  })()
  return auxCache
}

/** Page of a source line in the compiled PDF, from SyncTeX (only when the .aux file doesn't say). */
function pageOf(file: string, line: number): Promise<number | null> {
  const pdf = host.lastPdf()
  if (!pdf) return Promise.resolve(null)
  const key = `${file}:${line}`
  let p = pages.get(key)
  if (!p) {
    p = (api.synctexForward(file, line, pdf) as Promise<{ page: number } | null>).then((b) => b?.page ?? null).catch(() => null)
    pages.set(key, p)
  }
  return p
}

async function refCard(key: string): Promise<HTMLElement> {
  const card = el('div', 'ot-hv')
  const hit = await findLabel(key)
  if (!hit) {
    card.append(el('div', 'ot-hv-muted', `No \\label{${key}} in this paper`))
    return card
  }
  const target = classify(hit.text, hit.at, hit.file)
  const aux = (await auxLabels()).get(key)
  const head = el('div', 'ot-hv-head')
  head.append(el('span', 'ot-hv-kind', [target.name, aux?.num].filter(Boolean).join(' ') || 'Label'))
  const where = el('span', 'ot-hv-muted', aux?.page ? `page ${aux.page}` : `${hit.file}, line ${target.line}`)
  head.append(where)
  card.append(head)
  if (!aux?.page) {
    // Fill in the page from SyncTeX if there's a compiled PDF; the card doesn't wait for it.
    void pageOf(hit.file, target.line).then((p) => p && (where.textContent = `page ${p}`))
  }
  if (target.kind === 'figure') {
    if (target.graphic) {
      const path = await resolveGraphic(target.graphic, hit.file)
      card.append(path ? await thumbNode(path) : el('div', 'ot-hv-muted', `Picture not found: ${target.graphic}`))
    }
    if (target.title) card.append(el('div', 'ot-hv-caption', target.title))
  } else if (target.kind === 'equation' && target.math) {
    card.append(await mathNode(target.math, true))
  } else if (target.title) {
    card.append(el('div', target.kind === 'section' ? 'ot-hv-title' : 'ot-hv-caption', target.title))
  }
  return card
}

// ---------- \cite: the reference from the .bib files ----------
function bibField(entry: string, name: string): string {
  const m = new RegExp(`[,\\s]${name}\\s*=\\s*`, 'i').exec(entry)
  if (!m) return ''
  let i = m.index + m[0].length
  const open = entry[i]
  if (open === '"') return entry.slice(i + 1, entry.indexOf('"', i + 1))
  if (open !== '{') return (entry.slice(i).match(/^[^,\n}]*/) ?? [''])[0]
  let depth = 0
  const start = i + 1
  for (; i < entry.length; i++) {
    if (entry[i] === '\\') i++
    else if (entry[i] === '{') depth++
    else if (entry[i] === '}' && --depth === 0) break
  }
  return entry.slice(start, i)
}

const ACCENT: Record<string, string> = { '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', u: '̆', '.': '̇', '"': '̈', H: '̋', v: '̌', c: '̧' }
const LETTER: Record<string, string> = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', oe: 'œ', OE: 'Œ' }
/** BibTeX text as you'd read it: {\"o} -> ö, \& -> &, -- -> –, no braces or commands. */
export function cleanBib(s: string): string {
  return s
    .replace(/\\([`'^~=."])\s*\{?\s*\\?([a-zA-Z])\}?/g, (_m, a: string, c: string) => c + ACCENT[a])
    .replace(/\\([uvHc])(?:\s*\{\s*\\?([a-zA-Z])\}|\s+([a-zA-Z]))/g, (_m, a: string, c1?: string, c2?: string) => (c1 ?? c2 ?? '') + ACCENT[a])
    .replace(/\\(ss|oe|OE|ae|AE|aa|AA|o|O|l|L|i)(?![a-zA-Z])\s*/g, (_m, l: string) => LETTER[l])
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, ' ')
    .replace(/\\[a-zA-Z]+\*?\s*/g, '')
    .replace(/[{}\\$]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC')
}

/** Split at a separator outside braces. */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let last = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') depth--
    else if (depth === 0) {
      const m = sep.exec(s.slice(i))
      if (m && m.index === 0) {
        out.push(s.slice(last, i))
        i += m[0].length - 1
        last = i + 1
      }
    }
  }
  out.push(s.slice(last))
  return out.map((x) => x.trim()).filter(Boolean)
}

/** "Smith, J. and Jones, K." -> "Smith and Jones"; four or more -> "Smith et al." */
export function shortAuthors(s: string): string {
  const names = splitTop(s.replace(/\s+/g, ' '), /^\s+and\s+/i)
  const last = (n: string): string => {
    const parts = splitTop(n, /^,/)
    const name = parts.length > 1 ? parts[0] : (splitTop(n, /^\s+/).pop() ?? n)
    return cleanBib(name)
  }
  const others = names.length > 1 && /^others$/i.test(names[names.length - 1])
  const ls = names.filter((n) => !/^others$/i.test(n)).map(last)
  if (!ls.length) return ''
  if (ls.length > 3 || others) return `${ls[0]} et al.`
  if (ls.length === 1) return ls[0]
  return `${ls.slice(0, -1).join(', ')} and ${ls[ls.length - 1]}`
}

async function bibEntry(key: string): Promise<string | null> {
  for (const f of projectFiles((p) => /\.bib$/i.test(p))) {
    const t = await text(f)
    if (!t) continue
    let c = bibs.get(f)
    if (!c || c.text !== t) {
      const entries = new Map<string, string>()
      for (const e of t.split(/(?=@\w+\s*[{(])/)) {
        const m = e.match(/^@(\w+)\s*[{(]\s*([^,\s]+)\s*,/)
        if (m && !/^(string|comment|preamble)$/i.test(m[1])) entries.set(m[2], e)
      }
      c = { text: t, entries }
      bibs.set(f, c)
    }
    const e = c.entries.get(key)
    if (e) return e
  }
  return null
}

function externalLink(label: string, url: string): HTMLElement {
  const a = el('a', 'ot-hv-link', label) as HTMLAnchorElement
  a.href = url
  // Opens in the browser: the main process sends window.open to shell.openExternal.
  a.onclick = (e) => {
    e.preventDefault()
    window.open(url)
  }
  return a
}

function citeDetails(key: string, e: string): HTMLElement {
  const box = el('div', 'ot-hv-cite')
  const f = (n: string): string => cleanBib(bibField(e, n))
  const year = f('year') || (f('date').match(/\d{4}/)?.[0] ?? '')
  const where = f('journal') || f('journaltitle') || f('booktitle') || f('publisher') || f('school') || f('institution')
  const title = f('title')
  box.append(el('div', 'ot-hv-title', title || key))
  const who = [shortAuthors(bibField(e, 'author') || bibField(e, 'editor')), year].filter(Boolean).join(', ')
  if (who) box.append(el('div', '', who))
  if (where) box.append(el('div', 'ot-hv-journal', where))
  const doi = bibField(e, 'doi').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '')
  const url = bibField(e, 'url').trim()
  if (doi) {
    const line = el('div', 'ot-hv-doi', 'DOI ')
    line.append(externalLink(doi, `https://doi.org/${encodeURI(doi)}`))
    box.append(line)
  } else if (/^https?:\/\//i.test(url)) box.append(externalLink('Open link', url))
  return box
}

async function citeCard(keys: string[], key: string | null): Promise<HTMLElement> {
  const card = el('div', 'ot-hv')
  const show = key ? [key] : keys.slice(0, 8)
  const entries = await Promise.all(show.map(bibEntry))
  if (show.length === 1) {
    card.append(el('div', 'ot-hv-key', show[0]))
    card.append(entries[0] ? citeDetails(show[0], entries[0]) : el('div', 'ot-hv-muted', 'Not in your .bib files'))
    return card
  }
  // Several keys: one compact line each.
  show.forEach((k, i) => {
    const e = entries[i]
    const row = el('div', 'ot-hv-row')
    row.append(el('span', 'ot-hv-key', k))
    if (!e) row.append(el('span', 'ot-hv-muted', 'Not in your .bib files'))
    else {
      const year = cleanBib(bibField(e, 'year')) || (bibField(e, 'date').match(/\d{4}/)?.[0] ?? '')
      row.append(el('span', '', [shortAuthors(bibField(e, 'author') || bibField(e, 'editor')), year].filter(Boolean).join(', ')))
      const t = cleanBib(bibField(e, 'title'))
      if (t) row.append(el('span', 'ot-hv-muted', t.length > 90 ? t.slice(0, 89) + '…' : t))
    }
    card.append(row)
  })
  if (keys.length > show.length) card.append(el('div', 'ot-hv-muted', `and ${keys.length - show.length} more`))
  return card
}

// ---------- Math (KaTeX, loaded on first use) ----------
type Katex = (typeof import('katex'))['default']
let katexP: Promise<Katex> | null = null
const loadKatex = (): Promise<Katex> =>
  (katexP ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([m]) => m.default)
    .catch((e) => {
      katexP = null
      throw e
    }))

/** An equation environment's body as something KaTeX can show (no numbers or labels). */
function mathSource(env: string, body: string): string {
  let b = body
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    .replace(/\\(nonumber|notag)(?![a-zA-Z])/g, '')
    .replace(/\\tag\*?\s*\{[^{}]*\}/g, '')
  const name = env.replace(/\*$/, '')
  if (name === 'align' || name === 'flalign' || name === 'eqnarray') return `\\begin{aligned}${b}\\end{aligned}`
  if (name === 'alignat') {
    const n = b.match(/^\s*\{(\d+)\}/)
    if (n) b = b.slice(n[0].length)
    return `\\begin{alignedat}{${n?.[1] ?? 1}}${b}\\end{alignedat}`
  }
  if (name === 'gather' || name === 'multline') return `\\begin{gathered}${b}\\end{gathered}`
  return b
}

/** \newcommand, \DeclareMathOperator and \def from the preamble and the project's .sty files. */
async function userMacros(): Promise<Record<string, string>> {
  const main = host.project()?.mainFile
  const parts: string[] = []
  if (main) {
    const t = (await text(main)) ?? ''
    const b = t.indexOf('\\begin{document}')
    const pre = maskComments(b >= 0 ? t.slice(0, b) : t)
    parts.push(pre)
    // Preamble files pulled in with \input (a common place for macros).
    const tex = new Set(projectFiles((p) => /\.tex$/i.test(p)))
    for (const m of pre.matchAll(/\\input\s*\{([^{}]+)\}/g)) {
      const f = [join(dirOf(main), m[1]), join(dirOf(main), `${m[1]}.tex`)].find((x) => tex.has(x))
      if (f) parts.push(maskComments((await text(f)) ?? ''))
    }
  }
  for (const f of projectFiles((p) => /\.sty$/i.test(p)).slice(0, 10)) parts.push(maskComments((await text(f)) ?? ''))
  const src = parts.join('\n')
  if (src === macroSrc) return macros
  macroSrc = src
  macroGen++
  const out: Record<string, string> = {}
  const add = (name: string, i: number, wrap = (v: string): string => v): void => {
    const arg = readArg(src, i, false)
    if (arg && !name.includes('@') && Object.keys(out).length < 500) out[name] = wrap(arg.value)
  }
  for (const m of src.matchAll(/\\(?:re|provide)?newcommand\*?\s*(?:\{\s*(\\[a-zA-Z]+)\s*\}|(\\[a-zA-Z]+))\s*(?:\[\d\]\s*)?(?:\[[^\]]*\]\s*)?/g)) add(m[1] ?? m[2], m.index! + m[0].length)
  for (const m of src.matchAll(/\\DeclareMathOperator(\*?)\s*\{\s*(\\[a-zA-Z]+)\s*\}\s*/g)) add(m[2], m.index! + m[0].length, (v) => `\\operatorname${m[1]}{${v}}`)
  for (const m of src.matchAll(/\\def\s*(\\[a-zA-Z]+)\s*(?:#\d)*\s*/g)) add(m[1], m.index! + m[0].length)
  macros = out
  return macros
}

async function mathNode(tex: string, display: boolean): Promise<HTMLElement> {
  const [katex, mac] = await Promise.all([loadKatex(), userMacros()])
  const key = `${display ? 'D' : 'I'}${macroGen}\u0000${tex}`
  let html = rendered.get(key)
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, macros: { ...mac }, maxSize: 50, maxExpand: 1000, output: 'html' })
    } catch (e) {
      html = `\u0000${String((e as Error)?.message ?? e).replace(/^KaTeX parse error:\s*/, '')}`
    }
    rendered.set(key, html)
    if (rendered.size > 100) rendered.delete(rendered.keys().next().value!)
  }
  if (html.startsWith('\u0000')) {
    const box = el('div', 'ot-hv-error')
    box.append(el('div', '', "Can't preview this"), el('div', 'ot-hv-small', html.slice(1)))
    return box
  }
  const box = el('div', 'ot-hv-math')
  box.innerHTML = html
  return box
}

/** The math at `pos`: inline $…$ or \(…\) on this line, or a display block around it. */
export function mathAt(state: EditorState, pos: number): { from: number; to: number; tex: string; display: boolean } | null {
  const line = state.doc.lineAt(pos)
  const t = line.text
  const p = pos - line.from
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '%') break
    let open = 0
    let close = ''
    let display = false
    if (c === '\\') {
      if (t[i + 1] === '(') (open = 2), (close = '\\)')
      else if (t[i + 1] === '[') (open = 2), (close = '\\]'), (display = true)
      else {
        i++
        continue
      }
    } else if (c === '$') {
      display = t[i + 1] === '$'
      open = display ? 2 : 1
      close = display ? '$$' : '$'
    } else continue
    let j = i + open
    while (j < t.length && !t.startsWith(close, j)) j += t[j] === '\\' ? 2 : 1
    if (j >= t.length) break // runs on past this line: handled below
    if (p >= i && p < j + close.length) {
      const tex = t.slice(i + open, j)
      return tex.trim() ? { from: line.from + i, to: line.from + j + close.length, tex, display } : null
    }
    i = j + close.length - 1
  }

  // Display math over several lines: \[…\], $$…$$ or an equation-like environment.
  const ws = Math.max(0, pos - 4000)
  const win = maskComments(state.doc.sliceString(ws, Math.min(state.doc.length, pos + 4000)))
  const q = pos - ws
  // (\\[2pt] inside align is a line break, not the start of display math.)
  const re = new RegExp(String.raw`\\begin\{(${MATH_ENVS})(\*?)\}|\\end\{(${MATH_ENVS})\*?\}|(?<!\\)\\\[|(?<!\\)\\\]|\$\$`, 'g')
  let open: { start: number; end: number; close: string; env: string } | null = null
  let done: { start: number; bodyEnd: number; end: number; env: string; bodyStart: number } | null = null
  for (let m = re.exec(win); m && m.index <= q; m = re.exec(win)) {
    const end = m.index + m[0].length
    if (m[1]) open = { start: m.index, end, close: `\\end{${m[1]}${m[2]}}`, env: m[1] + m[2] }
    else if (m[0] === '\\[') open = { start: m.index, end, close: '\\]', env: '' }
    else if (m[0] === '$$' && !open) open = { start: m.index, end, close: '$$', env: '' }
    else if (open && m[0].startsWith(open.close.slice(0, 2))) {
      done = { start: open.start, bodyStart: open.end, bodyEnd: m.index, end, env: open.env }
      open = null
    } else open = null
  }
  let r = done && done.end > q ? done : null
  if (open) {
    const c = win.indexOf(open.close, open.end)
    if (c >= 0) r = { start: open.start, bodyStart: open.end, bodyEnd: c, end: c + open.close.length, env: open.env }
  }
  if (!r) return null
  const body = win.slice(r.bodyStart, r.bodyEnd)
  if (!body.trim()) return null
  return { from: ws + r.start, to: ws + r.end, tex: r.env ? mathSource(r.env, body) : body.replace(/\\label\s*\{[^{}]*\}/g, ''), display: true }
}

// ---------- Pictures ----------
interface Thumb {
  bmp: ImageBitmap | null
  note?: string
}

/** Find a picture the way LaTeX does: next to the main file, in \graphicspath, with or without its extension. */
async function resolveGraphic(name: string, fromFile: string): Promise<string | null> {
  const pics = projectFiles((p) => /\.(pdf|png|jpe?g|gif|webp|bmp|eps)$/i.test(p))
  const byLower = new Map(pics.map((p) => [p.toLowerCase(), p]))
  const main = host.project()?.mainFile ?? fromFile
  const mainDir = dirOf(main)
  const n = name.trim().replace(/^"|"$/g, '').replace(/^\{|\}$/g, '')
  const dirs = [mainDir]
  const gp = ((await text(main)) ?? '').match(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/)
  if (gp) for (const m of gp[1].matchAll(/\{([^{}]*)\}/g)) dirs.push(join(mainDir, m[1]))
  dirs.push(dirOf(fromFile), '')
  const exts = /\.(pdf|png|jpe?g|gif|webp|bmp|eps)$/i.test(n) ? [''] : ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.gif', '.webp', '.bmp']
  for (const d of dirs) for (const e of exts) {
    const hit = byLower.get(join(d, n + e).toLowerCase())
    if (hit) return hit
  }
  return null
}

/** Width and height from a PNG or JPEG header, without decoding the picture. */
function imageSize(b: Uint8Array): [number, number] | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) {
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return [d.getUint32(16), d.getUint32(20)]
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const m = b[i + 1]
      if (m === 0xd8 || m === 0x01 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) {
        i += m === 0xff ? 1 : 2
        continue
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]]
      i += 2 + ((b[i + 2] << 8) | b[i + 3])
    }
  }
  return null
}

async function makeThumb(path: string): Promise<Thumb> {
  if (/\.eps$/i.test(path)) return { bmp: null, note: 'EPS picture (no preview)' }
  const data = (await api.readBinary(path)) as Uint8Array
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (/\.pdf$/i.test(path)) {
    // A PDF figure: draw its first page small with pdf.js.
    const task = pdfjs.getDocument({ data })
    try {
      const doc = await task.promise
      const page = await doc.getPage(1)
      const vp1 = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale: Math.min(THUMB_W / vp1.width, THUMB_H / vp1.height) * dpr })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      await page.render({ canvas, viewport: vp }).promise
      return { bmp: await createImageBitmap(canvas) }
    } finally {
      void task.destroy()
    }
  }
  const type = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : ''
  const blob = new Blob([data as BlobPart], type ? { type } : {})
  const size = imageSize(data)
  // Decode straight to thumbnail size, so a big photo never sits in memory at full size.
  const scale = size ? Math.min(1, THUMB_W / size[0], THUMB_H / size[1]) : 1
  const resizeWidth = Math.max(1, Math.round((size ? size[0] * scale : THUMB_W) * dpr))
  return { bmp: await createImageBitmap(blob, { resizeWidth, resizeQuality: 'medium' }) }
}

function thumb(path: string): Promise<Thumb> {
  let p = thumbs.get(path)
  if (p) {
    thumbs.delete(path) // most recently used goes last
    thumbs.set(path, p)
    return p
  }
  p = makeThumb(path).catch((): Thumb => ({ bmp: null, note: "Can't show this picture" }))
  thumbs.set(path, p)
  while (thumbs.size > MAX_THUMBS) forgetThumb(thumbs.keys().next().value!)
  return p
}

async function thumbNode(path: string): Promise<HTMLElement> {
  const box = el('div', 'ot-hv-img')
  const fill = (t: Thumb): void => {
    box.textContent = ''
    if (!t.bmp) return void box.append(el('div', 'ot-hv-muted', t.note ?? ''))
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const c = document.createElement('canvas')
    c.width = t.bmp.width
    c.height = t.bmp.height
    const s = Math.min(1 / dpr, THUMB_W / t.bmp.width, THUMB_H / t.bmp.height)
    c.style.width = `${Math.round(t.bmp.width * s)}px`
    c.style.height = `${Math.round(t.bmp.height * s)}px`
    c.getContext('2d')?.drawImage(t.bmp, 0, 0)
    box.append(c)
  }
  // Don't hold the card up for a slow picture: show it when it's ready.
  const t = await Promise.race([thumb(path), wait(250)])
  if (t) fill(t)
  else {
    box.append(el('div', 'ot-hv-muted', 'Loading picture…'))
    void thumb(path).then(fill)
  }
  return box
}

async function graphicCard(name: string, fromFile: string): Promise<HTMLElement> {
  const card = el('div', 'ot-hv')
  const path = await resolveGraphic(name, fromFile)
  if (!path) {
    card.append(el('div', 'ot-hv-muted', `No picture named “${name.trim()}” in this project`))
    return card
  }
  card.append(await thumbNode(path), el('div', 'ot-hv-muted ot-hv-small', path))
  return card
}

// ---------- Finding what's under the mouse ----------
const REF = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref|Vref|cpageref|Cpageref|labelcref|subref)\*?\s*\{([^{}]*)\}/g
const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g
const GRAPHIC = /\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]+)\}/g

/** A command on this line that holds `pos`, with the comma-separated key under the mouse (if any). */
function commandAt(lineText: string, lineFrom: number, pos: number, re: RegExp): { from: number; to: number; keys: string[]; key: string | null } | null {
  for (const m of lineText.matchAll(re)) {
    const from = lineFrom + m.index!
    const to = from + m[0].length
    if (pos < from || pos > to) continue
    if (commented(lineText, m.index!)) return null
    const argStart = from + m[0].lastIndexOf('{') + 1
    const keys: string[] = []
    let key: string | null = null
    let off = argStart
    for (const part of m[1].split(',')) {
      const k = part.trim()
      if (k) {
        keys.push(k)
        if (pos >= off && pos <= off + part.length) key = k
      }
      off += part.length + 1
    }
    return { from, to, keys, key }
  }
  return null
}

/** The preview card for whatever is at `pos`, or null. */
export async function preview(view: EditorView, pos: number): Promise<Tooltip | null> {
  const p = host.project()
  if (!p) return null
  if (p.root !== root) {
    root = p.root
    clearAll()
  }
  const state = view.state
  const line = state.doc.lineAt(pos)
  const tip = (from: number, to: number, dom: HTMLElement): Tooltip => ({ pos: from, end: to, above: true, create: () => ({ dom }) })
  const file = host.fileOf?.(view) ?? host.active() ?? p.mainFile ?? ''

  const ref = commandAt(line.text, line.from, pos, REF)
  if (ref && ref.keys.length) return tip(ref.from, ref.to, await refCard(ref.key ?? ref.keys[0]))
  const cite = commandAt(line.text, line.from, pos, CITE)
  if (cite && cite.keys.length) return tip(cite.from, cite.to, await citeCard(cite.keys, cite.key))
  const g = commandAt(line.text, line.from, pos, GRAPHIC)
  if (g) return tip(g.from, g.to, await graphicCard(g.keys.join(','), file))
  const math = mathAt(state, pos)
  if (math) {
    const card = el('div', 'ot-hv')
    card.append(await mathNode(math.tex, math.display))
    return tip(math.from, math.to, card)
  }
  return null
}
