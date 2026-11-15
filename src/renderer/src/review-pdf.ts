// File → Export Review PDF…: a PDF for co-authors and supervisors, with the comments as notes in the
// margin and, optionally, the changes since an earlier version marked. The copy is marked up and
// compiled by the main process (src/main/review-pdf-build.ts); this file asks the questions and
// reports the result. It is loaded only when the command is used.
import type { ProjectInfo, TreeNode } from '../../shared/types'
import type { OpenTexApi } from '../../preload/index'
import type { ChangedFile, Session, Version } from '../../shared/history'
import { when } from './history'
import { COMMENTS_FILE, locate, StoreFile, Thread } from './review'
import './review-pdf.css'

const api = (window as unknown as { opentex: OpenTexApi }).opentex

export interface ReviewHost {
  project: () => ProjectInfo | null
  saveAll: () => Promise<void>
  withProgress: (title: string, task: () => Promise<boolean>) => Promise<boolean>
  modal: (html: string, setup?: (d: HTMLDialogElement) => void) => Promise<string>
  ask: (message: string, buttons: string[], primary?: number) => Promise<number>
  log: (line: string) => void
  engine: () => string
  sessions: () => Session[]
}

interface Result {
  ok: boolean
  out: string
  error?: string
  details?: string[]
  pages: number
  comments: number
  commentsMissed: number
  changeMode: 'none' | 'latexdiff' | 'words'
  changedFiles: number
  changeNotes: number
  notesAtEnd: number
  leftOut: ('changes' | 'highlights' | 'comments')[]
  paperErrors: boolean
  ms: number
}

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const lower = (s: string): string => s.replace(/^(Just now|Today|Yesterday)/, (m) => m.toLowerCase())
/** A time for the PDF, which is read later: "today, 3:12 PM" rather than "5 min ago". */
const clock = (t: number): string => (/ago$|^Just now/.test(when(t)) ? `today, ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : lower(when(t)))
const DISK = new Set(['save', 'auto', 'outside', 'open'])
const SOURCE: Record<string, string> = { save: 'saved by you', auto: 'saved automatically', outside: 'changed outside OpenTex', open: 'when OpenTex first opened it' }

async function readThreads(): Promise<Thread[]> {
  try {
    const store = JSON.parse(await api.readFile(COMMENTS_FILE)) as StoreFile
    return Array.isArray(store.threads) ? store.threads : []
  } catch {
    return []
  }
}

function texFiles(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) texFiles(n.children ?? [], out)
    else if (/\.tex$/i.test(n.name)) out.push(n.path)
  }
  return out
}

/** Saved versions of the project's .tex files, newest first, for "since a saved version". */
async function savedVersions(project: ProjectInfo): Promise<(Version & { path: string })[]> {
  const files = texFiles(project.tree).slice(0, 200)
  const lists = await Promise.all(files.map((f) => api.history('list', f).then((vs: Version[]) => vs.map((v) => ({ ...v, path: f })), () => [])))
  return lists
    .flat()
    .filter((v) => DISK.has(v.src))
    .sort((a, b) => b.t - a.t)
    .slice(0, 100)
}

export async function exportReviewPdf(host: ReviewHost): Promise<void> {
  const project = host.project()
  if (!project) {
    await host.ask('Open your paper’s folder first (File → Open Folder…), then export a review PDF.', ['OK'])
    return
  }
  const mainFile = project.mainFile
  if (!mainFile) {
    await host.ask('OpenTex couldn’t tell which .tex file is the main one. Open it and choose it under “Main file” in the status bar, then export again.', ['OK'])
    return
  }
  await host.saveAll() // export what's on screen, and bring the comments file up to date
  const threads = await readThreads()
  const open = threads.filter((t) => !t.resolved).length
  const resolved = threads.length - open
  const sessions = host.sessions()
  const lastOpen = sessions[0]?.end
  let out = (await api.reviewPdf('start')) as string

  let withComments = threads.length > 0
  let withResolved = false
  let withChanges = false
  let since = NaN
  const pad = (n: number): string => String(n).padStart(2, '0')
  const local = (t: number): string => {
    const x = new Date(t)
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`
  }

  const go = await host.modal(
    `<div class="modal-body import review-pdf"><p><b>Export Review PDF</b></p>
     <p>A PDF of <code data-main></code> to send to co-authors or your supervisor. They can read it and print it without installing anything. Your files aren’t changed.</p>
     <div class="rp-opts">
       <label><input type="checkbox" data-comments /> <span data-comments-label></span></label>
       <label class="rp-sub"><input type="checkbox" data-resolved /> <span data-resolved-label></span></label>
       <label><input type="checkbox" data-changes /> Mark changes since…</label>
       <div class="rp-sub rp-since" data-since-box>
         <select data-since>
           ${lastOpen ? `<option value="session">the last time I had this project open (${esc(lower(when(lastOpen)))})</option>` : ''}
           <option value="time">a date and time…</option>
           <option value="version">a saved version…</option>
         </select>
         <input type="datetime-local" data-time class="hidden" />
         <select data-version class="hidden"><option value="">Loading versions…</option></select>
         <p class="hint">Added words are underlined in blue and removed words struck through in red. Changes inside equations, tables and figures get a “Changed here” note in the margin.</p>
       </div>
     </div>
     <p class="rp-save">Save as <code data-out></code> <button data-change>Change…</button></p></div>
     <div class="modal-actions"><button data-value="">Cancel</button><button class="primary" data-value="go">Export</button></div>`,
    (d) => {
      d.querySelector('[data-main]')!.textContent = mainFile
      const outEl = d.querySelector<HTMLElement>('[data-out]')!
      const showOut = (): void => {
        outEl.textContent = out.startsWith(project.root) ? out.slice(project.root.length + 1) : out
        outEl.title = out
      }
      showOut()
      const cb = d.querySelector<HTMLInputElement>('[data-comments]')!
      const rb = d.querySelector<HTMLInputElement>('[data-resolved]')!
      const chb = d.querySelector<HTMLInputElement>('[data-changes]')!
      const box = d.querySelector<HTMLElement>('[data-since-box]')!
      const pick = d.querySelector<HTMLSelectElement>('[data-since]')!
      const time = d.querySelector<HTMLInputElement>('[data-time]')!
      const ver = d.querySelector<HTMLSelectElement>('[data-version]')!
      d.querySelector('[data-comments-label]')!.textContent = threads.length ? `Include comments (${plural(open, 'open comment')})` : 'No comments to include'
      d.querySelector('[data-resolved-label]')!.textContent = `Include resolved comments${resolved ? ` (${resolved})` : ''}`
      cb.checked = withComments
      cb.disabled = !threads.length
      const sync = (): void => {
        withComments = cb.checked
        withResolved = rb.checked
        withChanges = chb.checked
        rb.disabled = !withComments || !resolved
        box.classList.toggle('off', !withChanges)
        box.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, input').forEach((el) => (el.disabled = !withChanges))
        time.classList.toggle('hidden', pick.value !== 'time')
        ver.classList.toggle('hidden', pick.value !== 'version')
        since = pick.value === 'session' ? lastOpen! : pick.value === 'time' ? new Date(time.value).getTime() : Number(ver.value || NaN)
      }
      time.value = local(lastOpen ?? Date.now() - 24 * 3600 * 1000)
      let loaded = false
      pick.onchange = async () => {
        sync()
        if (pick.value === 'version' && !loaded) {
          loaded = true
          const vs = await savedVersions(project)
          ver.innerHTML = vs.length
            ? vs.map((v) => `<option value="${v.t}">${esc(when(v.t))} · ${esc(v.path)} (${SOURCE[v.src] ?? v.src})</option>`).join('')
            : '<option value="">No saved versions yet</option>'
          sync()
        }
      }
      cb.onchange = rb.onchange = chb.onchange = time.onchange = ver.onchange = sync
      sync()
      d.querySelector<HTMLButtonElement>('[data-change]')!.onclick = async () => {
        const chosen = (await api.reviewPdf('choose')) as string | null
        if (chosen) {
          out = chosen
          showOut()
        }
      }
    }
  )
  if (go !== 'go') return

  // Where each comment is in the saved files (the same matching OpenTex uses for its highlights).
  const comments: object[] = []
  let unplaced = 0
  if (withComments) {
    const texts = new Map<string, string | null>()
    const chosen = threads.filter((t) => withResolved || !t.resolved)
    for (const t of chosen) {
      if (!texts.has(t.file)) texts.set(t.file, await api.readFile(t.file).catch(() => null))
      const text = texts.get(t.file)
      const at = text != null ? locate(text, t) : null
      if (!at) {
        unplaced++
        continue
      }
      comments.push({ file: t.file, from: at.from, to: at.to, quote: text!.slice(at.from, at.to), author: t.author, date: t.date, text: t.text, replies: t.replies ?? [], resolved: t.resolved })
    }
    // Number the notes in reading order within each file.
    comments.sort((a, b) => {
      const x = a as { file: string; from: number }
      const y = b as { file: string; from: number }
      return x.file === y.file ? x.from - y.from : x.file === mainFile ? -1 : y.file === mainFile ? 1 : x.file.localeCompare(y.file)
    })
  }

  // The changes: each changed .tex file as it was then.
  let changes: { label: string; files: { path: string; status: 'changed' | 'added'; old: string | null }[] } | null = null
  if (withChanges) {
    if (!Number.isFinite(since)) {
      await host.ask('Choose when to mark the changes from (a time, or a saved version), then export again.', ['OK'])
      return
    }
    const list: ChangedFile[] = await api.history('changesSince', since, {}).catch(() => [])
    const files: { path: string; status: 'changed' | 'added'; old: string | null }[] = []
    for (const f of list) {
      if (!/\.tex$/i.test(f.path) || f.status === 'deleted') continue
      if (f.status === 'added') files.push({ path: f.path, status: 'added', old: null })
      else if (f.base) files.push({ path: f.path, status: 'changed', old: await api.history('read', f.base.hash).catch(() => null) })
    }
    changes = { label: clock(since), files: files.filter((f) => f.status === 'added' || f.old !== null) }
    if (!changes.files.length) {
      const r = await host.ask(`Nothing in the paper’s .tex files has changed since ${changes.label}. Export without change marks?`, ['Export', 'Cancel'])
      if (r !== 0) return
      changes = null
    } else {
      const ld = (await api.reviewPdf('latexdiff').catch(() => null)) as { available: boolean; canInstall: boolean } | null
      if (ld && !ld.available && ld.canInstall) {
        const r = await host.ask(
          'latexdiff marks changes more precisely than OpenTex’s own marking, especially in equations and tables. It isn’t installed in your TinyTeX yet. Install it now (a small download from TeX Live)?',
          ['Install latexdiff', 'Use OpenTex’s marking'],
          1
        )
        if (r === 0) await host.withProgress('Installing latexdiff', () => api.installMissing(['latexdiff.pl']))
      }
    }
  }

  let res: Result | null = null
  const ok = await host.withProgress(`Making ${fileName(out)}`, async () => {
    try {
      res = (await api.reviewPdf('build', { mainFile, engine: host.engine(), comments, changes })) as Result
    } catch (e) {
      host.log((e as Error).message.replace(/^.*Error: /, ''))
      return false
    }
    if (!res.ok) {
      host.log(`\n${res.error ?? 'The export did not finish.'}`)
      for (const d of res.details ?? []) host.log(`  ${d}`)
      return false
    }
    host.log(`Done in ${(res.ms / 1000).toFixed(1)} s.`)
    return true
  })
  const r = res as Result | null
  if (!ok || !r?.ok) return

  let msg = `Saved ${fileName(r.out)}${r.pages ? ` (${plural(r.pages, 'page')})` : ''}.`
  if (withComments) {
    msg += r.comments ? ` ${plural(r.comments, 'comment')} ${r.comments === 1 ? 'is' : 'are'} in the margin.` : ''
    const missed = r.commentsMissed + unplaced
    if (r.notesAtEnd) msg += ` ${plural(r.notesAtEnd, 'comment')} didn’t fit beside ${r.notesAtEnd === 1 ? 'its' : 'their'} page and ${r.notesAtEnd === 1 ? 'is' : 'are'} listed at the end of the PDF.`
    if (missed) msg += `\n\n${plural(missed, 'comment')} couldn’t be placed: the text ${missed === 1 ? 'it points' : 'they point'} to has changed, isn’t part of the paper, or is in the preamble.`
  }
  if (changes && r.changeMode !== 'none') {
    msg += `\n\nChanges since ${changes.label} are marked in ${plural(r.changedFiles, 'file')}: added words underlined in blue, removed words struck through in red${r.changeMode === 'latexdiff' ? ' (by latexdiff)' : ''}.`
    if (r.changeNotes) msg += ` ${plural(r.changeNotes, 'change')} inside equations, tables, figures or commands ${r.changeNotes === 1 ? 'has' : 'have'} a “Changed here” note instead.`
  }
  if (r.leftOut.includes('changes')) msg += '\n\nThe change marks clashed with something in this paper, so they were left out.'
  if (r.leftOut.includes('comments')) msg += '\n\nThe margin notes clashed with something in this paper, so this PDF is the paper without its comments.'
  else if (r.leftOut.includes('highlights')) msg += '\n\nHighlighting the commented text clashed with something in this paper, so the notes are in the margin without highlights.'
  if (r.paperErrors) msg += `\n\nThe paper has LaTeX errors of its own (the ones Compile shows), so parts of the PDF may look wrong.${r.details?.length ? `\n${r.details.join('\n')}` : ''}`
  if ((await host.ask(msg, ['Show in Folder', 'OK'], 0)) === 0) await api.reviewPdf('reveal')
}
