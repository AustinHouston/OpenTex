// Paste and drop into a .tex file:
// - a picture (screenshot, image copied from a browser or PowerPoint) becomes a figure, saved in figures/;
// - picture files dropped from Finder or Explorer become figures (copied into figures/ when needed);
// - cells copied from Excel, Google Sheets, Numbers or Word become a LaTeX table (Undo gives the plain text);
// - Cmd/Ctrl+Shift+V always pastes plain text.
// Also the Table drop-down's "Paste from Excel" and "From a CSV file…".

import './paste.css'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isolateHistory, undo } from '@codemirror/commands'
import type { ProjectInfo } from '../../shared/types'
import type { OpenTexApi } from '../../preload/index'
import { allFiles } from './filetree'
import { ask } from './ui'
import { buildTable, Cell, cellsFromText, detectTable, Grid, gridToTsv, guessDelimiter, parseDelimited, parseHtmlTable } from './tables'

const api = (window as unknown as { opentex: OpenTexApi }).opentex

export interface PasteHost {
  view: EditorView
  texActive: () => boolean // a .tex file is open in the editor
  project: () => ProjectInfo | null
  mainText: () => string
  hasPackage: (pkg: string) => boolean
  ensurePackage: (pkg: string) => Promise<boolean>
  notice: (msg: string) => void
}

const CURSOR = '¦'
const IMAGE_FILE = /\.(png|jpe?g|pdf|eps)$/i
const TABLE_FILE = /\.(csv|tsv)$/i
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const errText = (e: unknown): string => (e as Error).message.replace(/^.*Error: /, '')

// ---------- Small helpers ----------

/** Put a block (figure, table) on its own lines, replacing from..to; `¦` marks the cursor. */
function blockChange(state: EditorState, from: number, to: number, snippet: string): { insert: string; cursor: number } {
  let text = snippet
  const line = state.doc.lineAt(from)
  if (state.doc.sliceString(line.from, from).trim()) text = '\n' + text
  if (state.doc.sliceString(to, state.doc.lineAt(to).to).trim()) text += '\n'
  const at = text.indexOf(CURSOR)
  const insert = text.split(CURSOR).join('')
  return { insert, cursor: at >= 0 ? at : insert.length }
}

/**
 * Remember where to insert while dialogs are open. Closing a dialog refocuses the editor, which can
 * move the selection, and \usepackage lines may be added above; the position shifts with those.
 */
function keepRange(view: EditorView, from = view.state.selection.main.from, to = view.state.selection.main.to): () => { from: number; to: number } {
  const len = view.state.doc.length
  return () => {
    const now = view.state.doc.length
    const d = now - len
    const f = Math.max(0, Math.min(from + d, now))
    return { from: f, to: Math.max(f, Math.min(to + d, now)) }
  }
}

function insertBlock(view: EditorView, snippet: string, at?: () => { from: number; to: number }): void {
  const sel = at ? at() : view.state.selection.main
  const { insert, cursor } = blockChange(view.state, sel.from, sel.to, snippet)
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + cursor }, scrollIntoView: true, userEvent: 'input.paste' })
  view.focus()
}

/** "a/b" + "../c" → "a/c"; null if it leaves the project folder. */
function joinPath(base: string, rel: string): string | null {
  const parts = base ? base.split('/') : []
  for (const seg of rel.split('/')) {
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** A project path as seen from the main file's folder (where LaTeX runs). */
function fromMainDir(mainDir: string, rel: string): string {
  if (!mainDir) return rel
  const a = mainDir.split('/')
  const b = rel.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/')
}

const safeStem = (name: string): string =>
  name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
const labelOf = (stem: string): string => stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'figure'

/** Escape what non-coders type in a caption that would break LaTeX (but leave $math$ and \commands alone). */
const escapeCaption = (s: string): string =>
  s.split(/(\$[^$]*\$)/).map((part, i) => (i % 2 ? part : part.replace(/(?<!\\)[%&#_]/g, '\\$&'))).join('')

// ---------- Notice under the editor ----------
let toastEl: HTMLElement | null = null
let toastTimer = 0
function hideToast(): void {
  clearTimeout(toastTimer)
  toastEl?.remove()
  toastEl = null
}
function toast(view: EditorView, msg: string, buttons: [string, () => void][] = []): void {
  hideToast()
  const el = document.createElement('div')
  el.className = 'paste-toast'
  el.setAttribute('role', 'status')
  const span = document.createElement('span')
  span.textContent = msg
  el.append(span)
  for (const [label, fn] of buttons) {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('mousedown', (e) => e.preventDefault()) // keep the editor's cursor
    b.onclick = () => {
      hideToast()
      fn()
    }
    el.append(b)
  }
  const x = document.createElement('button')
  x.className = 'x'
  x.title = 'Close'
  x.textContent = '×'
  x.addEventListener('mousedown', (e) => e.preventDefault())
  x.onclick = hideToast
  el.append(x)
  const r = view.dom.getBoundingClientRect()
  el.style.left = `${r.left + r.width / 2}px`
  el.style.top = `${Math.max(0, r.top) + 10}px` // top of the editor, clear of the cursor
  el.style.maxWidth = `${Math.max(260, r.width - 32)}px`
  document.body.append(el)
  toastEl = el
  const later = (ms: number): void => {
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(hideToast, ms)
  }
  el.onmouseenter = () => clearTimeout(toastTimer)
  el.onmouseleave = () => later(4000)
  later(10000)
}

// ---------- The figure dialog ----------
interface FigureChoice {
  name: string
  caption: string
  width: string
}

function figureDialog(previewUrl: string, defaultName: string, folder: string, taken: Set<string>): Promise<FigureChoice | null> {
  const d = document.getElementById('modal') as HTMLDialogElement
  const where = folder ? `${folder}/` : ''
  d.innerHTML = `<form method="dialog" class="paste-fig">
    <div class="modal-body">
      <p><b>Add the picture as a figure</b></p>
      <img class="pf-preview" alt="" src="${esc(previewUrl)}" />
      <label class="pf-field">File name<span class="pf-name"><input type="text" name="name" value="${esc(defaultName)}" spellcheck="false" /><span>.png</span></span></label>
      <p class="pf-hint" data-hint></p>
      <label class="pf-field">Caption <span class="pf-opt">(optional, you can also write it later)</span><input type="text" name="caption" placeholder="What the figure shows" /></label>
      <div class="pf-width">Size
        <label><input type="radio" name="width" value="\\linewidth" checked /> Full width</label>
        <label><input type="radio" name="width" value="0.5\\linewidth" /> Half width</label>
      </div>
    </div>
    <div class="modal-actions"><button type="button" data-cancel>Cancel</button><button class="primary" value="ok">Insert figure</button></div>
  </form>`
  const form = d.querySelector('form')!
  const nameIn = form.querySelector<HTMLInputElement>('input[name=name]')!
  const hint = form.querySelector<HTMLElement>('[data-hint]')!
  const clean = (): string => safeStem(nameIn.value) || defaultName
  const update = (): void => {
    const n = clean()
    hint.textContent = taken.has(n.toLowerCase())
      ? `${where}${n}.png already exists and will be replaced.`
      : `OpenTex saves the picture in your project as ${where}${n}.png and adds a figure at the cursor.`
    hint.classList.toggle('warn', taken.has(n.toLowerCase()))
  }
  nameIn.addEventListener('input', update)
  update()
  return new Promise((resolve) => {
    form.querySelector('[data-cancel]')!.addEventListener('click', () => d.close('cancel'))
    d.addEventListener(
      'close',
      () => {
        if (d.returnValue !== 'ok') return resolve(null)
        const data = new FormData(form)
        resolve({ name: clean(), caption: String(data.get('caption') ?? '').trim(), width: String(data.get('width') ?? '\\linewidth') })
      },
      { once: true }
    )
    d.returnValue = ''
    d.showModal()
    nameIn.focus()
    nameIn.select()
  })
}

// ---------- Install ----------
export function installPaste(host: PasteHost): { tableButtons: (el: HTMLElement) => void } {
  const view = host.view

  // Where pictures go: the folder \graphicspath names, else figures/ next to the main file.
  const figureFolder = (): { dir: string; mainDir: string } => {
    const main = host.project()?.mainFile ?? ''
    const mainDir = main.includes('/') ? main.slice(0, main.lastIndexOf('/')) : ''
    const text = host.mainText().replace(/(^|[^\\])%.*$/gm, '$1')
    const gp = text.match(/\\graphicspath\s*\{\s*\{([^}]*)\}/)?.[1]?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    const dir = gp !== undefined && !/^([a-z]:)?\//i.test(gp) ? joinPath(mainDir, gp) : null
    return { dir: dir ?? joinPath(mainDir, 'figures')!, mainDir }
  }
  const filesIn = (dir: string): string[] => {
    const p = host.project()
    const prefix = dir ? `${dir}/` : ''
    return p ? allFiles(p.tree, (f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/')).map((f) => f.slice(prefix.length)) : []
  }
  /** "fig" → the first figN not used yet; "plot.png" → plot.png, plot-2.png, … */
  const freeName = async (dir: string, stem: string, ext: string, numbered: boolean): Promise<string> => {
    const used = new Set(filesIn(dir).map((f) => (numbered ? f.replace(/\.[^.]+$/, '') : f).toLowerCase()))
    for (let n = numbered ? 1 : 0; n < 10000; n++) {
      const s = numbered ? `${stem}${n}` : n ? `${stem}-${n + 1}` : stem
      const name = numbered ? s : `${s}${ext}`
      if (!used.has(name.toLowerCase()) && !(await api.fileExists(joinPath(dir, numbered ? `${s}${ext}` : name)!))) return s
    }
    return `${stem}-${Date.now()}`
  }
  const figure = (path: string, caption: string, width: string, label: string): string =>
    `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${width}]{${path}}\n  \\caption{${caption ? escapeCaption(caption) : CURSOR}}\n  \\label{fig:${label}}\n\\end{figure}${caption ? CURSOR : ''}`

  // ----- Pasted picture → figures/figN.png -----
  async function pasteImage(file: File): Promise<void> {
    if (!host.project()) return
    const at = keepRange(view)
    const { dir, mainDir } = figureFolder()
    const def = await freeName(dir, 'fig', '.png', true)
    const taken = new Set(filesIn(dir).filter((f) => /\.png$/i.test(f)).map((f) => f.replace(/\.png$/i, '').toLowerCase()))
    const url = URL.createObjectURL(file)
    const choice = await figureDialog(url, def, dir, taken).finally(() => URL.revokeObjectURL(url))
    if (!choice) return view.focus()
    const rel = joinPath(dir, `${choice.name}.png`)!
    if (!taken.has(choice.name.toLowerCase()) && (await api.fileExists(rel))) {
      if ((await ask(`${rel} already exists. Replace it with the pasted picture?`, ['Replace', 'Cancel'], 1)) !== 0) return view.focus()
    }
    if (!(await host.ensurePackage('graphicx'))) return view.focus()
    try {
      await api.writeBinary(rel, await toPng(file))
    } catch (e) {
      await ask(`The picture could not be saved: ${errText(e)}`, ['OK'])
      return
    }
    insertBlock(view, figure(fromMainDir(mainDir, rel.replace(/\.png$/i, '')), choice.caption, choice.width, labelOf(choice.name)), at)
    toast(view, `Saved the picture as ${rel} and added a figure.`)
  }

  // ----- Dropped picture files -----
  async function dropImages(files: File[], pos: number | null): Promise<void> {
    const p = host.project()
    if (!p) return
    const at = pos === null ? keepRange(view) : keepRange(view, pos, pos)
    if (!(await host.ensurePackage('graphicx'))) return
    const { dir, mainDir } = figureFolder()
    const root = p.root.replace(/\\/g, '/').replace(/\/+$/, '')
    const blocks: string[] = []
    const copied: string[] = []
    for (const f of files) {
      const abs = (api.pathForFile(f) || '').replace(/\\/g, '/')
      let rel: string
      if (abs && abs.toLowerCase().startsWith(root.toLowerCase() + '/')) rel = abs.slice(root.length + 1) // already in the project
      else {
        const ext = (f.name.match(/\.[^.]+$/)?.[0] ?? '.png').toLowerCase()
        const stem = safeStem(f.name) || 'figure'
        rel = joinPath(dir, stem + ext)!
        if (await api.fileExists(rel)) {
          const a = await ask(`Your project already has a picture called ${rel}. Replace it with the one you dropped, or keep both?`, ['Replace', 'Keep both', 'Cancel'], 1)
          if (a === 2 || a === -1) continue
          if (a === 1) rel = joinPath(dir, (await freeName(dir, stem, ext, false)) + ext)!
        }
        try {
          if (abs) await api.copyIntoProject(abs, rel)
          else await api.writeBinary(rel, new Uint8Array(await f.arrayBuffer()))
        } catch (e) {
          await ask(`${f.name} could not be copied into the project: ${errText(e)}`, ['OK'])
          continue
        }
        copied.push(rel)
      }
      const stem = rel.split('/').pop()!.replace(/\.[^.]+$/, '')
      blocks.push(figure(fromMainDir(mainDir, rel), '', '0.8\\linewidth', labelOf(stem)))
    }
    if (!blocks.length) return view.focus()
    // The cursor goes in the first caption.
    insertBlock(view, blocks.map((b, i) => (i ? b.split(CURSOR).join('') : b)).join('\n\n'), at)
    const n = blocks.length === 1 ? 'a figure' : `${blocks.length} figures`
    toast(view, copied.length ? `Copied ${copied.length === 1 ? copied[0] : `${copied.length} pictures`} into your project and added ${n}.` : `Added ${n}.`)
  }

  // ----- Tables -----
  const nextLabel = (): string => {
    const text = view.state.doc.toString() + host.mainText()
    const used = new Set([...text.matchAll(/\\label\{tab:table(\d+)\}/g)].map((m) => Number(m[1])))
    let n = 1
    while (used.has(n)) n++
    return `tab:table${n}`
  }
  const build = (rows: Cell[][], booktabs = host.hasPackage('booktabs')): ReturnType<typeof buildTable> & { tabular: string } => {
    const t = buildTable(rows, { booktabs, siunitx: host.hasPackage('siunitx'), graphicx: host.hasPackage('graphicx'), label: nextLabel() })
    const tabular = t.text.slice(t.text.indexOf('\\begin{tabular}'), t.text.indexOf('\\end{tabular}'))
    return { ...t, tabular }
  }
  /** Toast buttons: switch the rules to booktabs (adding the package) when it isn't loaded. */
  const booktabsOffer = (tabular: string): [string, () => void][] =>
    host.hasPackage('booktabs')
      ? []
      : [
          [
            'Use booktabs rules',
            async () => {
              if (!(await host.ensurePackage('booktabs')) || !host.hasPackage('booktabs')) return
              const at = view.state.doc.toString().indexOf(tabular)
              if (at < 0) return host.notice('The table was changed, so its rules were left as they are.')
              let k = 0
              const rules = ['\\toprule', '\\midrule', '\\bottomrule']
              const next = tabular.replace(/\\hline/g, () => rules[Math.min(k++, 2)])
              view.dispatch({ changes: { from: at, to: at + tabular.length, insert: next }, userEvent: 'input' })
            }
          ]
        ]
  const message = (start: string, grid: Grid, notes: string[]): string =>
    [start, grid.merged ? 'Merged cells became separate cells.' : '', ...notes].filter(Boolean).join(' · ')

  /** Paste: insert the plain text first, then swap in the table, so the first Undo gives the plain text. */
  function pasteTable(grid: Grid, raw: string): void {
    const text = (raw || gridToTsv(grid.rows)).replace(/\r\n?/g, '\n') // the editor stores \n line endings
    const sel = view.state.selection.main
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, userEvent: 'input.paste' })
    const from = sel.from
    const t = build(grid.rows)
    const { insert, cursor } = blockChange(view.state, from, from + text.length, t.text)
    view.dispatch({
      changes: { from, to: from + text.length, insert },
      selection: { anchor: from + cursor },
      scrollIntoView: true,
      userEvent: 'input.paste',
      annotations: isolateHistory.of('full')
    })
    const after = view.state.doc
    toast(view, message('Pasted as a table · Undo to paste as text', grid, t.notes), [
      ['Paste as text', () => view.state.doc === after && (undo(view), view.focus())],
      ...booktabsOffer(t.tabular)
    ])
  }

  /** Insert a table from the ribbon (clipboard or CSV file). */
  function insertTable(grid: Grid, what: string, at: () => { from: number; to: number }): void {
    const t = build(grid.rows)
    insertBlock(view, t.text, at)
    toast(view, message(what, grid, t.notes), booktabsOffer(t.tabular))
  }

  const needTex = (): boolean => {
    if (host.texActive()) return true
    host.notice('Open a .tex file and put the cursor where you want to insert.')
    return false
  }
  const fromText = (text: string, delim?: string): Grid => ({ rows: cellsFromText(parseDelimited(text, delim ?? guessDelimiter(text))), merged: false })
  const usable = (g: Grid | null | undefined): g is Grid => Boolean(g && g.rows.length && (g.rows.length >= 2 || g.rows[0].length >= 2))

  async function pasteFromClipboard(): Promise<void> {
    if (!needTex()) return
    const at = keepRange(view)
    const { html, text } = await api.readClipboard()
    let grid: Grid | null = html ? parseHtmlTable(html) : null
    if (!usable(grid) && text.trim()) grid = fromText(text, text.includes('\t') ? '\t' : undefined)
    if (!usable(grid)) {
      await ask('There’s no table on the clipboard. In Excel, Google Sheets, Numbers or Word, select the cells, copy them (Ctrl+C or ⌘C), then try again.', ['OK'])
      return view.focus()
    }
    insertTable(grid, 'Inserted a table from the clipboard', at)
  }

  async function tableFromFile(file?: { name: string; text: string }, at = keepRange(view)): Promise<void> {
    if (!needTex()) return
    if (!file) {
      try {
        file = (await api.chooseTableFile()) ?? undefined
      } catch (e) {
        await ask(errText(e), ['OK'])
      }
      if (!file) return view.focus()
    }
    const grid = fromText(file.text, /\.tsv$/i.test(file.name) ? '\t' : undefined)
    if (!usable(grid)) {
      await ask(`${file.name} doesn’t look like a table. Save it from Excel with File → Save As → CSV, then try again.`, ['OK'])
      return view.focus()
    }
    insertTable(grid, `Inserted a table from ${file.name}`, at)
  }

  // ----- Event hooks -----
  const inEditor = (t: EventTarget | null): boolean => t instanceof Node && view.contentDOM.contains(t)

  view.dom.addEventListener(
    'paste',
    (e) => {
      if (!host.texActive() || !e.clipboardData || !inEditor(e.target)) return
      const dt = e.clipboardData
      const html = dt.getData('text/html')
      const text = dt.getData('text/plain')
      let grid: Grid | null = null
      try {
        grid = detectTable(html, text)
      } catch {
        grid = null
      }
      if (grid) {
        e.preventDefault()
        e.stopPropagation()
        pasteTable(grid, text)
        return
      }
      if (text.trim() || !host.project()) return
      const item = [...dt.items].find((i) => i.kind === 'file' && /^image\//.test(i.type))
      const file = item?.getAsFile()
      if (!file) return
      e.preventDefault()
      e.stopPropagation()
      void pasteImage(file)
    },
    true
  )

  // Cmd/Ctrl+Shift+V: paste as plain text, never a table or figure.
  view.dom.addEventListener(
    'keydown',
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || (e.code !== 'KeyV' && e.key.toLowerCase() !== 'v') || !inEditor(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      void api.readClipboard().then(({ text: raw }) => {
        const text = raw.replace(/\r\n?/g, '\n')
        if (!text) return
        const sel = view.state.selection.main
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true, userEvent: 'input.paste' })
      })
    },
    true
  )

  // Dropping pictures (or a CSV file) onto the window while a .tex file is open. This runs before
  // the window's own drop handler (Word documents, reference libraries), which keeps everything else.
  window.addEventListener(
    'drop',
    (e) => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length || !host.texActive() || !host.project()) return
      const images = files.filter((f) => IMAGE_FILE.test(f.name))
      const table = files.length === 1 && TABLE_FILE.test(files[0].name) ? files[0] : null
      if (!table && images.length !== files.length) return
      e.preventDefault()
      e.stopImmediatePropagation()
      // Clear CodeMirror's drop cursor, which never sees this drop.
      view.contentDOM.dispatchEvent(new DragEvent('dragleave', { bubbles: true }))
      const at = view.dom.contains(e.target as Node) ? view.posAtCoords({ x: e.clientX, y: e.clientY }, false) : null
      // A figure or table goes after the line it was dropped on, never in the middle of a word.
      const pos = at === null ? null : view.state.doc.lineAt(at).to
      if (table) {
        const at = pos === null ? keepRange(view) : keepRange(view, pos, pos)
        void table.text().then((text) => tableFromFile({ name: table.name, text }, at))
      } else void dropImages(images, pos)
    },
    true
  )

  return {
    tableButtons: (el) => {
      el.innerHTML = `<button class="ins-btn wide" data-paste-table title="Turn cells copied from Excel, Google Sheets, Numbers or Word into a LaTeX table">Paste from Excel</button><button class="ins-btn wide" data-csv-table title="Make a table from a CSV file (comma, semicolon or tab separated)">From a CSV file…</button>`
      el.querySelector<HTMLButtonElement>('[data-paste-table]')!.onclick = () => void pasteFromClipboard()
      el.querySelector<HTMLButtonElement>('[data-csv-table]')!.onclick = () => void tableFromFile()
    }
  }
}

/** Pictures are saved as PNG; other clipboard formats are converted. */
async function toPng(file: File): Promise<Uint8Array> {
  if (file.type === 'image/png') return new Uint8Array(await file.arrayBuffer())
  const bmp = await createImageBitmap(file)
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
  if (!blob) throw new Error('The picture could not be converted to PNG.')
  return new Uint8Array(await blob.arrayBuffer())
}
