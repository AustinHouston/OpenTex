// Editor helpers: autocomplete for citations, labels, environments and commands, and
// spellchecking that skips LaTeX commands, math and arguments like \cite{...}.
import { autocompletion, Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { Compartment, Extension, RangeSetBuilder } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'

export interface CompletionData {
  citations: { key: string; title: string }[]
  labels: string[]
  commands: string[]
}

const ENVIRONMENTS = ['equation', 'equation*', 'align', 'align*', 'figure', 'figure*', 'table', 'table*', 'tabular', 'itemize', 'enumerate', 'description', 'abstract', 'center', 'gather', 'gather*', 'multline', 'split', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'theorem', 'lemma', 'proof', 'definition', 'quote', 'verbatim', 'minipage', 'subfigure', 'thebibliography', 'document']
const COMMANDS = ['section', 'subsection', 'subsubsection', 'paragraph', 'chapter', 'part', 'label', 'ref', 'eqref', 'cite', 'citep', 'citet', 'emph', 'textbf', 'textit', 'texttt', 'underline', 'footnote', 'caption', 'includegraphics', 'begin', 'end', 'item', 'frac', 'sqrt', 'sum', 'int', 'prod', 'lim', 'infty', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'theta', 'lambda', 'mu', 'nu', 'pi', 'rho', 'sigma', 'tau', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Sigma', 'Phi', 'Psi', 'Omega', 'partial', 'nabla', 'cdot', 'times', 'leq', 'geq', 'neq', 'approx', 'sim', 'pm', 'mathrm', 'mathbf', 'mathcal', 'mathbb', 'left', 'right', 'quad', 'qquad', 'hline', 'centering', 'usepackage', 'documentclass', 'newcommand', 'renewcommand', 'input', 'include', 'bibliography', 'bibliographystyle', 'maketitle', 'title', 'author', 'date', 'tableofcontents', 'url', 'href', 'SI', 'si', 'num', 'autoref', 'cref', 'Cref']

export function latexCompletions(data: () => CompletionData): Extension {
  return autocompletion({
    activateOnTyping: true,
    icons: false,
    override: [
      (ctx: CompletionContext): CompletionResult | null => {
        const cite = ctx.matchBefore(/\\(?:no)?(?:cite|citep|citet|citealp|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\]){0,2}\{[^}]*/)
        if (cite) {
          const from = cite.from + cite.text.search(/[^{,\s]*$/)
          return { from, options: data().citations.map((c): Completion => ({ label: c.key, detail: c.title, type: 'text' })), validFor: /^[^,}\s]*$/ }
        }
        const ref = ctx.matchBefore(/\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref|vref)\{[^}]*/)
        if (ref) return { from: ref.from + ref.text.indexOf('{') + 1, options: data().labels.map((l) => ({ label: l, type: 'variable' })), validFor: /^[^}]*$/ }
        const env = ctx.matchBefore(/\\(?:begin|end)\{[^}]*/)
        if (env) return { from: env.from + env.text.indexOf('{') + 1, options: ENVIRONMENTS.map((e) => ({ label: e, type: 'type' })), validFor: /^[^}]*$/ }
        const cmd = ctx.matchBefore(/\\[a-zA-Z]*/)
        if (cmd && (cmd.text.length > 1 || ctx.explicit)) {
          const all = [...new Set([...COMMANDS, ...data().commands])]
          return { from: cmd.from + 1, options: all.map((c) => ({ label: c, type: 'keyword' })), validFor: /^[a-zA-Z]*$/ }
        }
        return null
      }
    ]
  })
}

/** Scan project text for \label{...} and \newcommand{\name}. */
export function scanTex(text: string, labels: Set<string>, commands: Set<string>): void {
  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) labels.add(m[1])
  for (const m of text.matchAll(/\\(?:re)?newcommand\*?\{?\\([a-zA-Z]+)/g)) commands.add(m[1])
  for (const m of text.matchAll(/\\DeclareMathOperator\*?\{\\([a-zA-Z]+)\}/g)) commands.add(m[1])
}

/** The value of a BibTeX field, with nested braces handled: title = {The {\TeX}book} -> The {\TeX}book */
function bibField(entry: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*`, 'i').exec(entry)
  if (!m) return ''
  let i = m.index + m[0].length
  const open = entry[i]
  if (open === '"') return entry.slice(i + 1, entry.indexOf('"', i + 1))
  if (open !== '{') return (entry.slice(i).match(/^[^,\n}]*/) ?? [''])[0]
  let depth = 0
  const start = i + 1
  for (; i < entry.length; i++) {
    if (entry[i] === '{') depth++
    else if (entry[i] === '}' && --depth === 0) break
  }
  return entry.slice(start, i)
}

/** Scan a .bib file for entry keys and titles. */
export function scanBib(text: string): { key: string; title: string }[] {
  const out: { key: string; title: string }[] = []
  const entries = text.split(/(?=@\w+\s*\{)/)
  for (const e of entries) {
    const m = e.match(/^@(\w+)\s*\{\s*([^,\s]+)\s*,/)
    if (!m || /^(string|comment|preamble)$/i.test(m[1])) continue
    const title = bibField(e, 'title').replace(/\\(LaTeX|TeX)\b/g, '$1').replace(/\\["'`^~=.]/g, '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
    out.push({ key: m[2], title })
  }
  return out
}

// ---------- Spellcheck ----------
const NO_SPELL = Decoration.mark({ attributes: { spellcheck: 'false' } })
// Commands, inline math, comment lines, and the arguments of commands that hold keys or code.
const SKIP = /\\(?:cite\w*|ref|eqref|autoref|cref|Cref|label|usepackage|documentclass|begin|end|input|include|includegraphics|bibliography\w*|url|href|newcommand|renewcommand)\*?(?:\[[^\]]*\])*\{[^}]*\}|\\[a-zA-Z@]+|\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\([\s\S]*?\\\)|%.*$/gm

const skipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(v: EditorView) {
      this.decorations = this.build(v)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>()
      for (const { from, to } of view.visibleRanges) {
        const start = view.state.doc.lineAt(from).from
        const end = view.state.doc.lineAt(to).to
        const text = view.state.doc.sliceString(start, end)
        for (const m of text.matchAll(SKIP)) if (m[0].length) b.add(start + m.index!, start + m.index! + m[0].length, NO_SPELL)
      }
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

export const spellCompartment = new Compartment()
export const spellExtension = (on: boolean): Extension =>
  on ? [EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }), skipPlugin] : []

/** Rough word count of LaTeX source: drops comments, commands, math and braces. */
export function countWords(tex: string): number {
  const body = tex.includes('\\begin{document}') ? tex.slice(tex.indexOf('\\begin{document}')) : tex
  const text = body
    .replace(/%.*$/gm, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$]*\$/g, ' ')
    .replace(/\\begin\{(equation|align|gather|multline)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
    .replace(/\\(?:cite\w*|ref|eqref|label|usepackage|begin|end|includegraphics|input|include|bibliography\w*)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}[\]~\\&#^_]/g, ' ')
  return (text.match(/[A-Za-z0-9À-ɏ][\wÀ-ɏ'’-]*/g) ?? []).length
}
