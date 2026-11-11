import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Simple scrolling PDF viewer. Pages near the viewport render first, others as you scroll. */
export class PdfView {
  private doc: PDFDocumentProxy | null = null
  private task: PDFDocumentLoadingTask | null = null
  private zoom: number | 'fit' = 'fit'
  private observer: IntersectionObserver | null = null
  private generation = 0
  private resizeTimer = 0
  private lastWidth = 0

  private scale = 1
  /** Called with a page point (PDF points from the top-left) when the user double-clicks the PDF. */
  onInverse: ((page: number, x: number, y: number) => void) | null = null

  constructor(private host: HTMLElement, private zoomLabel: HTMLElement, private pagesLabel: HTMLElement) {
    host.addEventListener('dblclick', (e) => {
      const hit = this.pointAt(e.clientX, e.clientY)
      if (hit && this.onInverse) {
        window.getSelection()?.removeAllRanges()
        this.onInverse(hit.page, hit.x, hit.y)
      }
    })
    new ResizeObserver(() => {
      const w = this.host.clientWidth
      if (this.zoom !== 'fit' || !this.doc || Math.abs(w - this.lastWidth) < 4) return
      clearTimeout(this.resizeTimer)
      this.resizeTimer = window.setTimeout(() => this.render(), 150)
    }).observe(host)
  }

  async load(data: Uint8Array): Promise<void> {
    const task = pdfjs.getDocument({ data })
    const doc = await task.promise
    const old = this.task
    this.task = task
    this.doc = doc
    await this.render()
    old?.destroy()
  }

  setZoom(z: number | 'fit'): void {
    this.zoom = z === 'fit' ? 'fit' : Math.min(4, Math.max(0.25, z))
    this.render()
  }

  zoomBy(f: number): void {
    const cur = this.zoom === 'fit' ? this.currentFitScale() : this.zoom
    this.setZoom(Math.round(cur * f * 20) / 20)
  }

  private fitScale = 1
  private currentFitScale(): number {
    return this.fitScale
  }

  private async render(): Promise<void> {
    const doc = this.doc
    if (!doc) return
    const gen = ++this.generation
    const keepRatio = this.host.scrollHeight > 0 ? this.host.scrollTop / this.host.scrollHeight : 0
    const keepLeft = this.host.scrollLeft
    this.lastWidth = this.host.clientWidth
    const first = await doc.getPage(1)
    const base = first.getViewport({ scale: 1 })
    this.fitScale = Math.max(0.2, (this.host.clientWidth - 28) / base.width)
    const scale = this.zoom === 'fit' ? this.fitScale : this.zoom
    this.scale = scale
    this.zoomLabel.textContent = this.zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`
    this.pagesLabel.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`

    // Build placeholders sized like the pages so the scroll position can be restored before drawing.
    const wrap = document.createElement('div')
    const slots: HTMLDivElement[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (i === 1 ? first : await doc.getPage(i)).getViewport({ scale })
      const slot = document.createElement('div')
      slot.className = 'pdf-page'
      slot.style.width = `${Math.floor(vp.width)}px`
      slot.style.height = `${Math.floor(vp.height)}px`
      slot.dataset.page = String(i)
      slot.style.setProperty('--scale-factor', String(scale))
      slot.style.setProperty('--total-scale-factor', String(scale))
      slots.push(slot)
      wrap.appendChild(slot)
    }
    if (gen !== this.generation) return

    // Pre-draw pages near the old position into the new slots so swapping doesn't flash.
    const totalH = slots.reduce((h, s) => h + parseFloat(s.style.height) + 12, 0)
    const targetTop = keepRatio * totalH
    let y = 0
    const near: number[] = []
    slots.forEach((s, i) => {
      const h = parseFloat(s.style.height) + 12
      if (y + h > targetTop - 200 && y < targetTop + this.host.clientHeight + 200) near.push(i + 1)
      y += h
    })
    await Promise.all(near.map((n) => this.drawPage(doc, n, slots[n - 1], scale, gen)))
    if (gen !== this.generation) return

    this.host.replaceChildren(wrap)
    this.host.scrollTop = keepRatio * this.host.scrollHeight
    this.host.scrollLeft = keepLeft

    this.observer?.disconnect()
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLDivElement
          if (e.isIntersecting && !el.dataset.drawn) this.drawPage(doc, Number(el.dataset.page), el, scale, gen)
        }
      },
      { root: this.host, rootMargin: '400px 0px' }
    )
    slots.forEach((s) => this.observer!.observe(s))
  }

  private async drawPage(doc: PDFDocumentProxy, n: number, slot: HTMLDivElement, scale: number, gen: number): Promise<void> {
    if (slot.dataset.drawn) return
    slot.dataset.drawn = '1'
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale })
    const dpr = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(vp.width * dpr)
    canvas.height = Math.floor(vp.height * dpr)
    canvas.style.width = `${Math.floor(vp.width)}px`
    canvas.style.height = `${Math.floor(vp.height)}px`
    try {
      await page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise
    } catch (e) {
      if (gen === this.generation) console.warn('PDF page render failed', e)
      return
    }
    if (!(gen === this.generation || !slot.isConnected)) return
    slot.replaceChildren(canvas)
    // Invisible, selectable text on top of the picture (for copying and commenting).
    const text = document.createElement('div')
    text.className = 'textLayer'
    slot.appendChild(text)
    // Not awaited: the text layer can wait indefinitely while the PDF panel is hidden, and nothing
    // (compiling, opening a project) should be held up by it.
    new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp }).render().catch(() => {
      /* text selection is optional */
    })
  }

  /** Page and PDF-point coordinates under a screen position. */
  pointAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    const slot = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>('.pdf-page')
    if (!slot) return null
    const r = slot.getBoundingClientRect()
    return { page: Number(slot.dataset.page), x: (clientX - r.left) / this.scale, y: (clientY - r.top) / this.scale }
  }

  /** The text selected in the PDF, with the point where it starts. */
  selection(): { text: string; page: number; x: number; y: number; rect: DOMRect } | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!this.host.contains(range.commonAncestorContainer)) return null
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
    const hit = this.pointAt(rect.left + 2, rect.top + rect.height / 2)
    const text = sel.toString().replace(/\s+/g, ' ').trim()
    return hit && text ? { text, ...hit, rect: range.getBoundingClientRect() } : null
  }

  /** Scroll to a box (PDF points) and flash a highlight on it. */
  showBox(box: { page: number; x: number; y: number; w: number; h: number }): void {
    const slot = this.host.querySelector<HTMLElement>(`.pdf-page[data-page="${box.page}"]`)
    if (!slot) return
    const mark = document.createElement('div')
    mark.className = 'pdf-flash'
    Object.assign(mark.style, {
      left: `${box.x * this.scale - 4}px`,
      top: `${box.y * this.scale - 3}px`,
      width: `${Math.max(box.w, 30) * this.scale + 8}px`,
      height: `${Math.max(box.h, 8) * this.scale + 6}px`
    })
    slot.appendChild(mark)
    const top = slot.offsetTop + box.y * this.scale - this.host.clientHeight / 3
    this.host.scrollTo({ top, behavior: 'smooth' })
    setTimeout(() => mark.remove(), 1600)
  }

  clear(): void {
    this.task?.destroy()
    this.task = null
    this.doc = null
    this.host.innerHTML = '<div class="pdf-empty">Compile to see the PDF here.</div>'
    this.pagesLabel.textContent = ''
  }
}
