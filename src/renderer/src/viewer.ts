// A figure viewer for file windows: shows one picture or PDF figure at a time, fitted to the panel,
// with zoom, pan, and ‹ › to step through the other figures in the same folder.
//
// Speed: after a file is shown, its neighbours (previous and next) are read and decoded in the
// background, so stepping through a folder is instant. A few of them are kept (pictures decoded,
// PDFs as bytes only); anything older is freed. Nothing here runs until a FileViewer is made.
import './viewer.css'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Same worker as the main PDF panel (pdfview.ts); Vite gives both imports the same URL.
if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// One pdf.js worker shared by all viewers, started on the first PDF figure and stopped when the
// last viewer goes away. (Without it pdf.js would start a fresh worker for every file shown.)
let sharedWorker: pdfjs.PDFWorker | null = null
let workerUsers = 0
function acquireWorker(): pdfjs.PDFWorker {
  if (!sharedWorker) sharedWorker = new pdfjs.PDFWorker()
  workerUsers++
  return sharedWorker
}
function releaseWorker(): void {
  if (--workerUsers > 0 || !sharedWorker) return
  sharedWorker.destroy()
  sharedWorker = null
}

export const VIEWABLE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf)$/i

export function isViewable(path: string): boolean {
  return VIEWABLE.test(path)
}

export interface ViewerHost {
  readBinary(rel: string): Promise<Uint8Array> // = window.opentex.readBinary (project-relative path)
  siblings(rel: string): string[] // viewable files in the same folder, in display order
  navigate(rel: string): void // prev/next chosen: host shows this file in the same tab, then calls show(rel)
  reveal(rel: string): void // show the file in Finder/Explorer
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp'
}
const CSS_UNITS = 96 / 72 // PDF points to CSS pixels, so 100% is the figure's printed size
const KEEP = 4 // files kept ready besides the one on screen
const FRESH_MS = 30_000 // a kept file older than this is read again (it may have been regenerated)
const PAD = 16 // space around a fitted figure
const MAX_UPSCALE = 2 // fit never blows a small bitmap up more than this
const MIN_ZOOM = 0.02
const MAX_ZOOM = 32
const MAX_CANVAS_PX = 24e6 // a zoomed PDF is drawn at most this big; past that it's stretched
const STEP = 1.25

type Loaded =
  | { kind: 'img'; url: string; img: HTMLImageElement; w: number; h: number; vector: boolean; cached: boolean }
  | { kind: 'pdf'; bytes: Uint8Array; cached: boolean }
interface Entry {
  at: number
  p: Promise<Loaded>
}
type Zoom = number | 'fit'
interface Size {
  w: number
  h: number
}

const ext = (p: string): string => /\.([^./\\]+)$/.exec(p)?.[1].toLowerCase() ?? ''
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const platform = navigator.platform || ''
const REVEAL_LABEL = platform.startsWith('Mac') ? 'Show in Finder' : platform.startsWith('Win') ? 'Show in Explorer' : 'Show in Folder'

const ICON = {
  prev: '<svg viewBox="0 0 20 20"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>',
  next: '<svg viewBox="0 0 20 20"><path d="M7.5 4.5L13 10l-5.5 5.5"/></svg>',
  minus: '<svg viewBox="0 0 20 20"><path d="M5 10h10"/></svg>',
  plus: '<svg viewBox="0 0 20 20"><path d="M5 10h10M10 5v10"/></svg>',
  folder: '<svg viewBox="0 0 20 20"><path d="M2.5 5.5a1 1 0 011-1h4l1.5 2h7.5a1 1 0 011 1v7.5a1 1 0 01-1 1h-13a1 1 0 01-1-1z"/></svg>'
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function button(cls: string, title: string, icon: string | null, label?: string): HTMLButtonElement {
  const b = h('button', cls)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  if (icon) b.innerHTML = icon // our own fixed icons, never file content
  if (label) b.append(h('span', 'ot-vw-label', label))
  return b
}

function friendly(err: unknown, rel: string): string {
  const msg = String((err as Error)?.message ?? err)
  const name = (err as Error)?.name ?? ''
  if (/ENOENT|ENOTDIR/.test(msg)) return "This file isn't there any more. It may have been moved, renamed or deleted."
  if (/EACCES|EPERM/.test(msg)) return "OpenTex isn't allowed to read this file."
  if (/EISDIR/.test(msg)) return 'This is a folder, not a file.'
  if (ext(rel) === 'pdf') return "This PDF couldn't be opened. It may be damaged, or still being written."
  if (name === 'EncodingError' || /decode/i.test(msg)) return `This picture couldn't be decoded. The file may be damaged, or not really a .${ext(rel)} file.`
  return "This file couldn't be shown."
}

export class FileViewer {
  readonly el: HTMLElement
  private host: ViewerHost
  private stage: HTMLElement
  private content: HTMLElement
  private msg: HTMLElement
  private bar: {
    prev: HTMLButtonElement
    next: HTMLButtonElement
    name: HTMLElement
    where: HTMLElement
    pages: HTMLElement
    pagePrev: HTMLButtonElement
    pageNext: HTMLButtonElement
    pageLabel: HTMLElement
    zoomLabel: HTMLButtonElement
    fit: HTMLButtonElement
    zoomButtons: HTMLButtonElement[]
  }
  private arrows: HTMLElement[]

  private rel = ''
  private sibs: string[] = []
  private gen = 0 // bumped by every show(); stale loads see a different number and stop
  private cache = new Map<string, Entry>()
  private shown: Loaded | null = null // what's on screen now (may also be in the cache)
  private disposed = false

  // View: the figure's natural size (CSS px at 100%), zoom, and where its top-left corner sits.
  private nat: Size | null = null
  private vector = false
  private zoom: Zoom = 'fit'
  private tx = 0
  private ty = 0

  // PDF state
  private doc: PDFDocumentProxy | null = null
  private worker: pdfjs.PDFWorker | null = null
  private docSrc: Loaded | null = null // the bytes `doc` was opened from
  private loadingTask: PDFDocumentLoadingTask | null = null
  private renderTask: RenderTask | null = null
  private pageNo = 1
  private paintToken = 0
  private paintedScale = 0
  private paintedDpr = 0
  private needPaint = false // a paint waits for the panel to get a size
  private needFresh = false // ...and it's for a newly shown file

  private paintTimer = 0
  private busyTimer = 0
  private idle = 0
  private ro: ResizeObserver
  private drag: { id: number; x: number; y: number; tx: number; ty: number } | null = null

  constructor(host: ViewerHost) {
    this.host = host
    this.el = h('div', 'ot-viewer')
    this.el.tabIndex = 0
    this.el.setAttribute('role', 'region')
    this.el.setAttribute('aria-label', 'Figure viewer')

    // Toolbar: ‹ name · 3 of 12 in figures/ › | page ‹ 1 of 3 › | − 100% + Fit | Show in Finder
    const tb = h('div', 'ot-vw-bar')
    const prev = button('ot-vw-nav', 'Previous file (←)', ICON.prev)
    const next = button('ot-vw-nav', 'Next file (→)', ICON.next)
    const title = h('div', 'ot-vw-title')
    const name = h('span', 'ot-vw-name')
    const where = h('span', 'ot-vw-where')
    title.append(name, where)
    const pages = h('div', 'ot-vw-pages hidden')
    const pagePrev = button('ot-vw-btn', 'Previous page', ICON.prev)
    const pageNext = button('ot-vw-btn', 'Next page', ICON.next)
    const pageLabel = h('span', 'ot-vw-pagelabel')
    pages.append(pagePrev, pageLabel, pageNext)
    const zoomOut = button('ot-vw-btn', 'Zoom out (−)', ICON.minus)
    const zoomLabel = button('ot-vw-btn ot-vw-pct', 'Actual size / fit', null, '100%')
    const zoomIn = button('ot-vw-btn', 'Zoom in (+)', ICON.plus)
    const fit = button('ot-vw-btn ot-vw-fit', 'Fit to window (0)', null, 'Fit')
    const reveal = button('ot-vw-btn ot-vw-reveal', REVEAL_LABEL, ICON.folder, REVEAL_LABEL)
    const zoomGroup = h('div', 'ot-vw-group')
    zoomGroup.append(zoomOut, zoomLabel, zoomIn, fit)
    tb.append(prev, title, next, h('span', 'ot-vw-spacer'), pages, zoomGroup, reveal)
    this.bar = { prev, next, name, where, pages, pagePrev, pageNext, pageLabel, zoomLabel, fit, zoomButtons: [zoomOut, zoomLabel, zoomIn, fit] }

    // Figure area, with big ‹ › arrows on its edges that appear on hover.
    this.stage = h('div', 'ot-vw-stage')
    this.content = h('div', 'ot-vw-content')
    this.msg = h('div', 'ot-vw-msg hidden')
    const left = button('ot-vw-arrow ot-vw-left', 'Previous file (←)', ICON.prev)
    const right = button('ot-vw-arrow ot-vw-right', 'Next file (→)', ICON.next)
    this.arrows = [left, right]
    this.stage.append(this.content, left, right, this.msg)
    this.el.append(tb, this.stage)

    prev.onclick = left.onclick = () => this.go(-1)
    next.onclick = right.onclick = () => this.go(1)
    pagePrev.onclick = () => this.setPage(this.pageNo - 1)
    pageNext.onclick = () => this.setPage(this.pageNo + 1)
    zoomOut.onclick = () => this.zoomBy(1 / STEP)
    zoomIn.onclick = () => this.zoomBy(STEP)
    zoomLabel.onclick = () => this.setZoom(this.zoom === 'fit' ? 1 : 'fit')
    fit.onclick = () => this.setZoom('fit')
    reveal.onclick = () => this.rel && this.host.reveal(this.rel)

    this.el.addEventListener('keydown', (e) => this.onKey(e))
    this.stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.stage.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.stage.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.stage.addEventListener('pointerup', (e) => this.onPointerUp(e))
    this.stage.addEventListener('pointercancel', (e) => this.onPointerUp(e))
    this.stage.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button, .ot-vw-msg')) return
      if (this.zoom === 'fit') this.zoomAt(1, e.clientX, e.clientY)
      else this.setZoom('fit')
    })
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.stage)
  }

  // ---------- Public ----------

  /** Show this file. Any earlier show() still loading is dropped. Never throws. */
  async show(rel: string): Promise<void> {
    if (this.disposed) return
    const gen = ++this.gen
    const same = rel === this.rel && this.shown !== null
    this.rel = rel
    this.cancelPdfWork()
    this.cancelIdle()
    this.updateBar()
    clearTimeout(this.busyTimer)
    this.busyTimer = window.setTimeout(() => this.el.classList.add('busy'), 150)
    // Showing the file that's already on screen means "refresh": read it again, keep the view.
    if (same) this.forget(rel)
    try {
      const l = await this.load(rel)
      if (gen !== this.gen) return
      if (l.kind === 'img') {
        this.closeDoc()
        this.pageNo = 1
        this.updatePages()
        this.commit(l, l.img, { w: l.w, h: l.h }, l.vector, !same)
      } else {
        const task = pdfjs.getDocument({ data: l.bytes.slice(), worker: (this.worker ??= acquireWorker()) }) // the worker takes the copy
        this.loadingTask = task
        const doc = await task.promise
        if (gen !== this.gen) {
          void task.destroy()
          return
        }
        this.loadingTask = null
        this.closeDoc()
        this.doc = doc
        this.docSrc = l
        this.pageNo = same ? Math.min(this.pageNo, doc.numPages) : 1
        await this.paintPdf(l, !same)
        if (gen !== this.gen) return
      }
    } catch (err) {
      if (gen !== this.gen || this.disposed) return
      if ((err as Error)?.name === 'RenderingCancelledException') return
      this.showError(rel, err)
    } finally {
      if (gen === this.gen) {
        clearTimeout(this.busyTimer)
        this.el.classList.remove('busy')
      }
    }
    if (gen === this.gen) this.prefetchSoon()
  }

  /** Call when the panel changes size (a ResizeObserver also catches most cases). */
  resize(): void {
    if (this.disposed) return
    this.layout()
    if (this.doc && (this.needPaint || this.paintDiffers())) this.schedulePaint()
  }

  /** Free everything: PDF documents, picture URLs, observers, timers. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.gen++
    this.cancelPdfWork()
    this.closeDoc()
    if (this.worker) releaseWorker()
    this.worker = null
    this.cancelIdle()
    clearTimeout(this.busyTimer)
    this.ro.disconnect()
    for (const rel of [...this.cache.keys()]) this.forget(rel)
    if (this.shown) this.free(this.shown)
    this.shown = null
    this.content.replaceChildren()
    this.el.remove()
  }

  // ---------- Loading and the small cache ----------

  private load(rel: string): Promise<Loaded> {
    const hit = this.cache.get(rel)
    if (hit && Date.now() - hit.at < FRESH_MS) {
      this.cache.delete(rel) // most recently used goes last
      this.cache.set(rel, hit)
      return hit.p
    }
    if (hit) this.forget(rel)
    const entry: Entry = { at: Date.now(), p: null as unknown as Promise<Loaded> }
    entry.p = this.fetch(rel).then(
      (l) => {
        if (this.cache.get(rel) !== entry || this.disposed) {
          l.cached = false
          if (l !== this.shown && rel !== this.rel) this.free(l) // dropped while loading and nobody wants it
        }
        return l
      },
      (err) => {
        if (this.cache.get(rel) === entry) this.cache.delete(rel) // try again next time
        throw err
      }
    )
    this.cache.set(rel, entry)
    this.trim()
    return entry.p
  }

  private async fetch(rel: string): Promise<Loaded> {
    const bytes = await this.host.readBinary(rel)
    if (ext(rel) === 'pdf') return { kind: 'pdf', bytes, cached: true }
    const type = MIME[ext(rel)] ?? ''
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], type ? { type } : {}))
    const img = new Image()
    img.decoding = 'async'
    img.draggable = false
    img.alt = baseName(rel)
    img.src = url
    try {
      await img.decode()
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
    const vector = type === 'image/svg+xml'
    let w = img.naturalWidth
    let hh = img.naturalHeight
    if (!w || !hh) [w, hh] = [800, 600] // an SVG with no size of its own: just fill the panel
    return { kind: 'img', url, img, w, h: hh, vector, cached: true }
  }

  /** Keep the file on screen plus at most KEEP others. */
  private trim(): void {
    while (this.cache.size > KEEP + 1) {
      const victim = [...this.cache.keys()].find((k) => k !== this.rel)
      if (!victim) break
      this.forget(victim)
    }
  }

  private forget(rel: string): void {
    const e = this.cache.get(rel)
    if (!e) return
    this.cache.delete(rel)
    e.p.then(
      (l) => {
        l.cached = false
        if (l !== this.shown && (rel !== this.rel || this.disposed)) this.free(l)
      },
      () => {}
    )
  }

  private free(l: Loaded): void {
    if (l.kind !== 'img') return
    l.img.removeAttribute('src')
    URL.revokeObjectURL(l.url)
  }

  private prefetchSoon(): void {
    if (this.sibs.length < 2) return
    const run = (): void => {
      this.idle = 0
      if (this.disposed) return
      const i = this.sibs.indexOf(this.rel)
      const n = this.sibs.length
      const want = i < 0 ? [this.sibs[0]] : [this.sibs[(i + 1) % n], this.sibs[(i - 1 + n) % n]]
      for (const rel of new Set(want)) if (rel !== this.rel) this.load(rel).catch(() => {})
    }
    this.idle = requestIdleCallback(run, { timeout: 300 })
  }

  private cancelIdle(): void {
    if (this.idle) cancelIdleCallback(this.idle)
    this.idle = 0
  }

  // ---------- Showing ----------

  /** Swap in a new picture or PDF canvas. `fresh` resets the view to fit. */
  private commit(l: Loaded, node: HTMLElement, nat: Size, vector: boolean, fresh: boolean): void {
    const old = this.shown
    this.shown = l
    if (old && old !== l && !old.cached) this.free(old)
    if (fresh) this.zoom = 'fit'
    const centre = fresh || !this.nat || this.nat.w !== nat.w || this.nat.h !== nat.h
    this.nat = nat
    this.vector = vector
    this.msg.classList.add('hidden')
    this.content.classList.toggle('ot-vw-checker', l.kind === 'img')
    this.content.classList.remove('hidden')
    if (this.content.firstChild !== node || this.content.childNodes.length !== 1) this.content.replaceChildren(node)
    if (centre) this.tx = this.ty = Number.NaN // centred by layout()
    this.layout()
  }

  private showError(rel: string, err: unknown): void {
    console.warn('Viewer could not show', rel, err)
    this.closeDoc()
    const old = this.shown
    this.shown = null
    if (old && !old.cached) this.free(old)
    this.nat = null
    this.content.replaceChildren()
    this.content.classList.add('hidden')
    this.updatePages()
    this.updateZoomLabel()
    const reveal = button('ot-vw-btn ot-vw-reveal', REVEAL_LABEL, ICON.folder, REVEAL_LABEL)
    reveal.onclick = () => this.host.reveal(rel)
    this.msg.replaceChildren(h('div', 'ot-vw-msg-title', `Can't show ${baseName(rel)}`), h('div', 'ot-vw-msg-text', friendly(err, rel)), reveal)
    this.msg.classList.remove('hidden')
  }

  private updateBar(): void {
    let sibs: string[] = []
    try {
      sibs = this.host.siblings(this.rel)
    } catch {
      /* host trouble: just no arrows */
    }
    this.sibs = sibs
    const many = sibs.length > 1
    const i = sibs.indexOf(this.rel)
    const dir = dirName(this.rel)
    this.bar.name.textContent = baseName(this.rel)
    this.bar.name.title = this.rel
    this.bar.where.textContent = many && i >= 0 ? `${i + 1} of ${sibs.length} in ${dir || 'the project folder'}` : dir
    this.bar.where.classList.toggle('hidden', !this.bar.where.textContent)
    for (const b of [this.bar.prev, this.bar.next, ...this.arrows]) b.classList.toggle('hidden', !many)
  }

  private updatePages(): void {
    const n = this.doc?.numPages ?? 1
    this.bar.pages.classList.toggle('hidden', n < 2)
    if (n < 2) return
    this.bar.pageLabel.textContent = `page ${this.pageNo} of ${n}`
    this.bar.pageLabel.dataset.short = `${this.pageNo}/${n}`
    this.bar.pagePrev.disabled = this.pageNo <= 1
    this.bar.pageNext.disabled = this.pageNo >= n
  }

  private updateZoomLabel(): void {
    const label = this.bar.zoomLabel.querySelector('span')!
    label.textContent = this.nat ? `${Math.round(this.scale() * 100)}%` : ''
    this.bar.fit.classList.toggle('on', this.zoom === 'fit' && !!this.nat)
    for (const b of this.bar.zoomButtons) b.disabled = !this.nat
  }

  // ---------- Navigation ----------

  private go(delta: number | 'first' | 'last'): void {
    let sibs: string[]
    try {
      sibs = this.host.siblings(this.rel)
    } catch {
      return
    }
    if (sibs.length < 2) return
    const n = sibs.length
    const i = sibs.indexOf(this.rel)
    const j = delta === 'first' ? 0 : delta === 'last' ? n - 1 : i < 0 ? (delta > 0 ? 0 : n - 1) : (((i + delta) % n) + n) % n
    if (sibs[j] !== this.rel) this.host.navigate(sibs[j])
  }

  private setPage(n: number): void {
    const doc = this.doc
    if (!doc || !this.docSrc || n < 1 || n > doc.numPages || n === this.pageNo) return
    this.pageNo = n
    this.updatePages()
    void this.paintPdf(this.docSrc!, false).catch((err) => this.paintFailed(err))
  }

  // ---------- Zoom and pan ----------

  private fitScale(nat: Size, vector: boolean): number {
    const sw = this.stage.clientWidth - 2 * PAD
    const sh = this.stage.clientHeight - 2 * PAD
    let s = Math.min(sw / nat.w, sh / nat.h)
    if (!vector) s = Math.min(s, MAX_UPSCALE)
    return Math.max(MIN_ZOOM, Number.isFinite(s) && s > 0 ? s : 1)
  }

  private scaleFor(nat: Size, vector: boolean, zoom: Zoom): number {
    return zoom === 'fit' ? this.fitScale(nat, vector) : zoom
  }

  private scale(): number {
    return this.nat ? this.scaleFor(this.nat, this.vector, this.zoom) : 1
  }

  private setZoom(z: Zoom): void {
    if (!this.nat) return
    if (z === 'fit') {
      this.zoom = 'fit'
      this.tx = this.ty = Number.NaN
      this.layout()
      this.afterZoom()
    } else {
      const r = this.stage.getBoundingClientRect()
      this.zoomAt(z, r.left + r.width / 2, r.top + r.height / 2)
    }
  }

  private zoomBy(f: number): void {
    if (!this.nat) return
    const r = this.stage.getBoundingClientRect()
    this.zoomAt(this.scale() * f, r.left + r.width / 2, r.top + r.height / 2)
  }

  /** Zoom to scale `s`, keeping the point under (clientX, clientY) still. */
  private zoomAt(s: number, clientX: number, clientY: number): void {
    if (!this.nat) return
    const s0 = this.scale()
    const s1 = clamp(s, MIN_ZOOM, MAX_ZOOM)
    if (Math.abs(s1 - s0) < 1e-4 && this.zoom !== 'fit') return
    const r = this.stage.getBoundingClientRect()
    const px = clientX - r.left
    const py = clientY - r.top
    this.zoom = s1
    this.tx = px - (px - this.tx) * (s1 / s0)
    this.ty = py - (py - this.ty) * (s1 / s0)
    this.layout()
    this.afterZoom()
  }

  private afterZoom(): void {
    if (this.doc && this.paintDiffers()) this.schedulePaint()
  }

  /** Size and place the figure. Smaller than the panel: centred. Bigger: kept inside the edges. */
  private layout(): void {
    const sw = this.stage.clientWidth
    const sh = this.stage.clientHeight
    if (!this.nat || !sw || !sh) return
    const s = this.scale()
    const cw = this.nat.w * s
    const ch = this.nat.h * s
    this.tx = cw <= sw ? (sw - cw) / 2 : Number.isNaN(this.tx) ? (sw - cw) / 2 : clamp(this.tx, sw - cw, 0)
    this.ty = ch <= sh ? (sh - ch) / 2 : Number.isNaN(this.ty) ? (sh - ch) / 2 : clamp(this.ty, sh - ch, 0)
    const st = this.content.style
    st.width = `${cw}px`
    st.height = `${ch}px`
    st.transform = `translate(${Math.round(this.tx)}px, ${Math.round(this.ty)}px)`
    const pannable = cw > sw + 0.5 || ch > sh + 0.5
    this.stage.classList.toggle('pannable', pannable)
    // Zoomed far into a bitmap: show crisp pixels instead of a blur.
    this.content.classList.toggle('ot-vw-pixels', !this.vector && s * (window.devicePixelRatio || 1) >= 4)
    this.updateZoomLabel()
  }

  private onWheel(e: WheelEvent): void {
    if (!this.nat) return
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + wheel, or a trackpad pinch (which arrives as a wheel event with ctrlKey).
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      const f = Math.abs(dy) >= 50 ? (dy < 0 ? STEP : 1 / STEP) : Math.exp(-dy * 0.01)
      this.zoomAt(this.scale() * f, e.clientX, e.clientY)
    } else if (this.stage.classList.contains('pannable')) {
      e.preventDefault()
      const k = e.deltaMode === 1 ? 33 : 1
      this.tx -= e.deltaX * k
      this.ty -= e.deltaY * k
      this.layout()
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('button, .ot-vw-msg')) return
    this.el.focus({ preventScroll: true })
    if (e.button !== 0 || !this.stage.classList.contains('pannable')) return
    e.preventDefault()
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }
    this.stage.setPointerCapture(e.pointerId)
    this.stage.classList.add('dragging')
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    this.tx = d.tx + e.clientX - d.x
    this.ty = d.ty + e.clientY - d.y
    this.layout()
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || this.drag.id !== e.pointerId) return
    this.drag = null
    this.stage.classList.remove('dragging')
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId)
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    const k = e.key
    if (k === 'ArrowLeft' || k === 'PageUp') this.go(-1)
    else if (k === 'ArrowRight' || k === 'PageDown') this.go(1)
    else if (k === 'Home') this.go('first')
    else if (k === 'End') this.go('last')
    else if (k === '+' || k === '=') this.zoomBy(STEP)
    else if (k === '-' || k === '_') this.zoomBy(1 / STEP)
    else if (k === '0') this.setZoom('fit')
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  // ---------- PDF ----------

  private paintDiffers(): boolean {
    if (!this.nat) return false
    const dpr = window.devicePixelRatio || 1
    return dpr !== this.paintedDpr || Math.abs(this.scale() / this.paintedScale - 1) > 0.01
  }

  private schedulePaint(): void {
    clearTimeout(this.paintTimer)
    this.paintTimer = window.setTimeout(() => {
      if (this.doc && this.docSrc) void this.paintPdf(this.docSrc, this.needFresh).catch((err) => this.paintFailed(err))
    }, 120)
  }

  private paintFailed(err: unknown): void {
    if ((err as Error)?.name === 'RenderingCancelledException' || this.disposed) return
    this.showError(this.rel, err)
  }

  /** Draw the current page crisp at the current zoom, then swap it in. */
  private async paintPdf(l: Loaded, fresh: boolean): Promise<void> {
    const doc = this.doc
    if (!doc) return
    const token = ++this.paintToken
    clearTimeout(this.paintTimer)
    this.renderTask?.cancel()
    this.renderTask = null
    const page = await doc.getPage(this.pageNo)
    if (token !== this.paintToken || doc !== this.doc) return
    const base = page.getViewport({ scale: CSS_UNITS })
    const nat = { w: base.width, h: base.height }
    if (!this.stage.clientWidth || !this.stage.clientHeight) {
      this.needPaint = true // hidden: draw when the panel is shown (resize() will call back)
      this.needFresh = this.needFresh || fresh
      return
    }
    this.needPaint = this.needFresh = false
    const s = this.scaleFor(nat, true, fresh ? 'fit' : this.zoom)
    const dpr = window.devicePixelRatio || 1
    let r = s * dpr
    const px = nat.w * nat.h * r * r
    if (px > MAX_CANVAS_PX) r *= Math.sqrt(MAX_CANVAS_PX / px)
    const vp = page.getViewport({ scale: CSS_UNITS * r })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(vp.width))
    canvas.height = Math.max(1, Math.floor(vp.height))
    const task = page.render({ canvas, viewport: vp })
    this.renderTask = task
    try {
      await task.promise
    } finally {
      if (this.renderTask === task) this.renderTask = null
    }
    if (token !== this.paintToken || doc !== this.doc || this.disposed) return
    this.paintedScale = s
    this.paintedDpr = dpr
    this.updatePages()
    this.commit(l, canvas, nat, true, fresh)
    if (this.paintDiffers()) this.schedulePaint() // zoom changed while drawing
  }

  private cancelPdfWork(): void {
    this.paintToken++
    clearTimeout(this.paintTimer)
    this.renderTask?.cancel()
    this.renderTask = null
    if (this.loadingTask) void this.loadingTask.destroy()
    this.loadingTask = null
  }

  private closeDoc(): void {
    if (this.doc) void this.doc.loadingTask.destroy()
    this.doc = null
    this.docSrc = null
    this.needPaint = this.needFresh = false
    this.paintedScale = 0
  }
}
