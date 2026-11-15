// File → Export to Word…: the paper (main file and everything it includes, with figures,
// equations, citations and comments) as one .docx. The work is done by Pandoc in the main
// process (src/main/word-export.ts); this file asks the questions and reports the result.
import type { ProjectInfo } from '../../shared/types'
import type { OpenTexApi } from '../../preload/index'
import { COMMENTS_FILE, locate, StoreFile, Thread } from './review'
import './word-export.css'

const api = (window as unknown as { opentex: OpenTexApi }).opentex

export interface ExportHost {
  project: () => ProjectInfo | null
  saveAll: () => Promise<void>
  ensurePandoc: () => Promise<boolean>
  withProgress: (title: string, task: () => Promise<boolean>) => Promise<boolean>
  modal: (html: string, setup?: (d: HTMLDialogElement) => void) => Promise<string>
  ask: (message: string, buttons: string[], primary?: number) => Promise<number>
  log: (line: string) => void // a line in the progress dialog
}

interface Result {
  ok: boolean
  out: string
  log: string
  comments: number
  commentsMissed: number
  figures: number
  missingFigures: string[]
  citations: 'text' | 'none' | 'no-bib'
  error?: string
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p

async function readThreads(): Promise<Thread[]> {
  try {
    const store = JSON.parse(await api.readFile(COMMENTS_FILE)) as StoreFile
    return Array.isArray(store.threads) ? store.threads : []
  } catch {
    return [] // no comments file
  }
}

export async function exportToWord(host: ExportHost): Promise<void> {
  const project = host.project()
  if (!project) {
    await host.ask('Open your paper’s folder first (File → Open Folder…), then export it to Word.', ['OK'])
    return
  }
  const mainFile = project.mainFile
  if (!mainFile) {
    await host.ask('OpenTex couldn’t tell which .tex file is the main one. Open it and choose it under “Main file” in the status bar, then export again.', ['OK'])
    return
  }
  await host.saveAll() // export what's on screen, and bring the comments file up to date
  const open = (await readThreads()).filter((t) => !t.resolved)
  let withComments = open.length > 0
  const go = await host.modal(
    `<div class="modal-body import word-export"><p><b>Export to Word</b></p>
     <p>OpenTex makes one Word file from <code data-main></code> and everything it includes, with its figures, equations and tables. Citations and the reference list become ordinary text. Your <code>.tex</code> files aren’t changed.</p>
     <p><label><input type="checkbox" data-comments ${withComments ? 'checked' : 'disabled'} /> <span data-comments-label></span></label></p>
     <p class="hint">Word can’t do everything LaTeX does, so look over the result, especially tables, figure placement and equation numbers. Journal templates and page layout aren’t carried over.</p></div>
     <div class="modal-actions"><button data-value="">Cancel</button><button class="primary" data-value="go">Export…</button></div>`,
    (d) => {
      d.querySelector('[data-main]')!.textContent = mainFile
      d.querySelector('[data-comments-label]')!.textContent = open.length
        ? `Include ${plural(open.length, 'comment')} as Word comments (resolved ones are left out)`
        : 'No open comments to include'
      const cb = d.querySelector<HTMLInputElement>('[data-comments]')!
      cb.onchange = () => (withComments = cb.checked)
    }
  )
  if (go !== 'go') return
  if (!(await host.ensurePandoc())) return
  const out = await api.exportWordChoose()
  if (!out) return

  // Where each comment is in the saved files (the same matching OpenTex uses for its highlights).
  const comments: object[] = []
  let unplaced = 0
  if (withComments) {
    const texts = new Map<string, string | null>()
    for (const t of open) {
      if (!texts.has(t.file)) texts.set(t.file, await api.readFile(t.file).catch(() => null))
      const text = texts.get(t.file)
      const at = text != null ? locate(text, t) : null
      if (!at) {
        unplaced++
        continue
      }
      comments.push({ file: t.file, from: at.from, to: at.to, author: t.author, date: t.date, text: t.text, replies: t.replies ?? [] })
    }
  }

  let res: Result | null = null
  const ok = await host.withProgress(`Exporting ${fileName(out)}`, async () => {
    try {
      res = (await api.exportWord(mainFile, comments)) as Result
    } catch (e) {
      host.log((e as Error).message.replace(/^.*Error: /, ''))
      return false
    }
    if (!res.ok) {
      host.log(res.error ?? 'The export did not finish.')
      if (res.log) host.log(`\n${res.log}`)
      return false
    }
    host.log(`Saved ${res.out}`)
    return true
  })
  const r = res as Result | null
  if (!ok || !r?.ok) return

  const parts = [plural(r.figures, 'figure')]
  if (withComments) parts.push(plural(r.comments, 'comment'))
  let msg = `Saved ${fileName(r.out)} with ${parts.join(' and ')}.`
  if (r.citations === 'text') msg += ' Citations and the reference list are written out as text.'
  if (r.citations === 'no-bib') msg += '\n\nThe paper cites references, but no .bib file was found, so the citations show their keys instead.'
  const missed = r.commentsMissed + unplaced
  if (withComments && missed) msg += `\n\n${plural(missed, 'comment')} couldn’t be placed in the Word file (the text they point to has changed or isn’t part of the paper).`
  if (r.missingFigures.length) msg += `\n\nThese pictures couldn’t be included: ${r.missingFigures.join(', ')}. Word shows PNG and JPEG pictures; save a PNG copy next to each one and export again.`
  if (await host.ask(msg, ['Show in Folder', 'OK'], 0) === 0) await api.revealExport()
}
