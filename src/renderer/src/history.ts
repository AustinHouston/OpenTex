// Saving automatically, crash recovery and version history (File → History…).
// The versions and recovery copies are kept by the main process (src/main/history.ts) in OpenTex's
// own folder, never in the project folder.

import './history.css'
import type { ChangeSpec, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ProjectInfo, Settings } from '../../shared/types'
import { ChangedFile, countChanges, diffLines, diffSeq, diffWords, HISTORY_EXT, Session, Version, VersionSource } from '../../shared/history'
import { ask } from './ui'

interface OpenFileLike {
  path: string
  state: EditorState
  saved: string
  dirty: boolean
}

export interface HistoryHost {
  api: {
    history: (op: string, ...args: unknown[]) => Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
    readFile: (rel: string) => Promise<string>
    writeFile: (rel: string, text: string) => Promise<void>
  }
  view: EditorView
  files: Map<string, OpenFileLike>
  active: () => string | null
  project: () => ProjectInfo | null
  settings: () => Settings
  openFile: (path: string) => Promise<void>
  /** Save without compiling. */
  autoSave: (path: string) => Promise<void>
  renderTabs: () => void
  reloadTree: () => Promise<void>
  status: (text: string, cls?: string) => void
}

const AUTOSAVE_MS = 2000
const RECOVERY_MS = 20000
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const SOURCE: Record<VersionSource, string> = {
  save: 'Saved by you',
  auto: 'Saved automatically',
  outside: 'Changed outside OpenTex',
  design: 'Before a Design change',
  restore: 'Before you restored a version',
  open: 'When OpenTex first opened it'
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** "Just now", "12 min ago", "Today, 3:12 PM", "Yesterday, …", "Tuesday, …", "4 Nov, …". */
export function when(t: number): string {
  const now = Date.now()
  if (now - t < 45000) return 'Just now'
  if (now - t < HOUR) return `${Math.max(1, Math.round((now - t) / 60000))} min ago`
  const d = new Date(t)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(new Date(now)) - day(d)) / DAY)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })}, ${time}`
  const year = d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric'
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short', year })}, ${time}`
}
const whenInline = (t: number): string => when(t).replace(/^(Just now|Today|Yesterday)/, (m) => m.toLowerCase())

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The smallest set of whole-line edits that turns `from` into `to`, so the cursor, comments and Undo behave. */
function lineChanges(from: string, to: string): ChangeSpec[] {
  const split = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const a = split(from)
  const b = split(to)
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) ids.set(s, (v = ids.size))
    return v
  }
  const runs = diffSeq(Int32Array.from(a, id), Int32Array.from(b, id), 4000)
  const off = [0]
  for (const l of a) off.push(off[off.length - 1] + l.length)
  const out: ChangeSpec[] = []
  let ai = 0
  let bi = 0
  for (let i = 0; i < runs.length; ) {
    if (runs[i].kind === 'eq') {
      ai += runs[i].n
      bi += runs[i].n
      i++
      continue
    }
    const a0 = ai
    const b0 = bi
    for (; i < runs.length && runs[i].kind !== 'eq'; i++) {
      if (runs[i].kind === 'del') ai += runs[i].n
      else bi += runs[i].n
    }
    out.push({ from: off[a0], to: off[ai], insert: b.slice(b0, bi).join('') })
  }
  return out
}

// ---------- Diff view ----------
const MAX_ROWS = 4000

function row(cls: string, na: number | '', nb: number | '', sign: string, html: string): string {
  return `<div class="hd-row ${cls}"><span class="hd-n">${na}</span><span class="hd-n">${nb}</span><span class="hd-s">${sign}</span><span class="hd-t">${html || ' '}</span></div>`
}
const marked = (parts: [string, boolean][]): string => parts.map(([t, ch]) => (ch && t.trim() ? `<mark>${esc(t)}</mark>` : esc(t))).join('')

/** Draw a readable line diff: added and removed lines highlighted, long unchanged stretches folded. */
function renderDiff(el: HTMLElement, oldText: string, newText: string, ctx = 3): { added: number; removed: number } {
  const { a, b, runs } = diffLines(oldText, newText)
  const counts = countChanges(runs)
  if (!counts.added && !counts.removed) {
    el.innerHTML = `<div class="hd-same">No differences: the two texts are the same.</div>`
    return counts
  }
  const rows: string[] = []
  const hidden: string[] = []
  const eq = (i: number, j: number): string => row('hd-eq', i + 1, j + 1, '', esc(a[i]))
  for (let r = 0; r < runs.length && rows.length < MAX_ROWS; r++) {
    const run = runs[r]
    if (run.kind === 'eq') {
      const head = r === 0 ? 0 : ctx
      const tail = r === runs.length - 1 ? 0 : ctx
      if (run.n > head + tail + 2) {
        for (let k = 0; k < head; k++) rows.push(eq(run.a + k, run.b + k))
        const fold: string[] = []
        for (let k = head; k < run.n - tail; k++) fold.push(eq(run.a + k, run.b + k))
        hidden.push(fold.join(''))
        rows.push(`<button class="hd-gap" data-gap="${hidden.length - 1}">⋯ ${plural(run.n - head - tail, 'unchanged line')} · show</button>`)
        for (let k = run.n - tail; k < run.n; k++) rows.push(eq(run.a + k, run.b + k))
      } else for (let k = 0; k < run.n; k++) rows.push(eq(run.a + k, run.b + k))
      continue
    }
    // A block of changes: removed lines, then added lines. Lines that pair up get word highlights.
    const dels: number[] = []
    const inss: number[] = []
    for (; r < runs.length && runs[r].kind !== 'eq'; r++) {
      const x = runs[r]
      for (let k = 0; k < x.n; k++) (x.kind === 'del' ? dels : inss).push(x.kind === 'del' ? x.a + k : x.b + k)
    }
    r--
    const pairs = Math.min(dels.length, inss.length, 200)
    const words = Array.from({ length: pairs }, (_, k) => (a[dels[k]].length < 2000 && b[inss[k]].length < 2000 ? diffWords(a[dels[k]], b[inss[k]]) : null))
    dels.forEach((i, k) => rows.push(row('hd-del', i + 1, '', '−', words[k] ? marked(words[k]!.a) : esc(a[i]))))
    inss.forEach((j, k) => rows.push(row('hd-add', '', j + 1, '+', words[k] ? marked(words[k]!.b) : esc(b[j]))))
  }
  if (rows.length >= MAX_ROWS) rows.push(`<div class="hd-same">Only the first ${MAX_ROWS.toLocaleString()} lines of differences are shown.</div>`)
  el.innerHTML = rows.join('')
  el.onclick = (e) => {
    const gap = (e.target as HTMLElement).closest<HTMLElement>('[data-gap]')
    if (gap) gap.outerHTML = hidden[Number(gap.dataset.gap)]
  }
  el.scrollTop = 0
  return counts
}

// ---------- Setup ----------
export function setupHistory(h: HistoryHost) {
  const call = h.api.history
  const textOf = (p: string): string | null => (p === h.active() ? h.view.state.doc.toString() : (h.files.get(p)?.state.doc.toString() ?? null))
  const root = (): string | null => h.project()?.root ?? null

  // ----- Saving automatically -----
  const pending = new Set<string>()
  let saveTimer = 0
  function edited(): void {
    const p = h.active()
    if (!p) return
    pending.add(p)
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(flush, AUTOSAVE_MS)
  }
  async function flush(): Promise<void> {
    const list = [...pending]
    pending.clear()
    if (!h.settings().autoSave || !h.project()) return
    for (const p of list) {
      if (!h.files.get(p)?.dirty) continue
      try {
        await h.autoSave(p)
      } catch (e) {
        h.status(`Couldn’t save ${p} automatically: ${(e as Error).message.replace(/^.*Error: /, '')}`, 'err')
      }
    }
  }

  // ----- Crash recovery: unsaved text is copied aside every 20 seconds and when the window loses focus -----
  const recovered = new Map<string, string>() // path → text last copied aside
  let ticks = 0
  function tick(): void {
    const r = root()
    if (!r) return
    for (const [p, f] of h.files) {
      const text = f.dirty ? textOf(p) : null
      if (text === null) {
        if (recovered.delete(p)) void call('recoveryClear', r, p).catch(() => {})
        continue
      }
      if (recovered.get(p) === text) continue
      recovered.set(p, text)
      void call('recoveryWrite', r, p, text).catch(() => recovered.delete(p))
    }
    for (const p of [...recovered.keys()]) if (!h.files.has(p)) recovered.delete(p) && void call('recoveryClear', r, p).catch(() => {})
    if (++ticks % 3 === 0) void call('touch').catch(() => {})
  }
  window.setInterval(tick, RECOVERY_MS)
  window.addEventListener('blur', tick)

  /** Put text into an open file's editor as one undoable change, leaving it unsaved. */
  function replaceText(path: string, text: string): void {
    const f = h.files.get(path)
    if (!f) return
    const st = path === h.active() ? h.view.state : f.state
    const cur = st.doc.toString()
    const changes = cur.includes('\r') || text.includes('\r') ? [{ from: 0, to: cur.length, insert: text }] : lineChanges(cur, text)
    const tr = st.update({ changes, userEvent: 'input' })
    if (path === h.active()) h.view.dispatch(tr)
    else f.state = tr.state
    f.dirty = true
    pending.delete(path) // left for the user to look over and save; typing on saves it as usual
    h.renderTabs()
  }

  let sessions: Session[] = []
  let openedAt = Date.now()

  async function projectOpened(): Promise<void> {
    recovered.clear()
    pending.clear()
    openedAt = Date.now()
    sessions = await call('opened').catch(() => [])
    const r = root()
    const list: { path: string; t: number; text: string; missing: boolean }[] = await call('recoveryList').catch(() => [])
    if (!r || !list.length) return
    const names = list.map((x) => x.path).join(', ')
    const choice = await ask(
      `OpenTex closed before these changes were saved: ${names}. Restore puts them back in the editor as unsaved changes, so you can look them over and save them. Discard keeps the files as they are now.`,
      ['Restore', 'Discard']
    )
    if (choice === 1) await call('recoveryClear', r, null).catch(() => {})
    if (choice !== 0) return
    let n = 0
    for (const x of list) {
      if (x.missing) {
        await h.api.writeFile(x.path, '').catch(() => {})
        await h.reloadTree()
      }
      await h.openFile(x.path)
      if (!h.files.has(x.path)) continue
      replaceText(x.path, x.text)
      recovered.set(x.path, x.text)
      n++
    }
    if (n) h.status(`Restored unsaved changes in ${plural(n, 'file')}. Look them over, then press Ctrl/Cmd+S to save.`, 'warn')
  }

  // ----- History dialog -----
  let dlg: HTMLDialogElement | null = null
  const cache = new Map<string, string>()
  async function readVersion(hash: string): Promise<string> {
    let t = cache.get(hash)
    if (t === undefined) {
      t = (await call('read', hash)) as string
      cache.set(hash, t)
      if (cache.size > 40) cache.delete(cache.keys().next().value!)
    }
    return t
  }
  async function currentText(path: string): Promise<string | null> {
    return textOf(path) ?? (await h.api.readFile(path).catch(() => null))
  }

  function dialog(): HTMLDialogElement {
    if (!dlg) {
      dlg = document.createElement('dialog')
      dlg.className = 'hist'
      document.body.appendChild(dlg)
    }
    return dlg
  }
  function show(d: HTMLDialogElement): void {
    d.querySelector<HTMLButtonElement>('[data-act=close]')!.onclick = () => d.close()
    if (!d.open) d.showModal()
  }

  const layout = (head: string, bar: string): string => `
    <div class="pane-head">${head}<span class="spacer"></span><button class="link" data-act="close">Close</button></div>
    <div class="hist-body">
      <ul class="hist-list"></ul>
      <div class="hist-main">
        <div class="hist-bar">${bar}</div>
        <div class="hist-legend"></div>
        <div class="hist-diff"></div>
      </div>
    </div>`

  /** Restore a file to an earlier text, keeping what it had as a version first. */
  async function restore(path: string, text: string, label: string): Promise<void> {
    const name = path.split('/').pop()
    if (!h.files.has(path) && (await h.api.readFile(path).catch(() => null)) === null) {
      // The file was deleted: bring it back.
      await h.api.writeFile(path, text)
      await h.reloadTree()
      dlg?.close()
      await h.openFile(path)
      h.status(`Brought back ${name} as it was ${label}.`, 'ok')
      return
    }
    await h.openFile(path)
    if (!h.files.has(path)) return
    await call('snapshot', path, textOf(path), 'restore').catch(() => {})
    replaceText(path, text)
    dlg?.close()
    h.status(`Restored ${name} as it was ${label}. It isn’t saved yet: press Ctrl/Cmd+S to keep it, or Undo to go back.`, 'ok')
  }

  /** The history of one file. */
  async function openFileHistory(path: string): Promise<void> {
    if (!h.project()) return
    const d = dialog()
    d.innerHTML = layout(
      `<span>History of <b class="hist-name"></b></span><button class="link" data-act="since">What changed in the whole project…</button>`,
      `<div class="hist-info"></div><span class="spacer"></span>
       <label class="hist-cmp">Compare with <select><option value="now">your current text</option><option value="prev">the version before it</option></select></label>
       <button data-act="copy" title="Copy this version’s text">Copy text</button>
       <button class="primary" data-act="restore">Restore this version</button>`
    )
    d.querySelector('.hist-name')!.textContent = path
    d.querySelector<HTMLButtonElement>('[data-act=since]')!.onclick = () => openChanges()
    show(d)
    const list = d.querySelector<HTMLUListElement>('.hist-list')!
    const info = d.querySelector<HTMLElement>('.hist-info')!
    const legend = d.querySelector<HTMLElement>('.hist-legend')!
    const diffEl = d.querySelector<HTMLElement>('.hist-diff')!
    const cmp = d.querySelector<HTMLSelectElement>('.hist-cmp select')!
    const bar = d.querySelector<HTMLElement>('.hist-bar')!
    await call('checkDisk', [path]).catch(() => {}) // make sure the text on disk is a version (no-op if it is)
    const versions: Version[] = await call('list', path).catch(() => [])
    const now = await currentText(path)
    const nowHash = now === null ? '' : await sha1(now)
    if (!versions.length) {
      bar.classList.add('hidden')
      diffEl.innerHTML = `<div class="hd-same">No earlier versions yet. OpenTex keeps a version each time you save, and when the file is changed outside OpenTex.</div>`
      return
    }
    list.innerHTML = versions
      .map((v, i) => {
        const older = versions[i + 1]
        const dz = older ? v.size - older.size : 0
        const delta = !older ? 'First version' : dz === 0 ? 'Same size' : `${dz > 0 ? '+' : '−'}${plural(Math.abs(dz), 'character')}`
        return `<li data-i="${i}" title="${esc(new Date(v.t).toLocaleString())}">
          <div class="hv-when">${esc(when(v.t))}${v.hash === nowHash ? '<span class="hv-tag">Same as now</span>' : ''}</div>
          <div class="hv-meta"><span class="hv-src src-${v.src}">${SOURCE[v.src]}</span>${v.before ? `<span class="hv-src src-${v.before}">${SOURCE[v.before]}</span>` : ''}<span>${delta}</span></div></li>`
      })
      .join('')
    let sel = 0
    let seq = 0
    const select = async (i: number): Promise<void> => {
      sel = i
      const my = ++seq
      list.querySelectorAll('li').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === i))
      const v = versions[i]
      const prev = cmp.value === 'prev'
      const older = versions[i + 1]
      cmp.querySelector<HTMLOptionElement>('[value=prev]')!.disabled = !older
      diffEl.innerHTML = '<div class="hd-same">Loading…</div>'
      const text = await readVersion(v.hash).catch(() => null)
      const base = prev ? (older ? await readVersion(older.hash).catch(() => '') : '') : text
      if (my !== seq) return
      if (text === null) {
        diffEl.innerHTML = '<div class="hd-same">This version couldn’t be read.</div>'
        return
      }
      const c = prev ? renderDiff(diffEl, base ?? '', text) : renderDiff(diffEl, text, now ?? '')
      const changes = `${plural(c.added, 'line')} added, ${plural(c.removed, 'line')} removed`
      info.innerHTML = `<b>${esc(when(v.t))}</b> · ${SOURCE[v.src]}${v.before ? ` · ${SOURCE[v.before]}` : ''}<br><span class="muted"></span>`
      info.querySelector('span')!.textContent = prev
        ? `In this version, compared with the one before it: ${changes}.`
        : now === null
          ? 'This file no longer exists. Restore brings it back.'
          : c.added || c.removed
            ? `Since this version: ${changes}.`
            : 'Your current text is the same as this version.'
      legend.innerHTML = prev
        ? '<span class="lg-add">Green</span> lines were added in this version, <span class="lg-del">red</span> lines were removed.'
        : '<span class="lg-add">Green</span> lines are in your current text but not in this version; <span class="lg-del">red</span> lines were in this version and aren’t now.'
    }
    list.onclick = (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li')
      if (li) void select(Number(li.dataset.i))
    }
    list.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      void select(Math.max(0, Math.min(versions.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))))
      list.querySelector('li.on')?.scrollIntoView({ block: 'nearest' })
    }
    list.tabIndex = 0
    cmp.onchange = () => void select(sel)
    d.querySelector<HTMLButtonElement>('[data-act=copy]')!.onclick = async () => {
      await navigator.clipboard.writeText(await readVersion(versions[sel].hash))
      h.status(`Copied the text of ${path} as it was ${whenInline(versions[sel].t)}`, 'ok')
    }
    d.querySelector<HTMLButtonElement>('[data-act=restore]')!.onclick = async () => {
      const v = versions[sel]
      await restore(path, await readVersion(v.hash), whenInline(v.t))
    }
    // Start with the newest version that differs from the current text.
    const first = versions.findIndex((v) => v.hash !== nowHash)
    await select(first < 0 ? 0 : first)
  }

  /** Which files changed in the project since a chosen time. */
  async function openChanges(): Promise<void> {
    if (!h.project()) return
    const d = dialog()
    d.innerHTML = layout(
      `<span>What changed in this project</span><select class="since-pick"></select><input type="datetime-local" class="since-custom hidden" />`,
      `<div class="hist-info"></div><span class="spacer"></span>
       <button data-act="open">Open file</button>
       <button data-act="history">Show this file’s history</button>`
    )
    show(d)
    const pick = d.querySelector<HTMLSelectElement>('.since-pick')!
    const custom = d.querySelector<HTMLInputElement>('.since-custom')!
    const list = d.querySelector<HTMLUListElement>('.hist-list')!
    const info = d.querySelector<HTMLElement>('.hist-info')!
    const legend = d.querySelector<HTMLElement>('.hist-legend')!
    const diffEl = d.querySelector<HTMLElement>('.hist-diff')!
    const bar = d.querySelector<HTMLElement>('.hist-bar')!
    const now = Date.now()
    const today = new Date(new Date().toDateString()).getTime()
    const opts: [string, number][] = []
    if (sessions[0]) opts.push([`Since I last had it open (${whenInline(sessions[0].end)})`, sessions[0].end])
    opts.push(['In the last hour', now - HOUR], ['Since the start of today', today], ['Since yesterday morning', today - DAY], ['In the last 7 days', now - 7 * DAY], ['In the last 30 days', now - 30 * DAY])
    for (const s of sessions.slice(1, 10)) opts.push([`Since I opened it ${whenInline(s.start)}`, s.start])
    opts.push(['Pick a date and time…', -1])
    pick.innerHTML = opts.map(([label, t], i) => `<option value="${i}" data-t="${t}">${esc(label)}</option>`).join('')
    const pad = (n: number): string => String(n).padStart(2, '0')
    const local = (t: number): string => {
      const x = new Date(t)
      return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`
    }
    custom.value = local(today)
    const historyStart = sessions.length ? sessions[sessions.length - 1].start : openedAt
    let current: ChangedFile[] = []
    let sel = -1
    let since = 0
    let seq = 0
    let note = ''

    const showFile = async (i: number): Promise<void> => {
      sel = i
      const my = ++seq
      list.querySelectorAll('li').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === i))
      const f = current[i]
      bar.classList.remove('hidden')
      d.querySelector<HTMLButtonElement>('[data-act=open]')!.disabled = f.status === 'deleted'
      diffEl.innerHTML = '<div class="hd-same">Loading…</div>'
      const base = f.base ? await readVersion(f.base.hash).catch(() => '') : ''
      const cur = f.status === 'deleted' ? '' : ((await currentText(f.path)) ?? '')
      if (my !== seq) return
      renderDiff(diffEl, base, cur)
      info.innerHTML = '<b></b><br><span class="muted"></span>'
      info.querySelector('b')!.textContent = f.path
      info.querySelector('span')!.textContent =
        f.status === 'added' ? `New file since ${whenInline(since)}.` : f.status === 'deleted' ? `Deleted since ${whenInline(since)}. Its history can bring it back.` : `Changes since ${whenInline(since)}.`
      legend.innerHTML = `<span class="lg-add">Green</span> lines were added since then, <span class="lg-del">red</span> lines were removed.${esc(note)}`
    }

    const load = async (): Promise<void> => {
      const o = opts[Number(pick.value)]
      custom.classList.toggle('hidden', o[1] !== -1)
      since = o[1] === -1 ? new Date(custom.value).getTime() || today : o[1]
      const my = ++seq
      list.innerHTML = ''
      bar.classList.add('hidden')
      legend.innerHTML = ''
      diffEl.innerHTML = '<div class="hd-same">Looking for changes…</div>'
      const live: Record<string, string> = {}
      for (const [p, f] of h.files) if (f.dirty && HISTORY_EXT.test(p)) live[p] = textOf(p)!
      current = await call('changesSince', since, live).catch(() => [])
      if (my !== seq) return
      note = since < historyStart ? ` OpenTex started keeping versions of this project ${whenInline(historyStart)}, so earlier changes aren’t known.` : ''
      if (!current.length) {
        diffEl.innerHTML = `<div class="hd-same">Nothing has changed since ${esc(whenInline(since))}.${esc(note)}</div>`
        return
      }
      list.innerHTML = current
        .map((f, i) => {
          const what = f.status === 'added' ? '<span class="hv-tag">New file</span>' : f.status === 'deleted' ? '<span class="hv-tag">Deleted</span>' : ''
          return `<li data-i="${i}"><div class="hv-when">${esc(f.path)}${what}</div>
            <div class="hv-meta"><span class="hv-add">+${f.added.toLocaleString()}</span><span class="hv-del">−${f.removed.toLocaleString()}</span><span>lines</span>${f.outside ? '<span class="hv-src src-outside">Changed outside OpenTex</span>' : ''}</div></li>`
        })
        .join('')
      await showFile(0)
    }
    list.onclick = (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li')
      if (li) void showFile(Number(li.dataset.i))
    }
    pick.onchange = () => void load()
    custom.onchange = () => void load()
    d.querySelector<HTMLButtonElement>('[data-act=open]')!.onclick = async () => {
      d.close()
      await h.openFile(current[sel].path)
    }
    d.querySelector<HTMLButtonElement>('[data-act=history]')!.onclick = () => openFileHistory(current[sel].path)
    await load()
  }

  return {
    /** The open file was edited (any change to its text). */
    edited,
    /** A file was saved (by you, or automatically). */
    saved(path: string, text: string, auto: boolean): void {
      const r = root()
      if (r && recovered.delete(path)) void call('recoveryClear', r, path).catch(() => {})
      void call('snapshot', path, text, auto ? 'auto' : 'save').catch(() => {})
    },
    /** A tab was closed (its unsaved edits, if any, were discarded). */
    closed(path: string): void {
      const r = root()
      pending.delete(path)
      if (r && recovered.delete(path)) void call('recoveryClear', r, path).catch(() => {})
    },
    /** All unsaved edits were discarded. */
    async discarded(): Promise<void> {
      const r = root()
      recovered.clear()
      pending.clear()
      if (r) await call('recoveryClear', r, null).catch(() => {})
    },
    projectOpened,
    /** Files changed on disk: keep versions of them (labelled "Changed outside OpenTex" unless OpenTex wrote them). */
    diskChanged(paths: string[]): void {
      const list = paths.filter((p) => HISTORY_EXT.test(p))
      if (list.length) void call('checkDisk', list).catch(() => {})
    },
    /** Keep a file's text as a version before OpenTex rewrites it (text null: as it is on disk). */
    before(path: string, text: string | null, src: VersionSource): Promise<unknown> {
      return call('snapshot', path, text, src).catch(() => {})
    },
    tracked: (path: string): boolean => HISTORY_EXT.test(path),
    open(path?: string | null): void {
      if (path && HISTORY_EXT.test(path)) void openFileHistory(path)
      else void openChanges()
    },
    changes: (): void => void openChanges(),
    /** Earlier times this project was open, newest first (for "since I last had it open"). */
    sessions: (): Session[] => sessions.slice()
  }
}
