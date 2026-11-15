// Turning spreadsheet data into LaTeX tables: reading HTML tables (Excel, Google Sheets, Numbers,
// Word, LibreOffice), tab-separated text and CSV files, and writing a tabular from the cells.
// No dependencies: small parsers that cover what spreadsheets actually put on the clipboard.

export interface Cell {
  text: string
  bold?: boolean
  italic?: boolean
}

export interface Grid {
  rows: Cell[][]
  merged: boolean // the source had merged cells (now plain cells)
}

// ---------- CSV / TSV ----------

/** Guess the delimiter from the first lines: tab, then semicolon or comma (whichever is more common). */
export function guessDelimiter(text: string): string {
  const head = text.slice(0, 20000)
  const count = (d: string): number => {
    let n = 0
    let quoted = false
    for (const ch of head) {
      if (ch === '"') quoted = !quoted
      else if (!quoted && ch === d) n++
    }
    return n
  }
  if (count('\t')) return '\t'
  return count(';') > count(',') ? ';' : ','
}

/** Parse delimited text (quoted fields, "" escapes, newlines inside quotes, any line ending, UTF-8 BOM). */
export function parseDelimited(text: string, delim = guessDelimiter(text)): string[][] {
  const s = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"'
        i += 2
        continue
      }
      if (ch === '"') quoted = false
      else field += ch
      i++
      continue
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true
      field = ''
    } else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (ch === '\r' && s[i + 1] === '\n') i++
    } else field += ch
    i++
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ---------- HTML tables ----------

/** Class rules from the clipboard's <style> block (Excel puts bold/italic there: .xl65 {font-weight:700}). */
function classStyles(doc: Document): Map<string, string> {
  const out = new Map<string, string>()
  for (const st of doc.querySelectorAll('style')) {
    const css = (st.textContent ?? '').replace(/<!--|-->/g, '')
    for (const m of css.matchAll(/(?:^|[\s,}])(?:[a-z]*)\.([\w-]+)\s*\{([^}]*)\}/gi)) out.set(m[1], (out.get(m[1]) ?? '') + ';' + m[2])
  }
  return out
}

const isBold = (style: string): boolean => /font-weight\s*:\s*(bold|bolder|[6-9]00)/i.test(style)
const isItalic = (style: string): boolean => /font-style\s*:\s*italic/i.test(style)

/** The cell's visible text, with line breaks and non-breaking spaces turned into plain spaces. */
function cellText(el: Element): string {
  let out = ''
  const walk = (n: Node): void => {
    if (n.nodeType === 3) out += n.nodeValue
    else if (n.nodeType === 1) {
      const e = n as Element
      const tag = e.tagName.toLowerCase()
      if (tag === 'style' || tag === 'script') return
      if (/display\s*:\s*none/i.test(e.getAttribute('style') ?? '')) return
      if (tag === 'br') out += ' '
      e.childNodes.forEach(walk)
      if (tag === 'p' || tag === 'div' || tag === 'li') out += ' '
    }
  }
  walk(el)
  return out.replace(/[\u00a0\s]+/g, ' ').trim()
}

/** Is every bit of text in the cell inside elements that make it bold (or italic)? */
function allStyled(td: Element, styles: Map<string, string>, test: (style: string) => boolean, tags: string): boolean {
  const own = (e: Element): string => (e.getAttribute('style') ?? '') + ';' + [...e.classList].map((c) => styles.get(c) ?? '').join(';')
  for (let e: Element | null = td; e && !/^(table|body|html)$/i.test(e.tagName); e = e.parentElement) {
    if (test(own(e))) return true
  }
  const walker = td.ownerDocument.createTreeWalker(td, NodeFilter.SHOW_TEXT)
  let any = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue?.replace(/\u00a0/g, ' ').trim()) continue
    any = true
    let ok = false
    for (let e = n.parentElement; e && e !== td; e = e.parentElement) {
      if (e.matches(tags) || test(own(e))) {
        ok = true
        break
      }
    }
    if (!ok) return false
  }
  return any
}

/** Read the first <table> in clipboard HTML. Merged cells become a cell plus empty ones. */
export function parseHtmlTable(html: string): Grid | null {
  if (!/<table[\s>]/i.test(html)) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return null
  const styles = classStyles(doc)
  const grid: Cell[][] = []
  let merged = false
  const trs = [...table.rows]
  trs.forEach((tr, r) => {
    grid[r] ??= []
    let c = 0
    for (const td of tr.cells) {
      while (grid[r][c]) c++
      const cs = Math.max(1, Math.min(td.colSpan || 1, 100))
      const rs = Math.max(1, Math.min(td.rowSpan || 1, trs.length - r))
      if (cs > 1 || rs > 1) merged = true
      const text = cellText(td)
      const cell: Cell = { text }
      if (text) {
        if (allStyled(td, styles, isBold, 'b, strong')) cell.bold = true
        if (allStyled(td, styles, isItalic, 'i, em')) cell.italic = true
      }
      for (let dr = 0; dr < rs; dr++) {
        grid[r + dr] ??= []
        for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = dr || dc ? { text: '' } : cell
      }
      c += cs
    }
  })
  return { rows: tidy(grid.map((row) => Array.from({ length: row.length }, (_, i) => row[i] ?? { text: '' }))), merged }
}

/** Make rows the same length and drop empty rows/columns at the edges (spreadsheet selections often have them). */
export function tidy(rows: Cell[][]): Cell[][] {
  const width = Math.max(0, ...rows.map((r) => r.length))
  let out = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? { text: '' }))
  const emptyRow = (r: Cell[]): boolean => r.every((c) => !c.text.trim())
  while (out.length && emptyRow(out[out.length - 1])) out.pop()
  while (out.length && emptyRow(out[0])) out.shift()
  const emptyCol = (i: number): boolean => out.every((r) => !r[i]?.text.trim())
  let w = width
  while (w > 0 && emptyCol(w - 1)) w--
  let start = 0
  while (start < w && emptyCol(start)) start++
  out = out.map((r) => r.slice(start, w))
  return out
}

export const cellsFromText = (rows: string[][]): Cell[][] => tidy(rows.map((r) => r.map((t) => ({ text: t.replace(/[\u00a0\s]+/g, ' ').trim() }))))

// ---------- Is this clipboard content a table? ----------

/** Text that is clearly LaTeX (or code) shouldn't be turned into a table. */
const looksLikeLatex = (text: string): boolean => /\\(begin|end|hline|toprule|midrule|item|section|usepackage)\b|\\\\\s*$|^\s*%[^\t]*$/m.test(text)

/**
 * The table in pasted content, or null when it should paste as ordinary text.
 * Needs at least 2 rows and 2 columns.
 */
export function detectTable(html: string, text: string): Grid | null {
  if (text && looksLikeLatex(text)) return null
  if (html && /<table[\s>]/i.test(html)) {
    const g = parseHtmlTable(html)
    if (g && g.rows.length >= 2 && (g.rows[0]?.length ?? 0) >= 2) return g
  }
  if (!text.includes('\t')) return null
  const raw = parseDelimited(text.replace(/\r?\n$/, ''), '\t')
  if (raw.length < 2) return null
  // Spreadsheet rows all have the same number of cells; tab-indented text doesn't fit that.
  const widths = new Set(raw.map((r) => r.length))
  if (widths.size !== 1 || raw[0].length < 2) return null
  if (raw.every((r) => !r[0].trim())) return null // indentation, not a first column
  const rows = cellsFromText(raw)
  if (rows.length < 2 || rows[0].length < 2) return null
  return { rows, merged: false }
}

// ---------- Writing LaTeX ----------

const ESC: Record<string, string> = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}'
}
// Characters pdfLaTeX can't print from plain text; the rest of Latin-1 (°, ±, µ, é …) works as is.
const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi o pi rho varsigma sigma tau upsilon phi chi psi omega'.split(' ')
const UNI: Record<string, string> = {
  '\u2212': '-', '\u2264': '\\ensuremath{\\leq}', '\u2265': '\\ensuremath{\\geq}', '\u2248': '\\ensuremath{\\approx}', '\u00d7': '\\ensuremath{\\times}',
  '\u2260': '\\ensuremath{\\neq}', '\u221e': '\\ensuremath{\\infty}', '\u2192': '\\ensuremath{\\rightarrow}', '\u2020': '\\textdagger{}', '\u2021': '\\textdaggerdbl{}',
  '\u00b2': '\\textsuperscript{2}', '\u00b3': '\\textsuperscript{3}', '\u00b9': '\\textsuperscript{1}', '\u2070': '\\textsuperscript{0}',
  '\u0394': '\\ensuremath{\\Delta}', '\u03a9': '\\ensuremath{\\Omega}', '\u03a3': '\\ensuremath{\\Sigma}', '\u03a6': '\\ensuremath{\\Phi}', '\u0393': '\\ensuremath{\\Gamma}',
  '\u039b': '\\ensuremath{\\Lambda}', '\u03a0': '\\ensuremath{\\Pi}', '\u03a8': '\\ensuremath{\\Psi}', '\u0398': '\\ensuremath{\\Theta}'
}
GREEK.forEach((g, i) => (UNI[String.fromCharCode(0x03b1 + i)] = g === 'o' ? 'o' : `\\ensuremath{\\${g}}`))

/** Escape text for LaTeX: & % $ # _ { } ~ ^ \ and a few symbols pdfLaTeX can't print directly. */
export function escapeLatex(s: string): string {
  return s.replace(/[\\&%$#_{}~^<>|]/g, (c) => ESC[c]).replace(/[\u2212\u2264\u2265\u2248\u00d7\u2260\u221e\u2192\u2020\u2021\u00b2\u00b3\u00b9\u2070\u0391-\u03c9]/g, (c) => UNI[c] ?? c)
}

const NUMBER = /^[-+\u2212\u00b1]?\s*[$€£¥]?\s*(\d{1,3}(,\d{3})+|\d+)?([.,]\d+)?([eE][-+]?\d+)?\s*%?$/
const MISSING = /^(-|–|—|n\/?a|na|nan|nd|\?|\*)$/i
const STRICT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

const isNumber = (s: string): boolean => /\d/.test(s) && NUMBER.test(s.trim())

export interface TableOptions {
  booktabs: boolean
  siunitx: boolean
  graphicx: boolean // for \resizebox on wide tables
  label: string // e.g. "tab:table1"
}

export interface BuiltTable {
  text: string // contains one ¦ where the cursor goes (in the caption)
  notes: string[] // things to tell the user
}

/** A table environment with the first row as the header and guessed column alignment. */
export function buildTable(rows: Cell[][], opts: TableOptions): BuiltTable {
  const notes: string[] = []
  const cols = rows[0]?.length ?? 0
  const body = rows.slice(1)
  // Numbers right-aligned (S columns with siunitx when every value is a plain number), text left.
  const align = Array.from({ length: cols }, (_, c) => {
    const vals = body.map((r) => r[c].text.trim()).filter((t) => t && !MISSING.test(t))
    if (!vals.length || !vals.every(isNumber)) return 'l'
    return opts.siunitx && vals.every((v) => STRICT.test(v)) ? 'S' : 'r'
  })
  const fmt = (cell: Cell, c: number): string => {
    let t = escapeLatex(cell.text)
    if (t && cell.italic) t = `\\textit{${t}}`
    if (t && cell.bold) t = `\\textbf{${t}}`
    // An S column only understands plain numbers; anything else goes in braces.
    if (align[c] === 'S' && t && (cell.bold || cell.italic || !STRICT.test(cell.text.trim()))) t = `{${t}}`
    return t
  }
  const lines = rows.map((r) => r.map(fmt))
  // Line up the & signs when the table is narrow enough to read that way.
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...lines.map((l) => l[c].length)))
  const pad = widths.reduce((a, b) => a + b, 0) + cols * 3 <= 120
  const row = (l: string[]): string => l.map((t, c) => (pad && c < cols - 1 ? t.padEnd(widths[c]) : t)).join(' & ').trimEnd() + ' \\\\'
  const top = opts.booktabs ? '\\toprule' : '\\hline'
  const mid = opts.booktabs ? '\\midrule' : '\\hline'
  const bottom = opts.booktabs ? '\\bottomrule' : '\\hline'
  const wide = cols > 8
  const ind = '  '
  const tabular = [
    `\\begin{tabular}{${align.join('')}}`,
    `${ind}${top}`,
    `${ind}${row(lines[0])}`,
    `${ind}${mid}`,
    ...lines.slice(1).map((l) => `${ind}${row(l)}`),
    `${ind}${bottom}`,
    '\\end{tabular}'
  ]
  let inner: string[]
  if (wide && opts.graphicx) {
    inner = ['\\resizebox{\\linewidth}{!}{%', ...tabular.map((l, i) => ind + l + (i === tabular.length - 1 ? '%' : '')), '}']
    notes.push(`The table has ${cols} columns, so it is shrunk to fit the page width.`)
  } else if (wide) {
    inner = ['% This table is wide. If it runs off the page, add \\usepackage{graphicx} and put', '% \\resizebox{\\linewidth}{!}{ … } around the tabular.', ...tabular]
    notes.push(`The table has ${cols} columns and may be wider than the page.`)
  } else inner = tabular
  const text = ['\\begin{table}[htbp]', `${ind}\\centering`, `${ind}\\caption{¦}`, `${ind}\\label{${opts.label}}`, ...inner.map((l) => ind + l), '\\end{table}'].join('\n')
  return { text, notes }
}

/** Plain tab-separated text for a grid (used when the clipboard only had HTML). */
export const gridToTsv = (rows: Cell[][]): string => rows.map((r) => r.map((c) => c.text).join('\t')).join('\n')
