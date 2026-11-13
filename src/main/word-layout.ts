// Turns Pandoc's one-file LaTeX of a Word document into an OpenTex project laid out like the
// example paper:
//
//   main.tex               a short, readable preamble, then one \input per section
//   sections/abstract.tex  a real abstract environment, when the document has an "Abstract" heading
//   sections/<name>.tex    one file per top-level Word heading, in reading order
//   figures/fig1.png …     pictures numbered in the order they appear, each figure labelled fig:N
//   refs.bib               when the document had Zotero / Mendeley / EndNote citations
//
// The text gets one sentence per line (it compiles exactly the same) and numbered sections.
// Word comments (the %@comment lines from the import filter) stay next to their text; OpenTex
// moves them into its comments file when the project opens.

export interface WordLayout {
  files: { path: string; text: string }[]
  /** Pictures to move: [Pandoc's path, new path], both relative to the project folder. */
  media: [string, string][]
  sections: number
  figures: number
}

/** Index just past the brace group that opens at s[open] ('{'), or -1. */
function groupEnd(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return -1
}

/** The argument of the first \cmd{…} in s (balanced braces), or null. */
function argOf(s: string, cmd: string): string | null {
  const m = new RegExp(`\\\\${cmd}\\s*\\{`).exec(s)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const end = groupEnd(s, open)
  return end < 0 ? null : s.slice(open + 1, end - 1)
}

/** Replace every \cmd{X} with what fn returns for X (balanced braces). */
function mapCommand(s: string, cmd: string, fn: (arg: string) => string): string {
  const re = new RegExp(`\\\\${cmd}\\s*\\{`, 'g')
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const open = m.index + m[0].length - 1
    const end = groupEnd(s, open)
    if (end < 0) break
    out += s.slice(last, m.index) + fn(s.slice(open + 1, end - 1))
    last = re.lastIndex = end
  }
  return out + s.slice(last)
}

/** A file name from a heading: "Methods & Materials" -> "methods-materials". */
function slug(title: string): string {
  const plain = title
    .replace(/\\[a-zA-Z]+\*?/g, ' ')
    .replace(/\\./g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return plain.slice(0, 40).replace(/-+$/, '') || 'section'
}

// ---------- One sentence per line ----------

// Environments whose lines are left exactly as they are.
const KEEP_ENVS = /^(verbatim|lstlisting|minted|Verbatim|Shaded|Highlighting|equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|displaymath|math|tabular\*?|tabularx|longtable|array)$/
// Lines that start with one of these commands aren't running text.
const STRUCTURAL = /^\s*\\(begin|end|section|subsection|subsubsection|paragraph|subparagraph|chapter|part|label|caption|includegraphics|centering|toprule|midrule|bottomrule|hline|bibliography|bibliographystyle|maketitle|def|item\s*$|\[|\])/
// Words that end with a full stop without ending a sentence.
const ABBREV = /(?:^|[\s~({])(?:e\.g|i\.e|et al|etc|vs|cf|Fig|Figs|Eq|Eqs|Ref|Refs|Tab|Sec|Secs|Ch|No|Nos|Vol|pp|p|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|approx|ca|resp|incl|Inc|Ltd|Co|Corp|[A-Z])\.$/

function splitSentences(line: string): string {
  // Don't look inside inline math, URLs or link targets.
  const masks: string[] = []
  const mask = (s: string): string => `\u0000${masks.push(s) - 1}\u0001`
  let t = line.replace(/\$[^$]*\$|\\\([\s\S]*?\\\)/g, mask)
  t = mapCommand(t, 'url', (a) => mask(`\\url{${a}}`))
  t = mapCommand(t, 'href', (a) => mask(`\\href{${a}}`))
  const indent = /^\s*/.exec(line)![0]
  // A sentence ends at . ! or ? (plus closing quotes or brackets), then a space, then a capital letter,
  // an opening quote, a bracket or a command (\emph{The …}).
  t = t.replace(/([.!?](?:''|'|"|\u201d|\u2019|\))*) +(?=[A-Z\u00c0-\u00de\\`"\u201c(])/g, (all: string, end: string, at: number, whole: string) => {
    if (end.startsWith('.') && ABBREV.test(whole.slice(0, at + 1))) return all
    return `${end}\n${indent}`
  })
  return t.replace(/\u0000(\d+)\u0001/g, (_, i: string) => masks[Number(i)])
}

function oneSentencePerLine(body: string): string {
  const stack: string[] = []
  return body
    .split('\n')
    .map((line) => {
      for (const m of line.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
        if (m[1] === 'begin') stack.push(m[2])
        else if (stack[stack.length - 1] === m[2]) stack.pop()
      }
      if (stack.some((e) => KEEP_ENVS.test(e)) || /^\s*%/.test(line) || STRUCTURAL.test(line) || /&|\\\\\s*$/.test(line) || /\\\[/.test(line)) return line
      return splitSentences(line)
    })
    .join('\n')
}

// ---------- Characters pdfLaTeX can't print without help ----------

const UNICODE: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda',
  μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  '−': '-', '≤': '\\leq', '≥': '\\geq', '≈': '\\approx', '≠': '\\neq', '∞': '\\infty', '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '∼': '\\sim', '∝': '\\propto', '∂': '\\partial', '∇': '\\nabla', '∑': '\\sum', '√': '\\surd', '∫': '\\int', '∆': '\\Delta',
  '′': '\\prime', '″': '\\prime\\prime', '⋅': '\\cdot', '∙': '\\cdot', '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '∪': '\\cup', '∩': '\\cap', '≡': '\\equiv',
  '∓': '\\mp', '⊥': '\\perp', '∥': '\\parallel', '\u212B': '\\mathring{A}' // the ångström sign (Å written as U+00C5 already works)
}

function unicodeDeclarations(text: string): string[] {
  const seen = new Set<string>()
  for (const ch of text) if (UNICODE[ch]) seen.add(ch)
  return [...seen].map((ch) => `  \\DeclareUnicodeCharacter{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}{\\ensuremath{${UNICODE[ch]}}} % ${ch}`)
}

// ---------- The layout ----------

export function restructure(tex: string, opts: { source: string; citations: boolean }): WordLayout {
  const b = tex.indexOf('\\begin{document}')
  const e = tex.lastIndexOf('\\end{document}')
  const pre = b >= 0 ? tex.slice(0, b) : ''
  let body = b >= 0 ? tex.slice(b + '\\begin{document}'.length, e > b ? e : undefined) : tex

  const title = argOf(pre, 'title')
  const author = argOf(pre, 'author')
  const date = argOf(pre, 'date')

  // Tidy what Pandoc wrote.
  body = body
    .replace(/^[ \t]*\\maketitle[ \t]*\n?/m, '')
    .replace(/^[ \t]*\\tightlist[ \t]*\n/gm, '')
  body = mapCommand(body, 'pandocbounded', (a) => a)
  // Strike-through, underline and highlight: Pandoc uses the soul package, which small TeX
  // installations (BasicTeX, TinyTeX) don't have; ulem and xcolor come with them.
  body = mapCommand(body, 'st', (a) => `\\sout{${a}}`)
  body = mapCommand(body, 'ul', (a) => `\\uline{${a}}`)
  body = mapCommand(body, 'hl', (a) => `\\colorbox{yellow}{${a}}`)
  body = body.replace(/(\\includegraphics\[[^\]]*?),?\s*alt=\{[^{}]*\}/g, '$1').replace(/\\includegraphics\[\s*,?\s*\]/g, '\\includegraphics')
  body = body.replace(/\\includegraphics\{/g, '\\includegraphics[width=0.8\\linewidth]{') // pictures with no size of their own
  // The bibliography: Pandoc puts \bibliography{…} at the end; main.tex gets its own.
  body = body.replace(/^[ \t]*\\bibliography(style)?\{[^}]*\}[ \t]*\n?/gm, '')

  // Pictures: figures/fig1.png, fig2.jpg … in the order they first appear.
  const media: [string, string][] = []
  const newName = new Map<string, string>()
  body = body.replace(/(\\includegraphics(?:\[[^\]]*\])?)\{([^}]+)\}/g, (_, cmd: string, p: string) => {
    const from = p.replace(/^\.\//, '')
    if (!newName.has(from)) {
      const ext = /\.[a-z0-9]+$/i.exec(from)?.[0].toLowerCase() ?? ''
      const to = `figures/fig${newName.size + 1}${ext}`
      newName.set(from, to)
      media.push([from, to])
    }
    // Windows-only picture formats: leave the extension off, so a PNG saved under the same name is used.
    return `${cmd}{${newName.get(from)!.replace(/\.(emf|wmf)$/i, '')}}`
  })
  // Labels, so figures and tables can be referred to with \ref.
  let figs = 0
  body = body.replace(/\\begin\{figure\}([\s\S]*?)\\end\{figure\}/g, (all, inner: string) => {
    figs++
    return /\\label\{/.test(inner) ? all : `\\begin{figure}${inner.replace(/\s*$/, '')}\n\\label{fig:${figs}}\n\\end{figure}`
  })
  let tabs = 0
  body = body.replace(/\\begin\{longtable\}[\s\S]*?\\end\{longtable\}/g, (table) => {
    const at = table.indexOf('\\caption{')
    if (at < 0 || /\\label\{/.test(table)) return table
    const end = groupEnd(table, at + '\\caption'.length)
    return end < 0 ? table : `${table.slice(0, end)}\\label{tab:${++tabs}}${table.slice(end)}`
  })

  body = oneSentencePerLine(body)

  // Split at the top-level headings.
  const parts = body.split(/^(?=[ \t]*\\section\*?\s*\{)/m)
  let front = parts[0].trim()
  const files: { path: string; text: string }[] = []
  const inputs: string[] = []
  const used = new Set<string>()
  let abstract: string | null = null
  for (const part of parts.slice(1)) {
    const heading = argOf(part, 'section\\*?') ?? ''
    const plain = heading.replace(/\\[a-zA-Z]+\*?|[{}]/g, '').trim()
    if (/^(abstract|summary)$/i.test(plain) && abstract === null) {
      // The heading line (and its label) go; the text goes into an abstract environment.
      const text = part.replace(/^[ \t]*\\section\*?\s*\{[^\n]*\n/, '').replace(/^[ \t]*\\label\{[^}]*\}[ \t]*\n/, '').trim()
      abstract = `\\begin{abstract}\n${text}\n\\end{abstract}\n`
      continue
    }
    // With citations, the Word reference list is generated by BibTeX from refs.bib instead.
    if (opts.citations && /^(references|bibliography|literature cited|works cited)$/i.test(plain)) continue
    let name = slug(plain)
    for (let i = 2; used.has(name) || name === 'abstract'; i++) name = `${slug(plain)}-${i}`
    used.add(name)
    files.push({ path: `sections/${name}.tex`, text: part.replace(/\s*$/, '\n') })
    inputs.push(`\\input{sections/${name}}`)
  }
  // An abstract Pandoc recognised by its Word style sits before the first heading.
  const absEnv = /\\begin\{abstract\}[\s\S]*?\\end\{abstract\}\n?/.exec(front)
  if (absEnv && abstract === null) {
    abstract = absEnv[0].trim() + '\n'
    front = (front.slice(0, absEnv.index) + front.slice(absEnv.index + absEnv[0].length)).trim()
  }
  if (abstract) files.unshift({ path: 'sections/abstract.tex', text: abstract })

  // main.tex
  const all = body + (title ?? '') + (author ?? '')
  const uses = (re: RegExp): boolean => re.test(all)
  const unicode = unicodeDeclarations(all)
  const pkg = (line: string, note: string): string => `${line.padEnd(34)} % ${note}`
  const lines = [
    `% Converted from the Word document "${opts.source}" by OpenTex.`,
    '% The original is kept in the "original" folder. Each section is its own file in "sections".',
    '',
    '\\documentclass[11pt]{article}',
    '% ==== OpenTex design: article (set in the Design tab) ====',
    '\\usepackage[margin=1in]{geometry}',
    '% ==== end OpenTex design ====',
    pkg('\\usepackage{amsmath,amssymb}', 'equations and math symbols'),
    pkg('\\usepackage{graphicx}', 'pictures: \\includegraphics'),
    ...(uses(/\\begin\{longtable\}/) ? [pkg('\\usepackage{longtable,booktabs,array,calc}', 'tables from Word'), pkg('\\newcounter{none}', 'for tables without a caption')] : []),
    ...(uses(/\\(sout|uline)\{/) ? [pkg('\\usepackage[normalem]{ulem}', 'strike-through and underline')] : []),
    ...(uses(/\\(textcolor|colorbox|color)\{/) ? [pkg('\\usepackage{xcolor}', 'coloured text')] : []),
    ...(opts.citations ? [pkg('\\usepackage[numbers,sort&compress]{natbib}', 'citations: \\cite, \\citep, \\citet')] : []),
    ...(unicode.length ? ['\\usepackage{iftex}', '\\ifPDFTeX % characters from Word that pdfLaTeX needs help with', ...unicode, '\\fi'] : []),
    pkg('\\setlength{\\emergencystretch}{3em}', 'fewer lines sticking into the margin'),
    pkg('\\usepackage[hidelinks]{hyperref}', 'clickable links; keep it last'),
    '',
    ...(title !== null ? [`\\title{${title}}`] : []),
    ...(author !== null ? [`\\author{${author}}`] : []),
    ...(title !== null ? [`\\date{${date ?? ''}}`] : []),
    ...(title !== null ? [''] : []),
    '\\begin{document}',
    ...(title !== null ? ['\\maketitle'] : []),
    ...(abstract ? ['\\input{sections/abstract}'] : []),
    ...(front ? ['', front, ''] : []),
    ...inputs,
    ...(opts.citations ? ['', '\\bibliographystyle{plainnat} % numbered, and \\citet can name the authors', '\\bibliography{refs}'] : []),
    '\\end{document}',
    ''
  ]
  files.unshift({ path: 'main.tex', text: lines.join('\n') })
  return { files, media, sections: inputs.length, figures: figs }
}
