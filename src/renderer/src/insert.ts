// The Insert toolbar (like Word's Insert tab): tables, equations, symbols, figures, superscript,
// subscript, bold, italic, lists, links, cross-references and footnotes, inserted at the cursor.
// (Citations have their own tab, which uses insertAtCursor from here.)
// Tools know whether the cursor is in math: symbols insert \alpha inside math and $\alpha$
// outside; superscript is ^{…} in math and \textsuperscript{…} in text. Anything that needs a
// package not yet loaded offers to add it.

import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { startCompletion } from '@codemirror/autocomplete'

export interface InsertHost {
  view: () => EditorView | null // null when no .tex file is open
  images: () => string[] // image files in the project, for figures
  ensurePackage: (pkg: string) => Promise<boolean> // true if loaded (or just added)
  hasPackage: (pkg: string) => boolean
  mainText?: () => string // the main .tex file's text, to see if it already has a table of contents
  notice: (msg: string) => void
  tableMore?: (el: HTMLElement) => void // extra buttons under the table grid (paste.ts)
  addByDoi?: () => void // no longer used here: citations (and Add by DOI) moved to the Citations tab
}

/** Where the text cursor marker goes after inserting a snippet. */
const CURSOR = '¦'

// ---------- Is the cursor inside math? ----------
const MATH_ENVS = 'equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|math'
export function inMath(state: EditorState, pos: number): boolean {
  const before = state.doc.sliceString(Math.max(0, pos - 20000), pos)
  // Display environments: the last \begin{…} of a math env without a matching \end{…} after it.
  const begins = [...before.matchAll(new RegExp(`\\\\begin\\{(${MATH_ENVS})\\*?\\}`, 'g'))]
  const ends = [...before.matchAll(new RegExp(`\\\\end\\{(${MATH_ENVS})\\*?\\}`, 'g'))]
  const lastBegin = begins.length ? begins[begins.length - 1].index! : -1
  const lastEnd = ends.length ? ends[ends.length - 1].index! : -1
  if (lastBegin > lastEnd) return true
  // \[ … \] and \( … \)
  if (before.lastIndexOf('\\[') > before.lastIndexOf('\\]')) return true
  if (before.lastIndexOf('\\(') > before.lastIndexOf('\\)')) return true
  // $ … $ within the current paragraph (ignoring \$ and comments).
  const para = before.slice(before.lastIndexOf('\n\n') + 1)
  const clean = para.replace(/\\\$/g, '').replace(/(^|[^\\])%.*$/gm, '$1')
  const dollars = (clean.match(/\$\$|\$/g) ?? []).length
  return dollars % 2 === 1
}

/** Insert text at the selection; `¦` marks where the cursor goes (the selection fills the first `¦`). */
export function insertSnippet(view: EditorView, snippet: string, opts: { ownLine?: boolean } = {}): void {
  const sel = view.state.selection.main
  const selected = view.state.sliceDoc(sel.from, sel.to)
  let text = snippet
  // If text was selected, it goes where the cursor marker is.
  if (selected && text.includes(CURSOR)) text = text.replace(CURSOR, selected + CURSOR)
  put(view, sel.from, sel.to, text, opts.ownLine)
}

/**
 * Replace `from`–`to` with `text` in one edit (so one Undo takes it back). The first `¦` is where
 * the cursor goes; with `select`, the text between the first and second `¦` is left selected.
 * `ownLine` puts the text on lines of its own.
 */
function put(view: EditorView, from: number, to: number, text: string, ownLine = false, select = false): void {
  if (ownLine) {
    const line = view.state.doc.lineAt(from)
    if (from > line.from && line.text.slice(0, from - line.from).trim()) text = '\n' + text
    const after = view.state.doc.sliceString(to, view.state.doc.lineAt(to).to)
    if (after.trim()) text = text + '\n'
  }
  const cursorAt = text.indexOf(CURSOR)
  const endAt = select && cursorAt >= 0 ? text.indexOf(CURSOR, cursorAt + 1) : -1
  const clean = text.split(CURSOR).join('')
  const anchor = from + (cursorAt >= 0 ? cursorAt : clean.length)
  view.dispatch({
    changes: { from, to, insert: clean },
    selection: { anchor, head: endAt >= 0 ? from + endAt - 1 : anchor },
    scrollIntoView: true,
    userEvent: 'input'
  })
  view.focus()
}

/** True if the braces in `s` pair up (ignoring \{ and \}). */
function balanced(s: string): boolean {
  let depth = 0
  for (const c of s.replace(/\\[{}]/g, '')) {
    if (c === '{') depth++
    else if (c === '}' && --depth < 0) return false
  }
  return depth === 0
}

/**
 * Wrap the selection in `prefix…}` (like \textbf{…}) and keep it selected, so a second tool can
 * wrap it again. With nothing selected, the cursor goes between the braces. If the selection is
 * already wrapped in exactly this command, the command is removed instead (a second click undoes it).
 */
function wrap(view: EditorView, prefix: string): void {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const sel = doc.sliceString(from, to)
  const start = from - prefix.length
  if (start >= 0 && doc.sliceString(start, from) === prefix && doc.sliceString(to, to + 1) === '}' && balanced(sel))
    return put(view, start, to + 1, `¦${sel}¦`, false, true)
  if (sel.startsWith(prefix) && sel.endsWith('}') && balanced(sel.slice(prefix.length, -1)))
    return put(view, from, to, `¦${sel.slice(prefix.length, -1)}¦`, false, true)
  put(view, from, to, sel ? `${prefix}¦${sel}¦}` : `${prefix}¦}`, false, true)
}

/** Itemize/enumerate: each selected line becomes an \item (an empty \item if nothing is selected). */
function insertList(view: EditorView, env: 'itemize' | 'enumerate'): void {
  const { from, to } = view.state.selection.main
  const lines = view.state.doc
    .sliceString(from, to)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const items = lines.length ? lines.map((l) => `  ${/^\\item\b/.test(l) ? l : `\\item ${l}`}`) : ['  \\item ']
  items[items.length - 1] += CURSOR
  put(view, from, to, `\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}`, true)
}

const uncommented = (s: string): string => s.replace(/(^|[^\\])%.*$/gm, '$1')

/** Table of contents, list of figures or list of tables, once, on its own line in the document body. */
const CONTENTS: Record<string, [cmd: string, name: string]> = {
  toc: ['\\tableofcontents', 'table of contents'],
  lof: ['\\listoffigures', 'list of figures'],
  lot: ['\\listoftables', 'list of tables']
}
function insertContents(view: EditorView, host: InsertHost, kind: string): void {
  const [cmd, name] = CONTENTS[kind]
  const doc = view.state.doc.toString()
  const begin = /^[^%\n]*\\begin\{document\}/m.exec(doc)
  if (begin && view.state.selection.main.from < begin.index + begin[0].length)
    return host.notice(`Put the cursor after \\begin{document}: the ${name} goes in the body of the document.`)
  const has = new RegExp(`\\${cmd}(?![a-zA-Z])`)
  if (has.test(uncommented(doc)) || has.test(uncommented(host.mainText?.() ?? '')))
    return host.notice(`This document already has a ${name} (${cmd}).`)
  insertSnippet(view, cmd + CURSOR, { ownLine: true })
}

/** Web link:\url{…}; selected text becomes the link's words, \href{¦}{text}; a selected address, \url{address}. */
function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const sel = view.state.doc.sliceString(from, to)
  if (!sel) return put(view, from, to, '\\url{¦}')
  if (/^\s*(https?:\/\/|www\.)\S+\s*$/i.test(sel)) return put(view, from, to, `\\url{${sel.trim()}}¦`)
  put(view, from, to, `\\href{¦}{${sel}}`)
}

// ---------- Symbols ----------
interface Sym {
  g: string // what the button shows
  c: string // LaTeX (math mode)
  name: string
  text?: string // text-mode form, when there is a natural one
  pkg?: string
}
const S = (g: string, c: string, name: string, extra: Partial<Sym> = {}): Sym => ({ g, c, name, ...extra })

const GREEK_LOWER: Sym[] = [
  S('α', '\\alpha', 'alpha'), S('β', '\\beta', 'beta'), S('γ', '\\gamma', 'gamma'), S('δ', '\\delta', 'delta'),
  S('ε', '\\epsilon', 'epsilon'), S('ϵ', '\\varepsilon', 'epsilon (variant)'), S('ζ', '\\zeta', 'zeta'), S('η', '\\eta', 'eta'),
  S('θ', '\\theta', 'theta'), S('ϑ', '\\vartheta', 'theta (variant)'), S('ι', '\\iota', 'iota'), S('κ', '\\kappa', 'kappa'),
  S('λ', '\\lambda', 'lambda'), S('μ', '\\mu', 'mu'), S('ν', '\\nu', 'nu'), S('ξ', '\\xi', 'xi'),
  S('ο', 'o', 'omicron (same as Latin o)'), S('π', '\\pi', 'pi'), S('ϖ', '\\varpi', 'pi (variant)'), S('ρ', '\\rho', 'rho'),
  S('ϱ', '\\varrho', 'rho (variant)'), S('σ', '\\sigma', 'sigma'), S('ς', '\\varsigma', 'final sigma'), S('τ', '\\tau', 'tau'),
  S('υ', '\\upsilon', 'upsilon'), S('φ', '\\phi', 'phi'), S('ϕ', '\\varphi', 'phi (variant)'), S('χ', '\\chi', 'chi'),
  S('ψ', '\\psi', 'psi'), S('ω', '\\omega', 'omega')
]
const GREEK_UPPER: Sym[] = [
  S('Α', '\\mathrm{A}', 'Alpha (same as Latin A)'), S('Β', '\\mathrm{B}', 'Beta (same as Latin B)'), S('Γ', '\\Gamma', 'Gamma'), S('Δ', '\\Delta', 'Delta'),
  S('Ε', '\\mathrm{E}', 'Epsilon (same as Latin E)'), S('Ζ', '\\mathrm{Z}', 'Zeta (same as Latin Z)'), S('Η', '\\mathrm{H}', 'Eta (same as Latin H)'), S('Θ', '\\Theta', 'Theta'),
  S('Ι', '\\mathrm{I}', 'Iota (same as Latin I)'), S('Κ', '\\mathrm{K}', 'Kappa (same as Latin K)'), S('Λ', '\\Lambda', 'Lambda'), S('Μ', '\\mathrm{M}', 'Mu (same as Latin M)'),
  S('Ν', '\\mathrm{N}', 'Nu (same as Latin N)'), S('Ξ', '\\Xi', 'Xi'), S('Ο', '\\mathrm{O}', 'Omicron (same as Latin O)'), S('Π', '\\Pi', 'Pi'),
  S('Ρ', '\\mathrm{P}', 'Rho (same as Latin P)'), S('Σ', '\\Sigma', 'Sigma'), S('Τ', '\\mathrm{T}', 'Tau (same as Latin T)'), S('Υ', '\\Upsilon', 'Upsilon'),
  S('Φ', '\\Phi', 'Phi'), S('Χ', '\\mathrm{X}', 'Chi (same as Latin X)'), S('Ψ', '\\Psi', 'Psi'), S('Ω', '\\Omega', 'Omega')
]
const OPERATORS: Sym[] = [
  S('±', '\\pm', 'plus-minus'), S('∓', '\\mp', 'minus-plus'), S('×', '\\times', 'times'), S('÷', '\\div', 'divide'),
  S('·', '\\cdot', 'dot'), S('∘', '\\circ', 'composition'), S('⊗', '\\otimes', 'tensor product'), S('⊕', '\\oplus', 'direct sum'),
  S('√', '\\sqrt{¦}', 'square root'), S('∑', '\\sum', 'sum'), S('∏', '\\prod', 'product'), S('∫', '\\int', 'integral'),
  S('∬', '\\iint', 'double integral', { pkg: 'amsmath' }), S('∮', '\\oint', 'contour integral'), S('∂', '\\partial', 'partial'), S('∇', '\\nabla', 'nabla (gradient)'),
  S('∞', '\\infty', 'infinity'), S('′', "'", 'prime'), S('†', '\\dagger', 'dagger'), S('∗', '\\ast', 'asterisk'),
  S('…', '\\ldots', 'dots', { text: '\\ldots' }), S('⋯', '\\cdots', 'centered dots'), S('⋮', '\\vdots', 'vertical dots'), S('⋱', '\\ddots', 'diagonal dots')
]
const RELATIONS: Sym[] = [
  S('≤', '\\leq', 'less than or equal'), S('≥', '\\geq', 'greater than or equal'), S('≪', '\\ll', 'much less than'), S('≫', '\\gg', 'much greater than'),
  S('≠', '\\neq', 'not equal'), S('≈', '\\approx', 'approximately'), S('≃', '\\simeq', 'similar or equal'), S('≅', '\\cong', 'congruent'),
  S('≡', '\\equiv', 'identical / defined as'), S('∝', '\\propto', 'proportional to'), S('∼', '\\sim', 'similar / scales as'), S('≲', '\\lesssim', 'less than or about', { pkg: 'amssymb' }),
  S('⊥', '\\perp', 'perpendicular'), S('∥', '\\parallel', 'parallel'), S('∠', '\\angle', 'angle'), S('≜', '\\triangleq', 'defined as', { pkg: 'amssymb' })
]
const ARROWS: Sym[] = [
  S('→', '\\rightarrow', 'right arrow'), S('←', '\\leftarrow', 'left arrow'), S('↔', '\\leftrightarrow', 'left-right arrow'), S('⇌', '\\rightleftharpoons', 'equilibrium'),
  S('⇒', '\\Rightarrow', 'implies'), S('⇐', '\\Leftarrow', 'implied by'), S('⇔', '\\Leftrightarrow', 'if and only if'), S('↦', '\\mapsto', 'maps to'),
  S('↑', '\\uparrow', 'up arrow'), S('↓', '\\downarrow', 'down arrow'), S('⟶', '\\longrightarrow', 'long right arrow'), S('⇀', '\\rightharpoonup', 'harpoon')
]
const SETS: Sym[] = [
  S('∈', '\\in', 'element of'), S('∉', '\\notin', 'not an element of'), S('⊂', '\\subset', 'subset'), S('⊆', '\\subseteq', 'subset or equal'),
  S('∪', '\\cup', 'union'), S('∩', '\\cap', 'intersection'), S('∅', '\\emptyset', 'empty set'), S('∀', '\\forall', 'for all'),
  S('∃', '\\exists', 'there exists'), S('¬', '\\neg', 'not'), S('∧', '\\wedge', 'and'), S('∨', '\\vee', 'or'),
  S('ℝ', '\\mathbb{R}', 'real numbers', { pkg: 'amssymb' }), S('ℂ', '\\mathbb{C}', 'complex numbers', { pkg: 'amssymb' }), S('ℤ', '\\mathbb{Z}', 'integers', { pkg: 'amssymb' }), S('ℕ', '\\mathbb{N}', 'natural numbers', { pkg: 'amssymb' })
]
const SCIENCE: Sym[] = [
  S('ℏ', '\\hbar', 'h-bar (reduced Planck constant)'), S('ℓ', '\\ell', 'script l'), S('°', '^\\circ', 'degree'), S('Å', '\\mathring{\\mathrm{A}}', 'ångström', { text: '\\AA' }),
  S('µ', '\\mu', 'micro'), S('⟨', '\\langle', 'left angle bracket'), S('⟩', '\\rangle', 'right angle bracket'), S('‖', '\\|', 'norm'),
  S('ℜ', '\\Re', 'real part'), S('ℑ', '\\Im', 'imaginary part'), S('∡', '\\measuredangle', 'measured angle', { pkg: 'amssymb' }), S('⊙', '\\odot', 'sun / circled dot')
]
const ACCENTS: Sym[] = [
  S('x̂', '\\hat{¦}', 'hat'), S('x̄', '\\bar{¦}', 'bar'), S('x⃗', '\\vec{¦}', 'vector'), S('ẋ', '\\dot{¦}', 'dot (time derivative)'),
  S('ẍ', '\\ddot{¦}', 'double dot'), S('x̃', '\\tilde{¦}', 'tilde'), S('𝐱', '\\mathbf{¦}', 'bold'), S('ℱ', '\\mathcal{¦}', 'calligraphic')
]

const SYMBOL_GROUPS: [string, Sym[]][] = [
  ['Greek, lowercase', GREEK_LOWER],
  ['Greek, uppercase', GREEK_UPPER],
  ['Operators', OPERATORS],
  ['Relations', RELATIONS],
  ['Arrows', ARROWS],
  ['Sets and logic', SETS],
  ['Physics and units', SCIENCE],
  ['Accents and styles', ACCENTS]
]

// ---------- Equation templates ----------
interface Tmpl {
  label: string
  short?: string // the cell's label when the full one would wrap (the tooltip keeps the full one)
  show: string // short preview
  math: string // snippet, math mode
  pkg?: string
}
const TEMPLATES: Tmpl[] = [
  { label: 'Fraction', show: 'a⁄b', math: '\\frac{¦}{}' },
  { label: 'Square root', show: '√x', math: '\\sqrt{¦}' },
  { label: 'Power', show: 'xⁿ', math: '^{¦}' },
  { label: 'Subscript', show: 'xᵢ', math: '_{¦}' },
  { label: 'Sum', show: '∑', math: '\\sum_{i=1}^{n} ¦' },
  { label: 'Integral', show: '∫ dx', math: '\\int_{a}^{b} ¦ \\, dx' },
  { label: 'Limit', show: 'lim', math: '\\lim_{x \\to ¦}' },
  { label: 'Derivative', show: 'd/dx', math: '\\frac{d¦}{dx}' },
  { label: 'Partial derivative', short: 'Partial', show: '∂/∂x', math: '\\frac{\\partial ¦}{\\partial x}' },
  { label: 'Matrix', show: '( ⋱ )', math: '\\begin{pmatrix} ¦a & b \\\\ c & d \\end{pmatrix}', pkg: 'amsmath' },
  { label: 'Cases', show: '{ ⋮', math: 'f(x) = \\begin{cases} ¦ & \\text{if } x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}', pkg: 'amsmath' },
  { label: 'Units', show: '5 m', math: '\\,\\mathrm{¦}' },
  { label: 'Parentheses', show: '( )', math: '\\left( ¦ \\right)' },
  { label: 'Text in math', show: 'abc', math: '\\text{¦}', pkg: 'amsmath' }
]

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function buildSections(el: HTMLElement, host: InsertHost): void {
  const need = (): EditorView | null => {
    const v = host.view()
    if (!v) host.notice('Open a .tex file and put the cursor where you want to insert.')
    return v
  }
  const mathSnippet = async (snippet: string, pkg?: string): Promise<void> => {
    const v = need()
    if (!v) return
    if (pkg && !(await host.ensurePackage(pkg))) return
    const m = inMath(v.state, v.state.selection.main.from)
    insertSnippet(v, m ? snippet : `$${snippet}$`)
  }

  el.innerHTML = `
    <section class="ins-sec"><h4>Table</h4>
      <div class="ins-grid" data-grid></div>
      <div class="ins-hint" data-grid-label>Pick a size</div>
      <div class="ins-row" data-table-more></div>
    </section>
    <section class="ins-sec"><h4>Equation</h4>
      <div class="ins-row">
        <button class="ins-btn wide" data-eq="inline" title="Math inside a sentence: $…$">Inline <i>x</i></button>
        <button class="ins-btn wide" data-eq="equation" title="A numbered equation on its own line">Numbered</button>
        <button class="ins-btn wide" data-eq="align" title="Several equations lined up at &amp;">Aligned</button>
        <button class="ins-btn wide" data-eq="display" title="An unnumbered equation on its own line: \\[ … \\]">Unnumbered</button>
      </div>
      <div class="ins-tmpl">${TEMPLATES.map((t, i) => `<button class="ins-btn" data-tmpl="${i}" title="${esc(t.label)}: ${esc(t.math.replace('¦', '…'))}" aria-label="${esc(t.label)}"><span class="g">${esc(t.show)}</span><span class="l">${esc(t.short ?? t.label)}</span></button>`).join('')}</div>
    </section>
    <section class="ins-sec"><h4>Figure</h4>
      <div class="ins-row"><select data-figure></select><button class="ins-btn wide" data-insert-figure>Insert figure</button></div>
    </section>
    <section class="ins-sec"><h4>Symbols</h4>
      <input type="text" class="ins-search" placeholder="Search symbols (e.g. alpha, arrow, approx)" data-search />
      ${SYMBOL_GROUPS.map(([name, syms], gi) => `<div class="ins-group" data-group><h5>${esc(name)}</h5><div class="ins-syms">${syms.map((s, si) => `<button class="ins-sym" data-sym="${gi}:${si}" title="${esc(s.name)}: ${esc(s.c.replace('¦', '…'))}${s.pkg ? ` (needs ${s.pkg})` : ''}">${esc(s.g)}</button>`).join('')}</div></div>`).join('')}
    </section>`

  // Keep the editor's cursor: buttons shouldn't take focus when pressed.
  el.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault()
  })

  // Table size picker (like Word's grid).
  const grid = el.querySelector<HTMLElement>('[data-grid]')!
  const label = el.querySelector<HTMLElement>('[data-grid-label]')!
  const R = 8
  const C = 8
  for (let r = 1; r <= R; r++) for (let c = 1; c <= C; c++) {
    const cell = document.createElement('button')
    cell.className = 'ins-cell'
    cell.dataset.r = String(r)
    cell.dataset.c = String(c)
    cell.title = `${r} × ${c}`
    grid.appendChild(cell)
  }
  grid.addEventListener('mouseover', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.ins-cell')
    if (!t) return
    const rr = Number(t.dataset.r)
    const cc = Number(t.dataset.c)
    grid.querySelectorAll<HTMLElement>('.ins-cell').forEach((x) => x.classList.toggle('on', Number(x.dataset.r) <= rr && Number(x.dataset.c) <= cc))
    label.textContent = `${rr} row${rr > 1 ? 's' : ''} × ${cc} column${cc > 1 ? 's' : ''} (first row is the header)`
  })
  grid.addEventListener('mouseleave', () => {
    grid.querySelectorAll('.ins-cell.on').forEach((x) => x.classList.remove('on'))
    label.textContent = 'Pick a size'
  })
  grid.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.ins-cell')
    if (t) insertTable(Number(t.dataset.r), Number(t.dataset.c))
  })

  host.tableMore?.(el.querySelector<HTMLElement>('[data-table-more]')!)

  async function insertTable(rows: number, cols: number): Promise<void> {
    const v = need()
    if (!v) return
    const booktabs = host.hasPackage('booktabs')
    const cells = (prefix: string): string => Array.from({ length: cols }, (_, i) => `${prefix} ${i + 1}`).join(' & ')
    const top = booktabs ? '\\toprule' : '\\hline'
    const mid = booktabs ? '\\midrule' : '\\hline'
    const bottom = booktabs ? '\\bottomrule' : '\\hline'
    const snippet = [
      '\\begin{table}[tb]',
      '  \\centering',
      '  \\caption{¦}',
      '  \\label{tab:}',
      `  \\begin{tabular}{${'l'.repeat(cols)}}`,
      `    ${top}`,
      `    ${cells('Header')} \\\\`,
      `    ${mid}`,
      ...Array.from({ length: Math.max(0, rows - 1) }, () => `    ${Array.from({ length: cols }, () => '').join(' & ')} \\\\`),
      `    ${bottom}`,
      '  \\end{tabular}',
      '\\end{table}'
    ].join('\n')
    insertSnippet(v, snippet, { ownLine: true })
  }

  el.querySelectorAll<HTMLButtonElement>('[data-eq]').forEach((b) => {
    b.onclick = async () => {
      const v = need()
      if (!v) return
      const kind = b.dataset.eq
      if (kind === 'inline') insertSnippet(v, '$¦$')
      else if (kind === 'equation') insertSnippet(v, '\\begin{equation}\n  ¦\n  \\label{eq:}\n\\end{equation}', { ownLine: true })
      else if (kind === 'display') insertSnippet(v, '\\[\n  ¦\n\\]', { ownLine: true })
      else if (await host.ensurePackage('amsmath')) insertSnippet(v, '\\begin{align}\n  ¦a &= b \\\\\n  c &= d\n\\end{align}', { ownLine: true })
    }
  })
  el.querySelectorAll<HTMLButtonElement>('[data-tmpl]').forEach((b) => {
    const t = TEMPLATES[Number(b.dataset.tmpl)]
    b.onclick = () => mathSnippet(t.math, t.pkg)
  })
  el.querySelectorAll<HTMLButtonElement>('[data-sym]').forEach((b) => {
    const [gi, si] = b.dataset.sym!.split(':').map(Number)
    const s = SYMBOL_GROUPS[gi][1][si]
    b.onclick = async () => {
      const v = need()
      if (!v) return
      if (s.pkg && !(await host.ensurePackage(s.pkg))) return
      const m = inMath(v.state, v.state.selection.main.from)
      if (!m && s.text) return insertSnippet(v, s.text + '¦')
      // Commands ending in a letter need a space before a following letter (\alpha x, not \alphax).
      const next = v.state.sliceDoc(v.state.selection.main.to, v.state.selection.main.to + 1)
      const pad = /\\[a-zA-Z]+$/.test(s.c) && /[a-zA-Z]/.test(next) ? ' ' : ''
      insertSnippet(v, m ? s.c + (s.c.includes('¦') ? '' : '¦') + pad : `$${s.c}${s.c.includes('¦') ? '' : '¦'}$`)
    }
  })

  // Search filters symbol buttons by name or command.
  el.querySelector<HTMLInputElement>('[data-search]')!.addEventListener('input', (e) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase()
    el.querySelectorAll<HTMLElement>('[data-group]').forEach((g) => {
      let any = false
      g.querySelectorAll<HTMLElement>('.ins-sym').forEach((b) => {
        const hit = !q || b.title.toLowerCase().includes(q) || b.textContent === q
        b.classList.toggle('hidden', !hit)
        any ||= hit
      })
      g.classList.toggle('hidden', !any)
    })
  })

  // Figure: choose one of the project's images.
  const figSel = el.querySelector<HTMLSelectElement>('[data-figure]')!
  const refreshImages = (): void => {
    const imgs = host.images()
    figSel.innerHTML = imgs.length ? imgs.map((p) => `<option>${esc(p)}</option>`).join('') : '<option value="">(no images in this project yet)</option>'
  }
  figSel.addEventListener('focus', refreshImages)
  figSel.addEventListener('mousedown', refreshImages)
  refreshImages()
  el.querySelector<HTMLButtonElement>('[data-insert-figure]')!.onclick = async () => {
    const v = need()
    if (!v) return
    refreshImages()
    const img = figSel.value
    if (!img) return host.notice('Drag an image (PNG, JPG or PDF) into the project folder first; it will appear here.')
    if (!(await host.ensurePackage('graphicx'))) return
    const name = img.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()
    insertSnippet(v, `\\begin{figure}[tb]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${img}}\n  \\caption{¦}\n  \\label{fig:${name}}\n\\end{figure}`, { ownLine: true })
  }
}

export { insertSnippet as insertAtCursor }

const T = (x: number, y: number, size: number, body: string, attrs = ''): string =>
  `<text x="${x}" y="${y}" font-size="${size}" font-family="Times New Roman, serif" fill="currentColor" stroke="none"${attrs}>${body}</text>`
const N = (y: number, n: number): string =>
  `<text x="1.8" y="${y}" font-size="6.5" font-family="system-ui, sans-serif" font-weight="700" fill="currentColor" stroke="none">${n}</text>`
const DOT = (y: number): string => `<circle cx="4.5" cy="${y}" r="1.4" fill="currentColor" stroke="none"/>`
const LINES = '<path d="M8.5 5.5h8M8.5 10h8M8.5 14.5h8"/>'
const ICONS: Record<string, string> = {
  table: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 8h15M2.5 12.5h15M7.5 3.5v13M12.5 3.5v13"/>',
  equation: '<path d="M14.5 4.5h-9l5 5.5-5 5.5h9"/>',
  symbol: '<text x="10" y="15.5" text-anchor="middle" font-size="15" font-family="Times New Roman, serif" fill="currentColor" stroke="none">Ω</text>',
  figure: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="M3 14.5l4-4 3 3 2.5-2.5 4.5 4"/>',
  superscript: T(2, 16.5, 15, 'x', ' font-style="italic"') + T(10.5, 9, 9.5, '2'),
  subscript: T(2, 13, 15, 'x', ' font-style="italic"') + T(10.5, 18.5, 9.5, '2'),
  bold: T(10, 15.5, 15, 'B', ' text-anchor="middle" font-weight="bold"'),
  italic: T(10, 15.5, 15, 'I', ' text-anchor="middle" font-style="italic"'),
  bullets: DOT(5.5) + DOT(10) + DOT(14.5) + LINES,
  numbers: N(8, 1) + N(12.6, 2) + N(17.2, 3) + LINES,
  link: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c-2.2 2-3.2 4.3-3.2 7s1 5 3.2 7M10 3c2.2 2 3.2 4.3 3.2 7s-1 5-3.2 7"/>',
  contents: '<path d="M3 4.5h8M5.5 8.5h6M5.5 12h5M3 16h7.5"/><path d="M14.5 4.5h2.5M14.5 8.5h2.5M14.5 12h2.5M14.5 16h2.5" stroke-width="2"/>',
  reference: '<path d="M8.5 11.5l3-3M7 9.2 5.4 10.8a2.6 2.6 0 0 0 3.7 3.7l1.6-1.6M13 10.8l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7L9.3 7.1"/>',
  footnote: '<path d="M3.5 5.5h9M3.5 9h9M3.5 12.5h6"/><path d="M14.5 13.5l1.5-1.5v5"/>'
}

/** What the formatting tools wrap the selection in: [in math, in text]. */
const WRAPS: Record<string, [string, string]> = {
  superscript: ['^{', '\\textsuperscript{'],
  subscript: ['_{', '\\textsubscript{'],
  bold: ['\\mathbf{', '\\textbf{'],
  italic: ['\\mathit{', '\\emph{']
}

/**
 * Build the Insert toolbar in `bar`. Table, Equation, Symbol and Figure open a drop-down
 * (`pop`); the formatting, list and link tools act on the selection; Cross-reference and
 * Footnote insert directly (Cross-reference opens autocomplete). Citations have their own tab.
 */
export function buildInsertBar(bar: HTMLElement, pop: HTMLElement, host: InsertHost): void {
  const store = document.createElement('div')
  buildSections(store, host)
  const sections = [...store.querySelectorAll<HTMLElement>('.ins-sec')]
  const byName: Record<string, HTMLElement> = { table: sections[0], equation: sections[1], figure: sections[2], symbol: sections[3] }
  const contents = (byName.contents = document.createElement('section'))
  contents.className = 'ins-sec'
  contents.innerHTML = [
    ['toc', 'Table of contents', 'The section headings with page numbers'],
    ['lof', 'List of figures', 'Every figure’s caption with its page'],
    ['lot', 'List of tables', 'Every table’s caption with its page']
  ]
    .map(([k, b, s]) => `<button class="ins-choice" data-contents="${k}" title="Insert ${esc(CONTENTS[k][0])}"><b>${b}</b><small>${s} (filled in after the next compile)</small></button>`)
    .join('')
  contents.querySelectorAll<HTMLButtonElement>('[data-contents]').forEach((b) => {
    b.onclick = () => {
      const v = host.view()
      if (v) insertContents(v, host, b.dataset.contents!)
    }
  })
  const tool = (id: string, label: string, title: string, dropdown: boolean): string =>
    `<button class="rb-tile rb-btn" data-tool="${id}" title="${esc(title)}"${dropdown ? ' aria-haspopup="dialog" aria-expanded="false" aria-controls="ins-pop"' : ''}><svg viewBox="0 0 20 20">${ICONS[id]}</svg><span>${label}</span>${dropdown ? '<i class="rb-caret" aria-hidden="true"><svg viewBox="0 0 8 8"><path d="M1.75 3l2.25 2.25L6.25 3"/></svg></i>' : ''}</button>`
  // Small tools show only their icon, stacked two to a column; the tooltip says what they insert.
  const small = (id: string, label: string, title: string): string =>
    `<button class="rb-tile rb-btn rb-mini" data-tool="${id}" title="${esc(`${label}: ${title}`)}" aria-label="${esc(label)}"><svg viewBox="0 0 20 20">${ICONS[id]}</svg></button>`
  bar.innerHTML = `<div class="rb-group">${tool('table', 'Table', 'Insert a table', true)}${tool('equation', 'Equation', 'Insert an equation or math template', true)}${tool('symbol', 'Symbol', 'Insert a symbol: Greek letters, operators, arrows…', true)}${tool('figure', 'Figure', 'Insert a figure from the project’s images', true)}</div>
    <div class="rb-sep"></div>
    <div class="rb-group"><div class="rb-stack">${small('superscript', 'Superscript (exponent)', '^{…} in math, \\textsuperscript{…} in text. Select text first to raise it.')}${small('subscript', 'Subscript', '_{…} in math, \\textsubscript{…} in text. Select text first to lower it.')}</div><div class="rb-stack">${small('bold', 'Bold', '\\textbf{…} in text, \\mathbf{…} in math. Select text first to make it bold; click again to remove it.')}${small('italic', 'Italic (emphasis)', '\\emph{…} in text, \\mathit{…} in math. Select text first to emphasize it; click again to remove it.')}</div></div>
    <div class="rb-sep"></div>
    <div class="rb-group"><div class="rb-stack">${small('bullets', 'Bulleted list', '\\begin{itemize} \\item … \\end{itemize}. Selected lines become the items.')}${small('numbers', 'Numbered list', '\\begin{enumerate} \\item … \\end{enumerate}. Selected lines become the items.')}</div>${tool('link', 'Link', 'Web link: \\url{address}; with text selected, \\href{address}{text} makes that text the link (uses the hyperref package).', false)}</div>
    <div class="rb-sep"></div>
    <div class="rb-group ins-tail">${tool('reference', 'Cross-reference', 'Insert \\ref{…} to a figure, table, equation or section', false)}${tool('footnote', 'Footnote', 'Insert \\footnote{…}', false)}${tool('contents', 'Contents', 'Insert a table of contents (\\tableofcontents), list of figures or list of tables', true)}</div>`

  let openTool: string | null = null
  let opener: HTMLElement | null = null
  /** `refocus`: Escape from the keyboard hands the focus back to the tile that opened the drop-down. */
  const close = (refocus = false): void => {
    const back = refocus && opener && (pop.contains(document.activeElement) || document.activeElement === opener)
    pop.classList.add('hidden')
    bar.querySelectorAll('.rb-btn.on').forEach((b) => b.classList.remove('on'))
    bar.querySelectorAll('[aria-expanded=true]').forEach((b) => b.setAttribute('aria-expanded', 'false'))
    if (back) opener!.focus()
    openTool = null
    opener = null
  }
  const open = (id: string, btn: HTMLElement): void => {
    if (openTool === id) return close()
    close()
    if (!host.view()) return host.notice('Open a .tex file and put the cursor where you want to insert.')
    openTool = id
    opener = btn
    const fromKeyboard = btn.matches(':focus-visible')
    btn.classList.add('on')
    btn.setAttribute('aria-expanded', 'true')
    pop.replaceChildren(byName[id])
    pop.dataset.tool = id
    pop.setAttribute('aria-label', btn.querySelector('span')?.textContent ?? id)
    pop.classList.remove('hidden')
    const r = btn.getBoundingClientRect()
    const w = pop.offsetWidth
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`
    pop.style.top = `${r.bottom + 4}px`
    pop.style.maxHeight = `${window.innerHeight - r.bottom - 24}px`
    if (id === 'symbol') setTimeout(() => byName.symbol.querySelector<HTMLInputElement>('[data-search]')?.focus(), 0)
    if (id === 'figure') byName.figure.querySelector('select')?.dispatchEvent(new Event('focus'))
    // Opened from the keyboard: move into the drop-down (Escape comes back to the tile).
    if (fromKeyboard && id !== 'symbol') pop.querySelector<HTMLElement>('button, select, input')?.focus()
  }
  bar.addEventListener('mousedown', (e) => e.preventDefault()) // keep the editor's cursor
  bar.querySelectorAll<HTMLButtonElement>('.rb-btn').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.tool!
      if (byName[id]) return open(id, b)
      close()
      const v = host.view()
      if (!v) return host.notice('Open a .tex file and put the cursor where you want to insert.')
      const math = inMath(v.state, v.state.selection.main.from)
      if (WRAPS[id]) return wrap(v, WRAPS[id][math ? 0 : 1])
      const list = id === 'bullets' || id === 'numbers'
      if ((list || id === 'link') && math) return host.notice(`A ${list ? 'list' : 'link'} can’t go inside math. Put the cursor in ordinary text.`)
      if (list) return insertList(v, id === 'bullets' ? 'itemize' : 'enumerate')
      if (id === 'link') {
        if (await host.ensurePackage('hyperref')) insertLink(v)
        return
      }
      insertSnippet(v, id === 'reference' ? '~\\ref{¦}' : '\\footnote{¦}')
      if (id === 'reference') setTimeout(() => startCompletion(v), 0)
    }
  })
  // Inserting from Table, Equation or Figure closes the drop-down; Symbol stays open for more.
  pop.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (b && openTool && openTool !== 'symbol') setTimeout(close, 0)
  })
  document.addEventListener('mousedown', (e) => {
    if (openTool && !pop.contains(e.target as Node) && !bar.contains(e.target as Node)) close()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openTool) close(true)
  })
}
