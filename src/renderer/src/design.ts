// Design presets: switch the look of the whole paper (class, page layout, font, line spacing,
// citation and reference style) by rewriting only the design part of main.tex:
//   - the \documentclass line,
//   - a managed block of design packages, marked with "% ==== OpenTex design: … ====" comments
//     and placed before hyperref (which must load last) or before \begin{document},
//   - the \bibliographystyle{…} line.
// The user's other packages, title, authors and text are never touched. The user's own design lines
// are switched off in place (prefixed "%OpenTex off: ") rather than deleted, and the setup they made
// is saved as "Custom", so choosing Custom restores it exactly, in the same place.

export interface Preset {
  id: string
  name: string
  desc: string
  classLine: string
  block: string[]
  bibstyle: string
  look: { cols: 1 | 2; spacing: 1 | 1.5 | 2; lineNumbers?: boolean; superscript?: boolean }
}

export interface CustomDesign {
  classLine: string
  active: string[] // the user's design lines that were in effect (switched off while a preset is used)
  block: string[] // a modified preset block, if that's what the setup was
  bibstyle: string | null
}

const OFF = '%OpenTex off: '

export const PRESETS: Preset[] = [
  {
    id: 'article',
    name: 'Article',
    desc: 'OpenTex’s default: one column, 11 pt, 1-inch margins, numbered references [1].',
    classLine: '\\documentclass[11pt]{article}',
    block: ['\\usepackage[margin=1in]{geometry}'],
    bibstyle: 'plain',
    look: { cols: 1, spacing: 1 }
  },
  {
    id: 'nature',
    name: 'Nature-style',
    desc: 'One column, Times, 1.5 line spacing, superscript citations¹, references in the order cited.',
    classLine: '\\documentclass[11pt]{article}',
    block: ['\\usepackage[a4paper,margin=2.5cm]{geometry}', '\\renewcommand{\\rmdefault}{ptm} % Times for the text', '\\usepackage{setspace}', '\\onehalfspacing', '\\usepackage[numbers,super,sort&compress]{natbib}'],
    bibstyle: 'unsrtnat',
    look: { cols: 1, spacing: 1.5, superscript: true }
  },
  {
    id: 'science',
    name: 'Science-style',
    desc: '12 pt Times, double spaced, citations as (1), references in the order cited.',
    classLine: '\\documentclass[12pt]{article}',
    block: ['\\usepackage[letterpaper,margin=1in]{geometry}', '\\renewcommand{\\rmdefault}{ptm} % Times for the text', '\\usepackage{setspace}', '\\doublespacing', '\\usepackage[numbers,round,sort&compress]{natbib}'],
    bibstyle: 'unsrtnat',
    look: { cols: 1, spacing: 2 }
  },
  {
    id: 'physrev',
    name: 'Physical Review-style',
    desc: 'Two columns, 10 pt Times, numbered references [1] in the order cited.',
    classLine: '\\documentclass[10pt,twocolumn]{article}',
    block: ['\\usepackage[letterpaper,margin=0.75in,columnsep=0.3in]{geometry}', '\\renewcommand{\\rmdefault}{ptm} % Times for the text', '\\usepackage[numbers,sort&compress]{natbib}'],
    bibstyle: 'unsrtnat',
    look: { cols: 2, spacing: 1 }
  },
  {
    id: 'ieee',
    name: 'IEEE conference',
    desc: 'The official IEEEtran class: two columns, IEEE reference style.',
    classLine: '\\documentclass[conference]{IEEEtran}',
    block: ['\\usepackage{cite}'],
    bibstyle: 'IEEEtran',
    look: { cols: 2, spacing: 1 }
  },
  {
    id: 'draft',
    name: 'Review draft',
    desc: 'For co-authors and reviewers: 12 pt, double spaced, line numbers, wide margins.',
    classLine: '\\documentclass[12pt]{article}',
    block: ['\\usepackage[margin=1.25in]{geometry}', '\\usepackage{setspace}', '\\doublespacing', '\\usepackage{lineno}', '\\linenumbers'],
    bibstyle: 'plain',
    look: { cols: 1, spacing: 2, lineNumbers: true }
  }
]

const BEGIN = (id: string): string => `% ==== OpenTex design: ${id} (set in the Design tab) ====`
const END = '% ==== end OpenTex design ===='
const BLOCK_RE = /^% ==== OpenTex design: ([\w-]+)[^\n]*\n([\s\S]*?)^% ==== end OpenTex design ====[^\n]*\n?/m

// Preamble lines that belong to the design and are replaced by a preset.
const DESIGN_PKGS = new Set(['geometry', 'setspace', 'mathptmx', 'newtxtext', 'newtxmath', 'times', 'txfonts', 'helvet', 'lmodern', 'kpfonts', 'libertine', 'cite', 'natbib', 'lineno'])
function isDesignLine(line: string): boolean {
  const t = line.trim()
  const pkg = t.match(/^\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}\s*(%.*)?$/)
  if (pkg) return pkg[1].split(',').every((p) => DESIGN_PKGS.has(p.trim()))
  return /^\\(doublespacing|onehalfspacing|singlespacing|linenumbers)\b/.test(t) || /^\\(geometry|setcitestyle|setstretch)\{/.test(t) || /^\\renewcommand\{?\\(rmdefault|sfdefault|familydefault)\}?/.test(t)
}

interface Parsed {
  classLine: string | null
  classIdx: number // character index of the class line
  beginDoc: number
  block: { id: string; lines: string[]; start: number; end: number } | null
  designLines: string[] // the user's design lines in effect, outside the managed block
  bibstyle: string | null
}

function parse(text: string): Parsed {
  const cls = /^[ \t]*\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[^\n]*$/m.exec(text)
  const beginDoc = text.search(/^[ \t]*\\begin\{document\}/m)
  const pre = beginDoc >= 0 ? text.slice(0, beginDoc) : text
  const b = BLOCK_RE.exec(pre)
  const outside = b ? pre.slice(0, b.index) + pre.slice(b.index + b[0].length) : pre
  const designLines = outside.split('\n').filter((l) => !/^\s*%/.test(l) && isDesignLine(l))
  const bib = /\\bibliographystyle\{([^}]*)\}/.exec(text)
  return {
    classLine: cls ? cls[0].trim() : null,
    classIdx: cls ? cls.index : -1,
    beginDoc,
    block: b ? { id: b[1], lines: b[2].split('\n').filter((l) => l.trim()), start: b.index, end: b.index + b[0].length } : null,
    designLines,
    bibstyle: bib ? bib[1] : null
  }
}

/** Which design the file uses now: a preset id if it is that preset, unchanged; otherwise 'custom'. */
export function currentDesign(text: string): string {
  const p = parse(text)
  if (!p.block || p.designLines.length) return 'custom'
  const preset = PRESETS.find((x) => x.id === p.block!.id)
  if (!preset) return 'custom'
  const same = preset.classLine === p.classLine && preset.block.join('\n') === p.block.lines.map((l) => l.trim()).join('\n') && (p.bibstyle === null || p.bibstyle === preset.bibstyle)
  return same ? preset.id : 'custom'
}

/** Rewrite the design part of `text`. Returns the new text and the Custom design to remember. */
export function applyDesign(text: string, target: string, saved: CustomDesign | undefined): { text: string; custom: CustomDesign | undefined; error?: string } {
  const p = parse(text)
  if (!p.classLine) return { text, custom: saved, error: 'This file has no \\documentclass line, so it isn’t the main file of a paper.' }
  if (p.beginDoc < 0) return { text, custom: saved, error: 'This file has no \\begin{document}.' }
  // Remember the current setup as Custom, unless it's an unmodified preset.
  const custom: CustomDesign | undefined =
    currentDesign(text) === 'custom' ? { classLine: p.classLine, active: p.designLines.map((l) => l.trim()), block: p.block && !PRESETS.some((x) => x.id === p.block!.id && x.block.join('\n') === p.block!.lines.join('\n')) ? p.block.lines : p.block?.id === 'custom' ? p.block.lines : [], bibstyle: p.bibstyle } : saved
  let classLine: string
  let lines: string[]
  let bibstyle: string | null
  let managed = false
  if (target === 'custom') {
    if (!custom) return { text, custom, error: 'There is no Custom design saved yet. It is saved automatically the first time you switch to a preset.' }
    classLine = custom.classLine
    lines = custom.block
    bibstyle = custom.bibstyle
    managed = custom.block.length > 0
  } else {
    const preset = PRESETS.find((x) => x.id === target)
    if (!preset) return { text, custom, error: `Unknown design ${target}` }
    classLine = preset.classLine
    lines = preset.block
    bibstyle = preset.bibstyle
    managed = true
  }

  // 1. Preamble: drop the managed block; switch the user's design lines off (preset) or back on (Custom).
  let pre = text.slice(0, p.beginDoc)
  const body = text.slice(p.beginDoc)
  if (p.block) pre = pre.slice(0, p.block.start) + pre.slice(p.block.end)
  const restore = new Set(target === 'custom' ? custom!.active : [])
  pre = pre
    .split('\n')
    .map((l) => {
      if (l.startsWith(OFF)) return restore.has(l.slice(OFF.length).trim()) ? l.slice(OFF.length) : l
      return !/^\s*%/.test(l) && isDesignLine(l) ? OFF + l : l
    })
    .join('\n')
  pre = pre.replace(/^[ \t]*\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[^\n]*$/m, classLine)
  const insert = managed ? [BEGIN(target), ...lines, END].join('\n') + '\n' : ''
  if (insert) {
    // Before hyperref (it should load last), else at the end of the preamble.
    const hyper = /^[ \t]*\\usepackage(?:\[[^\]]*\])?\{[^}]*\bhyperref\b[^}]*\}/m.exec(pre)
    const at = hyper ? hyper.index : pre.length
    const before = pre.slice(0, at)
    pre = before + (before.endsWith('\n') || !before ? '' : '\n') + insert + pre.slice(at)
  }

  // 2. Bibliography style.
  let newBody = body
  if (bibstyle) {
    if (/\\bibliographystyle\{[^}]*\}/.test(newBody)) newBody = newBody.replace(/\\bibliographystyle\{[^}]*\}/, `\\bibliographystyle{${bibstyle}}`)
    else if (/^[ \t]*\\bibliography\{/m.test(newBody)) newBody = newBody.replace(/^([ \t]*)\\bibliography\{/m, `$1\\bibliographystyle{${bibstyle}}\n$1\\bibliography{`)
  }
  return { text: pre + newBody, custom }
}

/** A small picture of the page layout for the Design gallery. */
export function designThumb(look: Preset['look'] | null): string {
  const cols = look?.cols ?? 1
  const gap = look ? (look.spacing === 2 ? 7 : look.spacing === 1.5 ? 5.5 : 4.5) : 4.5
  const lines: string[] = []
  const colW = cols === 2 ? 15 : 34
  for (let c = 0; c < cols; c++) {
    const x0 = 8 + c * 19
    for (let y = 22, i = 0; y < 52; y += gap, i++) {
      const w = i % 4 === 3 ? colW * 0.6 : colW
      lines.push(`<rect x="${x0}" y="${y}" width="${w}" height="1.6" rx=".8" fill="currentColor" opacity=".45"/>`)
      if (look?.lineNumbers && c === 0) lines.push(`<rect x="3.5" y="${y}" width="2" height="1.6" fill="currentColor" opacity=".35"/>`)
    }
  }
  const sup = look?.superscript ? '<text x="40" y="17" font-size="5" fill="currentColor" opacity=".7">¹</text>' : ''
  const custom = look ? '' : '<path d="M17 30l6 6 10-12" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".25"/>'
  return `<svg viewBox="0 0 50 60" aria-hidden="true"><rect x=".5" y=".5" width="49" height="59" rx="2" fill="var(--bg)" stroke="var(--border)"/><rect x="12" y="7" width="26" height="2.6" rx="1.3" fill="currentColor" opacity=".7"/><rect x="17" y="12" width="16" height="1.6" rx=".8" fill="currentColor" opacity=".4"/>${sup}${custom}${lines.join('')}</svg>`
}
