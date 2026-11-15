// The Outline panel: the paper's parts, chapters and sections (and, optionally, its figures and
// tables) in reading order across every \input / \include file. Click an item to go there; the
// section holding the cursor is highlighted.
import './outline.css'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { ProjectInfo } from '../../shared/types'
import { countWords } from './assist'
import { allFiles } from './filetree'
import { Layout, ZONES } from './layout'

export interface OutlineHost {
  project: () => ProjectInfo | null
  active: () => string | null
  cursor: () => number | null // offset of the cursor in the active file
  textOf: (path: string) => string | null // text of an open file (with unsaved edits)
  goTo: (file: string, line: number) => Promise<void>
}

export interface Outline {
  /** Something was edited or another file opened: refresh soon. */
  schedule: (delay?: number) => void
  /** Editor extension that keeps the highlight on the section holding the cursor. */
  extension: Extension
}

// ---------- Reading the paper ----------
export interface Item {
  kind: 'heading' | 'float' | 'missing'
  level: number // part 0 … subsubsection 4; floats and missing files sit under the current heading
  cmd: string // section, figure, table…
  title: string
  label: string
  file: string
  line: number
  starred: boolean
  words: number // own words (headings), before adding subsections
}

interface Scan {
  root: string
  items: Item[]
  /** Per file: positions (line starts) where the reading order moves on, and how many items came before. */
  marks: Map<string, { pos: number; idx: number }[]>
}

const LEVEL: Record<string, number> = { part: 0, chapter: 1, addchap: 1, section: 2, addsec: 2, subsection: 3, subsubsection: 4, abstract: 2 }
const FLOATS = 'figure|table|wrapfigure|wraptable|sidewaysfigure|sidewaystable|SCfigure|SCtable'
const TOKEN = new RegExp(
  [
    `\\\\(part|chapter|section|subsection|subsubsection|addchap|addsec)(?![a-zA-Z@])\\s*(\\*?)`, // 1, 2
    `\\\\begin\\s*\\{(abstract|(?:${FLOATS})\\*?)\\}`, // 3
    `\\\\(input|include|subfile)(?![a-zA-Z@])\\s*(?:\\{([^{}]*)\\}|([^\\s{}\\\\%]+))`, // 4, 5, 6
    `\\\\(sub)?(?:import|inputfrom|includefrom|subimportlevel)\\*?\\s*\\{([^{}]*)\\}\\s*\\{([^{}]*)\\}` // 7, 8, 9
  ].join('|'),
  'g'
)

/** Blank out comments (keeping every character's position), so commented-out lines are ignored. */
export function maskComments(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  return text
    .replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, (m, a: string, b: string) => a + b + ' '.repeat(m.length - a.length - b.length))
    .replace(/\\begin\{comment\}[\s\S]*?\\end\{comment\}/g, blank)
    .replace(/\\iffalse(?![a-zA-Z@])[\s\S]*?\\fi(?![a-zA-Z@])/g, blank)
}

/** Read `[optional]` then `{argument}` at `i` (nested braces allowed). */
function readArg(t: string, i: number): { value: string; end: number } | null {
  const skip = (): void => {
    while (i < t.length && /\s/.test(t[i])) i++
  }
  skip()
  if (t[i] === '[') {
    let depth = 0
    for (; i < t.length; i++) {
      if (t[i] === '{') depth++
      else if (t[i] === '}') depth--
      else if (t[i] === ']' && depth <= 0) break
    }
    i++
    skip()
  }
  if (t[i] !== '{') return null
  let depth = 0
  const start = i + 1
  for (; i < t.length; i++) {
    if (t[i] === '\\') i++
    else if (t[i] === '{') depth++
    else if (t[i] === '}' && --depth === 0) return { value: t.slice(start, i), end: i + 1 }
  }
  return null
}

/** A title as you'd read it: no labels, footnotes or formatting commands. */
export function tidy(s: string): string {
  let t = s
  // Drop commands whose argument isn't part of the title.
  for (const cmd of ['label', 'footnote', 'index', 'cite', 'citep', 'citet', 'protect', 'thanks', 'hspace', 'vspace']) {
    for (let at = t.indexOf(`\\${cmd}`); at >= 0; at = t.indexOf(`\\${cmd}`, at)) {
      const arg = readArg(t, at + cmd.length + 1)
      t = arg ? t.slice(0, at) + t.slice(arg.end) : t.slice(0, at) + t.slice(at + cmd.length + 1)
    }
  }
  t = t.replace(/\\(?:ref|eqref|autoref|cref|Cref)\{[^{}]*\}/g, '?')
  t = t.replace(/\\(La)?TeX\b/g, (_m, la) => (la ? 'LaTeX' : 'TeX'))
  t = t.replace(/\\\\|\\newline\b|~/g, ' ').replace(/\\([&%#_$])/g, '$1')
  t = t.replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, '').replace(/[{}$]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  return t.length > 140 ? t.slice(0, 139) + '…' : t
}

function lineStarts(text: string): number[] {
  const out = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) out.push(i + 1)
  return out
}
function lineAt(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo // 0-based
}

/** Join a path written in a file ("../figs/a") onto a folder ("sections"). */
function join(dir: string, rel: string): string {
  const parts = dir ? dir.split('/') : []
  for (const seg of rel.trim().replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
const dirOf = (f: string): string => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')

/**
 * Walk the paper from `root` in reading order: each \input / \include / \subfile / \import is read
 * where it appears. `read` gives a file's text, or null if it can't be read.
 */
export async function scanPaper(root: string, texFiles: Set<string>, read: (f: string) => Promise<string | null>): Promise<Scan> {
  const items: Item[] = []
  const marks = new Map<string, { pos: number; idx: number }[]>()
  const seen = new Set<string>()
  let current: Item | null = null
  const rootDir = dirOf(root)

  // LaTeX looks for \input files next to the main file; OpenTex also tries the including file's folder.
  const resolve = (name: string, dirs: string[]): string | null => {
    const n = name.trim().replace(/^"|"$/g, '')
    if (!n) return null
    for (const d of dirs) for (const c of [join(d, n), join(d, `${n}.tex`)]) if (texFiles.has(c)) return c
    return null
  }

  const walk = async (file: string): Promise<void> => {
    if (seen.has(file) || seen.size > 400) return
    seen.add(file)
    const text = await read(file)
    if (text == null) return
    const t = maskComments(text)
    const starts = lineStarts(t)
    // A file with its own \begin{document} (the main file, a \subfile) is read from there on.
    const b = t.indexOf('\\begin{document}')
    const from = b >= 0 ? b + '\\begin{document}'.length : 0
    const e = t.indexOf('\\end{document}', from)
    const to = e >= 0 ? e : t.length
    const fileMarks = [{ pos: 0, idx: items.length }]
    marks.set(file, fileMarks)
    let last = from
    const words = (a: number, z: number): void => {
      if (current && z > a) current.words += countWords(t.slice(a, z))
    }
    const re = new RegExp(TOKEN.source, 'g')
    re.lastIndex = from
    for (let m = re.exec(t); m && m.index < to; m = re.exec(t)) {
      const line = lineAt(starts, m.index)
      const at = { file, line: line + 1, label: '', words: 0 }
      words(last, m.index)
      last = m.index
      if (m[1]) {
        const arg = readArg(t, m.index + m[0].length)
        if (!arg) continue
        const item: Item = { kind: 'heading', level: LEVEL[m[1]], cmd: m[1], title: tidy(arg.value) || '(untitled)', starred: Boolean(m[2]) || m[1].startsWith('add'), ...at }
        const lab = t.slice(arg.end, arg.end + 200).match(/^\s*\\label\{([^{}]*)\}/)
        if (lab) item.label = lab[1]
        items.push(item)
        current = item
        re.lastIndex = arg.end
      } else if (m[3] === 'abstract') {
        const item: Item = { kind: 'heading', level: LEVEL.abstract, cmd: 'abstract', title: 'Abstract', starred: true, ...at }
        items.push(item)
        current = item
      } else if (m[3]) {
        const env = m[3]
        const close = t.indexOf(`\\end{${env}}`, m.index)
        let body = t.slice(m.index + m[0].length, close >= 0 ? close : Math.min(t.length, m.index + 5000))
        body = body.replace(/\\begin\{(sub(?:figure|table|float))\}[\s\S]*?\\end\{\1\}/g, '') // sub-captions aren't the caption
        const cap = body.indexOf('\\caption')
        const arg = cap >= 0 ? readArg(body, cap + '\\caption'.length) : null
        const labels = [...body.matchAll(/\\label\{([^{}]*)\}/g)]
        const lab = labels.find((l) => cap < 0 || l.index! > cap) ?? labels[0]
        const kind = /table/i.test(env) ? 'table' : 'figure'
        items.push({ kind: 'float', level: 9, cmd: kind, title: arg ? tidy(arg.value) : '', starred: false, ...at, label: lab?.[1] ?? '' })
      } else {
        // \input, \include, \subfile, \import
        const name = m[5] ?? m[6] ?? m[9]
        const dirs = m[4] ? [rootDir, dirOf(file), ''] : m[7] ? [join(dirOf(file), m[8])] : [join(rootDir, m[8]), join('', m[8])]
        const child = resolve(name, dirs)
        if (child) await walk(child)
        else if (name && !/\.(sty|cls|bbl|tikz|pgf|pdf_tex|table|csv|dat)$/i.test(name)) {
          items.push({ kind: 'missing', level: 9, cmd: m[4] ?? 'import', title: name.trim(), starred: false, ...at })
        }
        last = m.index + m[0].length
      }
      fileMarks.push({ pos: starts[line], idx: items.length })
    }
    words(last, to)
  }
  await walk(root)
  return { root, items, marks }
}

// ---------- The panel ----------
const ICON = {
  figure: '<svg viewBox="0 0 20 20"><rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="M3 14.5l4-4 3 3 2.5-2.5 4.5 4"/></svg>',
  table: '<svg viewBox="0 0 20 20"><rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 8h15M2.5 12.5h15M7.5 3.5v13"/></svg>',
  missing: '<svg viewBox="0 0 20 20"><path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M8 10l4 4M12 10l-4 4"/></svg>',
  twist: '<svg viewBox="0 0 20 20"><path d="M6 8l4 4 4-4"/></svg>'
}
const FLOATS_KEY = 'opentex.outline.floats'

export function setupOutline(layout: Layout, savedLayout: unknown, host: OutlineHost): Outline {
  const api = (window as unknown as { opentex: { readFile: (p: string) => Promise<string>; on: (c: 'project:changed', fn: (paths: string[]) => void) => void } }).opentex
  const body = document.createElement('div')
  body.className = 'outline'
  body.innerHTML = `<div class="ol-note hidden"></div><ul class="ol-list"></ul><div class="ol-empty hidden"></div>`
  const note = body.querySelector<HTMLElement>('.ol-note')!
  const list = body.querySelector<HTMLElement>('.ol-list')!
  const empty = body.querySelector<HTMLElement>('.ol-empty')!
  const extras = document.createElement('div')
  extras.className = 'ol-extras'
  extras.innerHTML = `<button class="icon small" data-floats title="Show figures and tables">${ICON.figure}</button>`
  const floatsBtn = extras.querySelector<HTMLButtonElement>('[data-floats]')!

  let showFloats = true
  try {
    showFloats = localStorage.getItem(FLOATS_KEY) !== 'off'
  } catch {
    /* storage unavailable: keep the default */
  }
  const syncFloatsBtn = (): void => {
    floatsBtn.classList.toggle('on', showFloats)
    floatsBtn.title = showFloats ? 'Hide figures and tables' : 'Show figures and tables'
  }
  syncFloatsBtn()
  floatsBtn.onclick = (e) => {
    e.stopPropagation()
    showFloats = !showFloats
    try {
      localStorage.setItem(FLOATS_KEY, showFloats ? 'on' : 'off')
    } catch {
      /* not remembered, that's fine */
    }
    syncFloatsBtn()
    render()
  }

  // A layout saved before the Outline existed: add it without moving anything else around.
  const s = layout.state
  const known = ZONES.some((z) => s.zones[z].includes('outline'))
  const hadSaved = Boolean(savedLayout && typeof savedLayout === 'object' && (savedLayout as { zones?: unknown }).zones)
  if (!known && hadSaved) {
    const leftOpen = s.zones.left.some((id) => !s.hidden.includes(id) && !s.collapsed.includes(id))
    if (leftOpen) s.collapsed.push('outline')
    else s.hidden.push('outline')
  }
  layout.add({ id: 'outline', title: 'Outline', body, extras, defaultZone: 'left', onVisible: () => schedule(0) })

  // ---------- Keeping it up to date ----------
  const disk = new Map<string, string | null>() // text of files that aren't open, until they change on disk
  let diskRoot = ''
  api.on('project:changed', (paths: string[]) => {
    for (const p of paths) disk.delete(p)
    if (paths.some((p) => p.endsWith('.tex'))) schedule()
  })
  const read = async (f: string): Promise<string | null> => {
    const open = host.textOf(f)
    if (open != null) return open
    if (!disk.has(f)) disk.set(f, await api.readFile(f).catch(() => null))
    return disk.get(f) ?? null
  }

  let scan: Scan | null = null
  let timer = 0
  let generation = 0
  const collapsed = new Set<string>()
  const keyOf = (it: Item): string => `${it.file}|${it.cmd}|${it.title}`

  function schedule(delay = 400): void {
    clearTimeout(timer)
    timer = window.setTimeout(refresh, delay)
  }

  async function refresh(): Promise<void> {
    const p = host.project()
    if (!p) {
      scan = null
      return render()
    }
    if (!layout.isVisible('outline')) return // refreshed again when it's shown
    if (diskRoot !== p.root) {
      disk.clear()
      collapsed.clear()
      diskRoot = p.root
    }
    const gen = ++generation
    const tex = new Set(allFiles(p.tree, (f) => /\.tex$/i.test(f)))
    let next = p.mainFile ? await scanPaper(p.mainFile, tex, read) : null
    // A .tex file that isn't part of the paper (a supplement, notes): show its own outline.
    const active = host.active()
    if (active && /\.tex$/i.test(active) && (!next || !next.marks.has(active))) next = await scanPaper(active, tex, read)
    if (gen !== generation) return
    scan = next
    render()
  }

  // ---------- Drawing ----------
  let rows: { el: HTMLElement; idx: number }[] = []
  let shownCurrent = -1

  function render(): void {
    shownCurrent = -1
    rows = []
    const p = host.project()
    const items = scan?.items ?? []
    note.classList.toggle('hidden', !scan || !p || scan.root === p.mainFile)
    if (scan && p && scan.root !== p.mainFile) note.textContent = p.mainFile ? `${scan.root} (not part of ${p.mainFile})` : scan.root
    const headings = items.filter((i) => i.kind === 'heading')
    empty.classList.toggle('hidden', !p || headings.length > 0 || (showFloats && items.length > 0))
    empty.innerHTML = p?.mainFile || scan
      ? 'No sections yet. Write <code>\\section{Introduction}</code> in your text and it appears here.'
      : 'No main <code>.tex</code> file found. Right-click a <code>.tex</code> file under Files and choose “Set as main file”.'
    // Total words per heading: its own plus its subsections'.
    const total = items.map((it, i) => {
      if (it.kind !== 'heading') return 0
      let n = it.words
      for (let j = i + 1; j < items.length && !(items[j].kind === 'heading' && items[j].level <= it.level); j++) n += items[j].words
      return n
    })
    const stack: number[] = []
    let hideBelow = Infinity // inside a collapsed heading: hide items deeper than this
    const out: HTMLElement[] = []
    items.forEach((it, i) => {
      if (it.kind === 'heading') while (stack.length && stack[stack.length - 1] >= it.level) stack.pop()
      const depth = stack.length
      if (it.kind === 'heading' && it.level <= hideBelow) hideBelow = Infinity
      const hidden = it.kind === 'heading' ? hideBelow < it.level : hideBelow !== Infinity
      if (it.kind === 'heading') stack.push(it.level)
      if (hidden || (it.kind !== 'heading' && !showFloats)) return
      let next = i + 1 // the next item that would be shown
      while (next < items.length && items[next].kind !== 'heading' && !showFloats) next++
      const hasKids = it.kind === 'heading' && next < items.length && (items[next].kind !== 'heading' || items[next].level > it.level)
      const isCollapsed = it.kind === 'heading' && collapsed.has(keyOf(it))
      if (isCollapsed && hasKids) hideBelow = it.level
      const li = document.createElement('li')
      li.className = `ol-item ol-${it.kind} ol-${it.cmd}${it.starred ? ' starred' : ''}`
      li.style.setProperty('--depth', String(depth))
      const where = `${it.file}:${it.line}`
      if (it.kind === 'heading') {
        li.innerHTML = `<button class="ol-twist${hasKids ? '' : ' none'}${isCollapsed ? ' closed' : ''}" tabindex="-1">${ICON.twist}</button><span class="ol-title"></span><span class="ol-words"></span>`
        li.querySelector('.ol-title')!.textContent = it.title
        const w = total[i]
        li.querySelector('.ol-words')!.textContent = w ? w.toLocaleString() : ''
        li.title = `${it.title}\n${where}${w ? ` · ${w.toLocaleString()} words` : ''}${it.starred && it.cmd !== 'abstract' ? ' · not numbered' : ''}`
        li.querySelector<HTMLButtonElement>('.ol-twist')!.onclick = (e) => {
          e.stopPropagation()
          if (!hasKids) return
          const k = keyOf(it)
          if (collapsed.has(k)) collapsed.delete(k)
          else collapsed.add(k)
          render()
        }
      } else {
        li.innerHTML = `<span class="ol-icon">${ICON[it.kind === 'missing' ? 'missing' : (it.cmd as 'figure' | 'table')]}</span><span class="ol-title"></span><span class="ol-label"></span>`
        const what = it.kind === 'missing' ? `File not found: ${it.title}` : it.title || (it.cmd === 'table' ? 'Table without a caption' : 'Figure without a caption')
        li.querySelector('.ol-title')!.textContent = what
        li.querySelector('.ol-label')!.textContent = it.label
        li.title = `${what}${it.label ? `\n\\label{${it.label}}` : ''}\n${where}`
      }
      li.onclick = () => void host.goTo(it.file, it.line)
      out.push(li)
      rows.push({ el: li, idx: i })
    })
    list.replaceChildren(...out)
    highlight()
  }

  /** Highlight the section the cursor is in (or the nearest shown item above it). */
  function highlight(): void {
    const active = host.active()
    const pos = host.cursor()
    let cur = -1
    if (scan && active && pos != null) {
      const m = scan.marks.get(active)
      if (m) {
        let idx = m[0].idx
        for (const k of m) if (k.pos <= pos) idx = k.idx
        for (let i = idx - 1; i >= 0; i--) if (scan.items[i].kind === 'heading') {
          cur = i
          break
        }
      }
    }
    // If that heading is folded away, light up the visible heading that contains it.
    let row = -1
    for (let r = rows.length - 1; r >= 0; r--) if (rows[r].idx <= cur && scan!.items[rows[r].idx].kind === 'heading') {
      row = r
      break
    }
    if (row === shownCurrent) return
    if (shownCurrent >= 0) rows[shownCurrent]?.el.classList.remove('current')
    shownCurrent = row
    if (row >= 0) {
      const el = rows[row].el
      el.classList.add('current')
      const box = body.getBoundingClientRect() // the scrolling box
      const r = el.getBoundingClientRect()
      if (box.height && (r.top < box.top || r.bottom > box.bottom)) el.scrollIntoView({ block: 'nearest' })
    }
  }

  let frame = 0
  const extension = EditorView.updateListener.of((u) => {
    if (!u.selectionSet || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      highlight()
    })
  })

  return { schedule, extension }
}
