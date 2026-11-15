// Shared pieces for the error explanations: what main.ts provides, the shape of an
// explanation, and small helpers to read the paper and change it in the editor.
import type { EditorView } from '@codemirror/view'
import type { Engine, Problem } from '../../../shared/types'

/** What main.ts lends the explainer. */
export interface ExplainHost {
  view: EditorView
  openFile(path: string): Promise<void>
  /** A project file's text: the open editor's copy if it is open, else from disk. */
  readText(path: string): Promise<string | null>
  /** Every file in the project, '/'-separated paths relative to its folder. */
  files(): string[]
  mainFile(): string | null
  /** The file that was compiled last (the main file, or a supplement). */
  target(): string | null
  citations(): { key: string; title: string }[]
  labels(): string[]
  /** Commands the paper defines itself (\newcommand). */
  commands(): string[]
  hasPackage(pkg: string): boolean
  compile(): void
  importRefs(): void
  setEngine(e: Engine): void
  engine(): Engine
  status(text: string, cls?: string): void
}

export interface Fix {
  label: string
  /** Fixes with the same key make the same change; once one runs, the others count as done. */
  key?: string
  /** Returns false when the change couldn't be made (the text has moved on, say). */
  run: () => Promise<boolean | void> | boolean | void
  /** After the fix, offer "Compile again" (default true). */
  recompile?: boolean
}

/** A place in the paper: line is 1-based, col 0-based. */
export interface Spot {
  file: string
  line: number
  col: number
  len: number
}

export interface Explanation {
  /** Plain English. Text between `backticks` is shown as code. */
  text: string
  /** A few words for the status bar, e.g. "\SI needs the siunitx package". */
  short?: string
  fixes?: Fix[]
  /** The exact spot, shown as a clickable excerpt of the line. */
  at?: Spot
  /** A knock-on effect of an earlier problem: shown dimmer. */
  followOn?: boolean
}

/** Everything a rule gets to look at. */
export interface Ctx {
  p: Problem
  host: ExplainHost
  all: Problem[]
  index: number
  /** The project file the problem is in, if known. */
  file: string | null
  line: number | null
  /** The source line's text. */
  lineText: string | null
  /** The excerpt TeX showed (the "l.12 …" line): the text up to where it stopped. */
  shown: string
  /** Where TeX stopped on the line (0-based, just after the last character read), if found. */
  col: number | null
  /** The raw log lines around the problem. */
  log: string
  read(file: string): Promise<string | null>
}

export const tick = (s: string): string => '`' + s + '`'
export const isTex = (f: string): boolean => /\.(tex|ltx)$/i.test(f)
export const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A source line without its comment (blanked out, so columns still match). */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '%') return line.slice(0, i) + ' '.repeat(line.length - i)
  }
  return line
}

/** Edit distance with swaps (Damerau–Levenshtein, optimal string alignment). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  return d[a.length][b.length]
}

/** The candidate closest to word, if it is close enough to be a likely typo. */
export function closest(word: string, candidates: Iterable<string>, opts: { ignoreCase?: boolean } = {}): string | null {
  const w = opts.ignoreCase ? word.toLowerCase() : word
  const limit = w.length <= 3 ? 1 : w.length <= 7 ? 2 : 3
  let best: string | null = null
  let bestD = Infinity
  for (const c of new Set(candidates)) {
    if (c === word) continue
    const cc = opts.ignoreCase ? c.toLowerCase() : c
    let d = cc === w ? 0.5 : distance(w, cc)
    if (cc.toLowerCase() === w.toLowerCase()) d = 0.5 // only the case differs
    else if (cc.startsWith(w) || w.startsWith(cc)) d -= 0.25 // smith2020 → smith2020a
    if (d < bestD) [best, bestD] = [c, d]
  }
  return bestD <= limit ? best : null
}

/** Every match of re in the project's .tex files (or in the given files), with line and column. */
export async function searchProject(host: ExplainHost, re: RegExp, files?: string[]): Promise<{ file: string; line: number; col: number; match: RegExpMatchArray }[]> {
  const out: { file: string; line: number; col: number; match: RegExpMatchArray }[] = []
  const order = files ?? orderedTexFiles(host)
  for (const f of order) {
    const text = await host.readText(f)
    if (text == null) continue
    text.split('\n').forEach((l, i) => {
      const clean = stripComment(l)
      for (const m of clean.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) out.push({ file: f, line: i + 1, col: m.index!, match: m })
    })
  }
  return out
}

/** The project's .tex files, the compiled file first. */
export function orderedTexFiles(host: ExplainHost): string[] {
  const first = [host.target(), host.mainFile()].filter((f): f is string => Boolean(f))
  return [...new Set([...first, ...host.files().filter(isTex)])]
}

// ---------- Changing the paper ----------
// Every change goes through the editor, so it shows up, marks the file unsaved and can be undone.

async function openAt(host: ExplainHost, file: string, line: number): Promise<EditorView | null> {
  await host.openFile(file)
  const v = host.view
  return line >= 1 && line <= v.state.doc.lines ? v : null
}

/** Select a spot in the editor and scroll to it. */
export async function select(host: ExplainHost, at: Spot): Promise<void> {
  const v = await openAt(host, at.file, at.line)
  if (!v) return
  const l = v.state.doc.line(at.line)
  const from = Math.min(l.from + at.col, l.to)
  const to = Math.min(from + at.len, l.to)
  v.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
  v.focus()
}

/**
 * The line to change: the one given, or, if an earlier fix added or removed lines, the nearest
 * line within a few that still has the text (only for text long enough not to match by chance).
 */
function lineWith(v: EditorView, line: number, test: (text: string) => boolean, nearby: boolean): number | null {
  const n = v.state.doc.lines
  const ok = (k: number): boolean => k >= 1 && k <= n && test(v.state.doc.line(k).text)
  if (ok(line)) return line
  if (nearby) for (let d = 1; d <= 5; d++) for (const k of [line - d, line + d]) if (ok(k)) return k
  return null
}

/** Replace text at a spot, checking it is still what we expect there. */
export async function replaceAt(host: ExplainHost, at: Spot, expected: string, insert: string): Promise<boolean> {
  await host.openFile(at.file)
  const v = host.view
  if (!expected) return false
  const k = lineWith(v, Math.min(at.line, v.state.doc.lines), (t) => t.includes(expected), expected.length >= 3)
  if (k == null) return false
  const l = v.state.doc.line(k)
  let from = l.from + at.col
  if (k !== at.line || v.state.sliceDoc(from, from + expected.length) !== expected) {
    // An earlier fix may have shifted it: use the nearest occurrence on the line.
    let best = -1
    for (let i = l.text.indexOf(expected); i >= 0; i = l.text.indexOf(expected, i + 1)) {
      if (l.text[i - 1] === '\\' && !expected.startsWith('\\')) continue // already escaped, like \&
      if (best < 0 || Math.abs(i - at.col) < Math.abs(best - at.col)) best = i
    }
    if (best < 0) return false
    from = l.from + best
  }
  v.dispatch({ changes: { from, to: from + expected.length, insert }, selection: { anchor: from, head: from + insert.length }, scrollIntoView: true })
  v.focus()
  return true
}

/** Replace the occurrence of `find` on a line that is nearest to col (or the first one). */
export async function replaceInLine(host: ExplainHost, file: string, line: number, find: string | RegExp, insert: string | ((m: string) => string), col?: number | null): Promise<boolean> {
  await host.openFile(file)
  const v = host.view
  const re = typeof find === 'string' ? new RegExp(reEsc(find), 'g') : new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g')
  const k = lineWith(v, Math.min(line, v.state.doc.lines), (t) => new RegExp(re.source, re.flags.replace('g', '')).test(t), (typeof find === 'string' ? find : find.source).length >= 4)
  if (k == null) return false
  const l = v.state.doc.line(k)
  const hits = [...l.text.matchAll(re)]
  if (!hits.length) return false
  const hit = col == null ? hits[0] : hits.reduce((a, b) => (Math.abs(b.index! + b[0].length - col) < Math.abs(a.index! + a[0].length - col) ? b : a))
  const text = typeof insert === 'string' ? insert : insert(hit[0])
  const from = l.from + hit.index!
  v.dispatch({ changes: { from, to: from + hit[0].length, insert: text }, selection: { anchor: from, head: from + text.length }, scrollIntoView: true })
  v.focus()
  return true
}

/** Replace every match in a file. Returns how many were changed. */
export async function replaceAllInFile(host: ExplainHost, file: string, find: string, insert: string): Promise<number> {
  await host.openFile(file)
  const v = host.view
  const text = v.state.doc.toString()
  const changes: { from: number; to: number; insert: string }[] = []
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) changes.push({ from: i, to: i + find.length, insert })
  if (changes.length) v.dispatch({ changes, scrollIntoView: true })
  return changes.length
}

/** Insert whole lines before line `before` (1-based; lines+1 appends). */
export async function insertLines(host: ExplainHost, file: string, before: number, text: string): Promise<boolean> {
  await host.openFile(file)
  const v = host.view
  const doc = v.state.doc
  const pos = before > doc.lines ? doc.length : doc.line(Math.max(1, before)).from
  const insert = before > doc.lines && doc.length && !doc.toString().endsWith('\n') ? '\n' + text : text.endsWith('\n') ? text : text + '\n'
  v.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos, head: pos + insert.length }, scrollIntoView: true })
  v.focus()
  return true
}

/** Delete a line if it still looks like `test`. */
export async function deleteLine(host: ExplainHost, file: string, line: number, test: (text: string) => boolean): Promise<boolean> {
  const v = await openAt(host, file, line)
  if (!v) return false
  const l = v.state.doc.line(line)
  if (!test(l.text)) return false
  const to = line < v.state.doc.lines ? v.state.doc.line(line + 1).from : l.to
  v.dispatch({ changes: { from: l.from, to }, selection: { anchor: l.from }, scrollIntoView: true })
  v.focus()
  return true
}

/** Where a new preamble line goes in the main file: after the last \usepackage (but before hyperref and cleveref, which like to be last). */
export function preambleLine(text: string, last = false): number {
  const lines = text.split('\n')
  const begin = lines.findIndex((l) => /^\s*\\begin\{document\}/.test(l))
  const end = begin < 0 ? lines.length : begin
  const pk = lines.slice(0, end).map((l, i) => (/^\s*\\usepackage/.test(stripComment(l)) ? i : -1)).filter((i) => i >= 0)
  const late = pk.filter((i) => /\{(hyperref|cleveref)\}/.test(lines[i]))
  if (!last && late.length && pk.some((i) => i < late[0])) return late[0] + 1 // before hyperref
  if (pk.length) return pk[pk.length - 1] + 2 // after the last \usepackage
  const dc = lines.findIndex((l) => /^\s*\\documentclass/.test(l))
  return dc >= 0 ? dc + 2 : end + 1
}

/** Add a line (e.g. \usepackage{x}) to the main file's preamble. */
export async function addToPreamble(host: ExplainHost, line: string, last = false): Promise<boolean> {
  const main = host.mainFile()
  if (!main) return false
  const text = (await host.readText(main)) ?? ''
  if (text.includes(line)) return true
  await insertLines(host, main, preambleLine(text, last), line)
  host.status(`Added ${line} to ${main}`, 'ok')
  return true
}

/** A fix that adds \usepackage{pkg}. */
export function packageFix(host: ExplainHost, pkg: string, options = ''): Fix {
  const line = `\\usepackage${options ? `[${options}]` : ''}{${pkg}}`
  return { label: `Add ${tick(line)}`, key: `pkg:${pkg}`, run: () => addToPreamble(host, line, pkg === 'cleveref') }
}

/** The compile-again fix. */
export const compileFix = (host: ExplainHost, label = 'Compile again'): Fix => ({ label, key: 'compile', recompile: false, run: () => host.compile() })
