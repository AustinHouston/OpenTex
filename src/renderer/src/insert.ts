// The Insert toolbar (like Word's Insert tab): tables, equations, symbols, figures, citations,
// cross-references and footnotes, inserted at the cursor.
// Symbols know whether the cursor is in math: inside math they insert \alpha, outside they
// insert $\alpha$. Anything that needs a package not yet loaded offers to add it.

import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { startCompletion } from '@codemirror/autocomplete'

export interface InsertHost {
  view: () => EditorView | null // null when no .tex file is open
  images: () => string[] // image files in the project, for figures
  ensurePackage: (pkg: string) => Promise<boolean> // true if loaded (or just added)
  hasPackage: (pkg: string) => boolean
  notice: (msg: string) => void
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
  if (opts.ownLine) {
    const line = view.state.doc.lineAt(sel.from)
    if (sel.from > line.from && line.text.slice(0, sel.from - line.from).trim()) text = '\n' + text
    const after = view.state.doc.sliceString(sel.to, view.state.doc.lineAt(sel.to).to)
    if (after.trim()) text = text + '\n'
  }
  const cursorAt = text.indexOf(CURSOR)
  const clean = text.split(CURSOR).join('')
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: clean },
    selection: { anchor: sel.from + (cursorAt >= 0 ? cursorAt : clean.length) },
    scrollIntoView: true,
    userEvent: 'input'
  })
  view.focus()
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
  { label: 'Partial derivative', show: '∂/∂x', math: '\\frac{\\partial ¦}{\\partial x}' },
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
    </section>
    <section class="ins-sec"><h4>Equation</h4>
      <div class="ins-row">
        <button class="ins-btn wide" data-eq="inline" title="Math inside a sentence: $…$">Inline <i>x</i></button>
        <button class="ins-btn wide" data-eq="equation" title="A numbered equation on its own line">Numbered</button>
        <button class="ins-btn wide" data-eq="align" title="Several equations lined up at &amp;">Aligned</button>
        <button class="ins-btn wide" data-eq="display" title="An unnumbered equation on its own line: \\[ … \\]">Unnumbered</button>
      </div>
      <div class="ins-tmpl">${TEMPLATES.map((t, i) => `<button class="ins-btn" data-tmpl="${i}" title="${esc(t.label)}: ${esc(t.math.replace('¦', '…'))}"><span class="g">${esc(t.show)}</span><span class="l">${esc(t.label)}</span></button>`).join('')}</div>
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

const ICONS: Record<string, string> = {
  table: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 8h15M2.5 12.5h15M7.5 3.5v13M12.5 3.5v13"/>',
  equation: '<path d="M14.5 4.5h-9l5 5.5-5 5.5h9"/>',
  symbol: '<text x="10" y="15.5" text-anchor="middle" font-size="15" font-family="Times New Roman, serif" fill="currentColor" stroke="none">Ω</text>',
  figure: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><circle cx="7" cy="8" r="1.5"/><path d="M3 14.5l4-4 3 3 2.5-2.5 4.5 4"/>',
  citation: '<path d="M4 3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v11.5H5.5A1.5 1.5 0 0 1 4 15z"/><path d="M4 15a1.5 1.5 0 0 1 1.5-1.5H15M7.5 6.5h4.5M7.5 9h3"/>',
  reference: '<path d="M8.5 11.5l3-3M7 9.2 5.4 10.8a2.6 2.6 0 0 0 3.7 3.7l1.6-1.6M13 10.8l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7L9.3 7.1"/>',
  footnote: '<path d="M3.5 5.5h9M3.5 9h9M3.5 12.5h6"/><path d="M14.5 13.5l1.5-1.5v5"/>'
}

/**
 * Build the Insert toolbar in `bar`. Table, Equation, Symbol and Figure open a drop-down
 * (`pop`); Citation, Cross-reference and Footnote insert directly and open autocomplete.
 */
export function buildInsertBar(bar: HTMLElement, pop: HTMLElement, host: InsertHost): void {
  const store = document.createElement('div')
  buildSections(store, host)
  const sections = [...store.querySelectorAll<HTMLElement>('.ins-sec')]
  const byName: Record<string, HTMLElement> = { table: sections[0], equation: sections[1], figure: sections[2], symbol: sections[3] }
  const tool = (id: string, label: string, title: string, dropdown: boolean): string =>
    `<button class="rb-btn" data-tool="${id}" title="${title}"><svg viewBox="0 0 20 20">${ICONS[id]}</svg><span>${label}</span>${dropdown ? '<i class="rb-caret">▾</i>' : ''}</button>`
  bar.innerHTML = `<div class="rb-group">${tool('table', 'Table', 'Insert a table', true)}${tool('equation', 'Equation', 'Insert an equation or math template', true)}${tool('symbol', 'Symbol', 'Insert a symbol: Greek letters, operators, arrows…', true)}${tool('figure', 'Figure', 'Insert a figure from the project’s images', true)}</div>
    <div class="rb-sep"></div>
    <div class="rb-group">${tool('citation', 'Citation', 'Insert \\cite{…} and pick a reference', false)}${tool('reference', 'Cross-reference', 'Insert \\ref{…} to a figure, table, equation or section', false)}${tool('footnote', 'Footnote', 'Insert \\footnote{…}', false)}</div>`

  let openTool: string | null = null
  const close = (): void => {
    pop.classList.add('hidden')
    bar.querySelectorAll('.rb-btn.on').forEach((b) => b.classList.remove('on'))
    openTool = null
  }
  const open = (id: string, btn: HTMLElement): void => {
    if (openTool === id) return close()
    close()
    if (!host.view()) return host.notice('Open a .tex file and put the cursor where you want to insert.')
    openTool = id
    btn.classList.add('on')
    pop.replaceChildren(byName[id])
    pop.dataset.tool = id
    pop.classList.remove('hidden')
    const r = btn.getBoundingClientRect()
    const w = pop.offsetWidth
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`
    pop.style.top = `${r.bottom + 4}px`
    pop.style.maxHeight = `${window.innerHeight - r.bottom - 24}px`
    if (id === 'symbol') setTimeout(() => byName.symbol.querySelector<HTMLInputElement>('[data-search]')?.focus(), 0)
    if (id === 'figure') byName.figure.querySelector('select')?.dispatchEvent(new Event('focus'))
  }
  bar.addEventListener('mousedown', (e) => e.preventDefault()) // keep the editor's cursor
  bar.querySelectorAll<HTMLButtonElement>('.rb-btn').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.tool!
      if (byName[id]) return open(id, b)
      close()
      const v = host.view()
      if (!v) return host.notice('Open a .tex file and put the cursor where you want to insert.')
      insertSnippet(v, id === 'citation' ? '~\\cite{¦}' : id === 'reference' ? '~\\ref{¦}' : '\\footnote{¦}')
      if (id !== 'footnote') setTimeout(() => startCompletion(v), 0)
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
    if (e.key === 'Escape' && openTool) close()
  })
}
