import './styles.css'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { CompileResult, Engine, Problem, ProjectInfo, Settings, TexInfo, Theme, TreeNode } from '../../shared/types'
import type { OpenTexApi } from '../../preload/index'
import { dimCompartment, dimExtension, goToLine, makeExtensions } from './editor'
import { allFiles, isTextFile, renderTree } from './filetree'
import { PdfView } from './pdfview'
import { openSettings } from './settings-ui'
import { applyTheme, BUILT_IN } from './themes'
import { ask, contextMenu, promptText } from './ui'

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

const extensions = makeExtensions(
  {
    onChange: () => {
      const f = active && files.get(active)
      if (f && !f.dirty) {
        f.dirty = true
        renderTabs()
      }
    },
    onCursor: (line, col) => ($('st-cursor').textContent = `Ln ${line}, Col ${col}`)
  },
  false
)
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
  view.dispatch({ effects: dimCompartment.reconfigure(dimExtension(focusOn && settings.focusDim)) })
  view.requestMeasure()
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  settings = await api.setSettings(patch)
  applySettings()
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
  $('welcome').classList.add('hidden')
  ;($('engine') as HTMLSelectElement).value = info.config.engine ?? settings.engine
  refreshProjectUi()
  if (info.mainFile) {
    await openFile(info.mainFile)
    const pdfPath = info.mainFile.replace(/\.tex$/i, '.pdf')
    if (allFiles(info.tree, (p) => p === pdfPath).length) await showPdf(pdfPath)
  }
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
  }
  switchTo(path)
}

function switchTo(path: string): void {
  if (active && files.has(active)) files.get(active)!.state = view.state
  active = path
  view.setState(files.get(path)!.state)
  view.dispatch({ effects: dimCompartment.reconfigure(dimExtension(focusOn && settings.focusDim)) })
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
  renderTabs()
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
      renderTabs()
    } else {
      setCompileStatus(`${p} changed on disk; your unsaved edits are kept`, 'warn')
    }
  }
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
    document.body.classList.remove('no-pdf')
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

// ---------- Splitters ----------
function setupSplitters(): void {
  const saved = (k: string): string | null => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  }
  const sw = saved('sidebar-w')
  const pw = saved('pdf-w')
  if (sw) document.documentElement.style.setProperty('--sidebar-w', sw)
  if (pw) document.documentElement.style.setProperty('--pdf-w', pw)
  document.querySelectorAll<HTMLElement>('.splitter').forEach((sp) => {
    sp.addEventListener('pointerdown', (e) => {
      const target = $(sp.dataset.target!)
      const isPdf = sp.dataset.target === 'pdf-col'
      const startX = e.clientX
      const startW = target.getBoundingClientRect().width
      sp.setPointerCapture(e.pointerId)
      sp.classList.add('dragging')
      const move = (ev: PointerEvent): void => {
        const w = Math.max(140, startW + (isPdf ? startX - ev.clientX : ev.clientX - startX))
        document.documentElement.style.setProperty(isPdf ? '--pdf-w' : '--sidebar-w', `${w}px`)
      }
      const up = (): void => {
        sp.classList.remove('dragging')
        sp.removeEventListener('pointermove', move)
        const k = isPdf ? 'pdf-w' : 'sidebar-w'
        try {
          localStorage.setItem(k, document.documentElement.style.getPropertyValue(`--${k}`))
        } catch {
          /* storage unavailable; widths just won't persist */
        }
      }
      sp.addEventListener('pointermove', move)
      sp.addEventListener('pointerup', up, { once: true })
    })
  })
}

// ---------- Wiring ----------
async function chooseFolder(): Promise<void> {
  await setProject(await api.chooseProject())
}

const actions: Record<string, () => unknown> = {
  'open-folder': chooseFolder,
  'new-file': () => newFile(),
  save: () => save(),
  'close-tab': () => active && closeTab(active),
  settings: () => openSettings(settings, themes, tex, api, updateSettings),
  focus: () => project && setFocus(!focusOn),
  'toggle-sidebar': () => document.body.classList.toggle('no-sidebar'),
  'toggle-pdf': () => document.body.classList.toggle('no-pdf'),
  compile: () => compile(),
  'show-log': () => {
    $('log-text').textContent = lastLog || 'No compile yet.'
    ;($('log-dialog') as HTMLDialogElement).showModal()
  }
}

function wire(): void {
  api.on('menu', (a: string) => actions[a]?.())
  api.on('project:changed', (paths: string[]) => onDiskChange(paths))
  api.on('app:before-close', async () => {
    if (await confirmDiscardAll()) api.closeOk()
  })
  $('btn-open').onclick = chooseFolder
  $('btn-compile').onclick = () => compile()
  $('btn-focus').onclick = () => actions.focus()
  $('focus-exit').onclick = () => setFocus(false)
  $('btn-sidebar').onclick = actions['toggle-sidebar']
  $('btn-pdf').onclick = actions['toggle-pdf']
  $('btn-settings').onclick = actions.settings
  $('btn-new-file').onclick = () => newFile()
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
  setupSplitters()
}

async function init(): Promise<void> {
  settings = await api.getSettings()
  themes = [...BUILT_IN, ...((await api.userThemes()) as Theme[])]
  applySettings()
  wire()
  await refreshTex()
  if (settings.lastProject) await setProject(await api.openProject(settings.lastProject))
}

init()
