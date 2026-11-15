// Live preview: the PDF follows your typing, like Word, with no Compile-and-wait.
//
// About 0.7 s after you pause typing in a .tex or .bib file (2 s on battery), the current text,
// saved or not, is built in the background into a private folder (src/main/live-preview.ts).
// A good build swaps in quietly at the same scroll position and briefly marks the edited line; a
// failed one keeps the last good PDF and shows "Paused: error on line N". Nothing runs while the
// window or the PDF panel is hidden, and the Compile button still does a full, normal compile.
import './live-preview.css'
import type { EditorView } from '@codemirror/view'
import type { Engine } from '../../shared/types'
import type { LiveResult } from '../../shared/live-preview'
import type { OpenTexApi } from '../../preload/index'
import type { PdfView } from './pdfview'

export interface LiveHost {
  api: OpenTexApi
  view: EditorView
  pdf: PdfView
  pdfEl: HTMLElement
  enabled(): boolean
  active(): string | null
  target(): string | null // what Compile would build
  engine(): Engine
  /** Unsaved .tex/.bib/... files with their current text. */
  edits(): { path: string; text: string }[]
  compiling(): boolean
  pdfVisible(): boolean
  jump(file: string, line: number): void
}

export interface LivePreview {
  /** Every edit in the editor (cheap: only notes the time). */
  edited(): void
  /** A full Compile is starting: stop the background build, its result would be older. */
  compileStarting(): void
  /** The PDF of the project folder is shown again (after Compile, or switching files). */
  projectPdfShown(): void
  /** While a live PDF is shown, SyncTeX must look in the live build. */
  showing(): boolean
  settingsChanged(): void
}

const QUIET_MS = 250 // don't start drawing a new PDF until typing has paused this long

export function setupLivePreview(h: LiveHost): LivePreview {
  let lastEdit = 0
  let timer = 0
  let stale = false // the text changed since the last background build started
  let building = false
  let followUp = false // one extra pass for changed cross-references
  let onBattery = false
  let showingLive = false
  let builds = 0
  const delay = (): number => (onBattery ? 2000 : 700)
  void h.api.live.onBattery().then((b) => (onBattery = b)).catch(() => {})
  h.api.live.onPower((b) => (onBattery = b))

  const chip = document.createElement('button')
  chip.className = 'live-chip'
  chip.hidden = true
  let chipTarget: { file: string; line: number } | null = null
  chip.onclick = () => chipTarget && h.jump(chipTarget.file, chipTarget.line)

  function arm(ms: number): void {
    if (!timer) timer = window.setTimeout(tick, Math.max(0, ms))
  }

  function tick(): void {
    timer = 0
    const wait = lastEdit + delay() - performance.now()
    if (wait > 10) return arm(wait)
    void run()
  }

  /** Builds only while someone can see the result. resume() picks up when that changes. */
  function canRun(): boolean {
    return h.enabled() && !document.hidden && h.pdfVisible() && h.pdfEl.clientWidth > 0
  }

  function resume(): void {
    if (stale && canRun() && !building) arm(0)
  }

  async function run(): Promise<void> {
    if (!stale || building || !canRun()) return
    if (h.compiling()) return arm(1000) // the full compile wins; look again shortly
    const target = h.target()
    if (!target || !/\.tex$/i.test(target)) return
    stale = false
    building = true
    const file = h.active()
    const line = h.view.state.doc.lineAt(h.view.state.selection.main.head).number
    let r: LiveResult | null = null
    try {
      r = await h.api.live.build({ target, engine: h.engine(), files: h.edits() })
    } catch (e) {
      console.warn('Live preview build failed', e)
    }
    if (r) await show(r, file, line).catch((e) => console.warn('Live preview could not show the PDF', e))
    building = false // only now, so an older PDF can never be drawn over a newer one
    if (stale && r?.skipped !== 'hidden') arm(lastEdit + delay() - performance.now())
    else if (r?.ok && r.rerun && !followUp) {
      followUp = true
      stale = true
      arm(delay())
    }
  }

  async function show(r: LiveResult, file: string | null, line: number): Promise<void> {
    if (r.skipped === 'hidden') stale = true // build when the window is back (resume)
    if (r.cancelled || r.skipped) return
    if (!h.enabled()) return
    if (r.ok && r.pdf) {
      // Never draw in the middle of a burst of typing.
      while (performance.now() - lastEdit < QUIET_MS) await new Promise((res) => setTimeout(res, QUIET_MS))
      showingLive = true
      await h.pdf.load(r.pdf)
      setChip(null)
      builds++
      Object.assign(h.pdfEl.dataset, { liveBuilds: String(builds), liveMs: String(r.ms), livePasses: String(r.passes), liveShownAt: String(Date.now()) })
      if (file && /\.tex$/i.test(file)) void flash(file, line)
    } else if (r.error) {
      setChip(r.error)
      h.pdfEl.dataset.liveErrors = String(Number(h.pdfEl.dataset.liveErrors ?? 0) + 1)
    }
  }

  function setChip(err: LiveResult['error'] | null): void {
    if (!err) {
      chip.hidden = true
      chipTarget = null
      return
    }
    const where = err.line ? (err.file && err.file !== h.active() ? ` in ${err.file.split('/').pop()}, line ${err.line}` : ` on line ${err.line}`) : ''
    chip.textContent = `Paused: error${where}`
    chip.title = `${err.message}\n\nThe PDF shows your last version that worked. It updates again as soon as this is fixed.${err.line ? ' Click to go to the line.' : ''}`
    chipTarget = err.file && err.line ? { file: err.file, line: err.line } : null
    chip.classList.toggle('clickable', !!chipTarget)
    const host = h.pdfEl.parentElement
    if (host && chip.parentElement !== host) {
      host.classList.add('live-host')
      host.appendChild(chip)
    }
    chip.hidden = false
  }

  /** Briefly mark where the edited line landed, without moving the PDF. */
  async function flash(file: string, line: number): Promise<void> {
    const box = await h.api.live.forward(file, line).catch(() => null)
    if (!box) return
    const slot = h.pdfEl.querySelector<HTMLElement>(`.pdf-page[data-page="${box.page}"]`)
    const scale = parseFloat(slot?.style.getPropertyValue('--scale-factor') ?? '')
    if (!slot || !scale) return
    const mark = document.createElement('div')
    mark.className = 'live-flash'
    Object.assign(mark.style, {
      left: `${Math.max(0, box.x * scale - 6)}px`,
      top: `${box.y * scale - 3}px`,
      width: `${Math.max(box.w, 40) * scale + 12}px`,
      height: `${Math.max(box.h, 8) * scale + 6}px`
    })
    slot.appendChild(mark)
    setTimeout(() => mark.remove(), 1300)
  }

  document.addEventListener('visibilitychange', resume)
  new ResizeObserver(resume).observe(h.pdfEl) // the PDF panel was shown again

  return {
    edited() {
      if (!h.enabled()) return
      const a = h.active()
      if (!a || !/\.(tex|bib)$/i.test(a)) return
      lastEdit = performance.now()
      stale = true
      followUp = false
      arm(delay())
    },
    compileStarting() {
      stale = false
      clearTimeout(timer)
      timer = 0
      if (building) void h.api.live.cancel()
    },
    projectPdfShown() {
      showingLive = false
      setChip(null)
    },
    showing: () => showingLive,
    settingsChanged() {
      if (h.enabled()) return
      clearTimeout(timer)
      timer = 0
      stale = false
      setChip(null)
      if (building) void h.api.live.cancel()
    }
  }
}
