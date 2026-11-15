// File → Export Review PDF…: the paper as a PDF for co-authors and supervisors who don't use LaTeX.
// The comments become notes in a wider right margin, with the commented text highlighted, and the
// changes since an earlier version can be marked (added words underlined in blue, removed words
// struck through in red). Like Export to Word, the project's own files are never changed: the paper
// is copied to a temporary folder, marked up there, compiled there, and only the PDF comes back.
//
// Only standard LaTeX is used (xcolor, ulem and \marginpar), so it works with a basic TeX install
// such as BasicTeX or TinyTeX. latexdiff is used for the change marks when it is installed.
// If the marked-up copy doesn't compile, simpler versions are tried, down to the plain paper.
//
// This file is loaded only when an export starts (see review-pdf.ts).

import { spawn } from 'child_process'
import { constants as fsc, existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'path'
import { diffLines, diffSeq, Run } from '../shared/history'
import type { Engine, TexInfo } from '../shared/types'
import type { Project } from './project'
import { compile } from './tex'
import { noGoZones, safeSpot } from './word-export'

export interface ReviewComment {
  file: string // project-relative .tex file
  from: number // where the commented text is in that file, as saved
  to: number
  quote: string
  author: string
  date: string
  text: string
  replies: { author: string; date: string; text: string }[]
  resolved: boolean
}

export interface ReviewChangedFile {
  path: string
  status: 'changed' | 'added'
  old: string | null // the text as it was then (null for a new file)
}

export interface ReviewRequest {
  mainFile: string
  engine: Engine
  comments: ReviewComment[]
  changes: { label: string; files: ReviewChangedFile[] } | null // label: "today, 3:12 PM"
}

export interface ReviewResult {
  ok: boolean
  out: string
  error?: string // plain-English reason when ok is false
  details: string[] // the first few LaTeX errors, when they matter
  pages: number
  comments: number // placed in the margin
  commentsMissed: number
  changeMode: 'none' | 'latexdiff' | 'words'
  changedFiles: number // files with marked changes
  changeNotes: number // "Changed here" notes (changes inside equations, tables, commands…)
  notesAtEnd: number // comments listed at the end because they didn't fit in the margin
  leftOut: ('changes' | 'highlights' | 'comments')[] // dropped so the paper would compile
  paperErrors: boolean // the paper has LaTeX errors of its own
  ms: number
}

type Log = (line: string) => void

// ---------- Where text can be added ----------
// A "point" is a place between two characters (point i is just before text[i]). Each point gets one
// of these values:
const OK = 0 // ordinary paragraph text: a margin note or a highlight can go here
const BEFORE = 1 // inside math, a float, a table…: the nearest good spot is just before it
const AFTER = 2 // inside a heading, a caption, \cite{…}, a command name…: the good spot is just after it
const NEVER = 3 // the preamble, after \end{document}, or a file of settings

// Environments that hold ordinary paragraphs. Notes can't go into any other environment (floats,
// tables, minipages, math…), so they move just before it.
const SAFE_ENVS = new Set('document abstract itemize enumerate description quote quotation center flushleft flushright verse proof theorem lemma corollary proposition definition remark example'.split(' '))
const LISTS = new Set(['itemize', 'enumerate', 'description'])
// Commands whose argument is ordinary text that may hold a note or a highlight.
const STYLE = new Set('emph textbf textit textsl textsc textsf textrm textup textmd textnormal'.split(' '))
const VERBATIM = /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|alltt)\}[\s\S]*?(?:\\end\{\1\}|$)/g
const SETTINGS_FILE = /^[^%\n]*\\(?:documentclass|usepackage|RequirePackage|ProvidesPackage|ProvidesFile)\b/m

/** For each point of a .tex file, whether a note may go there (see OK, BEFORE, AFTER, NEVER). */
export function layoutMask(text: string, fragment = false): Uint8Array {
  const n = text.length
  const m = new Uint8Array(n + 1)
  const fill = (v: number, a: number, b: number): void => {
    if (b > a) m.fill(v, Math.max(0, a), Math.min(n + 1, b))
  }
  // Math, % comments, \verb and verbatim environments. Verbatim text is blanked first so a $ or %
  // inside it doesn't start anything.
  const verb: [number, number][] = []
  const scan = text.replace(VERBATIM, (s: string, _name: string, at: number) => {
    verb.push([at, at + s.length])
    return ' '.repeat(s.length)
  })
  const zones = [...noGoZones(scan), ...verb]
  const skip = new Uint8Array(n)
  for (const [a, b] of zones) {
    skip.fill(1, a, b)
    fill(BEFORE, a + 1, b)
  }
  const isLetter = (c: string | undefined): boolean => !!c && /[A-Za-z@]/.test(c)
  const blankAt = (i: number): boolean => text[i] === '\n' && /^[ \t]*\n/.test(text.slice(i + 1, i + 40))
  /** Skip a `*` and [optional] arguments after a command; returns where they end. */
  const optArgs = (k: number): number => {
    let j = k
    for (;;) {
      let t = j
      while (t < n && (text[t] === ' ' || text[t] === '\t' || (text[t] === '\n' && !blankAt(t)))) t++
      if (text[t] === '*' && t === j) {
        j = t + 1
        continue
      }
      if (text[t] !== '[') break
      let d = 0
      let u = t + 1
      for (; u < n; u++) {
        if (skip[u]) continue
        if (text[u] === '{') d++
        else if (text[u] === '}') d--
        else if (text[u] === ']' && d <= 0) break
      }
      if (u >= n) break
      j = u + 1
    }
    return j
  }

  interface Env {
    name: string
    start: number
    safe: boolean
    itemFrom: number // lists: from here to the first \item nothing may go
  }
  const envs: Env[] = []
  const groups: { start: number; owner: string | null }[] = []
  let pending = -1 // index of a `{` that is the argument of pendingName
  let pendingName = ''
  let lastClose = -1
  let lastOwner: string | null = null

  for (let i = 0; i < n; i++) {
    if (skip[i]) continue
    const c = text[i]
    if (c === '\\') {
      if (i + 1 >= n) break
      if (!isLetter(text[i + 1])) {
        // \\, \%, \, …: nothing between the backslash and its character, nor before a \\[2pt].
        fill(AFTER, i + 1, i + 2)
        const k = text[i + 1] === '\\' ? optArgs(i + 2) : i + 2
        fill(AFTER, i + 2, k)
        i = k - 1
        continue
      }
      let j = i + 1
      while (j < n && isLetter(text[j])) j++
      const name = text.slice(i + 1, j)
      if (name === 'begin' || name === 'end') {
        const env = /^\s*\{([^{}]*)\}/.exec(text.slice(j, j + 80))
        if (env) {
          const envName = env[1].trim()
          const tokEnd = j + env[0].length
          if (name === 'begin') {
            const k = optArgs(tokEnd)
            fill(AFTER, i + 1, k)
            const parentSafe = !envs.length || envs[envs.length - 1].safe
            envs.push({ name: envName, start: i, safe: parentSafe && SAFE_ENVS.has(envName.replace(/\*$/, '')), itemFrom: LISTS.has(envName) ? k : -1 })
            i = k - 1
          } else {
            let e = envs.length - 1
            while (e >= 0 && envs[e].name !== envName) e--
            if (e >= 0) {
              const open = envs[e]
              envs.length = e
              if (open.itemFrom >= 0) fill(AFTER, open.itemFrom, i) // a list without items
              if (open.safe) fill(AFTER, i + 1, tokEnd)
              else fill(BEFORE, open.start + 1, tokEnd)
            } else fill(AFTER, i + 1, tokEnd)
            i = tokEnd - 1
          }
          continue
        }
      }
      const k = optArgs(j)
      fill(AFTER, i + 1, j) // inside the command name
      let t = k
      while (t < n && (text[t] === ' ' || text[t] === '\t' || (text[t] === '\n' && !blankAt(t)))) t++
      if (text[t] === '{') {
        fill(AFTER, j, t + 1) // between the command and its argument
        pending = t
        pendingName = name
      } else fill(AFTER, j, k)
      if (name === 'item' && envs.length) {
        const top = envs[envs.length - 1]
        if (top.itemFrom >= 0) {
          fill(AFTER, top.itemFrom, k)
          top.itemFrom = -1
        }
      }
      i = (text[t] === '{' ? t : k) - 1
      continue
    }
    if (c === '{') {
      let owner: string | null = null
      if (pending === i) owner = pendingName
      else {
        // A further argument of the command whose argument just closed (\href{url}{text}).
        let t = i - 1
        while (t >= 0 && (text[t] === ' ' || text[t] === '\t')) t--
        if (t === lastClose && lastOwner && !STYLE.has(lastOwner)) owner = lastOwner
      }
      pending = -1
      groups.push({ start: i, owner })
      continue
    }
    if (c === '}') {
      const g = groups.pop()
      if (!g) continue
      if (g.owner && !STYLE.has(g.owner)) fill(AFTER, g.start, i + 1)
      lastClose = i
      lastOwner = g.owner
    }
  }
  for (const e of envs) if (!e.safe) fill(BEFORE, e.start + 1, n + 1)
  for (const g of groups) if (g.owner && !STYLE.has(g.owner)) fill(AFTER, g.start, n + 1)

  if (!fragment) {
    const find = (s: string): number => {
      for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) if (!skip[i]) return i
      return -1
    }
    const begin = find('\\begin{document}')
    if (begin >= 0) fill(NEVER, 0, begin + '\\begin{document}'.length)
    else if (SETTINGS_FILE.test(scan)) fill(NEVER, 0, n + 1)
    const end = find('\\end{document}')
    if (end >= 0) fill(NEVER, end + 1, n + 1)
  }
  return m
}

/** The nearest point where a note can go, or null if there is none (the preamble, say). */
function settle(mask: Uint8Array, p: number): number | null {
  const n = mask.length - 1
  p = Math.max(0, Math.min(n, p))
  if (mask[p] === OK) return p
  if (mask[p] === NEVER) return null
  let a = p
  while (a > 0 && mask[a - 1] !== OK) a--
  let b = p
  while (b < n && mask[b + 1] !== OK) b++
  const before = a > 0 && !mask.subarray(a, p).includes(NEVER) ? a - 1 : null
  const after = b < n && !mask.subarray(p, b + 1).includes(NEVER) ? b + 1 : null
  return mask[p] === BEFORE ? (before ?? after) : (after ?? before)
}

// Characters that can be underlined or highlighted as they are (no commands, groups or math).
const PLAIN = /[^\\{}$%&#^_~[\]"\x00-\x08\x0b-\x1f\x7f]/
const STYLE_LEFTOVER = /\\(?:emph|textbf|textit|textsl|textsc|textsf|textrm|textup|textmd|textnormal)\b|[\s{}~]/g
const REFS = /\\(?:cite[A-Za-z]*|[cC]?ref|eqref|autoref|pageref|label)\*?(?:\s*\[[^\]]*\])*\s*\{[^{}]*\}/g

/** Stretches of plain text in text[a, b) that sit where a highlight may go. */
function plainRuns(text: string, a: number, b: number, mask: Uint8Array): [number, number][] {
  const out: [number, number][] = []
  let s = -1
  const push = (x: number, y: number): void => {
    while (x < y && /\s/.test(text[x])) x++
    while (y > x && /\s/.test(text[y - 1])) y--
    if (x < y && /[\p{L}\p{N}]/u.test(text.slice(x, y))) out.push([x, y])
  }
  for (let i = a; i <= b; i++) {
    const ok = i < b && PLAIN.test(text[i]) && mask[i] === OK && mask[i + 1] === OK && !(text[i] === '\n' && /^[ \t]*\n/.test(text.slice(i + 1, i + 40)))
    if (ok && s < 0) s = i
    else if (!ok && s >= 0) {
      push(s, i)
      s = -1
    }
  }
  return out
}

/** What's left of text[a, b) outside the runs, ignoring spaces, braces and style commands. */
function leftover(text: string, a: number, b: number, runs: [number, number][], refsOk = true): string {
  let rest = ''
  let at = a
  for (const [x, y] of runs) {
    rest += text.slice(at, x)
    at = y
  }
  // Added citations and cross-references next to underlined words speak for themselves (removed ones don't).
  return (rest + text.slice(at, b)).replace(refsOk ? REFS : /(?!)/g, '').replace(STYLE_LEFTOVER, '')
}

// ---------- Writing LaTeX ----------
const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', $: '\\$', '&': '\\&', '#': '\\#', '^': '\\^{}', _: '\\_', '~': '\\textasciitilde{}', '%': '\\%',
  '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}', '"': "''", '‘': '`', '’': "'", '“': '``', '”': "''", '–': '--', '—': '---', '…': '\\ldots{}', '\u00a0': '~',
  ß: '\\ss{}', æ: '\\ae{}', Æ: '\\AE{}', ø: '\\o{}', Ø: '\\O{}', å: '\\aa{}', Å: '\\AA{}', œ: '\\oe{}', Œ: '\\OE{}', ł: '\\l{}', Ł: '\\L{}', '¡': '!`', '¿': '?`', '£': '\\pounds{}', '©': '\\copyright{}', '°': '\\textdegree{}', µ: '\\textmu{}', '×': '\\texttimes{}', '•': '\\textbullet{}'
}
const ACCENT: Record<string, string> = { '\u0301': "'", '\u0300': '`', '\u0302': '^', '\u0308': '"', '\u0303': '~', '\u0304': '=', '\u0307': '.', '\u0306': 'u', '\u030c': 'v', '\u030b': 'H', '\u0327': 'c', '\u030a': 'r' }

/** Plain text as LaTeX. With pdflatex, characters it can't print become "?" rather than an error. */
function esc(s: string, unicode: boolean): string {
  let out = ''
  for (const ch of s.replace(/\r/g, '')) {
    if (ch === '\n') out += '\\otrvpar '
    else if (SPECIAL[ch]) out += SPECIAL[ch]
    else if (ch < ' ') continue
    else if (ch <= '~' || unicode) out += ch
    else {
      const d = ch.normalize('NFD')
      out += d.length === 2 && /[A-Za-z]/.test(d[0]) && ACCENT[d[1]] ? `\\${ACCENT[d[1]]}{${d[0]}}` : '?'
    }
  }
  return out
}

const plainify = (s: string): string =>
  s
    .replace(/\\[A-Za-z@]+\*?(?=\s*[{[])/g, ' ') // \emph{…} and the like: keep what they hold
    .replace(/\\([A-Za-z]+)/g, '$1') // \tau → tau
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const shorten = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean)
  if (!w.length) return '?'
  if (w.length === 1) return w[0].slice(0, 2)
  return w
    .slice(0, 3)
    .map((x) => x[0].toUpperCase())
    .join('')
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
function niceDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}` : d
}

/** Added to the main file just before \begin{document}. */
function preamble(legend: string): string {
  return String.raw`
%% ---- Added by OpenTex for the review copy (not in your files) ----
\makeatletter
\@ifpackageloaded{xcolor}{}{\usepackage{xcolor}}
\@ifpackageloaded{ulem}{}{\usepackage[normalem]{ulem}}
\definecolor{otrvHl}{HTML}{FFE58A}
\definecolor{otrvC}{HTML}{D9A400}
\definecolor{otrvR}{HTML}{9E9E9E}
\definecolor{otrvX}{HTML}{E06C00}
\definecolor{otrvIns}{HTML}{1F5FBF}
\definecolor{otrvDel}{HTML}{C62828}
\newcommand\otrvpar{\par}% a paragraph break that may sit inside \emph{…} and similar arguments
\newcommand\otrvhl{\bgroup\markoverwith{\textcolor{otrvHl}{\rule[-.6ex]{2pt}{2.7ex}}}\ULon}
\newcommand\otrvins[1]{{\color{otrvIns}\uline{#1}}}
\newcommand\otrvdel[1]{{\color{otrvDel}\sout{#1}}\kern.15em}
\newcommand\otrvboxw[3]{{\setlength\fboxsep{3pt}\setlength\fboxrule{.5pt}\fcolorbox{#2}{#2!10}{\parbox{\dimexpr#1-2\fboxsep-2\fboxrule\relax}{\raggedright\sffamily\scriptsize #3}}}}
\newcommand\otrvbox{\otrvboxw\marginparwidth}
% \otrvnote{id}{number shown in the text}{colour}{text}. Each note records where it ended up on the
% page; a note that ran off the bottom of a page goes to a list at the end on the next run instead.
\def\otrv@at#1#2#3{\ifdim#2sp<.25in\relax\global\@namedef{otrv@over@#1}{#3}\fi}
\let\otrv@rest\@empty
\ifdefined\pdfsavepos\let\otrv@savepos\pdfsavepos\let\otrv@ypos\pdflastypos\else\ifdefined\savepos\let\otrv@savepos\savepos\let\otrv@ypos\lastypos\fi\fi
\def\otrv@pos#1{\ifdefined\otrv@savepos\par\otrv@savepos\write\@auxout{\string\otrv@at{#1}{\the\otrv@ypos}{\thepage}}\write16{\ifdim\the\otrv@ypos sp<.25in Rerun to get the OpenTex review notes right.\fi}\fi}
\newcommand\otrvnote[4]{\typeout{OPENTEX-NOTE #1}%
  \ifhmode\ifx\relax#2\relax\else\textsuperscript{\textcolor{#3!80!black}{\sffamily\bfseries #2}}\fi\fi
  \ifcsname otrv@over@#1\endcsname
    \@bsphack\protected@write\@auxout{}{\string\otrv@at{#1}{-1}{\thepage}}\@esphack
    \g@addto@macro\otrv@rest{\otrv@restitem{#1}{#3}{#4}}%
  \else\marginpar{\otrvbox{#3}{#4}\otrv@pos{#1}}\fi}
\def\otrv@restitem#1#2#3{\par\noindent\otrvboxw\linewidth{#2}{\textbf{Page \csname otrv@over@#1\endcsname}\enspace #3}\par\smallskip}
\AtEndDocument{\ifx\otrv@rest\@empty\else\par\bigskip\noindent{\sffamily\bfseries\small Notes that didn't fit in the margin}\par\nopagebreak\smallskip\otrv@rest\fi}
\newdimen\otrv@w
\def\otrv@layout{%
  \dimen@=\dimexpr\paperwidth-1in-\hoffset-\oddsidemargin-\textwidth\relax
  \if@twocolumn
    \otrv@w=2in \global\advance\hoffset\otrv@w \global\advance\paperwidth2\otrv@w
    \ifdim\dimexpr1in+\hoffset+\oddsidemargin-\otrv@w<\dimen@ \dimen@=\dimexpr1in+\hoffset+\oddsidemargin-\otrv@w\relax\fi
  \else
    \otrv@w=2.4in \global\@mparswitchfalse \global\evensidemargin\oddsidemargin \global\advance\paperwidth\otrv@w
  \fi
  \global\marginparsep=14pt
  \global\marginparwidth=\dimexpr\dimen@+\otrv@w-\marginparsep-.3in\relax
  \global\marginparpush=4pt
  \ifdefined\pdfpagewidth\global\pdfpagewidth\paperwidth\fi
  \ifdefined\pagewidth\global\pagewidth\paperwidth\fi}
\ifdefined\AddToHook\AddToHook{begindocument/end}{\otrv@layout}\else\AtBeginDocument{\otrv@layout}\fi
\ifdefined\AddToHookNext\AddToHookNext{shipout/foreground}{\put(0,0){\kern\dimexpr1in+\oddsidemargin+\textwidth+\marginparsep\relax\lower.55in\hbox{\otrvbox{otrvR}{${legend}}}}}\fi
\makeatother
%% ---- End of OpenTex additions ----
`
}

// ---------- Marking up one file ----------
interface Point {
  at: number
  s: string
}
interface Span {
  a: number
  b: number
  kind: 'ins' | 'hl'
}

/** Insert notes and wrap highlighted/added text. Wraps never overlap, and never contain a note. */
function render(text: string, points: Point[], spans: Span[]): string {
  const cuts = new Set(points.map((p) => p.at))
  const cover = new Uint8Array(text.length)
  const ins: { at: number; rank: number; s: string; seq: number }[] = []
  let seq = 0
  for (const kind of ['ins', 'hl'] as const) {
    for (const sp of spans) {
      if (sp.kind !== kind) continue
      let start = -1
      const push = (x: number, y: number): void => {
        while (x < y && /\s/.test(text[x])) x++
        while (y > x && /\s/.test(text[y - 1])) y--
        if (x >= y || !/[\p{L}\p{N}]/u.test(text.slice(x, y))) return
        cover.fill(1, x, y)
        ins.push({ at: x, rank: 2, s: kind === 'ins' ? '\\otrvins{' : '\\otrvhl{', seq: seq++ }, { at: y, rank: 0, s: '}', seq: seq++ })
      }
      for (let i = sp.a; i <= sp.b; i++) {
        const stop = i === sp.b || cover[i] === 1 || (i > sp.a && cuts.has(i))
        if (stop && start >= 0) {
          push(start, i)
          start = -1
        }
        if (i < sp.b && !cover[i] && start < 0) start = i
      }
    }
  }
  for (const p of points) ins.push({ at: p.at, rank: 1, s: p.s, seq: seq++ })
  ins.sort((x, y) => x.at - y.at || x.rank - y.rank || x.seq - y.seq)
  let out = ''
  let last = 0
  for (const x of ins) {
    out += text.slice(last, x.at) + x.s
    last = x.at
  }
  return out + text.slice(last)
}

function lineStarts(s: string): number[] {
  const out = [0]
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) out.push(i + 1)
  return out
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu

/** Word-level change marks for one file: added text underlined, removed text struck through, and a
 *  "Changed here" spot for each change that can't be shown word by word. */
function markChanges(old: string, cur: string, mask: Uint8Array): { points: Point[]; spans: Span[]; flagged: number[]; marked: boolean } {
  const points: Point[] = []
  const spans: Span[] = []
  const flagged: number[] = []
  let marked = false
  const { a: A, b: B, runs } = diffLines(old, cur)
  const starts = lineStarts(cur)
  const lineEnd = (k: number): number => starts[k] + B[k].length
  let bad = false

  const insSpan = (s: number, e: number): void => {
    if (!/\S/.test(cur.slice(s, e)) || mask[s] === NEVER) return
    const rs = plainRuns(cur, s, e, mask)
    for (const [x, y] of rs) spans.push({ a: x, b: y, kind: 'ins' })
    if (rs.length) marked = true
    if (leftover(cur, s, e, rs)) bad = true
  }
  const delText = (t: string, at: number, lead: string): void => {
    if (!/\S/.test(t) || mask[at] === NEVER) return
    const rs = plainRuns(t, 0, t.length, layoutMask(t, true))
    const struck = rs.map(([x, y]) => t.slice(x, y).replace(/\s+/g, ' ')).join(' ')
    if (struck && mask[at] === OK) {
      const space = !lead && /^\s/.test(t) && at > 0 && !/\s/.test(cur[at - 1]) ? ' ' : ''
      points.push({ at, s: `${lead || space}\\otrvdel{${struck}}` })
      marked = true
    } else if (struck) bad = true
    if (leftover(t, 0, t.length, rs, false)) bad = true
  }
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) ids.set(s, (v = ids.size))
    return v
  }
  const words = (oldLine: string, newLine: string, base: number): void => {
    const ta = oldLine.match(TOKEN) ?? []
    const tb = newLine.match(TOKEN) ?? []
    // Word runs, then tidied the way a person would mark them: a rewritten phrase reads better as
    // one struck-out phrase and one underlined phrase than as shreds around shared little words.
    let parts = diffSeq(Int32Array.from(ta, id), Int32Array.from(tb, id), 300).map((r) => ({
      kind: r.kind,
      old: r.kind === 'ins' ? '' : ta.slice(r.a, r.a + r.n).join(''),
      now: r.kind === 'del' ? '' : tb.slice(r.b, r.b + r.n).join('')
    }))
    const small = (s: string): boolean => s.trim().length <= 3 || (s.trim().split(/\s+/).length === 1 && s.trim().length <= 6)
    for (let i = 1; i < parts.length - 1; i++) if (parts[i].kind === 'eq' && parts[i - 1].kind !== 'eq' && parts[i + 1].kind !== 'eq' && small(parts[i].now)) parts[i] = { ...parts[i], kind: 'ins' }
    const merged: typeof parts = []
    for (const p of parts) {
      const last = merged[merged.length - 1]
      if (last && last.kind !== 'eq' && p.kind !== 'eq') merged[merged.length - 1] = { kind: 'ins', old: last.old + p.old, now: last.now + p.now }
      else merged.push(p)
    }
    parts = merged
    let pos = base
    for (const p of parts) {
      if (p.kind !== 'eq') {
        if (p.old.trim() !== p.now.trim()) {
          delText(p.old, pos, '')
          insSpan(pos, pos + p.now.length)
        }
      }
      pos += p.now.length
    }
  }

  for (let ri = 0; ri < runs.length; ) {
    if (runs[ri].kind === 'eq') {
      ri++
      continue
    }
    const dels: number[] = []
    const inss: number[] = []
    const firstNew = runs[ri].b
    for (; ri < runs.length && runs[ri].kind !== 'eq'; ri++) {
      const r = runs[ri]
      for (let k = 0; k < r.n; k++) (r.kind === 'del' ? dels : inss).push(r.kind === 'del' ? r.a + k : r.b + k)
    }
    const blockAt = firstNew < B.length ? starts[firstNew] : cur.length
    bad = false
    const pairs = Math.min(dels.length, inss.length)
    for (let k = 0; k < pairs; k++) {
      // Lines too different to compare word by word are treated as removed and added.
      if (A[dels[k]].length > 4000 || B[inss[k]].length > 4000) {
        delText(A[dels[k]], starts[inss[k]], '')
        insSpan(starts[inss[k]], lineEnd(inss[k]))
      } else words(A[dels[k]], B[inss[k]], starts[inss[k]])
    }
    for (let k = pairs; k < inss.length; k++) insSpan(starts[inss[k]], lineEnd(inss[k]))
    if (dels.length > pairs) {
      const gone = dels.slice(pairs).map((i) => A[i]).join('\n')
      if (pairs) delText(gone, lineEnd(inss[pairs - 1]), ' ')
      else delText(gone, blockAt, '')
    }
    if (bad) flagged.push(inss.length ? starts[inss[0]] : blockAt)
  }
  return { points, spans, flagged, marked }
}

// ---------- latexdiff ----------
function capture(cmd: string, args: string[], cwd: string, binDir: string, ms: number): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const chunks: Buffer[] = []
    const p = spawn(cmd, args, { cwd, env: { ...process.env, PATH: binDir + delimiter + (process.env.PATH ?? '') }, windowsHide: true })
    const timer = setTimeout(() => p.kill(), ms)
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.stderr.on('data', () => {})
    p.on('error', () => {
      clearTimeout(timer)
      done({ code: -1, out: '' })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code ?? -1, out: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

/** latexdiff, if it is installed next to the TeX programs and runs (it needs Perl). */
export async function latexdiffPath(binDir: string): Promise<string | null> {
  const p = join(binDir, process.platform === 'win32' ? 'latexdiff.exe' : 'latexdiff')
  if (!existsSync(p)) return null
  return (await capture(p, ['--version'], tmpdir(), binDir, 20000)).code === 0 ? p : null
}

/** latexdiff's own definitions (\DIFadd…), for files that have no preamble of their own. */
async function latexdiffPreamble(tool: string, dir: string, binDir: string): Promise<string> {
  const doc = (w: string): string => `\\documentclass{article}\n\\begin{document}\n${w}\n\\end{document}\n`
  await fs.writeFile(join(dir, 'ld-a.tex'), doc('one'))
  await fs.writeFile(join(dir, 'ld-b.tex'), doc('two'))
  const r = await capture(tool, ['--type=UNDERLINE', 'ld-a.tex', 'ld-b.tex'], dir, binDir, 60000)
  const m = /%DIF PREAMBLE EXTENSION ADDED BY LATEXDIFF[\s\S]*?%DIF END PREAMBLE EXTENSION ADDED BY LATEXDIFF/.exec(r.out)
  return m ? m[0] : ''
}

/** Run latexdiff on one file. Notes are carried through it as marker words placed in both texts. */
async function latexdiffFile(tool: string, dir: string, binDir: string, old: string, cur: string, mask: Uint8Array, notes: Point[], k: number): Promise<{ text: string; missed: number } | null> {
  const { runs } = diffLines(old, cur)
  const cs = lineStarts(cur)
  const os = lineStarts(old)
  const toOld = (p: number): number | null => {
    let lo = 0
    let hi = cs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cs[mid] <= p) lo = mid
      else hi = mid - 1
    }
    const line = lo
    const r = runs.find((x: Run) => line >= x.b && line < x.b + x.n && x.kind !== 'del')
    if (!r || r.kind !== 'eq') return null
    return os[r.a + line - r.b] + (p - cs[line])
  }
  const mark = (i: number): string => `OTRVMK${i}X`
  const glue = (t: string, at: number): string => (/\\[A-Za-z@]+$/.test(t.slice(Math.max(0, at - 40), at)) ? '{}' : '')
  const oldPts: Point[] = []
  const curPts: Point[] = []
  let missed = 0
  notes.forEach((n, i) => {
    const o = mask[n.at] === OK ? toOld(n.at) : null
    if (o === null) {
      missed++
      return
    }
    curPts.push({ at: n.at, s: glue(cur, n.at) + mark(i) })
    oldPts.push({ at: o, s: glue(old, o) + mark(i) })
  })
  const a = join(dir, `ld-old-${k}.tex`)
  const b = join(dir, `ld-new-${k}.tex`)
  await fs.writeFile(a, render(old, oldPts, []))
  await fs.writeFile(b, render(cur, curPts, []))
  const r = await capture(tool, ['--type=UNDERLINE', a, b], dir, binDir, 120000)
  if (r.code !== 0 || !r.out.trim()) return null
  // A marker latexdiff counted as removed or added is dropped; the rest become the notes.
  let text = r.out.replace(/\\DIF(?:del|add)\{[^{}]*\}/g, (s) => s.replace(/OTRVMK\d+X/g, ''))
  const used = new Set<number>()
  text = text.replace(/(?:\{\})?OTRVMK(\d+)X/g, (_s, i: string) => {
    const n = Number(i)
    if (used.has(n) || !notes[n]) return ''
    used.add(n)
    return notes[n].s
  })
  return { text, missed: missed + curPts.length - used.size }
}

// ---------- Copying the project ----------
const SKIP_DIRS = new Set(['.git', 'node_modules', '.opentex', '.svn', '.hg', '__pycache__'])
const BUILD = /\.(aux|log|fls|fdb_latexmk|synctex\.gz|synctex|out|toc|lof|lot|bbl|blg|bcf|run\.xml|xdv|nav|snm|vrb|idx|ind|ilg|glo|gls|glg|ist|dvi)$/i
const MAX_COPY = 200 * 1024 * 1024

async function copyProject(root: string, dest: string, leaveOut: string[]): Promise<void> {
  const skip = new Set(leaveOut.map((p) => resolve(p)))
  await fs.cp(root, dest, {
    recursive: true,
    dereference: true,
    mode: fsc.COPYFILE_FICLONE, // instant on APFS and other copy-on-write disks
    filter: async (src) => {
      if (src === root) return true
      const name = basename(src)
      const st = await fs.stat(src).catch(() => null)
      if (!st) return false
      if (st.isDirectory()) return !SKIP_DIRS.has(name) && !name.startsWith('.')
      if (skip.has(resolve(src)) || BUILD.test(name) || name === 'comments.opentex.json') return false
      if (name.startsWith('.') && name !== '.latexmkrc') return false
      return st.size <= MAX_COPY
    }
  })
}

/** Build products from an earlier attempt, so the next one starts clean. */
async function cleanBuild(dir: string, depth = 0): Promise<void> {
  if (depth > 8) return
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await cleanBuild(p, depth + 1)
    else if (BUILD.test(e.name)) await fs.unlink(p).catch(() => {})
  }
}

/**
 * Papers sometimes take files from beside the project folder (\input{../shared/macros}). TeX looks
 * for those relative to the copy, so the folders they name are linked in next to it (up to two
 * levels up). TeX only reads them; nothing is written there.
 */
async function linkOutside(root: string, mirror: string, mainDir: string): Promise<void> {
  const refs = new Set<string>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (/\.(tex|sty|cls|bib)$/i.test(e.name)) {
        const text = await fs.readFile(p, 'utf8').catch(() => '')
        for (const m of text.matchAll(/(?:\.\.[\\/])+[^\s{},%]+/g)) refs.add(m[0])
      }
    }
  }
  await walk(mirror, 0)
  const up1 = dirname(root)
  const up2 = dirname(up1)
  const m1 = dirname(mirror)
  const m2 = dirname(m1)
  const under = (p: string, dir: string): boolean => p.startsWith(dir + sep)
  for (const ref of refs) {
    const target = resolve(mainDir, ref)
    if (target === root || under(target, root)) continue
    let from = ''
    let to = ''
    if (under(target, up1)) {
      const seg = relative(up1, target).split(sep)[0]
      ;[from, to] = [join(up1, seg), join(m1, seg)]
    } else if (under(target, up2)) {
      const seg = relative(up2, target).split(sep)[0]
      if (seg === basename(up1)) continue
      ;[from, to] = [join(up2, seg), join(m2, seg)]
    } else continue
    if (existsSync(to) || !existsSync(from)) continue
    const isDir = (await fs.stat(from)).isDirectory()
    await fs.symlink(from, to, isDir ? 'junction' : 'file').catch(() => (isDir ? undefined : fs.copyFile(from, to).catch(() => {})))
  }
}

// ---------- The export ----------
interface Variant {
  changes: 'none' | 'latexdiff' | 'words'
  highlights: boolean
  comments: boolean
}

export async function buildReviewPdf(project: Project, req: ReviewRequest, out: string, tex: TexInfo, useLatexmk: boolean, log: Log): Promise<ReviewResult> {
  const t0 = Date.now()
  const result: ReviewResult = {
    ok: false,
    out,
    details: [],
    pages: 0,
    comments: 0,
    commentsMissed: req.comments.length,
    changeMode: 'none',
    changedFiles: 0,
    changeNotes: 0,
    notesAtEnd: 0,
    leftOut: [],
    paperErrors: false,
    ms: 0
  }
  const fail = (error: string, details: string[] = []): ReviewResult => ({ ...result, error, details, ms: Date.now() - t0 })
  const root = project.root
  const mainFile = req.mainFile
  if (!/\.tex$/i.test(mainFile) || !existsSync(project.abs(mainFile))) return fail(`The main file (${mainFile}) can’t be found.`)
  const binDir = tex.binDir!
  const unicode = req.engine !== 'pdflatex'
  const mainStem = project.abs(mainFile).replace(/\.tex$/i, '')
  const tmp = await fs.mkdtemp(join(tmpdir(), 'opentex-review-'))
  try {
    log('Copying the paper to a temporary folder…')
    // The copy sits two folders down, so files the paper takes from beside the project
    // (\input{../shared/macros}) can be linked in at the same relative place.
    const mirror = join(tmp, 'up', 'up', basename(root) || 'paper')
    await copyProject(root, mirror, [out, `${mainStem}.pdf`, `${mainStem}.synctex.gz`])
    await linkOutside(root, mirror, dirname(project.abs(mainFile)))
    const work = join(tmp, 'work')
    await fs.mkdir(work)

    // The files that get marked up, as they are now.
    const isTex = (p: string): boolean => /\.tex$/i.test(p)
    const changed = new Map((req.changes?.files ?? []).filter((f) => isTex(f.path)).map((f) => [f.path, f]))
    const rels = new Set([mainFile, ...req.comments.map((c) => c.file).filter(isTex), ...changed.keys()])
    const texts = new Map<string, string>()
    for (const rel of rels) {
      const t = await fs.readFile(join(mirror, rel), 'utf8').catch(() => null)
      if (t !== null) texts.set(rel, t)
    }
    const masks = new Map<string, Uint8Array>()
    const maskOf = (rel: string): Uint8Array => {
      let m = masks.get(rel)
      if (!m) masks.set(rel, (m = layoutMask(texts.get(rel)!)))
      return m
    }
    const mainText = texts.get(mainFile)!
    if (!/^[^%\n]*\\begin\{document\}/m.test(mainText)) return fail(`OpenTex couldn’t find \\begin{document} in ${mainFile}, so it can’t add the margin notes. Choose the paper’s main file under “Main file” in the status bar and try again.`)

    // Comments: where each note goes, and what it says.
    const label = req.changes?.label ?? ''
    const notesOf = new Map<string, { n: number; at: number; hl: [number, number][] }[]>()
    const noteText = new Map<number, string>()
    const zonesOf = new Map<string, { zones: [number, number][]; skip: Uint8Array }>()
    req.comments.forEach((c, i) => {
      const n = i + 1
      if (!texts.has(c.file)) return
      const text = texts.get(c.file)!
      const mask = maskOf(c.file)
      if (c.from < 0 || c.to > text.length || c.from > c.to) return
      let z = zonesOf.get(c.file)
      if (!z) {
        const zones = noGoZones(text)
        const skip = new Uint8Array(text.length)
        for (const [a, b] of zones) skip.fill(1, a, b)
        zonesOf.set(c.file, (z = { zones, skip }))
      }
      // Word export's marker placement first (out of math, comments and command arguments), then
      // out of floats, headings and the like to the nearest spot a margin note can go.
      const at = settle(mask, safeSpot(text, z.zones, z.skip, c.from, false))
      if (at === null) return
      const moved = mask[c.from] !== OK || Math.abs(at - c.from) > 2
      const color = c.resolved ? 'otrvR' : 'otrvC'
      const date = (d: string): string => `{\\color{black!55}${esc(niceDate(d), unicode)}}`
      let body = `\\textbf{${n}}\\enspace\\textbf{${esc(initials(c.author), unicode)}}\\enspace${date(c.date)}${c.resolved ? '\\enspace\\textit{resolved}' : ''}`
      const quote = shorten(plainify(c.quote), 70)
      if (moved && quote) body += `\\otrvpar{\\itshape\\color{black!60}On \`\`${esc(quote, unicode)}''}`
      body += `\\otrvpar ${esc(c.text.trim(), unicode)}`
      for (const r of c.replies ?? []) {
        body += `\\otrvpar\\smallskip{\\leftskip.8em\\noindent$\\hookrightarrow$\\,\\textbf{${esc(initials(r.author), unicode)}}\\enspace${date(r.date)}\\otrvpar ${esc(r.text.trim(), unicode)}\\otrvpar}`
      }
      noteText.set(n, `\\otrvnote{c${n}}{${n}}{${color}}{${body}}`)
      notesOf.set(c.file, [...(notesOf.get(c.file) ?? []), { n, at, hl: c.to > c.from ? plainRuns(text, c.from, c.to, mask) : [] }])
    })

    // latexdiff, if it's there and changes are wanted.
    const latexdiff = req.changes && changed.size ? await latexdiffPath(binDir) : null
    const ldPreamble = latexdiff ? await latexdiffPreamble(latexdiff, work, binDir) : ''

    const legendFor = (v: Variant): string => {
      const parts = ['\\textbf{Review copy} made with OpenTex']
      if (v.comments && req.comments.length) parts.push('Comments are in the margin')
      if (v.changes !== 'none') parts.push(`Changes since ${esc(label, unicode)}: \\otrvins{added} \\otrvdel{removed}`)
      return parts.join('. ') + '.'
    }

    /** The marked-up texts for one way of exporting. */
    const build = async (v: Variant): Promise<{ files: Map<string, string>; changedFiles: number; changeNotes: number; missed: number }> => {
      const files = new Map<string, string>()
      let changedFiles = 0
      let changeNotes = 0
      let missed = 0
      let k = 0
      let xid = 0
      for (const [rel, text] of texts) {
        const mask = maskOf(rel)
        const notes = v.comments ? (notesOf.get(rel) ?? []) : []
        const points: Point[] = notes.map((x) => ({ at: x.at, s: noteText.get(x.n)! }))
        const spans: Span[] = v.highlights ? notes.flatMap((x) => x.hl.map(([a, b]) => ({ a, b, kind: 'hl' as const }))) : []
        const ch = v.changes !== 'none' ? changed.get(rel) : undefined
        let done: string | null = null
        if (ch?.status === 'added') {
          // Beside the first words of the new file (not its heading, which may share a line with the page before).
          let at: number | null = null
          for (let i = 0; i < text.length && at === null; i++) if (mask[i] === OK && mask[i + 1] === OK && /[\p{L}\p{N}]/u.test(text[i])) at = i
          at ??= settle(mask, 0)
          if (at !== null) {
            points.unshift({ at, s: `\\otrvnote{x${++xid}}{}{otrvIns}{\\textbf{New file} since ${esc(label, unicode)}: ${esc(rel, unicode)}}` })
            changedFiles++
          }
        } else if (ch?.old != null && v.changes === 'latexdiff') {
          const r = await latexdiffFile(latexdiff!, work, binDir, ch.old, text, mask, points, k++)
          if (r) {
            done = r.text
            missed += r.missed
            changedFiles++
          }
        }
        if (done === null && ch?.old != null && v.changes !== 'none') {
          const c = markChanges(ch.old, text, mask)
          points.push(...c.points)
          spans.push(...c.spans)
          const seen = new Set<number>()
          for (const f of c.flagged) {
            const at = settle(mask, f)
            if (at === null || seen.has(at)) continue
            seen.add(at)
            points.push({ at, s: `\\otrvnote{x${++xid}}{}{otrvX}{\\textbf{Changed here}{\\color{black!60}: in an equation, table, figure or command}}` })
            changeNotes++
          }
          if (c.marked || seen.size) changedFiles++
        }
        if (done === null) done = render(text, points, spans)
        if (rel === mainFile) {
          const m = /^[^%\n]*?(\\begin\{document\})/m.exec(done)!
          const at = m.index + m[0].length - m[1].length
          done = done.slice(0, at) + (ldPreamble && v.changes === 'latexdiff' ? ldPreamble + '\n' : '') + preamble(legendFor(v)) + done.slice(at)
        }
        files.set(rel, done)
      }
      return { files, changedFiles, changeNotes, missed }
    }

    let attempt = 0
    /** Compile one version of the copy (null: the paper as it is). Its PDF is kept aside. */
    const tryVariant = async (v: Variant | null): Promise<{ clean: boolean; pdf: string | null; log: string; errors: string[]; atEnd: number; built: Awaited<ReturnType<typeof build>> | null }> => {
      const built = v ? await build(v) : null
      for (const [rel, text] of texts) await fs.writeFile(join(mirror, rel), built?.files.get(rel) ?? text)
      if (attempt++) await cleanBuild(mirror)
      log(attempt === 1 ? 'Compiling the review copy (this takes about as long as a normal compile)…' : 'Compiling again…')
      const r = await compile(mirror, mainFile, req.engine, tex, useLatexmk, { lowPriority: true })
      const errors = r.problems.filter((p) => p.severity === 'error').map((p) => (p.file ? `${p.file}${p.line ? `:${p.line}` : ''}: ` : '') + p.message)
      let pdf: string | null = null
      if (r.pdf) {
        pdf = join(work, `attempt-${attempt}.pdf`)
        await fs.rename(join(mirror, r.pdf), pdf)
      }
      // Notes that didn't fit in the margin and went to the list at the end.
      const aux = await fs.readFile(join(mirror, mainFile.replace(/\.tex$/i, '.aux')), 'utf8').catch(() => '')
      const atEnd = new Set([...aux.matchAll(/\\otrv@at\{(c\d+)\}\{-1\}/g)].map((m) => m[1])).size
      return { clean: !!pdf && !errors.length, pdf, log: r.log, errors, atEnd, built }
    }

    const wantComments = req.comments.length > 0 && notesOf.size > 0
    const wantChanges: Variant['changes'] = req.changes && changed.size ? (latexdiff ? 'latexdiff' : 'words') : 'none'
    if (wantComments) log(`Adding ${req.comments.length} comment${req.comments.length === 1 ? '' : 's'} in the margin…`)
    if (wantChanges !== 'none') log(`Marking the changes since ${label}${latexdiff ? ' with latexdiff' : ''}…`)
    const first: Variant = { changes: wantChanges, highlights: true, comments: wantComments }
    let best = await tryVariant(first)
    let used: Variant | null = first
    if (!best.clean) {
      log('That didn’t compile cleanly. Checking whether the paper compiles on its own…')
      const plain = await tryVariant(null)
      if (!plain.clean) {
        // The paper has errors of its own: keep the fullest PDF there is, as Compile would show it.
        result.paperErrors = true
        result.details = plain.errors.slice(0, 3)
        if (!best.pdf) {
          best = plain
          used = null
        }
        if (!best.pdf) return fail('The paper doesn’t compile at the moment, so there’s no PDF to mark up. Compile it in OpenTex to see what’s wrong, fix that, and export again.', plain.errors.slice(0, 3))
      } else {
        const fallbacks: Variant[] = []
        if (wantChanges === 'latexdiff') fallbacks.push({ changes: 'words', highlights: true, comments: wantComments })
        if (wantChanges !== 'none' && wantComments) fallbacks.push({ changes: 'none', highlights: true, comments: true })
        if (wantComments) fallbacks.push({ changes: 'none', highlights: false, comments: true })
        best = plain
        used = null
        for (const v of fallbacks) {
          log(v.changes === 'words' ? 'Trying again with OpenTex’s own change marks…' : v.highlights ? 'Trying again without the change marks…' : 'Trying again with just the margin notes…')
          const r = await tryVariant(v)
          if (r.clean) {
            best = r
            used = v
            break
          }
        }
      }
    }

    if (!best.pdf) return fail('The PDF couldn’t be made.')
    const texLog = best.log.split(/===== .*\.log =====/).pop() ?? ''
    const placed = new Set([...texLog.matchAll(/OPENTEX-NOTE c(\d+)/g)].map((m) => m[1]))
    result.comments = used?.comments ? placed.size : 0
    result.commentsMissed = req.comments.length - result.comments
    result.notesAtEnd = best.atEnd
    result.pages = Number(/Output written on .*?\((\d+) pages?/.exec(texLog)?.[1] ?? 0)
    if (used && best.built) {
      result.changeMode = used.changes
      result.changedFiles = best.built.changedFiles
      result.changeNotes = best.built.changeNotes
    }
    if (wantChanges !== 'none' && (!used || used.changes === 'none')) result.leftOut.push('changes')
    if (wantComments && (!used || !used.comments)) result.leftOut.push('comments')
    else if (used && !used.highlights && wantComments) result.leftOut.push('highlights')

    log('Saving the PDF…')
    try {
      await fs.copyFile(best.pdf, out)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return fail(
        code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
          ? `OpenTex couldn’t save “${basename(out)}”. If it’s open in another program, close it there and export again, or choose another name.`
          : `OpenTex couldn’t save “${basename(out)}” (${(e as Error).message}).`
      )
    }
    log(`Saved ${out}`)
    return { ...result, ok: true, ms: Date.now() - t0 }
  } catch (e) {
    return fail(`Something went wrong while making the review copy: ${(e as Error).message}`)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
