// Add a reference by DOI (or arXiv ID): look up its BibTeX online, clean it, give it a readable key,
// append it to the project's .bib file and cite it at the cursor. Also offers this when a DOI is
// pasted into the editor.
import './doi.css'
import type { EditorView } from '@codemirror/view'
import type { ProjectInfo } from '../../shared/types'
import { allFiles } from './filetree'
import { makeKey, mergeIntoBib, parseBibtex, Ref } from './refs-import'
import { ask } from './ui'

type LookUpResult = { ok: true; bibtex: string; source: string } | { ok: false; reason: 'not-found' | 'network' | 'no-bibtex' | 'bad-reply'; detail?: string }

export interface DoiHost {
  view: () => EditorView | null // the editor, when a .tex file is open
  active: () => string | null
  project: () => ProjectInfo | null
  textOf: (path: string) => string | null // text of an open file
  isDirty: (path: string) => boolean
  save: (path: string) => Promise<void>
  /** A file was written on disk: reload the tree, the open copy and the citation list. */
  changed: (path: string) => Promise<void>
  notice: (msg: string) => void
}

interface Api {
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, t: string) => Promise<void>
  lookUpDoi: (id: string, kind: 'doi' | 'arxiv') => Promise<LookUpResult>
}
const api = (window as unknown as { opentex: Api }).opentex

// ---------- Recognizing DOIs and arXiv IDs ----------
export interface RefId {
  kind: 'doi' | 'arxiv'
  id: string
}

const DOI_RE = /10\.\d{4,9}\/\S+/
const ARXIV_NEW = /^\d{4}\.\d{4,5}(v\d+)?$/
const ARXIV_OLD = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/

/** Remove punctuation that ends a sentence rather than the DOI. */
function trimDoi(d: string): string {
  d = d.replace(/[.,;:'"”’>\]]+$/, '')
  // A closing parenthesis belongs to the DOI only if the DOI opened one.
  while (d.endsWith(')') && (d.match(/\(/g) ?? []).length < (d.match(/\)/g) ?? []).length) d = d.slice(0, -1).replace(/[.,;:]+$/, '')
  return d
}

/** One token (a word on a line) to a DOI or arXiv ID; `strict` requires an explicit DOI/arXiv form. */
export function parseId(token: string, strict = false): RefId | null {
  let t = token.trim().replace(/^<|>$/g, '')
  if (!t) return null
  const arxivUrl = t.match(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i)
  const arxivPre = t.match(/^arxiv:\s*(.+)$/i)
  const ax = (arxivUrl?.[1] ?? arxivPre?.[1] ?? (strict ? '' : t)).trim()
  if (ax && (ARXIV_NEW.test(ax) || ((arxivUrl || arxivPre) && ARXIV_OLD.test(ax)))) return { kind: 'arxiv', id: ax }
  if (arxivUrl || arxivPre) return null
  const url = t.match(/^https?:\/\/(?:dx\.)?doi\.org\/(.+)$/i)
  if (url) {
    try {
      t = decodeURIComponent(url[1])
    } catch {
      t = url[1]
    }
  } else if (/^doi:\s*/i.test(t)) t = t.replace(/^doi:\s*/i, '')
  else if (strict && !/^10\.\d{4,9}\//.test(t)) return null
  const m = t.match(DOI_RE)
  if (!m || (strict && m.index !== 0)) return null
  const id = trimDoi(m[0])
  return /^10\.\d{4,9}\/\S+$/.test(id) ? { kind: 'doi', id } : null
}

/** Every DOI or arXiv ID in pasted text (one per line, or separated by spaces). */
export function parseIds(text: string): { input: string; ref: RefId | null }[] {
  const out: { input: string; ref: RefId | null }[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    // "doi: 10.1/x" and "arXiv: 2101.00001" have a space after the prefix.
    const tokens = l.replace(/\b(doi|arxiv):\s+/gi, '$1:').split(/\s+/)
    const found = tokens.map((t) => parseId(t)).filter((r): r is RefId => Boolean(r))
    if (!found.length) out.push({ input: l, ref: null })
    for (const ref of found) {
      const k = `${ref.kind}:${ref.id.toLowerCase()}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ input: ref.kind === 'arxiv' ? `arXiv:${ref.id}` : ref.id, ref })
    }
  }
  return out
}

// ---------- Cleaning the BibTeX that doi.org, Crossref or arXiv send ----------
interface Entry {
  type: string
  key: string
  fields: [string, string, 'brace' | 'bare'][]
}

/** Parse one BibTeX entry, with nested braces in values. */
export function parseEntry(src: string): Entry | null {
  const head = src.match(/@\s*(\w+)\s*\{\s*([^,\s]*)\s*,/)
  if (!head) return null
  const fields: Entry['fields'] = []
  let i = head.index! + head[0].length
  const n = src.length
  while (i < n) {
    const m = /^\s*([A-Za-z][\w:.+-]*)\s*=\s*/.exec(src.slice(i, i + 200))
    if (!m) break
    const name = m[1].toLowerCase()
    i += m[0].length
    let value = ''
    let kind: 'brace' | 'bare' = 'brace'
    if (src[i] === '{') {
      let depth = 0
      const start = i + 1
      for (; i < n; i++) {
        if (src[i] === '\\') i++
        else if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) break
      }
      value = src.slice(start, i)
      i++
    } else if (src[i] === '"') {
      const start = i + 1
      let depth = 0
      for (i++; i < n; i++) {
        if (src[i] === '\\') i++
        else if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        else if (src[i] === '"' && depth <= 0) break
      }
      value = src.slice(start, i)
      i++
    } else {
      const bare = /^[^,}\s]+/.exec(src.slice(i))?.[0] ?? ''
      value = bare
      i += bare.length
      kind = /^\d+$/.test(bare) ? 'brace' : 'bare'
    }
    fields.push([name, value, kind])
    const sep = /^\s*,?/.exec(src.slice(i))![0]
    i += sep.length
  }
  return { type: head[1].toLowerCase(), key: head[2], fields }
}

/** Decode HTML entities (&amp;, &#x2013;, …) without running anything: a textarea's value is plain text. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  const ta = document.createElement('textarea')
  ta.innerHTML = s.replace(/</g, '&lt;')
  return ta.value
}

// Characters pdfLaTeX can't print from a .bib file without extra packages.
const UNICODE: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa',
  λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon',
  φ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega', Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi',
  Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega', '≤': '\\leq', '≥': '\\geq', '≈': '\\approx', '≠': '\\neq',
  '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow', '∞': '\\infty', '∼': '\\sim', '′': '\\prime', '∂': '\\partial',
  '√': '\\surd', '∑': '\\sum', '∫': '\\int', '⊥': '\\perp', '∥': '\\parallel', '·': '\\cdot', 'ℏ': '\\hbar', '∇': '\\nabla', '−': '-'
}
const UNICODE_RE = new RegExp(`[${Object.keys(UNICODE).join('')}]`, 'g')

/** Turn a value from the web into BibTeX that compiles: no HTML, special characters escaped outside math. */
function cleanText(v: string): string {
  let s = v
    .replace(/<(sub|inf)>([\s\S]*?)<\/\1>/gi, '$_{$2}$')
    .replace(/<sup>([\s\S]*?)<\/sup>/gi, '$^{$1}$')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '\\textit{$2}')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '\\textbf{$2}')
    .replace(/<\/?[a-zA-Z][\w:.-]*(\s[^<>]*)?\/?>/g, '') // any other tags (MathML, <scp>, …)
  s = decodeEntities(s)
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ -   ]/g, ' ') // thin spaces ("B. P."); \, would add a comma to author lists
    .replace(/\s+/g, ' ')
    .trim()
  // Escape & % # _ outside math, unless already escaped; math-only symbols go in $…$.
  return s
    .split(/(\$[^$]*\$)/)
    .map((part, i) =>
      i % 2 ? part : part.replace(/(^|[^\\])([&%#_])/g, '$1\\$2').replace(/(^|[^\\])([&%#_])/g, '$1\\$2').replace(UNICODE_RE, (c) => (UNICODE[c] === '-' ? '-' : `$${UNICODE[c]}$`))
    )
    .join('')
}

export interface Found {
  ref: Ref // key filled in later; raw holds the cleaned entry (with key placeholder)
  entry: Entry
  preview: string
}

/** Readable text for the preview: drop braces and simple commands. */
const plain = (s: string): string =>
  s.replace(/\\(?:textit|textbf|emph|mathrm|text)\{([^{}]*)\}/g, '$1').replace(/\\[a-zA-Z]+\s?/g, '').replace(/[{}$\\]/g, '').replace(/\s+/g, ' ').trim()

export function cleanEntry(bibtex: string, ref: RefId): Found | null {
  const e = parseEntry(bibtex)
  if (!e) return null
  const out: Entry['fields'] = []
  const get = (k: string): string => out.find((f) => f[0] === k)?.[1] ?? ''
  for (const [name, raw, kind] of e.fields) {
    if (kind === 'bare') {
      out.push([name, name === 'month' ? raw.toLowerCase() : raw, 'bare'])
      continue
    }
    let v = name === 'url' || name === 'doi' ? decodeEntities(raw).trim() : cleanText(raw)
    if (name === 'pages') v = v.replace(/\s*[–—-]+\s*/g, '--')
    if (name === 'doi') v = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    if (name === 'url') v = v.replace(/^https?:\/\/dx\.doi\.org\//i, 'https://doi.org/')
    if (name === 'title') v = v.replace(/^\{([^{}]*)\}$/, '$1')
    if (v) out.push([name, v, 'brace'])
  }
  if (ref.kind === 'doi' && !get('doi')) out.push(['doi', ref.id, 'brace'])
  if (ref.kind === 'arxiv' && !get('journal') && !get('note') && !get('howpublished')) out.push(['note', `arXiv:${ref.id.replace(/v\d+$/, '')}`, 'brace'])
  // Readable text (for the preview, the key and spotting duplicates) comes from the original values.
  const orig = e.fields
  const original = (k: string): string => plain(decodeEntities((orig.find((f) => f[0] === k)?.[1] ?? '').replace(/<[^<>]*>/g, '')))
  e.fields = out
  const authors = original('author')
    .split(/\s+and\s+/)
    .map((a) => a.trim())
    .filter(Boolean)
  const title = original('title')
  const r: Ref = { type: e.type, key: '', fields: { title, year: get('year'), doi: get('doi'), publisher: original('publisher') }, authors }
  const last = (a: string): string => (a.includes(',') ? a.split(',')[0] : (a.split(/\s+/).pop() ?? a))
  const names = authors.length > 3 ? `${authors.slice(0, 3).map(last).join(', ')} et al.` : authors.map(last).join(authors.length === 2 ? ' and ' : ', ')
  const venue = original('journal') || original('booktitle') || original('publisher') || (ref.kind === 'arxiv' ? `arXiv:${ref.id}` : '')
  const preview = [names || 'Unknown authors', r.fields.year ? `(${r.fields.year})` : '', '·', title || '(no title)', venue ? `· ${venue}` : ''].filter(Boolean).join(' ')
  return { ref: r, entry: e, preview }
}

const FIRST = ['author', 'title', 'journal', 'booktitle', 'year', 'volume', 'number', 'pages', 'month', 'publisher', 'doi', 'url']
export function entryToBibtex(e: Entry, key: string): string {
  const order = (n: string): number => (FIRST.includes(n) ? FIRST.indexOf(n) : FIRST.length)
  const fields = [...e.fields].sort((a, b) => order(a[0]) - order(b[0]))
  const lines = fields.map(([n, v, kind]) => `  ${n} = ${kind === 'bare' ? v : n === 'title' ? `{{${v}}}` : `{${v}}`}`)
  return `@${e.type}{${key},\n${lines.join(',\n')}\n}`
}

// ---------- Inserting \cite{…} ----------
const CITE_BEFORE = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/

/** If `pos` is inside \cite{…}: where the key list starts and ends. */
function citeAround(view: EditorView, pos: number): { open: number; close: number } | null {
  const doc = view.state.doc
  const m = doc.sliceString(Math.max(0, pos - 400), pos).match(CITE_BEFORE)
  if (!m) return null
  const after = doc.sliceString(pos, Math.min(doc.length, pos + 400)).match(/^[^{}]*\}/)
  if (!after) return null
  return { open: pos - m[1].length, close: pos + after[0].length - 1 }
}

const keysIn = (list: string): string[] => list.split(',').map((k) => k.trim()).filter(Boolean)

/** Cite `keys` at the cursor, or add them to the \cite{…} the cursor is in. `replace` is text to swap out (a pasted DOI). */
function cite(view: EditorView, keys: string[], replace?: { from: number; to: number }): void {
  if (!keys.length) return
  const doc = view.state.doc
  const head = view.state.selection.main.head
  let from = replace?.from ?? head
  let to = replace?.to ?? head
  // Inside \cite{…}, or right after one: add to that list.
  const c = citeAround(view, from) ?? (!replace && from > 0 && doc.sliceString(from - 1, from) === '}' ? citeAround(view, from - 1) : null)
  let insert: string
  if (c) {
    const list = doc.sliceString(c.open, c.close)
    if (!replace) from = to = c.close // add to the end of the list
    // Keys already in the list (apart from the pasted text) aren't added twice.
    const rest = keysIn(list.slice(0, from - c.open) + list.slice(to - c.open))
    insert = [...new Set(keys)].filter((k) => !rest.includes(k)).join(',')
    const prev = doc.sliceString(c.open, from).trim()
    const next = doc.sliceString(to, c.close).trim()
    if (insert && prev && !prev.endsWith(',')) insert = ',' + insert
    if (insert && next && !next.startsWith(',')) insert += ','
    const close = c.close + insert.length - (to - from)
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: close + 1 }, scrollIntoView: true, userEvent: 'input' })
  } else {
    const prev = view.state.sliceDoc(Math.max(0, from - 1), from)
    insert = `${prev && !/\s|~/.test(prev) ? '~' : ''}\\cite{${keys.join(',')}}`
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: 'input' })
  }
  view.focus()
}

// ---------- The dialog ----------
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function failure(r: Extract<LookUpResult, { ok: false }>, ref: RefId): string {
  const what = ref.kind === 'arxiv' ? 'arXiv ID' : 'DOI'
  if (r.reason === 'not-found') return `That ${what} wasn’t found. Check it for typos.`
  if (r.reason === 'network') return `Couldn’t reach ${ref.kind === 'arxiv' ? 'arxiv.org' : 'doi.org'}. Check your internet connection (some networks block it).`
  if (r.reason === 'no-bibtex') return 'This DOI exists, but its publisher doesn’t offer the reference details. Copy the BibTeX from the publisher’s page instead.'
  return `The lookup didn’t work${r.detail ? ` (${r.detail})` : ''}. Try again in a moment.`
}

interface Row {
  input: string
  ref: RefId | null
  state: 'wait' | 'ok' | 'dup' | 'err'
  found?: Found
  key?: string // new key, or the existing key for a duplicate
  note?: string
}

export interface DoiTool {
  open: (prefill?: string, replace?: { from: number; to: number; text: string; file: string }) => Promise<void>
}

export function setupDoi(host: DoiHost): DoiTool {
  let lastBib = ''

  /** Every .bib in the project with its text, keys and DOIs. */
  async function library(): Promise<{ path: string; text: string; refs: Ref[] }[]> {
    const p = host.project()
    if (!p) return []
    const out = []
    for (const path of allFiles(p.tree, (x) => x.endsWith('.bib'))) {
      const text = host.textOf(path) ?? (await api.readFile(path).catch(() => ''))
      out.push({ path, text, refs: parseBibtex(text) })
    }
    return out
  }

  /** The .bib the main file lists in \bibliography / \addbibresource, if any. */
  function listedBib(bibs: string[]): string | null {
    const p = host.project()
    const main = p?.mainFile ? (host.textOf(p.mainFile) ?? '') : ''
    const m = main.replace(/(^|[^\\])%.*$/gm, '$1').match(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]*)\}/)
    if (!m) return null
    const names = m[1].split(',').map((n) => n.trim().replace(/\.bib$/, ''))
    return bibs.find((b) => names.some((n) => b === `${n}.bib` || b.endsWith(`/${n}.bib`))) ?? null
  }

  async function open(prefill = '', replace?: { from: number; to: number; text: string; file: string }): Promise<void> {
    const p = host.project()
    if (!p) {
      await ask('Open your paper’s folder first (File → Open Folder…), then add references to it.', ['OK'])
      return
    }
    const bibs = allFiles(p.tree, (x) => x.endsWith('.bib'))
    const preferred = [lastBib, listedBib(bibs) ?? '', bibs[0] ?? ''].find((b) => b && bibs.includes(b)) ?? '__new'
    const canCite = Boolean(host.view())
    const citeIn = host.active()?.split('/').pop() ?? ''
    const d = document.getElementById('modal') as HTMLDialogElement
    d.innerHTML = `<div class="modal-body doi-dialog">
      <p><b>Add references by DOI</b></p>
      <p class="hint">Paste DOIs or arXiv IDs, one per line. OpenTex looks each one up online (at doi.org, or arxiv.org) and adds it to your <code>.bib</code> file.</p>
      <textarea data-ids rows="4" spellcheck="false" placeholder="10.1126/science.1102896&#10;https://doi.org/10.1038/nature14539&#10;arXiv:1706.03762"></textarea>
      <ul class="doi-results" data-results></ul>
      <div class="doi-opts">
        <label>Add to <select data-target>${[...bibs.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`), `<option value="__new">New file: refs.bib</option>`].join('')}</select></label>
        ${canCite ? `<label><input type="checkbox" data-doi-cite checked /> ${replace ? 'Cite it where you pasted it' : `Cite at the cursor in ${esc(citeIn)}`}</label>` : ''}
      </div>
    </div>
    <div class="modal-actions"><button data-cancel>Cancel</button><button class="primary" data-go>Look up</button></div>`
    const input = d.querySelector<HTMLTextAreaElement>('[data-ids]')!
    const list = d.querySelector<HTMLElement>('[data-results]')!
    const go = d.querySelector<HTMLButtonElement>('[data-go]')!
    const target = d.querySelector<HTMLSelectElement>('[data-target]')!
    target.value = preferred
    input.value = prefill
    let rows: Row[] = []
    let looked = '' // the text the rows belong to
    let busy = false

    const render = (): void => {
      list.replaceChildren(
        ...rows.map((r) => {
          const li = document.createElement('li')
          li.className = `doi-row ${r.state}`
          const mark = { wait: '…', ok: '✓', dup: '=', err: '✗' }[r.state]
          li.innerHTML = `<span class="doi-mark"></span><div><div class="doi-main"></div><div class="doi-sub"></div></div>`
          li.querySelector('.doi-mark')!.textContent = mark
          li.querySelector('.doi-main')!.textContent = r.found?.preview ?? r.input
          li.querySelector('.doi-sub')!.textContent = r.state === 'wait' ? `Looking up ${r.input}…` : r.state === 'ok' ? `${r.input} · will be added as ${r.key}` : (r.note ?? '')
          return li
        })
      )
      const add = rows.filter((r) => r.state === 'ok').length
      const citeable = rows.filter((r) => r.state === 'ok' || r.state === 'dup').length
      const fresh = input.value.trim() === looked.trim()
      go.disabled = busy || !input.value.trim()
      go.textContent = busy ? 'Looking up…' : !fresh ? 'Look up' : add ? `Add ${add} reference${add === 1 ? '' : 's'}` : citeable ? (canCite ? 'Cite' : 'Close') : 'Look up'
    }

    async function lookUpAll(): Promise<void> {
      busy = true
      looked = input.value
      rows = parseIds(input.value).map((x) => ({ input: x.input, ref: x.ref, state: x.ref ? 'wait' : 'err', note: x.ref ? undefined : 'This doesn’t look like a DOI (10.xxxx/…) or an arXiv ID.' }))
      render()
      const lib = await library()
      const used = new Set(lib.flatMap((b) => b.refs.map((r) => r.key.toLowerCase())))
      const byDoi = new Map<string, { key: string; path: string }>()
      const byTitle = new Map<string, { key: string; path: string }>()
      const norm = (t: string, y: string): string => t.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 60) + y
      for (const b of lib)
        for (const r of b.refs) {
          if (r.fields.doi) byDoi.set(r.fields.doi.toLowerCase(), { key: r.key, path: b.path })
          const t = norm(r.fields.title ?? '', r.fields.year ?? '')
          if (t.length > 8) byTitle.set(t, { key: r.key, path: b.path })
        }
      // Look up a few at a time, so a long list is quick but polite to the servers.
      const queue = rows.filter((r) => r.ref)
      const worker = async (): Promise<void> => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          const ref = r.ref!
          const known = ref.kind === 'doi' ? byDoi.get(ref.id.toLowerCase()) : undefined
          if (known) {
            Object.assign(r, { state: 'dup', key: known.key, note: `Already in ${known.path} as ${known.key}${canCite ? ', so it’s only cited' : ''}.` })
            render()
            continue
          }
          let res: LookUpResult
          try {
            res = await api.lookUpDoi(ref.id, ref.kind)
          } catch (e) {
            res = { ok: false, reason: 'bad-reply', detail: (e as Error).message.replace(/^.*Error: /, '') }
          }
          const found = res.ok ? cleanEntry(res.bibtex, ref) : null
          if (!res.ok) Object.assign(r, { state: 'err', note: failure(res, ref) })
          else if (!found) Object.assign(r, { state: 'err', note: 'The reply couldn’t be read as a reference. Try again in a moment.' })
          else {
            r.found = found
            const doi = found.ref.fields.doi?.toLowerCase()
            const dup = (doi && byDoi.get(doi)) || byTitle.get(norm(found.ref.fields.title ?? '', found.ref.fields.year ?? ''))
            if (dup) Object.assign(r, { state: 'dup', key: dup.key, note: `Already in ${dup.path} as ${dup.key}${canCite ? ', so it’s only cited' : ''}.` })
            else {
              r.key = makeKey(found.ref, used)
              r.state = 'ok'
              if (doi) byDoi.set(doi, { key: r.key, path: 'this list' })
            }
          }
          render()
        }
      }
      await Promise.all([worker(), worker(), worker()])
      busy = false
      render()
    }

    input.addEventListener('input', render)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        go.click()
      }
    })
    d.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => d.close()
    const done = new Promise<boolean>((resolve) => {
      go.onclick = async () => {
        if (busy) return
        if (input.value.trim() !== looked.trim() || !rows.some((r) => r.state === 'ok' || r.state === 'dup')) return void lookUpAll()
        resolve(true)
        d.close()
      }
      d.addEventListener('close', () => resolve(false), { once: true })
    })
    render()
    d.showModal()
    input.focus()
    if (prefill.trim()) void lookUpAll()
    if (!(await done)) return

    // ---------- Add them ----------
    const adding = rows.filter((r) => r.state === 'ok')
    const citeKeys = rows.filter((r) => r.state === 'ok' || r.state === 'dup').map((r) => r.key!)
    const wantCite = canCite && (d.querySelector<HTMLInputElement>('[data-doi-cite]')?.checked ?? false)
    let bibPath = target.value
    if (bibPath === '__new') {
      bibPath = 'refs.bib'
      for (let i = 2; bibs.includes(bibPath); i++) bibPath = `refs-${i}.bib`
    }
    lastBib = bibPath
    if (adding.length) {
      if (host.isDirty(bibPath)) await host.save(bibPath)
      const existing = bibs.includes(bibPath) ? await api.readFile(bibPath).catch(() => '') : ''
      const refs = adding.map((r) => ({ ...r.found!.ref, key: r.key!, raw: entryToBibtex(r.found!.entry, r.key!) }))
      const merged = mergeIntoBib(existing, refs)
      try {
        await api.writeFile(bibPath, merged.text)
      } catch (e) {
        await ask(`Couldn’t save ${bibPath}: ${(e as Error).message.replace(/^.*Error: /, '')}`, ['OK'])
        return
      }
      await host.changed(bibPath)
    }
    const v = host.view()
    if (wantCite && v) {
      let range: { from: number; to: number } | undefined
      if (replace && replace.file === host.active()) {
        // Find the pasted DOI again (the text may have moved a little since).
        const doc = v.state.doc
        if (doc.sliceString(replace.from, replace.to) === replace.text) range = { from: replace.from, to: replace.to }
        else {
          const lo = Math.max(0, replace.from - 2000)
          const at = doc.sliceString(lo, Math.min(doc.length, replace.to + 2000)).indexOf(replace.text)
          if (at >= 0) range = { from: lo + at, to: lo + at + replace.text.length }
        }
      }
      cite(v, citeKeys, range)
    }
    const added = adding.length ? `Added ${adding.length} reference${adding.length === 1 ? '' : 's'} to ${bibPath}` : ''
    const msg = [added, wantCite ? `cited as ${citeKeys.join(', ')}` : ''].filter(Boolean).join(', ')
    if (msg) host.notice(msg)
    if (adding.length) await offerBibliography(bibPath, msg)
  }

  /** Like Import References: if the main file doesn't list this .bib yet, offer to add a bibliography. */
  async function offerBibliography(bibPath: string, summary: string): Promise<void> {
    const p = host.project()
    if (!p?.mainFile) return
    const main = p.mainFile
    const text = host.textOf(main) ?? (await api.readFile(main).catch(() => ''))
    const base = bibPath.replace(/\.bib$/, '')
    const hasBib = new RegExp(`\\\\(bibliography|addbibresource)\\{[^}]*${base.split('/').pop()}`).test(text)
    if (hasBib || !/\\end\{document\}/.test(text)) return
    const r = await ask(`${summary}.\n\nYour main file doesn’t list ${bibPath} yet, so the reference won’t appear in the PDF. Add a bibliography at the end of ${main}?`, ['Add bibliography', 'Not now'])
    if (r !== 0) return
    const add = `\\bibliographystyle{plain}\n\\bibliography{${base}}\n\n`
    const v = host.view()
    if (v && host.active() === main) {
      const at = v.state.doc.toString().lastIndexOf('\\end{document}')
      v.dispatch({ changes: { from: at, insert: add } })
      await host.save(main)
    } else {
      if (host.isDirty(main)) await host.save(main)
      const now = host.textOf(main) ?? (await api.readFile(main))
      const at = now.lastIndexOf('\\end{document}')
      await api.writeFile(main, now.slice(0, at) + add + now.slice(at))
      await host.changed(main)
    }
  }

  // ---------- Pasting a DOI into the editor ----------
  const notice = document.createElement('div')
  notice.className = 'doi-notice hidden'
  let noticeTimer = 0
  const hideNotice = (): void => {
    notice.classList.add('hidden')
    clearTimeout(noticeTimer)
  }
  function offer(id: RefId, pasted: { from: number; to: number; text: string; file: string }, inCite: boolean): void {
    if (!notice.isConnected) document.querySelector('.editor-col')?.appendChild(notice)
    notice.innerHTML = `<span class="doi-n-text"></span><button class="primary" data-yes>Add reference</button><button data-no title="Keep the text as you pasted it">No thanks</button>`
    notice.querySelector('.doi-n-text')!.textContent = inCite
      ? `That’s ${id.kind === 'arxiv' ? 'an arXiv ID' : 'a DOI'}. Add this reference to your .bib file and cite it here?`
      : `You pasted ${id.kind === 'arxiv' ? 'an arXiv ID' : 'a DOI'}. Add this reference to your .bib file and cite it here instead?`
    notice.querySelector<HTMLButtonElement>('[data-yes]')!.onclick = () => {
      hideNotice()
      void open(id.kind === 'arxiv' ? `arXiv:${id.id}` : id.id, pasted)
    }
    notice.querySelector<HTMLButtonElement>('[data-no]')!.onclick = () => {
      hideNotice()
      host.view()?.focus()
    }
    notice.classList.remove('hidden')
    clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(hideNotice, 15000)
  }
  document.getElementById('editor')?.addEventListener(
    'paste',
    (e) => {
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? ''
      const v = host.view()
      const file = host.active()
      if (!v || !file || !text || text.length > 300 || /\s/.test(text)) return
      const id = parseId(text, true)
      if (!id) return
      const start = v.state.selection.main.from
      setTimeout(() => {
        const head = v.state.selection.main.head
        const pastedText = v.state.sliceDoc(head - text.length, head)
        if (pastedText !== text || head < start) return
        offer(id, { from: head - text.length, to: head, text, file }, Boolean(citeAround(v, head - text.length)))
      }, 0)
    },
    true
  )
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideNotice()
  })

  return { open }
}
