// IPC for File → Export Review PDF… (see review-pdf-build.ts, which does the work). The builder is
// loaded only when an export starts, so this feature costs nothing until it's used.
import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, shell } from 'electron'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import type { Project } from './project'
import { loadSettings } from './settings'
import { detectTex } from './tex'
import { isTinyTex } from './tinytex'
import type { ReviewRequest, ReviewResult } from './review-pdf-build'

const ENGINES = ['pdflatex', 'xelatex', 'lualatex']

export function registerReviewPdfIpc(need: (e: IpcMainInvokeEvent) => Project): void {
  const chosen = new Map<number, string>() // per window: where the PDF goes
  const defaultOut = (p: Project): string => join(p.root, `${basename(p.root).replace(/[\\/:*?"<>|]+/g, '-') || 'paper'}-review.pdf`)

  /** The dialog opened: start from the default file name. */
  ipcMain.handle('review:start', (e) => {
    const out = defaultOut(need(e))
    chosen.set(e.sender.id, out)
    return out
  })
  ipcMain.handle('review:choose', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Export Review PDF', buttonLabel: 'Choose', defaultPath: chosen.get(e.sender.id) ?? defaultOut(need(e)), filters: [{ name: 'PDF', extensions: ['pdf'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const file = /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`
    chosen.set(e.sender.id, file)
    return file
  })
  /** Whether latexdiff can be used, and whether OpenTex could install it (TinyTeX only). */
  ipcMain.handle('review:latexdiff', async () => {
    const tex = detectTex((await loadSettings()).texPath)
    if (!tex.binDir) return { available: false, canInstall: false }
    const { latexdiffPath } = await import('./review-pdf-build')
    return { available: Boolean(await latexdiffPath(tex.binDir)), canInstall: isTinyTex(tex.binDir) }
  })
  ipcMain.handle('review:build', async (e, req: ReviewRequest): Promise<ReviewResult | { ok: false; error: string }> => {
    const out = chosen.get(e.sender.id)
    if (!out) return { ok: false, error: 'Choose where to save the PDF first.' }
    const s = await loadSettings()
    const tex = detectTex(s.texPath)
    if (!tex.found || !tex.binDir) return { ok: false, error: 'No TeX installation was found, so OpenTex can’t make PDFs yet. Install TinyTeX (File menu) or MacTeX/MiKTeX, then try again.' }
    const engine = ENGINES.includes(req.engine) ? req.engine : s.engine
    const { buildReviewPdf } = await import('./review-pdf-build')
    return buildReviewPdf(need(e), { ...req, engine, comments: Array.isArray(req.comments) ? req.comments : [] }, out, tex, s.useLatexmk, (line) => !e.sender.isDestroyed() && e.sender.send('tex:progress', line))
  })
  ipcMain.handle('review:reveal', (e) => {
    const out = chosen.get(e.sender.id)
    if (out && existsSync(out)) shell.showItemInFolder(out)
  })
}
