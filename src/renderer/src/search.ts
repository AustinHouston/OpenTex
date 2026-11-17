// Find and replace across the whole project (the Search panel). Open files are searched in their
// live editor text and changed through the editor, so Undo works; files that aren't open are read
// from disk and, for Replace all, written back to disk.
import './search.css'
import { EditorView } from '@codemirror/view'
import { allFiles } from './filetree'
import { ask } from './ui'
import { AppHost, editOpenFile, editText, esc, liveText } from './apphost'
import type { Layout } from './layout'

const SEARCHABLE = /\.(tex|bib|sty|cls|txt|md)$/i
const CAP = 2000
const WORD = '[\\w\\u00C0-\\u024F]'

interface Hit {
  file: string
  from: number
  to: number
  line: number
  pre: string
  match: string
  post: string
}

type Opt = 'case' | 'word' | 'regex'

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`

export class ProjectSearch {
  readonly body = document.createElement('div')
  private layout: Layout | null = null
  private q: HTMLInputElement
  private r: HTMLInputElement
  private msg: HTMLElement
  private list: HTMLElement
  private opts: Record<Opt, boolean> = { case: false, word: false, regex: false }
  private hits: Hit[] = []
  private current = -1
  private truncated = false
  private disk = new Map<string, string | null>() // text of files that aren't open
  private root: string | null = null
  private folded = new Set<string>()
  private timer = 0
  private stale = false
  private runId = 0

  constructor(private host: AppHost) {
    this.body.className = 'psearch'
    this.body.innerHTML = `
      <div class="ps-box">
        <input type="text" class="ps-q" placeholder="Search all files" spellcheck="false" aria-label="Search all files" />
        <span class="ps-opts">
          <button data-opt="case" title="Match upper and lower case exactly">Aa</button>
          <button data-opt="word" title="Whole words only"><u>ab</u></button>
          <button data-opt="regex" title="Use a regular expression (a search pattern, for advanced users)">.*</button>
        </span>
      </div>
      <div class="ps-box"><input type="text" class="ps-r" placeholder="Replace with" spellcheck="false" aria-label="Replace with" /></div>
      <div class="ps-actions">
        <button class="ps-one" title="Replace the selected result, then go to the next one">Replace</button>
        <button class="ps-all" title="Replace every result in every file">Replace all</button>
      </div>
      <div class="ps-msg" aria-live="polite"></div>
      <div class="ps-list" tabindex="-1"></div>`
    this.q = this.body.querySelector('.ps-q')!
    this.r = this.body.querySelector('.ps-r')!
    this.msg = this.body.querySelector('.ps-msg')!
    this.list = this.body.querySelector('.ps-list')!
    this.q.addEventListener('input', () => this.schedule(200))
    this.q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (this.hits.length) this.go((this.current + (e.shiftKey ? -1 : 1) + this.hits.length) % this.hits.length, false)
      } else if (e.key === 'Escape') host.view.focus()
    })
    this.r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void ((e.metaKey || e.ctrlKey) ? this.replaceAll() : this.replaceOne())
      } else if (e.key === 'Escape') host.view.focus()
    })
    this.body.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) => {
      b.onclick = () => {
        const o = b.dataset.opt as Opt
        this.opts[o] = !this.opts[o]
        b.classList.toggle('on', this.opts[o])
        b.setAttribute('aria-pressed', String(this.opts[o]))
        void this.run()
      }
    })
    this.body.querySelector<HTMLButtonElement>('.ps-one')!.onclick = () => this.replaceOne()
    this.body.querySelector<HTMLButtonElement>('.ps-all')!.onclick = () => this.replaceAll()
    this.list.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const hit = t.closest<HTMLElement>('.ps-hit')
      if (hit) return void this.go(Number(hit.dataset.i), true)
      const head = t.closest<HTMLElement>('.ps-file')
      if (head) {
        const f = head.dataset.file!
        this.folded.has(f) ? this.folded.delete(f) : this.folded.add(f)
        this.render()
      }
    })
  }

  /** Add the panel: left, under Files, hidden until asked for. */
  mount(layout: Layout): void {
    this.layout = layout
    layout.add({ id: 'search', title: 'Search', body: this.body, defaultZone: 'left', startHidden: true, onVisible: () => this.stale && this.schedule(0) })
  }

  /** Edit → Find in Project (Cmd/Ctrl+Shift+H). */
  open(): void {
    if (!this.host.project()) return
    const sel = this.host.view.state.selection.main
    const text = this.host.view.state.sliceDoc(sel.from, sel.to)
    if (text && !text.includes('\n') && text.length < 200) {
      this.q.value = this.opts.regex ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : text
      this.schedule(0)
    }
    this.layout?.show('search')
    setTimeout(() => {
      this.q.focus()
      this.q.select()
    }, 30)
  }

  /** The open file's text changed. */
  edited(): void {
    this.stale = true
    if (this.q.value && this.layout?.isVisible('search')) this.schedule(400)
  }

  /** Files changed on disk. */
  diskChanged(paths: string[]): void {
    for (const p of paths) this.disk.delete(p)
    if (paths.some((p) => SEARCHABLE.test(p))) this.edited()
  }

  /** A different project folder was opened (or none). */
  reset(): void {
    this.disk.clear()
    this.root = null
    this.hits = []
    this.current = -1
    this.folded.clear()
    this.stale = true
    if (this.q.value && this.layout?.isVisible('search')) this.schedule(0)
    else this.render()
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.run(), ms)
  }

  // ---------- Searching ----------
  private pattern(): RegExp | string | null {
    const q = this.q.value
    if (!q) return null
    let src = this.opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (this.opts.word) src = `(?<!${WORD})(?:${src})(?!${WORD})`
    try {
      return new RegExp(src, 'gm' + (this.opts.case ? '' : 'i'))
    } catch (e) {
      return String((e as Error).message).split(': ').pop() ?? 'invalid'
    }
  }

  /** Text of every searchable file: live for open files, from disk (cached) for the rest. */
  private async texts(fresh = false): Promise<[string, string][]> {
    const project = this.host.project()
    if (!project) return []
    if (project.root !== this.root) {
      this.disk.clear()
      this.root = project.root
    }
    const paths = allFiles(project.tree, (p) => SEARCHABLE.test(p))
    const missing = paths.filter((p) => !this.host.files.has(p) && (fresh || !this.disk.has(p)))
    if (missing.length) for (const [p, t] of await this.host.api.readMany(missing)) this.disk.set(p, t)
    const out: [string, string][] = []
    for (const p of paths) {
      const t = liveText(this.host, p) ?? this.disk.get(p)
      if (t != null) out.push([p, t])
    }
    return out
  }

  /** Every match in one text (stopping once `limit` hits are collected). */
  private scan(re: RegExp, file: string, text: string, out: Hit[], limit: number): boolean {
    re.lastIndex = 0
    let line = 1
    let lineStart = 0
    let scanned = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex++
        continue
      }
      for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
        line++
        lineStart = i + 1
      }
      scanned = m.index
      const lineEnd = text.indexOf('\n', m.index)
      const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)
      const col = m.index - lineStart
      const end = Math.min(col + m[0].length, lineText.length)
      let pre = lineText.slice(0, col).trimStart()
      if (pre.length > 16) pre = '…' + pre.slice(-14).trimStart() // keep the match in view in a narrow panel
      out.push({ file, from: m.index, to: m.index + m[0].length, line, pre, match: lineText.slice(col, end) + (end < col + m[0].length ? ' …' : ''), post: lineText.slice(end, end + 160) })
      if (out.length >= limit) return true
    }
    return false
  }

  async run(): Promise<void> {
    clearTimeout(this.timer)
    const id = ++this.runId
    this.stale = false
    const re = this.pattern()
    if (typeof re === 'string') {
      this.hits = []
      this.truncated = false
      this.render(`That pattern isn’t a valid regular expression yet (${re.toLowerCase()}). Keep typing, or switch off .* to search for the text as typed.`, true)
      return
    }
    if (!re || !this.host.project()) {
      this.hits = []
      this.truncated = false
      this.render()
      return
    }
    const texts = await this.texts()
    if (id !== this.runId) return // a newer search started meanwhile
    const prev = this.hits[this.current]
    const hits: Hit[] = []
    this.truncated = false
    for (const [file, text] of texts) {
      if (this.scan(re, file, text, hits, CAP)) {
        this.truncated = true
        break
      }
    }
    this.hits = hits
    this.current = prev ? hits.findIndex((h) => h.file === prev.file && h.from >= prev.from) : -1
    if (prev && this.current < 0) this.current = Math.min(hits.length - 1, hits.findIndex((h) => h.file === prev.file))
    this.render()
  }

  private render(message?: string, error = false): void {
    const files = new Map<string, number[]>()
    this.hits.forEach((h, i) => (files.get(h.file) ?? files.set(h.file, []).get(h.file)!).push(i))
    this.msg.classList.toggle('err', error)
    if (message) this.msg.textContent = message
    else if (!this.q.value) this.msg.textContent = this.host.project() ? 'Type to search every .tex, .bib, .sty, .cls, .txt and .md file in this project.' : 'Open a project folder to search it.'
    else if (!this.hits.length) this.msg.textContent = 'No results.'
    else this.msg.textContent = `${plural(this.hits.length, 'result')} in ${plural(files.size, 'file')}${this.truncated ? `. Showing the first ${CAP.toLocaleString()}; type more to narrow the search.` : ''}`
    const html: string[] = []
    for (const [file, idx] of files) {
      const slash = file.lastIndexOf('/')
      const folded = this.folded.has(file)
      html.push(
        `<div class="ps-file${folded ? ' folded' : ''}" data-file="${esc(file)}" title="${esc(file)}"><span class="ps-caret">${folded ? '▸' : '▾'}</span><span class="ps-name">${esc(file.slice(slash + 1))}</span><span class="ps-dir">${esc(slash > 0 ? file.slice(0, slash) : '')}</span><span class="ps-count">${idx.length}</span></div>`
      )
      if (folded) continue
      for (const i of idx) {
        const h = this.hits[i]
        html.push(
          `<div class="ps-hit${i === this.current ? ' current' : ''}" data-i="${i}" title="${esc(file)}, line ${h.line}"><span class="ps-ln">${h.line}</span><span class="ps-tx">${esc(h.pre)}<mark>${esc(h.match)}</mark>${esc(h.post)}</span></div>`
        )
      }
    }
    const scroll = this.list.scrollTop
    this.list.innerHTML = html.join('')
    this.list.scrollTop = scroll
    const busy = !this.hits.length
    this.body.querySelector<HTMLButtonElement>('.ps-one')!.disabled = busy
    this.body.querySelector<HTMLButtonElement>('.ps-all')!.disabled = busy
  }

  /** Open a result's file and select the match. */
  private async go(i: number, focusEditor: boolean): Promise<void> {
    const h = this.hits[i]
    if (!h) return
    this.current = i
    this.list.querySelectorAll('.ps-hit.current').forEach((el) => el.classList.remove('current'))
    const row = this.list.querySelector<HTMLElement>(`.ps-hit[data-i="${i}"]`)
    row?.classList.add('current')
    row?.scrollIntoView({ block: 'nearest' })
    if (h.file !== this.host.active()) await this.host.openFile(h.file)
    if (h.file !== this.host.active()) return
    const view = this.host.view
    const len = view.state.doc.length
    const from = Math.min(h.from, len)
    view.dispatch({ selection: { anchor: from, head: Math.min(h.to, len) }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    if (focusEditor) view.focus()
    else this.q.focus()
  }

  // ---------- Replacing ----------
  /** The replacement for one match; in pattern mode $1, $<name>, $& and \n work as usual. */
  private replacement(m: RegExpExecArray): string {
    const r = this.r.value
    if (!this.opts.regex) return r
    return r
      .replace(/\$(\$|&|<[^>]*>|\d{1,2})|\\([nt\\])/g, (all, k: string | undefined, esc: string | undefined) => {
        if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\'
        if (k === '$') return '$'
        if (k === '&') return m[0]
        if (k!.startsWith('<')) return m.groups?.[k!.slice(1, -1)] ?? ''
        const n = Number(k)
        if (n < m.length) return m[n] ?? ''
        if (k!.length === 2 && Number(k![0]) < m.length) return (m[Number(k![0])] ?? '') + k![1]
        return all
      })
  }

  /** Replace the selected result (or the first), through the editor so Undo works. */
  async replaceOne(): Promise<void> {
    const re = this.pattern()
    if (!(re instanceof RegExp) || !this.hits.length) return
    const i = Math.max(0, Math.min(this.current, this.hits.length - 1))
    const h = this.hits[i]
    if (!this.host.files.has(h.file) || h.file !== this.host.active()) await this.host.openFile(h.file)
    const text = liveText(this.host, h.file)
    if (text === null) return
    const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y')
    sticky.lastIndex = h.from
    const m = sticky.exec(text)
    if (!m || !m[0].length) {
      this.host.status('That text has changed, so the results were refreshed. Try again.', 'warn')
      await this.run()
      return
    }
    editOpenFile(this.host, h.file, [{ from: h.from, to: h.from + m[0].length, expect: m[0], insert: this.replacement(m) }])
    this.current = i
    await this.run()
    // Move on to the next result (the one that took this one's place in the list).
    this.current = this.hits.length ? Math.min(i, this.hits.length - 1) : -1
    if (this.current >= 0) await this.go(this.current, false)
    else this.render()
  }

  /** Replace every match in every file, after asking. */
  async replaceAll(): Promise<void> {
    const re = this.pattern()
    if (!(re instanceof RegExp)) return
    const host = this.host
    const texts = await this.texts(true) // re-read closed files so nothing newer is overwritten
    const plan: { file: string; text: string; open: boolean; changes: { from: number; to: number; expect: string; insert: string }[] }[] = []
    for (const [file, text] of texts) {
      const changes: { from: number; to: number; expect: string; insert: string }[] = []
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        if (!m[0].length) {
          re.lastIndex++
          continue
        }
        changes.push({ from: m.index, to: m.index + m[0].length, expect: m[0], insert: this.replacement(m) })
      }
      if (changes.length) plan.push({ file, text, open: host.files.has(file), changes })
    }
    const total = plan.reduce((n, p) => n + p.changes.length, 0)
    if (!total) {
      host.status('Nothing to replace', 'warn')
      return
    }
    const closed = plan.filter((p) => !p.open).length
    let msg = `Replace ${plural(total, 'match')} in ${plural(plan.length, 'file')}?`
    if (closed) msg += ` ${closed === plan.length ? (closed === 1 ? 'That file isn’t' : 'Those files aren’t') : closed === 1 ? 'One of them isn’t' : `${closed} of them aren’t`} open, so OpenTex changes ${closed === 1 ? 'it' : 'them'} on disk right away, and Undo can’t reverse ${closed === 1 ? 'that change' : 'those changes'}.`
    if ((await ask(msg, ['Replace all', 'Cancel'])) !== 0) return
    let done = 0
    let failed = 0
    for (const p of plan) {
      if (p.open) done += editOpenFile(host, p.file, p.changes)
      else {
        const r = editText(p.text, p.changes)
        try {
          await host.api.writeFile(p.file, r.text)
          this.disk.set(p.file, r.text)
          done += r.applied
        } catch {
          failed++
        }
      }
    }
    const open = plan.length - closed
    host.status(
      `Replaced ${plural(done, 'match')} in ${plural(plan.length - failed, 'file')}.` +
        (closed ? ` ${plural(closed - failed, 'closed file')} saved directly.` : '') +
        (open ? ` Changes in open files aren’t saved yet; Undo works there.` : '') +
        (failed ? ` ${plural(failed, 'file')} could not be written.` : ''),
      failed ? 'err' : 'ok'
    )
    host.refresh()
    await this.run()
  }
}
