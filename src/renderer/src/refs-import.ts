// Reference import: EndNote XML, RIS (Zotero, Mendeley, EndNote, Web of Science, PubMed),
// CSL JSON (Zotero "Better CSL JSON"/"CSL JSON"), and BibTeX, all converted to BibTeX entries
// with readable keys (smith2020graphene) and merged without duplicates.

export interface Ref {
  type: string // BibTeX entry type
  key: string
  fields: Record<string, string>
  authors: string[] // "Last, First"
  raw?: string // original BibTeX text, when the source was BibTeX
}

export type RefFormat = 'endnote-xml' | 'ris' | 'csl-json' | 'bibtex'

export function detectFormat(text: string, fileName = ''): RefFormat | null {
  const t = text.trimStart()
  if (/\.(bib|bibtex)$/i.test(fileName) || /^@\w+\s*\{/m.test(t.slice(0, 5000))) return 'bibtex'
  if (/^<\?xml|^<xml>|<records>/i.test(t.slice(0, 500))) return 'endnote-xml'
  if (/^\s*TY\s+-/m.test(t.slice(0, 2000))) return 'ris'
  if (/^[[{]/.test(t)) return 'csl-json'
  return null
}

export function parseRefs(text: string, fmt: RefFormat): Ref[] {
  if (fmt === 'endnote-xml') return parseEndNoteXml(text)
  if (fmt === 'ris') return parseRis(text)
  if (fmt === 'csl-json') return parseCsl(text)
  return parseBibtex(text)
}

// ---------- EndNote XML (File → Export… → XML) ----------
const ENDNOTE_TYPES: Record<string, string> = {
  'journal article': 'article', 'magazine article': 'article', 'newspaper article': 'article', 'electronic article': 'article',
  book: 'book', 'edited book': 'book', 'electronic book': 'book', 'book section': 'incollection', 'electronic book section': 'incollection',
  'conference proceedings': 'inproceedings', 'conference paper': 'inproceedings', thesis: 'phdthesis', report: 'techreport',
  'government document': 'techreport', patent: 'misc', 'web page': 'misc', dataset: 'misc', generic: 'misc', manuscript: 'unpublished'
}

function parseEndNoteXml(text: string): Ref[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('This XML file could not be read. In EndNote, use File → Export… and choose “XML” as the type.')
  const txt = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const out: Ref[] = []
  for (const r of doc.querySelectorAll('record')) {
    const typeName = (r.querySelector('ref-type')?.getAttribute('name') ?? 'Generic').toLowerCase()
    const type = ENDNOTE_TYPES[typeName] ?? 'misc'
    const authors = [...r.querySelectorAll('contributors > authors > author')].map(txt).filter(Boolean)
    const editors = [...r.querySelectorAll('contributors > secondary-authors > author')].map(txt).filter(Boolean)
    const f: Record<string, string> = {}
    f.title = txt(r.querySelector('titles > title'))
    const secondary = txt(r.querySelector('titles > secondary-title')) || txt(r.querySelector('periodical > full-title'))
    if (secondary) f[type === 'article' ? 'journal' : type === 'incollection' || type === 'inproceedings' ? 'booktitle' : 'series'] = secondary
    f.year = txt(r.querySelector('dates > year'))
    f.volume = txt(r.querySelector('volume'))
    f.number = txt(r.querySelector('number')) || txt(r.querySelector('issue'))
    f.pages = txt(r.querySelector('pages')).replace(/\s*[-–]\s*/, '--')
    f.publisher = txt(r.querySelector('publisher'))
    f.address = txt(r.querySelector('pub-location'))
    f.doi = txt(r.querySelector('electronic-resource-num')).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    f.url = txt(r.querySelector('urls related-urls url')) || txt(r.querySelector('urls url'))
    f.isbn = txt(r.querySelector('isbn'))
    f.abstract = txt(r.querySelector('abstract'))
    f.note = txt(r.querySelector('notes'))
    const kw = [...r.querySelectorAll('keywords > keyword')].map(txt).filter(Boolean)
    if (kw.length) f.keywords = kw.join(', ')
    if (type === 'phdthesis' || type === 'techreport') f[type === 'phdthesis' ? 'school' : 'institution'] = f.publisher
    if (editors.length) f.editor = editors.join(' and ')
    out.push({ type, key: '', fields: f, authors })
  }
  return out
}

// ---------- RIS ----------
const RIS_TYPES: Record<string, string> = {
  JOUR: 'article', JFULL: 'article', MGZN: 'article', NEWS: 'article', EJOUR: 'article', BOOK: 'book', EBOOK: 'book', EDBOOK: 'book',
  CHAP: 'incollection', ECHAP: 'incollection', CONF: 'inproceedings', CPAPER: 'inproceedings', THES: 'phdthesis', RPRT: 'techreport',
  GOVDOC: 'techreport', UNPB: 'unpublished', ELEC: 'misc', DATA: 'misc', GEN: 'misc'
}

function parseRis(text: string): Ref[] {
  const out: Ref[] = []
  let cur: { tags: Record<string, string[]> } | null = null
  let lastTag = ''
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/)
    if (m) {
      const [, tag, value] = m
      if (tag === 'TY') cur = { tags: {} }
      if (!cur) continue
      if (tag === 'ER') {
        out.push(risToRef(cur.tags))
        cur = null
        continue
      }
      ;(cur.tags[tag] ??= []).push(value.trim())
      lastTag = tag
    } else if (cur && lastTag && line.trim()) {
      const arr = cur.tags[lastTag]
      arr[arr.length - 1] += ' ' + line.trim() // wrapped line
    }
  }
  if (cur) out.push(risToRef(cur.tags))
  return out
}

function risToRef(t: Record<string, string[]>): Ref {
  const one = (...tags: string[]): string => tags.map((x) => t[x]?.[0]).find(Boolean) ?? ''
  const type = RIS_TYPES[one('TY')] ?? 'misc'
  const authors = [...(t.AU ?? []), ...(t.A1 ?? [])]
  const f: Record<string, string> = {}
  f.title = one('TI', 'T1', 'CT')
  const container = one('T2', 'JO', 'JF', 'JA', 'BT')
  if (container) f[type === 'article' ? 'journal' : type === 'incollection' || type === 'inproceedings' ? 'booktitle' : 'series'] = container
  f.year = (one('PY', 'Y1', 'DA').match(/\d{4}/) ?? [''])[0]
  f.volume = one('VL')
  f.number = one('IS', 'CP')
  const sp = one('SP')
  const ep = one('EP')
  f.pages = sp && ep ? `${sp}--${ep}` : sp.replace(/\s*[-–]\s*/, '--')
  f.publisher = one('PB')
  f.address = one('CY', 'PP')
  f.doi = one('DO').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  f.url = one('UR', 'L2')
  f.isbn = one('SN')
  f.abstract = one('AB', 'N2')
  if (t.KW?.length) f.keywords = t.KW.join(', ')
  const eds = [...(t.A2 ?? []), ...(t.ED ?? [])]
  if (eds.length) f.editor = eds.join(' and ')
  if (type === 'phdthesis') f.school = f.publisher
  if (type === 'techreport') f.institution = f.publisher
  return { type, key: '', fields: f, authors }
}

// ---------- CSL JSON ----------
const CSL_TYPES: Record<string, string> = {
  'article-journal': 'article', 'article-magazine': 'article', 'article-newspaper': 'article', article: 'article', book: 'book',
  chapter: 'incollection', 'paper-conference': 'inproceedings', thesis: 'phdthesis', report: 'techreport', manuscript: 'unpublished'
}

function parseCsl(text: string): Ref[] {
  let data = JSON.parse(text)
  if (!Array.isArray(data)) data = data.items ?? [data]
  type Name = { family?: string; given?: string; literal?: string }
  const name = (n: Name): string => (n.literal ? `{${n.literal}}` : [n.family, n.given].filter(Boolean).join(', '))
  return (data as Record<string, unknown>[]).map((it) => {
    const s = (k: string): string => (it[k] == null ? '' : String(it[k]))
    const type = CSL_TYPES[s('type')] ?? 'misc'
    const f: Record<string, string> = {}
    f.title = s('title')
    const container = s('container-title')
    if (container) f[type === 'article' ? 'journal' : type === 'incollection' || type === 'inproceedings' ? 'booktitle' : 'series'] = container
    const issued = it.issued as { 'date-parts'?: number[][]; raw?: string } | undefined
    f.year = String(issued?.['date-parts']?.[0]?.[0] ?? (issued?.raw ?? '').match(/\d{4}/)?.[0] ?? '')
    f.volume = s('volume')
    f.number = s('issue')
    f.pages = s('page').replace(/\s*[-–]\s*/, '--')
    f.publisher = s('publisher')
    f.address = s('publisher-place')
    f.doi = s('DOI')
    f.url = s('URL')
    f.isbn = s('ISBN')
    f.abstract = s('abstract')
    const eds = ((it.editor as Name[]) ?? []).map(name)
    if (eds.length) f.editor = eds.join(' and ')
    const key = s('citation-key') || s('id')
    return { type, key: /^[\w:.-]+$/.test(key) && !/^\d+$/.test(key) && !/^item-?\d+$/i.test(key) ? key : '', fields: f, authors: ((it.author as Name[]) ?? []).map(name) }
  })
}

// ---------- BibTeX ----------
export function parseBibtex(text: string): Ref[] {
  const out: Ref[] = []
  for (const chunk of splitBibEntries(text)) {
    const m = chunk.match(/^@(\w+)\s*\{\s*([^,\s]+)\s*,/)
    if (!m || /^(string|comment|preamble)$/i.test(m[1])) continue
    const field = (k: string): string => chunk.match(new RegExp(`\\b${k}\\s*=\\s*[{"]((?:[^{}"]|\\{[^{}]*\\})*)[}"]`, 'i'))?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
    const year = field('year') || (chunk.match(/\byear\s*=\s*(\d{4})/i)?.[1] ?? '')
    out.push({ type: m[1].toLowerCase(), key: m[2], fields: { title: field('title'), year, doi: field('doi') }, authors: field('author').split(/\s+and\s+/).filter(Boolean), raw: chunk.trim() })
  }
  return out
}

function splitBibEntries(text: string): string[] {
  const out: string[] = []
  let i = text.indexOf('@')
  while (i >= 0) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    let depth = 0
    let j = open
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}' && --depth === 0) break
    }
    out.push(text.slice(i, j + 1))
    i = text.indexOf('@', j + 1)
  }
  return out
}

// ---------- Keys, duplicates, output ----------
const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'by', 'at', 'is', 'are', 'towards', 'toward', 'via'])
const ascii = (s: string): string => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
const lastName = (a: string): string => (a.includes(',') ? a.split(',')[0] : a.trim().split(/\s+/).pop() ?? '')
const normTitle = (s: string): string => ascii(s).slice(0, 60)

function makeKey(r: Ref, used: Set<string>): string {
  const who = ascii(lastName(r.authors[0] ?? '')) || ascii(r.fields.publisher ?? '') || 'ref'
  const word = (r.fields.title ?? '').split(/\s+/).map(ascii).find((w) => w.length > 2 && !STOP.has(w)) ?? ''
  const base = `${who}${r.fields.year ?? ''}${word}` || 'ref'
  let key = base
  for (let i = 0; used.has(key.toLowerCase()); i++) key = base + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '')
  used.add(key.toLowerCase())
  return key
}

/** Escape characters that break BibTeX/LaTeX, except in URLs and DOIs. */
function esc(v: string, key: string): string {
  if (key === 'url' || key === 'doi') return v
  return v.replace(/\\/g, '\\textbackslash{}').replace(/([&%#_$])/g, '\\$1').replace(/[{}]/g, '').replace(/~/g, '\\textasciitilde{}')
}

const FIELD_ORDER = ['author', 'editor', 'title', 'journal', 'booktitle', 'series', 'year', 'volume', 'number', 'pages', 'publisher', 'school', 'institution', 'address', 'doi', 'url', 'isbn', 'keywords', 'note', 'abstract']

export function toBibtex(r: Ref): string {
  if (r.raw) return r.raw
  const f: Record<string, string> = { ...r.fields }
  if (r.authors.length) f.author = r.authors.join(' and ')
  const lines = FIELD_ORDER.filter((k) => f[k]).map((k) => {
    const v = k === 'author' || k === 'editor' ? f[k].replace(/[&%#_$]/g, '\\$&') : esc(f[k], k)
    // Double braces keep the title's capitalization exactly as entered.
    return `  ${k} = ${k === 'title' ? `{{${v}}}` : `{${v}}`}`
  })
  return `@${r.type}{${r.key},\n${lines.join(',\n')}\n}`
}

export interface MergeResult {
  added: Ref[]
  duplicates: number
  text: string // the new .bib contents
}

/** Merge new references into an existing .bib text: skip ones already there (same DOI, key or title+year). */
export function mergeIntoBib(existingText: string, incoming: Ref[]): MergeResult {
  const existing = parseBibtex(existingText)
  const used = new Set(existing.map((r) => r.key.toLowerCase()))
  const dois = new Set(existing.map((r) => r.fields.doi?.toLowerCase()).filter(Boolean))
  const titles = new Set(existing.map((r) => normTitle(r.fields.title ?? '') + r.fields.year).filter((t) => t.length > 8))
  const added: Ref[] = []
  let duplicates = 0
  for (const r of incoming) {
    const doi = r.fields.doi?.toLowerCase()
    const tkey = normTitle(r.fields.title ?? '') + (r.fields.year ?? '')
    if ((doi && dois.has(doi)) || (tkey.length > 8 && titles.has(tkey)) || (r.raw && used.has(r.key.toLowerCase()))) {
      duplicates++
      continue
    }
    if (doi) dois.add(doi)
    if (tkey.length > 8) titles.add(tkey)
    if (!r.raw) r.key = r.key && !used.has(r.key.toLowerCase()) ? (used.add(r.key.toLowerCase()), r.key) : makeKey(r, used)
    else used.add(r.key.toLowerCase())
    added.push(r)
  }
  const body = added.map(toBibtex).join('\n\n')
  const sep = existingText.trim() ? '\n\n' : ''
  return { added, duplicates, text: added.length ? existingText.replace(/\s*$/, '') + sep + body + '\n' : existingText }
}
