import './styles.css'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { CompileResult, Engine, Problem, ProjectInfo, Settings, TexInfo, Theme, TreeNode } from '../../shared/types'
import type { OpenTexApi } from '../../preload/index'
import { dimCompartment, dimExtension, goToLine, makeExtensions, PluginMark, setPluginMarks } from './editor'
import { allFiles, isTextFile, renderTree } from './filetree'
import { PdfView } from './pdfview'
import { openSettings } from './settings-ui'
import { applyTheme, BUILT_IN } from './themes'
import { ask, contextMenu, promptText } from './ui'
import { findQuote, parseComments } from './comments'
import { anchorAt, commentClicks, commentField, COMMENTS_FILE, locate, newId, Placed, placedIn, setComments, StoreFile, Thread, today } from './review'
import { CompletionData, countWords, scanBib, scanTex, spellCompartment, spellExtension } from './assist'
import { PluginPanels } from './panels'
import { buildInsertBar, insertAtCursor } from './insert'
import { Ribbon } from './ribbon'
import { applyDesign, currentDesign, CustomDesign, PRESETS } from './design'
import { detectFormat, mergeIntoBib, parseRefs, RefFormat } from './refs-import'
import { Layout, LayoutState, normalize as normalizeLayout } from './layout'
import type { PluginInfo } from '../../shared/types'

const api = (window as unknown as { opentex: OpenTexApi }).opentex
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

// ---------- State ----------
interface OpenFile {
  path: string
  state: EditorState
  saved: string
  dirty: boolean
}
const files = new Map<string, OpenFile>()
let tabOrder: string[] = []
let active: string | null = null
let project: ProjectInfo | null = null
let settings: Settings
let tex: TexInfo
let themes: Theme[] = BUILT_IN
let problems: Problem[] = []
let lastLog = ''
let compiling = false
let compileQueued = false
let lastPdf: string | null = null
let lastPdfLoad = 0
let focusOn = false
let completion: CompletionData = { citations: [], labels: [], commands: [] }
let liveTimer = 0

const extensions = [...makeExtensions(
  {
    onChange: () => {
      const f = active && files.get(active)
      if (f && !f.dirty) {
        f.dirty = true
        renderTabs()
      }
      scheduleComments()
      scheduleLiveCompile()
      scheduleWords()
      scheduleDocument()
    },
    onTyped: (n) => noteTyping(n),
    onCursor: (line, col) => ($('st-cursor').textContent = `Ln ${line}, Col ${col}`),
    onSelection: () => placeBubble()
  },
  false,
  () => completion
), commentField, commentClicks((id) => layout.isVisible('comments') && focusCard(id))]
const view = new EditorView({ parent: $('editor'), state: EditorState.create({ doc: '', extensions }) })
const pdf = new PdfView($('pdf'), $('pdf-zoom'), $('pdf-pages'))

// ---------- Settings & themes ----------
function applySettings(): void {
  const theme = themes.find((t) => t.name === settings.theme) ?? BUILT_IN[0]
  applyTheme(theme)
  const r = document.documentElement.style
  r.setProperty('--editor-font', settings.fontFamily)
  r.setProperty('--editor-font-size', `${settings.fontSize}px`)
  r.setProperty('--editor-line-height', String(settings.lineHeight))
  r.setProperty('--focus-width', `${settings.focusWidth}ch`)
  document.body.classList.toggle('no-ribbon', settings.showInsertBar === false)
  view.dispatch({ effects: [dimCompartment.reconfigure(dimExtension(focusOn && settings.focusDim)), spellCompartment.reconfigure(spellExtension(settings.spellcheck))] })
  view.requestMeasure()
  plugins?.broadcastTheme()
}

function currentTheme(): Theme {
  return themes.find((t) => t.name === settings.theme) ?? BUILT_IN[0]
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings = await api.setSettings(patch)
  applySettings()
  if ('disabledPlugins' in patch) plugins.setPlugins(allPlugins, settings.disabledPlugins)
  if ('texPath' in patch) await refreshTex()
}

async function refreshTex(): Promise<void> {
  tex = await api.detectTex()
  const el = $('st-tex')
  el.textContent = tex.found ? `TeX: ${tex.latexmk ? 'latexmk' : tex.engines[0]}` : 'No TeX found'
  el.className = tex.found ? '' : 'err'
  el.title = tex.found ? tex.binDir! : 'Install TeX (MacTeX, MiKTeX, TeX Live or TinyTeX), or set its folder in Settings.'
  $('welcome-tex').textContent = tex.found
    ? `Using TeX from ${tex.binDir}`
    : 'No TeX installation was found. Install MacTeX, MiKTeX or TinyTeX, or set its folder in Settings.'
}

// ---------- Project ----------
async function setProject(info: ProjectInfo | null): Promise<void> {
  if (!info) return
  if (!(await confirmDiscardAll())) return
  files.clear()
  tabOrder = []
  active = null
  project = info
  lastPdf = null
  pdf.clear()
  showProblems([], false)
  $('project-name').textContent = info.name
  document.body.classList.remove('no-project')
  $('welcome').classList.add('hidden')
  layout.render()
  ;($('engine') as HTMLSelectElement).value = info.config.engine ?? settings.engine
  refreshProjectUi()
  scheduleComments()
  refreshIndex()
  refreshGit()
  if (info.mainFile) {
    await openFile(info.mainFile)
    const pdfPath = info.mainFile.replace(/\.tex$/i, '.pdf')
    if (allFiles(info.tree, (p) => p === pdfPath).length) void showPdf(pdfPath) // don't hold up opening the project
  }
  await loadComments()
  await migrateLegacyComments()
  mainTextCache = info.mainFile ? (textOf(info.mainFile) ?? (await api.readFile(info.mainFile).catch(() => ''))) : ''
  ribbon?.renderDesign()
}

function refreshProjectUi(): void {
  if (!project) return
  renderTree($('tree'), project.tree, active, project.mainFile, {
    open: (p) => openFile(p),
    contextMenu: (n, x, y) => treeMenu(n, x, y)
  })
  const sel = $('st-main') as HTMLSelectElement
  const texFiles = allFiles(project.tree, (p) => p.endsWith('.tex'))
  sel.innerHTML = texFiles.map((p) => `<option ${p === project!.mainFile ? 'selected' : ''}>${p}</option>`).join('')
  if (!texFiles.length) sel.innerHTML = '<option>(none)</option>'
}

function treeMenu(n: TreeNode, x: number, y: number): void {
  const items: [string, () => void][] = []
  if (!n.dir && n.path.endsWith('.tex')) items.push(['Set as main file', () => setMainFile(n.path)])
  if (!n.dir) items.push(['Open', () => openFile(n.path)])
  items.push(['New file here…', () => newFile(n.dir ? n.path + '/' : n.path.replace(/[^/]+$/, ''))])
  items.push([navigator.platform.startsWith('Mac') ? 'Reveal in Finder' : 'Show in folder', () => api.reveal(n.path)])
  contextMenu(x, y, items)
}

async function setMainFile(path: string): Promise<void> {
  if (!project) return
  project.config = await api.setProjectConfig({ mainFile: path })
  project.mainFile = path
  refreshProjectUi()
}

async function reloadTree(): Promise<void> {
  if (!project) return
  const info: ProjectInfo = await api.projectInfo()
  project.tree = info.tree
  project.mainFile = info.mainFile
  refreshProjectUi()
}

async function newFile(prefix = ''): Promise<void> {
  if (!project) return
  const name = await promptText('New file name (relative to the project folder):', prefix || 'section.tex')
  if (!name) return
  try {
    await api.createFile(name)
  } catch (e) {
    await ask(`Could not create ${name}: ${(e as Error).message.replace(/^.*Error: /, '')}`, ['OK'])
    return
  }
  await reloadTree()
  await openFile(name)
}

// ---------- Files & tabs ----------
async function openFile(path: string): Promise<void> {
  if (/\.pdf$/i.test(path)) return showPdf(path)
  if (!isTextFile(path)) {
    api.reveal(path)
    return
  }
  if (!files.has(path)) {
    let text: string
    try {
      text = await api.readFile(path)
    } catch (e) {
      await ask(`Could not open ${path}.`, ['OK'])
      return
    }
    files.set(path, { path, saved: text, dirty: false, state: EditorState.create({ doc: text, extensions }) })
    tabOrder.push(path)
    placeIn(path)
  }
  switchTo(path)
}

function switchTo(path: string): void {
  if (active && files.has(active)) files.get(active)!.state = view.state
  active = path
  view.setState(files.get(path)!.state)
  view.dispatch({ effects: [dimCompartment.reconfigure(dimExtension(focusOn && settings.focusDim)), spellCompartment.reconfigure(spellExtension(settings.spellcheck))] })
  hideBubble()
  updateWords()
  scheduleDocument(50)
  renderTabs()
  refreshProjectUi()
  view.focus()
}

function renderTabs(): void {
  const host = $('tabs')
  host.replaceChildren(
    ...tabOrder.map((p) => {
      const f = files.get(p)!
      const tab = document.createElement('div')
      tab.className = `tab${p === active ? ' active' : ''}${f.dirty ? ' dirty' : ''}`
      tab.title = p
      tab.innerHTML = `<span></span><button class="close" title="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button>`
      tab.firstElementChild!.textContent = p.split('/').pop()!
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) closeTab(p)
      })
      tab.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.close')) closeTab(p)
        else if (p !== active) switchTo(p)
      })
      return tab
    })
  )
}

async function closeTab(path: string): Promise<void> {
  const f = files.get(path)
  if (!f) return
  if (path === active) f.state = view.state
  if (f.dirty) {
    const r = await ask(`Save changes to ${path}?`, ['Save', "Don't save", 'Cancel'])
    if (r === 2 || r === -1) return
    if (r === 0) await save(path, false)
  }
  const i = tabOrder.indexOf(path)
  tabOrder.splice(i, 1)
  files.delete(path)
  if (active === path) {
    active = null
    const next = tabOrder[Math.min(i, tabOrder.length - 1)]
    if (next) switchTo(next)
    else {
      view.setState(EditorState.create({ doc: '', extensions }))
      renderTabs()
      refreshProjectUi()
    }
  } else renderTabs()
}

async function save(path = active, maybeCompile = true): Promise<void> {
  if (!path) return
  const f = files.get(path)
  if (!f) return
  const state = path === active ? view.state : f.state
  const text = state.doc.toString()
  await api.writeFile(path, text)
  f.saved = text
  f.dirty = false
  syncAnchors(path, state)
  if (path === project?.mainFile) {
    mainTextCache = text
    ribbon?.renderDesign()
  }
  renderTabs()
  refreshIndex()
  refreshGit()
  if (maybeCompile && settings.compileOnSave && /\.(tex|bib|sty|cls)$/i.test(path)) compile()
}

async function saveAll(): Promise<void> {
  for (const f of files.values()) if (f.dirty) await save(f.path, false)
}

async function confirmDiscardAll(): Promise<boolean> {
  if (active && files.has(active)) files.get(active)!.state = view.state
  const dirty = [...files.values()].filter((f) => f.dirty)
  if (!dirty.length) return true
  const r = await ask(`You have unsaved changes in ${dirty.map((f) => f.path).join(', ')}.`, ['Save all', 'Discard', 'Cancel'])
  if (r === 0) await saveAll()
  return r === 0 || r === 1
}

/** Files changed on disk (by a collaborator, Dropbox, git or another editor). */
async function onDiskChange(paths: string[]): Promise<void> {
  if (!project) return
  const structural = paths.some((p) => !/\.(aux|log|fls|fdb_latexmk|synctex\.gz|out|toc|bbl|blg|bcf|xml)$/i.test(p))
  if (structural) reloadTree()
  if (paths.includes(COMMENTS_FILE)) {
    const now = await api.readFile(COMMENTS_FILE).catch(() => '')
    if (now !== storeText) await loadComments() // a collaborator's comments arrived
  }
  for (const p of paths) {
    const f = files.get(p)
    if (!f) continue
    const disk: string | null = await api.readFile(p).catch(() => null)
    if (disk === null || disk === f.saved) continue
    if (!f.dirty) {
      // Reload silently, keeping the cursor roughly where it was.
      f.saved = disk
      const state = p === active ? view.state : f.state
      const head = Math.min(state.selection.main.head, disk.length)
      const tr = state.update({ changes: { from: 0, to: state.doc.length, insert: disk }, selection: { anchor: head } })
      if (p === active) view.dispatch(tr)
      else f.state = tr.state
      f.dirty = false
      placeIn(p) // match the comments to the new text
      renderTabs()
    } else {
      setCompileStatus(`${p} changed on disk; your unsaved edits are kept`, 'warn')
    }
  }
  if (paths.some((p) => p.endsWith('.tex'))) {
    await checkDetached()
    scheduleComments()
  }
  if (paths.some((p) => /\.(tex|bib)$/.test(p))) refreshIndex()
  if (structural) refreshGit()
  if (lastPdf && paths.includes(lastPdf) && !compiling && Date.now() - lastPdfLoad > 2000) showPdf(lastPdf)
}

// ---------- Compile ----------
function setCompileStatus(text: string, cls = ''): void {
  const el = $('st-compile')
  el.textContent = text
  el.className = cls
}

async function compile(): Promise<void> {
  if (!project) return
  if (!project.mainFile) {
    await ask('No main .tex file found. Right-click a .tex file in the sidebar and choose "Set as main file".', ['OK'])
    return
  }
  if (!tex?.found) {
    await ask('No TeX installation was found. Install MacTeX (macOS), MiKTeX (Windows) or TinyTeX, then restart OpenTex, or set the TeX folder in Settings.', ['OK'])
    return
  }
  if (compiling) {
    compileQueued = true
    return
  }
  compiling = true
  $('btn-compile').classList.add('busy')
  setCompileStatus('Compiling…')
  await saveAll()
  const engine = ($('engine') as HTMLSelectElement).value as Engine
  let r: CompileResult
  try {
    r = await api.compile(project.mainFile, engine)
  } catch (e) {
    setCompileStatus(`Compile failed: ${(e as Error).message.replace(/^.*Error: /, '')}`, 'err')
    finishCompile()
    return
  }
  lastLog = r.log
  const errors = r.problems.filter((p) => p.severity === 'error').length
  const warnings = r.problems.length - errors
  const secs = (r.durationMs / 1000).toFixed(1)
  if (r.cancelled) setCompileStatus('Compile stopped')
  else if (errors) setCompileStatus(`✗ ${errors} error${errors > 1 ? 's' : ''}, ${warnings} warning${warnings === 1 ? '' : 's'}`, 'err')
  else setCompileStatus(`✓ Compiled in ${secs}s${warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`, warnings ? 'warn' : 'ok')
  if (r.missingFiles.length) setCompileStatus(`Missing package file: ${r.missingFiles.join(', ')}`, 'err')
  showProblems(r.problems, errors > 0)
  if (r.pdf) await showPdf(r.pdf)
  finishCompile()
  if (r.missingFiles.length) offerMissing(r.missingFiles)
}

function finishCompile(): void {
  compiling = false
  $('btn-compile').classList.remove('busy')
  if (compileQueued) {
    compileQueued = false
    compile()
  }
}

async function showPdf(path: string): Promise<void> {
  try {
    const data: Uint8Array = await api.readBinary(path)
    lastPdf = path
    lastPdfLoad = Date.now()
    await pdf.load(data)
  } catch (e) {
    console.warn('Could not show PDF', e)
  }
}

function showProblems(list: Problem[], open: boolean): void {
  problems = list
  $('problems-title').textContent = list.length ? `Problems (${list.length})` : 'Problems'
  const ul = $('problems-list')
  ul.replaceChildren(
    ...list.map((p) => {
      const li = document.createElement('li')
      li.className = p.severity
      const loc = p.line ? `${p.file ?? project?.mainFile ?? ''}:${p.line}` : p.file ?? ''
      li.innerHTML = `<span class="sev">${p.severity === 'error' ? '✗' : '!'}</span><span class="loc"></span><span class="msg"></span>`
      li.querySelector('.loc')!.textContent = loc
      li.querySelector('.msg')!.textContent = p.message
      li.addEventListener('click', async () => {
        const file = p.file ?? project?.mainFile
        if (!file || !p.line) return
        await openFile(file)
        goToLine(view, p.line)
      })
      return li
    })
  )
  if (open) $('problems').classList.remove('hidden')
  if (!list.length) $('problems').classList.add('hidden')
}

// ---------- Interface zoom ----------
const ZOOMS = [0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2]
function zoom(dir: 1 | -1 | 0): void {
  const cur = settings.uiZoom || 1
  let next = 1
  if (dir !== 0) {
    const i = ZOOMS.findIndex((z) => z >= cur - 0.001)
    next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.indexOf(1) : i) + dir))]
  }
  api.setZoom(next)
  updateSettings({ uiZoom: next })
  setCompileStatus(`Interface size ${Math.round(next * 100)}%`)
}
document.addEventListener(
  'keydown',
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const k = e.key
    if (k === '=' || k === '+') zoom(1)
    else if (k === '-' || k === '_') zoom(-1)
    else if (k === '0') zoom(0)
    else return
    e.preventDefault()
    e.stopPropagation()
  },
  true
)

// ---------- Focus mode ----------
let exitTimer = 0
function setFocus(on: boolean): void {
  focusOn = on
  document.body.classList.toggle('focus', on)
  $('btn-focus').classList.toggle('on', on)
  view.dispatch({ effects: dimCompartment.reconfigure(dimExtension(on && settings.focusDim)) })
  if (settings.focusFullscreen) api.setFullscreen(on)
  if (on) flashExit()
  view.requestMeasure()
  view.focus()
}
function flashExit(): void {
  const b = $('focus-exit')
  b.classList.add('show')
  clearTimeout(exitTimer)
  exitTimer = window.setTimeout(() => b.classList.remove('show'), 1800)
}
document.addEventListener('mousemove', () => focusOn && flashExit())
document.addEventListener(
  'keydown',
  (e) => {
    // Esc leaves focus mode unless it is closing the search panel or a dialog.
    if (e.key === 'Escape' && focusOn && !document.querySelector('.cm-search') && !document.querySelector('dialog[open]')) {
      e.preventDefault()
      setFocus(false)
    }
  },
  true
)

// ---------- TinyTeX ----------
/** Run a long task while showing its output in a dialog. */
async function withProgress(title: string, task: () => Promise<boolean>): Promise<boolean> {
  const d = $<HTMLDialogElement>('modal')
  d.innerHTML = `<div class="modal-body"><p><b></b></p></div><pre class="progress-log"></pre><div class="modal-actions"><button class="primary" disabled>Working…</button></div>`
  d.querySelector('b')!.textContent = title
  const logEl = d.querySelector('pre')!
  progressSink = (line) => {
    logEl.textContent += line + '\n'
    logEl.scrollTop = logEl.scrollHeight
  }
  d.addEventListener('cancel', (e) => e.preventDefault(), { once: true }) // Esc can't hide a running install
  d.showModal()
  const ok = await task().catch(() => false)
  progressSink = null
  const btn = d.querySelector('button')!
  btn.disabled = false
  btn.textContent = ok ? 'Done' : 'Close'
  await new Promise<void>((r) => (btn.onclick = () => (d.close(), r())))
  return ok
}
let progressSink: ((line: string) => void) | null = null

async function installTinyTex(): Promise<void> {
  const r = await ask(
    'TinyTeX is a small (about 100 MB), standard TeX installation. OpenTex will download it from the TinyTeX project on GitHub and install it in your user folder. No administrator password is needed.',
    ['Install TinyTeX', 'Cancel']
  )
  if (r !== 0) return
  const ok = await withProgress('Installing TinyTeX', () => api.installTinyTex())
  await refreshTex()
  if (ok && tex.found) setCompileStatus('TinyTeX installed. Missing packages are offered when a paper needs them.', 'ok')
}

async function offerMissing(missing: string[]): Promise<void> {
  if (!(await api.canInstallPackages())) {
    await ask(
      `Your TeX installation is missing ${missing.join(', ')}. Install the package that provides it with your TeX distribution's package manager (TeX Live Utility on macOS, MiKTeX Console on Windows), then compile again.`,
      ['OK']
    )
    return
  }
  const r = await ask(`This paper needs ${missing.join(', ')}, which isn't installed. Install it now?`, ['Install', 'Not now'])
  if (r !== 0) return
  if (await withProgress('Installing missing packages', () => api.installMissing(missing))) compile()
}

// ---------- Comments (kept in comments.opentex.json, never in the .tex text) ----------
let store: Thread[] = []
let storeText = '' // last contents read or written, to tell our own writes from a collaborator's
const detached = new Set<string>() // comments whose text can't be found any more
let autoMigrate = false
let commentsTimer = 0
function scheduleComments(): void {
  clearTimeout(commentsTimer)
  commentsTimer = window.setTimeout(renderComments, 200)
}

function textOf(path: string): string | null {
  if (path === active) return view.state.doc.toString()
  return files.get(path)?.state.doc.toString() ?? null
}
const stateOf = (path: string): EditorState | null => (path === active ? view.state : (files.get(path)?.state ?? null))

async function loadComments(): Promise<void> {
  store = []
  detached.clear()
  if (!project) return
  storeText = await api.readFile(COMMENTS_FILE).catch(() => '')
  if (storeText.trim()) {
    try {
      const d = JSON.parse(storeText) as StoreFile
      store = Array.isArray(d.threads) ? d.threads.filter((t) => t && t.id && t.file) : []
    } catch {
      setCompileStatus(`${COMMENTS_FILE} could not be read, so comments are not shown`, 'warn')
    }
  }
  for (const f of files.keys()) placeIn(f)
  await checkDetached()
  scheduleComments()
}

async function saveComments(): Promise<void> {
  if (!project) return
  if (!store.length && !storeText) return // nothing to save and no file yet
  storeText = JSON.stringify({ version: 1, threads: store } satisfies StoreFile, null, 2) + '\n'
  await api.writeFile(COMMENTS_FILE, storeText)
}

function applyPlaced(path: string, placed: Placed[]): void {
  const f = files.get(path)
  if (!f) return
  if (path === active) view.dispatch({ effects: setComments.of(placed) })
  else f.state = f.state.update({ effects: setComments.of(placed) }).state
}

/** Match a file's comments to its current text and show them in its editor. */
function placeIn(path: string): void {
  const state = stateOf(path)
  if (!state) return
  const text = state.doc.toString()
  const placed: Placed[] = []
  for (const t of store.filter((x) => x.file === path)) {
    const r = locate(text, t)
    if (r) {
      placed.push({ id: t.id, ...r, resolved: t.resolved })
      detached.delete(t.id)
    } else detached.add(t.id)
  }
  applyPlaced(path, placed)
}

/** Redraw a file's comments at their current (live) positions, e.g. after resolving one. */
function redraw(path: string, extra?: Placed): void {
  const state = stateOf(path)
  if (!state) return
  const byId = new Map(store.map((t) => [t.id, t]))
  const placed = placedIn(state)
    .filter((p) => byId.has(p.id) && p.id !== extra?.id)
    .map((p) => ({ ...p, resolved: byId.get(p.id)!.resolved }))
  if (extra) placed.push(extra)
  applyPlaced(path, placed)
}

/** On save: record where each comment is now, so the comments file matches the saved text. */
function syncAnchors(path: string, state: EditorState): void {
  const mine = store.filter((t) => t.file === path)
  if (!mine.length) return
  const text = state.doc.toString()
  const live = new Map(placedIn(state).map((p) => [p.id, p]))
  const before = JSON.stringify(mine)
  for (const t of mine) {
    const p = live.get(t.id)
    if (p) {
      Object.assign(t, anchorAt(text, p.from, p.to))
      detached.delete(t.id)
    } else detached.add(t.id) // its text was deleted
  }
  if (JSON.stringify(mine) !== before) saveComments()
  scheduleComments()
}

/** For files that aren't open, check against the text on disk which comments still fit. */
async function checkDetached(): Promise<void> {
  const disk = new Map<string, string | null>()
  for (const t of store) {
    if (files.has(t.file)) continue
    if (!disk.has(t.file)) disk.set(t.file, await api.readFile(t.file).catch(() => null))
    const text = disk.get(t.file)
    if (text != null && locate(text, t)) detached.delete(t.id)
    else detached.add(t.id)
  }
}

function lineOf(t: Thread): number | null {
  const state = stateOf(t.file)
  const p = state && placedIn(state).find((x) => x.id === t.id)
  return p ? state!.doc.lineAt(p.from).number : null
}

function renderComments(): void {
  const open = store.filter((t) => !t.resolved).length
  $('comment-count').textContent = open ? String(open) : ''
  if (!layout.isVisible('comments')) return
  const showResolved = ($('show-resolved') as HTMLInputElement).checked
  const list = $('comments-list')
  const shown = store.filter((t) => showResolved || !t.resolved)
  if (!shown.length) {
    list.innerHTML = `<div class="c-empty">${store.length ? 'No open comments.' : 'No comments yet. Select some text in the editor or the PDF and click <b>+ Comment</b>, or right-click it. Press Ctrl/Cmd+Shift+M to comment at the cursor.'}</div>`
    return
  }
  list.replaceChildren(
    ...shown.map((t) => {
      const card = document.createElement('div')
      const broken = detached.has(t.id)
      card.className = `c-card${t.resolved ? ' resolved' : ''}${broken ? ' detached' : ''}`
      card.dataset.id = t.id
      const entry = (e: { author: string; date: string; text: string }, cls = ''): HTMLElement => {
        const d = document.createElement('div')
        d.className = cls
        d.innerHTML = `<div class="c-meta"><b></b><span></span></div><div class="c-text"></div>`
        d.querySelector('b')!.textContent = e.author || 'Anonymous'
        d.querySelector('.c-meta span')!.textContent = e.date
        d.querySelector('.c-text')!.textContent = e.text
        return d
      }
      if (broken) {
        const b = document.createElement('button')
        b.className = 'c-broken'
        b.title = 'The text this comment was on has changed or moved. Click to re-link it.'
        b.innerHTML = '<svg viewBox="0 0 20 20"><path d="M8.5 11.5l3-3M7 9.2 5.4 10.8a2.6 2.6 0 0 0 3.7 3.7l1.6-1.6M13 10.8l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7L9.3 7.1M4 4l2 2M16 16l-2-2"/></svg> Not found in the text · Re-link'
        b.onclick = (e) => {
          e.stopPropagation()
          relink(t)
        }
        card.appendChild(b)
      }
      if (t.quote.trim()) {
        const q = document.createElement('div')
        q.className = 'c-quote'
        const short = t.quote.replace(/\s+/g, ' ').trim()
        q.textContent = `“${short.length > 140 ? short.slice(0, 140) + '…' : short}”`
        card.appendChild(q)
      }
      card.appendChild(entry(t))
      t.replies.forEach((r) => card.appendChild(entry(r, 'c-reply')))
      const ctx = document.createElement('div')
      ctx.className = 'c-ctx'
      const ln = lineOf(t)
      ctx.textContent = `${t.file}${ln ? `:${ln}` : ''}`
      card.appendChild(ctx)
      const actions = document.createElement('div')
      actions.className = 'c-actions'
      const btn = (label: string, fn: () => void): void => {
        const b = document.createElement('button')
        b.textContent = label
        b.onclick = (e) => {
          e.stopPropagation()
          fn()
        }
        actions.appendChild(b)
      }
      btn('Reply', () => replyTo(t))
      btn(t.resolved ? 'Reopen' : 'Resolve', () => setResolved(t, !t.resolved))
      if (!broken) btn('Re-link', () => relink(t))
      btn('Delete', () => deleteThread(t))
      card.appendChild(actions)
      card.onclick = () => showThread(t)
      return card
    })
  )
}

/** Jump to a comment's text in the editor and select it. */
async function showThread(t: Thread): Promise<void> {
  if (detached.has(t.id)) {
    await relink(t)
    return
  }
  await openFile(t.file)
  const p = placedIn(view.state).find((x) => x.id === t.id)
  if (!p) return
  view.dispatch({ selection: { anchor: p.from, head: p.to }, effects: EditorView.scrollIntoView(p.from, { y: 'center' }) })
  view.focus()
}

/** Clicking commented text in the editor highlights its card. */
function focusCard(id: string): void {
  if (!store.some((t) => t.id === id)) return
  if (!layout.isVisible('comments')) layout.show('comments')
  renderComments()
  const card = $('comments-list').querySelector<HTMLElement>(`[data-id="${id}"]`)
  if (!card) return
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  card.classList.remove('flash')
  void card.offsetWidth
  card.classList.add('flash')
}

async function authorName(): Promise<string | null> {
  if (settings.authorName) return settings.authorName
  const name = await promptText('Your name, shown on comments you write:', '')
  if (name) await updateSettings({ authorName: name })
  return name
}

/**
 * Add a comment on the editor selection (or at the cursor). From the PDF, `target` names the
 * source file and line found with SyncTeX, and the PDF text, which is looked up near that line.
 */
async function addComment(target?: { file: string; line: number; quote: string }): Promise<void> {
  if (!target && (!active || !active.endsWith('.tex'))) {
    await ask('Open a .tex file and select the text (or click where) you want to comment.', ['OK'])
    return
  }
  const sel = view.state.selection.main
  const shownQuote = target ? target.quote : view.state.sliceDoc(sel.from, sel.to)
  hideBubble()
  const name = await authorName()
  if (!name) return
  const short = shownQuote.replace(/\s+/g, ' ').trim()
  const body = await promptText(short ? `Comment on “${short.length > 80 ? short.slice(0, 80) + '…' : short}”:` : 'Comment:')
  if (!body) return
  let from = sel.from
  let to = sel.to
  if (target) {
    await openFile(target.file)
    const doc = view.state.doc
    const line = doc.line(Math.min(Math.max(1, target.line), doc.lines))
    const end = doc.line(Math.min(doc.lines, line.number + 4)).to
    const hit = findQuote(doc.sliceString(line.from, end), target.quote)
    from = hit ? line.from + hit[0] : line.from
    to = hit ? line.from + hit[1] : line.from
  }
  const t: Thread = { id: newId(), file: active!, ...anchorAt(view.state.doc.toString(), from, to), author: name, date: today(), text: body.trim(), replies: [], resolved: false }
  store.push(t)
  redraw(active!, { id: t.id, from, to, resolved: false })
  await saveComments()
  focusCard(t.id)
}

async function replyTo(t: Thread): Promise<void> {
  const name = await authorName()
  if (!name) return
  const text = await promptText('Reply:')
  if (!text) return
  t.replies.push({ author: name, date: today(), text: text.trim() })
  await saveComments()
  renderComments()
}

async function setResolved(t: Thread, resolved: boolean): Promise<void> {
  t.resolved = resolved
  redraw(t.file)
  await saveComments()
  renderComments()
}

async function deleteThread(t: Thread): Promise<void> {
  if ((await ask('Delete this comment and its replies?', ['Delete', 'Cancel'])) !== 0) return
  store = store.filter((x) => x !== t)
  detached.delete(t.id)
  redraw(t.file)
  await saveComments()
  renderComments()
}

/** Attach a comment to the text selected in the editor (or the cursor position). */
async function relink(t: Thread): Promise<void> {
  const sel = view.state.selection.main
  if (!active || !active.endsWith('.tex') || (sel.empty && !detached.has(t.id))) {
    await ask(`Select the text this comment belongs to${t.quote.trim() ? ` (it was on “${t.quote.replace(/\s+/g, ' ').trim().slice(0, 60)}”)` : ''}, then click Re-link on the comment.`, ['OK'])
    if (!active || active !== t.file) await openFile(t.file).catch(() => {})
    return
  }
  if (sel.empty && (await ask('Nothing is selected. Attach the comment at the cursor position?', ['Attach here', 'Cancel'])) !== 0) return
  const oldFile = t.file
  Object.assign(t, { file: active }, anchorAt(view.state.doc.toString(), sel.from, sel.to))
  detached.delete(t.id)
  if (oldFile !== active) redraw(oldFile)
  redraw(active, { id: t.id, from: sel.from, to: sel.to, resolved: t.resolved })
  await saveComments()
  focusCard(t.id)
}

/** Convert comments written as %@comment lines (older OpenTex, and Word import) into the comments file. */
async function migrateLegacyComments(): Promise<void> {
  if (!project) return
  const found: { file: string; text: string }[] = []
  for (const f of allFiles(project.tree, (p) => p.endsWith('.tex'))) {
    const text = textOf(f) ?? (await api.readFile(f).catch(() => ''))
    if (/^\s*%@comment\[/m.test(text)) found.push({ file: f, text })
  }
  const auto = autoMigrate
  autoMigrate = false
  if (!found.length) return
  if (!auto) {
    const r = await ask('This project has comments written as %@comment lines in its .tex files (the older OpenTex format). Move them into OpenTex’s comments file? Your text stays the same; only those comment lines are removed.', ['Move them', 'Not now'])
    if (r !== 0) return
  }
  for (const { file, text } of found) {
    if (files.get(file)?.dirty) await save(file, false)
    const threads = parseComments(text, file)
    const lines = text.split('\n')
    const removed = new Set<number>()
    for (const t of threads) for (let i = t.line - 1; i <= t.endLine - 1; i++) removed.add(i)
    const kept: string[] = []
    const newIndex: number[] = []
    lines.forEach((l, i) => {
      newIndex[i] = kept.length
      if (!removed.has(i)) kept.push(l)
    })
    const newText = kept.join('\n')
    const starts: number[] = []
    let off = 0
    for (const l of kept) {
      starts.push(off)
      off += l.length + 1
    }
    for (const t of threads) {
      const at = starts[Math.min(newIndex[Math.min(t.targetLine - 1, lines.length - 1)] ?? 0, starts.length - 1)] ?? 0
      let from = at
      let to = at
      if (t.quote) {
        const hit = findQuote(newText.slice(at, at + 3000), t.quote)
        if (hit) {
          from = at + hit[0]
          to = at + hit[1]
        }
      }
      store.push({ id: newId(), file, ...anchorAt(newText, from, to), author: t.author, date: t.date, text: t.text, replies: t.replies.map((r) => ({ author: r.author, date: r.date, text: r.text })), resolved: t.resolved })
    }
    await api.writeFile(file, newText)
    const f = files.get(file)
    if (f) {
      // Replace the open copy right away so the comments land on the new text.
      const st = stateOf(file)!
      const tr = st.update({ changes: { from: 0, to: st.doc.length, insert: newText } })
      if (file === active) view.dispatch(tr)
      else f.state = tr.state
      f.saved = newText
      f.dirty = false
    }
  }
  await saveComments()
  for (const f of files.keys()) placeIn(f)
  renderTabs()
  scheduleComments()
}

// ---------- "+ Comment" bubble over selections ----------
let pointerDown = false
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('#comment-bubble')) pointerDown = true
})
document.addEventListener('pointerup', () => {
  pointerDown = false
  setTimeout(placeBubble, 0)
})
function hideBubble(): void {
  $('comment-bubble').classList.add('hidden')
}
/** Show the bubble above a non-empty selection in the editor or the PDF. */
function placeBubble(): void {
  const b = $('comment-bubble')
  if (pointerDown || focusOn || !project) return hideBubble()
  const pdfSel = pdf.selection()
  if (pdfSel) {
    b.dataset.source = 'pdf'
    b.style.left = `${pdfSel.rect.left + Math.min(pdfSel.rect.width, 240) / 2}px`
    b.style.top = `${pdfSel.rect.top - 8}px`
    b.classList.remove('hidden')
    return
  }
  const sel = view.state.selection.main
  if (sel.empty || !view.hasFocus || !active?.endsWith('.tex')) return hideBubble()
  const start = view.coordsAtPos(sel.from)
  const host = $('editor').getBoundingClientRect()
  if (!start || start.top < host.top || start.top > host.bottom) return hideBubble()
  const end = view.coordsAtPos(sel.to)
  const left = end && Math.abs(end.top - start.top) < 4 ? (start.left + end.left) / 2 : start.left + 30
  b.dataset.source = 'editor'
  b.style.left = `${Math.max(host.left + 40, Math.min(left, host.right - 50))}px`
  b.style.top = `${start.top - 8}px`
  b.classList.remove('hidden')
}
async function commentFromPdf(): Promise<void> {
  const s = pdf.selection()
  if (!s || !lastPdf) return
  hideBubble()
  const hit = await api.synctexInverse(lastPdf, s.page, s.x, s.y)
  if (!hit) {
    await ask('Could not find where this text is in the source. Compile again (SyncTeX data is made during compiling), then try once more.', ['OK'])
    return
  }
  window.getSelection()?.removeAllRanges()
  await addComment({ file: hit.file, line: hit.line, quote: s.text })
}

// ---------- Right-click menus (editor and PDF), with spelling suggestions ----------
let lastContext: { target: HTMLElement; x: number; y: number } | null = null
document.addEventListener('contextmenu', (e) => {
  lastContext = { target: e.target as HTMLElement, x: e.clientX, y: e.clientY }
})
function showContextMenu(spell: { misspelled: string; suggestions: string[] }): void {
  const c = lastContext
  if (!c) return
  const items: [string, () => void][] = []
  if (c.target.closest('#editor')) {
    const pos = view.posAtCoords({ x: c.x, y: c.y })
    const word = pos !== null ? view.state.wordAt(pos) : null
    if (spell.misspelled && word) {
      for (const s of spell.suggestions) items.push([`✓ ${s}`, () => view.dispatch({ changes: { from: word.from, to: word.to, insert: s } })])
      if (!spell.suggestions.length) items.push(['(no spelling suggestions)', () => {}])
      items.push([`Add “${spell.misspelled}” to dictionary`, () => api.addToDictionary(spell.misspelled)])
    }
    const sel = view.state.selection.main
    if (!sel.empty || !items.length) items.push([sel.empty ? 'Add comment here' : 'Add comment on selection', () => addComment()])
    items.push(['Show in PDF', () => syncForward()])
    if (!sel.empty) items.push(['Cut', () => api.editCommand('cut')], ['Copy', () => api.editCommand('copy')])
    items.push(['Paste', () => api.editCommand('paste')])
  } else if (c.target.closest('#pdf')) {
    if (pdf.selection()) items.push(['Add comment on selection', () => commentFromPdf()], ['Copy', () => api.editCommand('copy')])
    items.push(['Show source here', () => {
      const hit = pdf.pointAt(c.x, c.y)
      if (hit) syncInverse(hit.page, hit.x, hit.y)
    }])
  } else return
  hideBubble()
  contextMenu(c.x, c.y, items)
}

// ---------- SyncTeX ----------
async function syncForward(): Promise<void> {
  if (!active || !lastPdf || !active.endsWith('.tex')) return
  const line = view.state.doc.lineAt(view.state.selection.main.head).number
  const box = await api.synctexForward(active, line, lastPdf)
  if (box) {
    if (!layout.isVisible('pdf')) {
      layout.show('pdf')
      await new Promise((r) => setTimeout(r, 300)) // let the PDF lay out before scrolling to it
    }
    pdf.showBox(box)
  } else setCompileStatus('No PDF position for this line yet. Compile first.', 'warn')
}
async function syncInverse(page: number, x: number, y: number): Promise<void> {
  if (!lastPdf) return
  const hit = await api.synctexInverse(lastPdf, page, x, y)
  if (!hit) return setCompileStatus('No source position found. Compile again to refresh SyncTeX.', 'warn')
  await openFile(hit.file)
  goToLine(view, hit.line)
}
pdf.onInverse = (page, x, y) => syncInverse(page, x, y)

// ---------- Index for autocomplete, word count, git, live compile ----------
async function refreshIndex(): Promise<void> {
  if (!project) return
  const labels = new Set<string>()
  const commands = new Set<string>()
  const citations: CompletionData['citations'] = []
  for (const f of allFiles(project.tree, (p) => /\.(tex|bib)$/.test(p))) {
    const text = textOf(f) ?? (await api.readFile(f).catch(() => ''))
    if (f.endsWith('.bib')) citations.push(...scanBib(text))
    else scanTex(text, labels, commands)
  }
  completion = { citations, labels: [...labels].sort(), commands: [...commands] }
  if (project.mainFile) mainTextCache = textOf(project.mainFile) ?? (await api.readFile(project.mainFile).catch(() => ''))
}

let wordsTimer = 0
function scheduleWords(): void {
  clearTimeout(wordsTimer)
  wordsTimer = window.setTimeout(updateWords, 600)
}
function updateWords(): void {
  const el = $('st-words')
  if (!active || !/\.tex$/.test(active)) {
    el.textContent = ''
    return
  }
  const sel = view.state.selection.main
  const n = countWords(view.state.doc.toString())
  const s = sel.empty ? 0 : countWords(view.state.sliceDoc(sel.from, sel.to))
  el.textContent = `${n.toLocaleString()} words${s ? ` (${s.toLocaleString()} selected)` : ''}`
  el.title = 'Approximate count for this file, ignoring LaTeX commands, math and comments'
  plugins?.broadcastContext()
}

async function refreshGit(): Promise<void> {
  const g = project ? await api.gitStatus() : null
  const el = $('st-git')
  el.textContent = g ? `⎇ ${g.branch}${g.changed ? ` · ${g.changed} changed` : ''}` : ''
  el.title = g ? 'Git branch and number of files with uncommitted changes' : ''
}

function scheduleLiveCompile(): void {
  if (!settings.liveCompile) return
  clearTimeout(liveTimer)
  liveTimer = window.setTimeout(async () => {
    if (active && /\.(tex|bib)$/.test(active) && files.get(active)?.dirty) {
      await save(active, false)
      compile()
    }
  }, 1500)
}

// ---------- Plugins ----------
// Typing activity for plugins (e.g. the spaceship speeds up while you type).
let typedSince = 0
let typingTimer = 0
function noteTyping(n: number): void {
  typedSince += n
  if (typingTimer) return
  typingTimer = window.setTimeout(() => {
    typingTimer = 0
    plugins?.broadcastActivity(typedSince)
    typedSince = 0
  }, 250)
}
// Document text for plugins with the 'document' permission (e.g. Readability). Versioned so a
// highlight computed for older text is ignored rather than drawn in the wrong place.
let docVersion = 0
let docTimer = 0
function scheduleDocument(delay = 800): void {
  docVersion++
  clearTimeout(docTimer)
  docTimer = window.setTimeout(() => plugins?.broadcastDocument(), delay)
}
/**
 * The open file plus every .tex file of the paper, in reading order: the main file, then each
 * \\input / \\include / \\subfile at the point it first appears (depth first).
 */
async function paperDocument(): Promise<{ file: string; text: string; version: number; files: { file: string; text: string }[] } | null> {
  if (!active || !/\.tex$/i.test(active)) return null
  const version = docVersion
  const text = view.state.doc.toString()
  const out: { file: string; text: string }[] = []
  if (project?.mainFile) {
    const tex = new Set(allFiles(project.tree, (p) => p.endsWith('.tex')))
    const seen = new Set<string>()
    const resolve = (name: string, from: string): string | null => {
      const n = name.trim().replace(/^\.\//, '')
      const withExt = /\.tex$/i.test(n) ? n : `${n}.tex`
      const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
      for (const c of [withExt, dir + withExt]) if (tex.has(c)) return c
      return null
    }
    const walk = async (f: string): Promise<void> => {
      if (seen.has(f) || seen.size > 200) return
      seen.add(f)
      const t = textOf(f) ?? (await api.readFile(f).catch(() => ''))
      out.push({ file: f, text: t })
      const body = t.replace(/(^|[^\\])%.*$/gm, '$1')
      for (const m of body.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
        const child = resolve(m[1], f)
        if (child) await walk(child)
      }
    }
    await walk(project.mainFile)
  }
  if (!out.some((f) => f.file === active)) out.unshift({ file: active, text })
  return { file: active, text, version, files: out }
}
let allPlugins: PluginInfo[] = []
// ---------- Panels ----------
let layoutSaveTimer = 0
const layout = new Layout($('workspace'), {} as LayoutState, (state) => {
  clearTimeout(layoutSaveTimer)
  layoutSaveTimer = window.setTimeout(() => api.setSettings({ layout: state }), 300)
  updatePanelButtons()
})
const plugins = new PluginPanels(layout, {
  storageGet: (id) => api.pluginStorageGet(id),
  storageSet: (id, k, v) => api.pluginStorageSet(id, k, v),
  theme: () => currentTheme(),
  document: () => paperDocument(),
  highlight: (file, version, marks) => {
    if (file !== active || version !== docVersion) return
    view.dispatch({ effects: setPluginMarks.of(marks as PluginMark[]) })
  },
  goTo: async (file, from, to) => {
    if (file !== active) await openFile(file)
    const len = view.state.doc.length
    const a = Math.max(0, Math.min(from, len))
    const b = Math.max(a, Math.min(to, len))
    view.dispatch({ selection: { anchor: a, head: b }, effects: EditorView.scrollIntoView(a, { y: 'center' }) })
    view.focus()
  },
  context: () => ({ project: project?.name ?? null, file: active, words: Number(($('st-words').textContent ?? '').replace(/[^0-9]/g, '').slice(0, 9)) || 0 })
})

function setupPanels(saved: unknown): void {
  layout.state = normalizeLayout(saved as LayoutState | undefined)
  layout.add({ id: 'files', title: 'Files', body: $('tree'), extras: $('files-extras'), defaultZone: 'left' })
  layout.add({ id: 'pdf', title: 'PDF', body: $('pdf'), extras: $('pdf-extras'), defaultZone: 'right' })
  layout.add({ id: 'comments', title: 'Comments', body: $('comments'), extras: $('comments-extras'), defaultZone: 'side', onVisible: () => scheduleComments() })
  layout.render()
  updatePanelButtons()
}

// ---------- Insert toolbar helpers ----------
let ribbon: Ribbon | null = null

/** Switch the main file to a design preset (or back to Custom). */
async function applyDesignPreset(id: string): Promise<void> {
  if (!project?.mainFile) return
  const main = project.mainFile
  const text = textOf(main) ?? (await api.readFile(main))
  const saved = project.config.design?.custom as CustomDesign | undefined
  const r = applyDesign(text, id, saved)
  if (r.error) {
    await ask(r.error, ['OK'])
    return
  }
  if (r.custom !== saved) project.config = await api.setProjectConfig({ design: { custom: r.custom } })
  if (files.has(main)) {
    // Through the editor, so Undo works.
    const st = stateOf(main)!
    const tr = st.update({ changes: { from: 0, to: st.doc.length, insert: r.text }, userEvent: 'input' })
    if (main === active) view.dispatch(tr)
    else files.get(main)!.state = tr.state
    files.get(main)!.dirty = true
    await save(main, false)
  } else await api.writeFile(main, r.text)
  mainTextCache = r.text
  ribbon?.renderDesign()
  const name = id === 'custom' ? 'your Custom setup' : PRESETS.find((p) => p.id === id)!.name
  setCompileStatus(`Design: ${name}${id !== 'custom' && r.custom ? ' (your previous setup is saved as Custom)' : ''}`, 'ok')
  compile()
}

function openInsertTool(id: string): void {
  if (settings.showInsertBar === false) updateSettings({ showInsertBar: true })
  ribbon?.select('insert', false)
  setTimeout(() => document.querySelector<HTMLButtonElement>(`#ribbon [data-tool="${id}"]`)?.click(), 50)
}
let mainTextCache = ''
const mainText = (): string => (project?.mainFile ? (textOf(project.mainFile) ?? mainTextCache) : '')
function hasPackage(pkg: string): boolean {
  const alts: Record<string, string[]> = { amsmath: ['amsmath', 'mathtools'], amssymb: ['amssymb'], graphicx: ['graphicx'], booktabs: ['booktabs'] }
  const names = alts[pkg] ?? [pkg]
  const text = mainText().replace(/(^|[^\\])%.*$/gm, '$1')
  return [...text.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g)].some((m) => m[1].split(',').some((n) => names.includes(n.trim())))
}
/** Make sure the main file loads a package, asking first. */
async function ensurePackage(pkg: string): Promise<boolean> {
  if (!project?.mainFile || hasPackage(pkg)) return true
  const main = project.mainFile
  const r = await ask(`This needs the ${pkg} package, which ${main} doesn’t load yet. Add \\usepackage{${pkg}} to it?`, [`Add ${pkg}`, 'Insert anyway', 'Cancel'])
  if (r === 2 || r === -1) return false
  if (r === 1) return true
  const line = `\\usepackage{${pkg}}\n`
  const place = (text: string): number => {
    const m = [...text.matchAll(/^\\usepackage.*$/gm)].pop()
    if (m) return m.index! + m[0].length + 1
    const b = text.indexOf('\\begin{document}')
    return b >= 0 ? b : 0
  }
  const f = files.get(main)
  if (f) {
    const st = stateOf(main)!
    const tr = st.update({ changes: { from: place(st.doc.toString()), insert: line } })
    if (main === active) view.dispatch(tr)
    else f.state = tr.state
    f.dirty = true
    renderTabs()
  } else {
    const text = await api.readFile(main)
    const at = place(text)
    await api.writeFile(main, text.slice(0, at) + line + text.slice(at))
  }
  mainTextCache = mainText()
  setCompileStatus(`Added \\usepackage{${pkg}} to ${main}`, 'ok')
  return true
}

function updatePanelButtons(): void {
  // Comment highlights show only while the Comments panel is open (adding a comment reopens it).
  document.body.classList.toggle('comments-off', !layout.isVisible('comments'))
  $('btn-sidebar').classList.toggle('on', layout.isVisible('files'))
  $('btn-pdf').classList.toggle('on', layout.isVisible('pdf'))
}

function panelsMenu(): void {
  const r = $('btn-panels').getBoundingClientRect()
  const items: [string, () => void][] = layout.ids().map((id) => [`${layout.isShown(id) ? '✓' : '\u2003'}  ${layout.title(id)}`, () => (layout.isShown(id) ? layout.hide(id) : layout.show(id))])
  items.push(['Reset layout', () => layout.reset()])
  contextMenu(r.left - 120, r.bottom + 4, items)
}

// ---------- Importing: references ----------
const FORMAT_NAMES: Record<RefFormat, string> = { 'endnote-xml': 'EndNote XML', ris: 'RIS', 'csl-json': 'CSL JSON (Zotero)', bibtex: 'BibTeX' }

/** A modal built from HTML; resolves with the clicked button's value (or '' on Escape). */
function modal(html: string, setup?: (d: HTMLDialogElement) => void): Promise<string> {
  const d = $<HTMLDialogElement>('modal')
  d.innerHTML = html
  setup?.(d)
  return new Promise((resolve) => {
    let value = ''
    d.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((b) =>
      b.addEventListener('click', () => {
        value = b.dataset.value!
        d.close()
      })
    )
    d.addEventListener('close', () => resolve(value), { once: true })
    d.showModal()
  })
}

async function importRefs(file?: { name: string; text: string }): Promise<void> {
  if (!project) {
    await ask('Open your paper’s folder first (File → Open Folder…), then import references into it.', ['OK'])
    return
  }
  if (!file) {
    const go = await modal(`<div class="modal-body import">
      <p><b>Import references</b></p>
      <p>Choose a reference library exported from EndNote, Zotero, Mendeley, Web of Science or PubMed. OpenTex adds the references to your <code>.bib</code> file so you can cite them with <code>\\cite{…}</code>.</p>
      <div class="howto"><b>From EndNote</b><ol><li>Select all references (<kbd>Ctrl/Cmd</kbd>+<kbd>A</kbd>).</li><li>Choose <b>File → Export…</b></li><li>Set <b>Save as type</b> (Windows) or <b>Format</b> (Mac) to <b>XML</b>, and save.</li></ol></div>
      <div class="howto"><b>From Zotero or Mendeley</b><ol><li>Select the references or collection.</li><li>Choose <b>Export…</b> and pick <b>BibTeX</b> or <b>RIS</b>.</li></ol></div>
      <p class="hint">You can also drag the exported file onto the OpenTex window.</p>
    </div><div class="modal-actions"><button data-value="">Cancel</button><button class="primary" data-value="choose">Choose file…</button></div>`)
    if (go !== 'choose') return
    try {
      file = (await api.chooseRefs()) ?? undefined
    } catch (e) {
      await ask((e as Error).message.replace(/^.*Error: /, ''), ['OK'])
      return
    }
    if (!file) return
  }
  const fmt = detectFormat(file.text, file.name)
  if (!fmt) {
    await ask(`OpenTex couldn’t recognize “${file.name}” as a reference library. From EndNote, export as XML; from Zotero or Mendeley, export as BibTeX or RIS.`, ['OK'])
    return
  }
  let refs
  try {
    refs = parseRefs(file.text, fmt)
  } catch (e) {
    await ask((e as Error).message, ['OK'])
    return
  }
  if (!refs.length) {
    await ask(`No references were found in “${file.name}”.`, ['OK'])
    return
  }
  const bibs = allFiles(project.tree, (p) => p.endsWith('.bib'))
  const options = [...bibs.map((b) => `<option value="${b}">${b}</option>`), `<option value="__new">New file: refs.bib</option>`].join('')
  let target = ''
  const go = await modal(
    `<div class="modal-body import"><p><b>Found ${refs.length} reference${refs.length === 1 ? '' : 's'}</b> in <span data-name></span> (${FORMAT_NAMES[fmt]}).</p>
     <p><label>Add them to <select data-target>${options}</select></label></p>
     <p class="hint">References already in that file (same DOI, or same title and year) are skipped.</p></div>
     <div class="modal-actions"><button data-value="">Cancel</button><button class="primary" data-value="go">Import</button></div>`,
    (d) => {
      d.querySelector('[data-name]')!.textContent = `“${file!.name}”`
      const sel = d.querySelector<HTMLSelectElement>('[data-target]')!
      target = sel.value
      sel.onchange = () => (target = sel.value)
    }
  )
  if (go !== 'go') return
  let bibPath = target
  if (target === '__new') {
    bibPath = 'refs.bib'
    for (let i = 2; bibs.includes(bibPath); i++) bibPath = `refs-${i}.bib`
  }
  if (files.get(bibPath)?.dirty) await save(bibPath, false)
  const existing = bibs.includes(bibPath) ? await api.readFile(bibPath) : ''
  const merged = mergeIntoBib(existing, refs)
  if (merged.added.length) await api.writeFile(bibPath, merged.text)
  await reloadTree()
  await onDiskChange([bibPath])
  await refreshIndex()
  const base = bibPath.replace(/\.bib$/, '')
  const mainText = project.mainFile ? (textOf(project.mainFile) ?? (await api.readFile(project.mainFile).catch(() => ''))) : ''
  const hasBib = new RegExp(`\\\\(bibliography|addbibresource)\\{[^}]*${base.split('/').pop()}`).test(mainText)
  const summary = `Added ${merged.added.length} reference${merged.added.length === 1 ? '' : 's'} to ${bibPath}${merged.duplicates ? ` (${merged.duplicates} already there)` : ''}. Type \\cite{ to use them.`
  if (merged.added.length && project.mainFile && !hasBib && /\\end\{document\}/.test(mainText)) {
    const r = await ask(`${summary}\n\nYour main file doesn’t list ${bibPath} yet. Add a bibliography at the end of ${project.mainFile}?`, ['Add bibliography', 'Not now'])
    if (r === 0) {
      await openFile(project.mainFile)
      const doc = view.state.doc.toString()
      const at = doc.lastIndexOf('\\end{document}')
      view.dispatch({ changes: { from: at, insert: `\\bibliographystyle{plain}\n\\bibliography{${base}}\n\n` } })
      await save(project.mainFile)
    }
  } else await ask(summary, ['OK'])
}

// ---------- Importing: Word ----------
async function importWordDoc(docx?: string): Promise<void> {
  docx = docx ?? (await api.chooseWord()) ?? undefined
  if (!docx) return
  if (!/\.docx$/i.test(docx)) {
    await ask('Only .docx files can be imported. In Word, open the document and use File → Save As → Word Document (.docx) first.', ['OK'])
    return
  }
  const name = docx.split(/[\\/]/).pop()!
  let parent = docx.replace(/[\\/][^\\/]+$/, '')
  let keepComments = true
  const go = await modal(
    `<div class="modal-body import"><p><b>Import <span data-name></span></b></p>
     <p>OpenTex makes a new project folder with <code>main.tex</code>, a <code>media</code> folder for the figures and, if the document has Zotero, Mendeley or EndNote citations, a <code>refs.bib</code>. Your Word file isn’t changed.</p>
     <p>New folder goes in: <code data-parent></code> <button class="link" data-change>Change…</button></p>
     <p><label><input type="checkbox" data-comments checked /> Keep Word comments as OpenTex comments</label></p>
     <p class="hint">Tracked changes are accepted. Equations become LaTeX math.</p></div>
     <div class="modal-actions"><button data-value="">Cancel</button><button class="primary" data-value="go">Import</button></div>`,
    (d) => {
      d.querySelector('[data-name]')!.textContent = `“${name}”`
      d.querySelector('[data-parent]')!.textContent = parent
      d.querySelector<HTMLButtonElement>('[data-change]')!.onclick = async () => {
        const p = await api.chooseFolder('Where should the new project folder go?', parent)
        if (p) {
          parent = p
          d.querySelector('[data-parent]')!.textContent = p
        }
      }
      const cb = d.querySelector<HTMLInputElement>('[data-comments]')!
      cb.onchange = () => (keepComments = cb.checked)
    }
  )
  if (go !== 'go') return
  if (!(await api.findPandoc())) {
    const r = await ask(
      'To convert Word files, OpenTex uses Pandoc, a free, widely used document converter (about 35 MB). OpenTex can download it from the Pandoc project on GitHub and keep it in its own folder. No administrator password is needed.',
      ['Download Pandoc', 'I’ll install it myself', 'Cancel']
    )
    if (r === 1) {
      window.open('https://pandoc.org/installing.html')
      await ask('Install Pandoc (the Windows .msi installs just for you without admin rights), then try the import again.', ['OK'])
      return
    }
    if (r !== 0) return
    const ok = await withProgress('Getting Pandoc', () => api.installPandoc())
    if (!ok) {
      await ask('Pandoc could not be downloaded (your network may block it). You can install it from pandoc.org instead, then import again.', ['OK'])
      return
    }
  }
  type Res = { ok: boolean; folder: string; log: string; citations: number; comments: number; images: number; unsupportedImages: string[] }
  let res: Res | null = null
  const ok = await withProgress(`Converting ${name}`, async () => {
    progressSink?.('Converting with Pandoc…')
    try {
      res = (await api.importWord(docx!, parent, keepComments)) as Res
    } catch (e) {
      progressSink?.((e as Error).message.replace(/^.*Error: /, ''))
      return false
    }
    if (res.log.trim()) progressSink?.(res.log.trim())
    progressSink?.(res.ok ? `Created ${res.folder}` : 'The conversion did not finish.')
    return res.ok
  })
  const r = res as Res | null
  if (!ok || !r) return
  autoMigrate = true // Word comments arrive as %@comment lines; move them into the comments file
  await setProject(await api.openProject(r.folder))
  const parts = [`${r.images} figure${r.images === 1 ? '' : 's'}`, `${r.comments} comment${r.comments === 1 ? '' : 's'}`, `${r.citations} reference${r.citations === 1 ? '' : 's'}`]
  let msg = `Imported ${name}: ${parts.join(', ')}. OpenTex will compile it now. Look over the result, especially tables and figure placement.`
  if (!r.citations) msg += '\n\nNo linked citations were found. If the document cites from EndNote, use File → Import References to bring in the library.'
  if (r.unsupportedImages.length) msg += `\n\n${r.unsupportedImages.length} picture(s) are in a Windows-only format LaTeX can’t use (${r.unsupportedImages.join(', ')}). In Word, right-click each one → Save as Picture → PNG, and put it in the media folder.`
  await ask(msg, ['OK'])
  compile()
}

// Drop files onto the window: .docx → Word import; reference libraries → reference import.
document.addEventListener(
  'dragover',
  (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  },
  true
)
document.addEventListener(
  'drop',
  async (e) => {
    const f = e.dataTransfer?.files?.[0]
    if (!f) return
    e.preventDefault()
    e.stopPropagation()
    if (/\.docx$/i.test(f.name)) {
      const path = api.pathForFile(f)
      if (path) importWordDoc(path)
      else ask('Save the Word file to your computer first, then drag it from Finder or File Explorer (or use File → Import Word Document…).', ['OK'])
    }
    else if (/\.(xml|ris|bib|json|txt|nbib|enw)$/i.test(f.name)) importRefs({ name: f.name, text: await f.text() })
    else if (/\.doc$/i.test(f.name)) ask('Old .doc files can’t be imported. In Word, use File → Save As → Word Document (.docx) first.', ['OK'])
  },
  true
)

// ---------- Welcome page, new projects, closing folders ----------
async function showWelcome(): Promise<void> {
  project = null
  store = []
  storeText = ''
  detached.clear()
  files.clear()
  tabOrder = []
  active = null
  lastPdf = null
  view.setState(EditorState.create({ doc: '', extensions }))
  renderTabs()
  pdf.clear()
  showProblems([], false)
  if (focusOn) setFocus(false)
  $('project-name').textContent = 'OpenTex'
  document.body.classList.add('no-project')
  $('welcome').classList.remove('hidden')
  const list = $('wl-recent')
  const recent = await api.recentProjects()
  if (!recent.length) {
    list.innerHTML = '<li class="empty">Folders you open will appear here.</li>'
    return
  }
  list.replaceChildren(
    ...recent.map((r) => {
      const li = document.createElement('li')
      li.innerHTML = `<button class="open"><span class="name"></span><span class="path"></span></button><button class="side" data-act="window" title="Open in a new window">New window</button><button class="side" data-act="forget" title="Remove from this list">✕</button>`
      li.querySelector('.name')!.textContent = r.name
      li.querySelector('.path')!.textContent = r.parent
      li.title = r.path
      li.querySelector<HTMLButtonElement>('.open')!.onclick = async () => setProject(await api.openProject(r.path))
      li.querySelector<HTMLButtonElement>('[data-act=window]')!.onclick = () => api.newWindow(r.path)
      li.querySelector<HTMLButtonElement>('[data-act=forget]')!.onclick = async () => {
        await api.forgetRecent(r.path)
        showWelcome()
      }
      return li
    })
  )
}

async function closeFolder(): Promise<void> {
  if (!project || !(await confirmDiscardAll())) return
  await api.closeProject()
  await showWelcome()
}

async function newProject(preset: 'blank' | 'example-paper' = 'blank'): Promise<void> {
  let parent = await api.defaultProjectParent()
  let template: 'blank' | 'example-paper' = preset
  let name = preset === 'blank' ? 'My Paper' : 'Example Paper'
  const go = await modal(
    `<div class="modal-body import"><p><b>New project</b></p>
     <div class="np-grid">
       <label for="np-name">Name</label><input type="text" id="np-name" />
       <span>Location</span><span><code data-parent></code> <button class="link" data-change>Change…</button></span>
       <div class="np-template">
         <label><input type="radio" name="np-t" value="blank" /> Blank paper<small>Title, abstract and the usual sections, ready to fill in</small></label>
         <label><input type="radio" name="np-t" value="example-paper" /> Example paper<small>A short paper full of LaTeX tips, to learn from</small></label>
       </div>
     </div></div>
     <div class="modal-actions"><button data-value="">Cancel</button><button class="primary" data-value="go">Create</button></div>`,
    (d) => {
      const input = d.querySelector<HTMLInputElement>('#np-name')!
      input.value = name
      input.oninput = () => (name = input.value)
      d.querySelector('[data-parent]')!.textContent = parent
      d.querySelector<HTMLButtonElement>('[data-change]')!.onclick = async () => {
        const p = await api.chooseFolder('Where should the new project folder go?', parent)
        if (p) {
          parent = p
          d.querySelector('[data-parent]')!.textContent = p
        }
      }
      d.querySelectorAll<HTMLInputElement>('input[name=np-t]').forEach((r) => {
        r.checked = r.value === template
        r.onchange = () => {
          template = r.value as typeof template
          if (input.value === 'My Paper' || input.value === 'Example Paper') input.value = name = template === 'blank' ? 'My Paper' : 'Example Paper'
        }
      })
      setTimeout(() => input.select())
    }
  )
  if (go !== 'go') return
  let folder: string
  try {
    folder = await api.createProject(parent, name, template)
  } catch (e) {
    await ask((e as Error).message.replace(/^.*Error: /, ''), ['OK'])
    return
  }
  await setProject(await api.openProject(folder))
  if (project) compile()
}

async function openExample(): Promise<void> {
  const folder = await api.exampleProject()
  await setProject(await api.openProject(folder))
  if (project) compile()
}

// ---------- Wiring ----------
async function chooseFolder(): Promise<void> {
  await setProject(await api.chooseProject())
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const actions: Record<string, (...args: any[]) => unknown> = {
  'new-project': () => newProject(),
  'open-example': () => openExample(),
  'open-path': async (path: string) => setProject(await api.openProject(path)),
  'close-folder': () => closeFolder(),
  'stop-compile': () => api.cancelCompile(),
  'open-folder': chooseFolder,
  'new-file': () => newFile(),
  save: () => save(),
  'close-tab': () => active && closeTab(active),
  settings: () => openSettings(settings, themes, tex, api, updateSettings, allPlugins),
  focus: () => project && setFocus(!focusOn),
  'toggle-sidebar': () => layout.toggle('files'),
  'toggle-pdf': () => layout.toggle('pdf'),
  compile: () => compile(),
  'add-comment': () => addComment(),
  'install-tinytex': () => installTinyTex(),
  'import-word': () => importWordDoc(),
  'import-refs': () => importRefs(),
  'show-comments': () => layout.show('comments'),
  'sync-forward': () => syncForward(),
  'show-insert': () => updateSettings({ showInsertBar: !settings.showInsertBar }),
  'insert-table': () => openInsertTool('table'),
  'insert-figure': () => openInsertTool('figure'),
  'insert-symbol': () => openInsertTool('symbol'),
  insert: (kind: string) => {
    if (!active?.endsWith('.tex')) return setCompileStatus('Open a .tex file first', 'warn')
    if (kind === 'equation') insertAtCursor(view, '\\begin{equation}\n  ¦\n  \\label{eq:}\n\\end{equation}', { ownLine: true })
    else if (kind === 'inline-math') insertAtCursor(view, '$¦$')
    else document.querySelector<HTMLButtonElement>(`#ribbon [data-tool="${kind}"]`)?.click()
  },
  'zoom-in': () => zoom(1),
  'zoom-out': () => zoom(-1),
  'zoom-reset': () => zoom(0),
  'show-log': () => {
    $('log-text').textContent = lastLog || 'No compile yet.'
    ;($('log-dialog') as HTMLDialogElement).showModal()
  }
}

function wire(): void {
  api.on('menu', (a: string, ...args: unknown[]) => actions[a]?.(...args))
  api.on('settings:changed', (s: Settings, info?: { enabledPlugin?: string | null }) => {
    const pluginsChanged = JSON.stringify(s.disabledPlugins) !== JSON.stringify(settings.disabledPlugins)
    settings = s
    applySettings()
    api.setZoom(s.uiZoom || 1)
    if (pluginsChanged) {
      plugins.setPlugins(allPlugins, s.disabledPlugins ?? [])
      ribbon?.renderPlugins()
    }
    // A plugin just switched on from the Plugins menu: show its panel.
    if (info?.enabledPlugin && project) layout.show(`plugin:${info.enabledPlugin}`)
  })
  api.on('tex:progress', (line: string) => progressSink?.(line))
  api.on('project:changed', (paths: string[]) => onDiskChange(paths))
  api.on('app:before-close', async () => {
    if (await confirmDiscardAll()) api.closeOk()
  })
  $('btn-open').onclick = chooseFolder
  $('btn-import-word').onclick = () => importWordDoc()
  $('wl-new').onclick = () => newProject()
  $('wl-example').onclick = () => openExample()
  $('wl-window').onclick = () => api.newWindow()
  // Show the right shortcut for this system.
  const newWindowKeys = navigator.platform.startsWith('Mac') ? '⇧⌘N' : 'Ctrl+Shift+N'
  document.querySelectorAll('[data-keys=new-window]').forEach((el) => (el.textContent = newWindowKeys))
  $('btn-compile').onclick = () => compile()
  $('btn-focus').onclick = () => actions.focus()
  $('focus-exit').onclick = () => setFocus(false)
  $('btn-sidebar').onclick = actions['toggle-sidebar']
  $('btn-pdf').onclick = actions['toggle-pdf']
  $('btn-new-file').onclick = () => newFile()
  ribbon = new Ribbon($('ribbon'), {
    run: (a) => (a === 'new-window' ? api.newWindow() : actions[a]?.()),
    recentMenu: async (x, y) => {
      const recent = await api.recentProjects()
      contextMenu(x, y, recent.length ? recent.map((r) => [`${r.name}   ·   ${r.parent}`, async () => setProject(await api.openProject(r.path))] as [string, () => void]) : [['No recent folders', () => {}]])
    },
    plugins: () => ({ list: allPlugins, disabled: settings.disabledPlugins ?? [] }),
    setPlugin: (id, on) => api.setPluginEnabled(id, on),
    openPluginsFolder: () => api.openPluginsFolder(),
    design: () => ({ current: project?.mainFile ? currentDesign(mainText()) : null, hasCustom: Boolean(project?.config.design?.custom) }),
    applyDesign: (id) => applyDesignPreset(id),
    editPreamble: async () => {
      if (!project?.mainFile) return
      await openFile(project.mainFile)
      goToLine(view, 1)
    }
  })
  buildInsertBar($('rb-insert'), $('ins-pop'), {
    view: () => (active?.endsWith('.tex') ? view : null),
    images: () => (project ? allFiles(project.tree, (p) => /\.(png|jpe?g|eps|pdf)$/i.test(p) && p !== lastPdf && p !== project!.mainFile?.replace(/\.tex$/i, '.pdf')) : []),
    hasPackage,
    ensurePackage,
    notice: (m) => setCompileStatus(m, 'warn')
  })
  $('btn-panels').onclick = (e) => {
    e.stopPropagation()
    panelsMenu()
  }
  $('show-resolved').onchange = () => renderComments()
  const bubble = $('comment-bubble')
  bubble.addEventListener('pointerdown', (e) => e.preventDefault()) // keep the selection
  bubble.onclick = () => (bubble.dataset.source === 'pdf' ? commentFromPdf() : addComment())
  $('editor').addEventListener('scroll', hideBubble, true)
  $('pdf').addEventListener('scroll', hideBubble)
  api.on('context-menu', (p: { misspelled: string; suggestions: string[] }) => showContextMenu(p))
  $('btn-log').onclick = actions['show-log']
  $('btn-problems-close').onclick = () => $('problems').classList.add('hidden')
  $('st-compile').onclick = () => problems.length && $('problems').classList.toggle('hidden')
  $('pdf-zoom-in').onclick = () => pdf.zoomBy(1.2)
  $('pdf-zoom-out').onclick = () => pdf.zoomBy(1 / 1.2)
  $('pdf-fit').onclick = () => pdf.setZoom('fit')
  $('st-main').onchange = (e) => setMainFile((e.target as HTMLSelectElement).value)
  $('engine').onchange = async (e) => {
    if (project) project.config = await api.setProjectConfig({ engine: (e.target as HTMLSelectElement).value })
  }
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('dialog') as HTMLDialogElement).close()))
}

async function init(): Promise<void> {
  settings = await api.getSettings()
  themes = [...BUILT_IN, ...((await api.userThemes()) as Theme[])]
  applySettings()
  api.setZoom(settings.uiZoom || 1)
  wire()
  allPlugins = await api.listPlugins()
  setupPanels(settings.layout)
  plugins.setPlugins(allPlugins, settings.disabledPlugins ?? [])
  ribbon?.renderPlugins() // the list wasn't loaded yet when the ribbon was first drawn
  await refreshTex()
  if (!tex.found) {
    const r = await ask('OpenTex needs a TeX installation to turn your .tex files into PDFs, and none was found on this computer.', [
      'Install TinyTeX (recommended)',
      'I have TeX: choose its folder',
      'Not now'
    ])
    if (r === 0) await installTinyTex()
    if (r === 1) openSettings(settings, themes, tex, api, updateSettings, allPlugins)
  }
  // A window opened for a specific folder (File → Open Folder in New Window, Recent → New window).
  const open = new URLSearchParams(location.search).get('open')
  if (open) await setProject(await api.openProject(open))
  if (!project) await showWelcome()
}

init()
