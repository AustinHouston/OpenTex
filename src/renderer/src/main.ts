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
import { CommentThread, commentHighlight, entryLine, parseComments } from './comments'
import { CompletionData, countWords, scanBib, scanTex, spellCompartment, spellExtension } from './assist'
import { PluginPanels } from './panels'
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
    },
    onCursor: (line, col) => ($('st-cursor').textContent = `Ln ${line}, Col ${col}`),
    onSelection: () => placeBubble()
  },
  false,
  () => completion
), commentHighlight]
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
  $('welcome').classList.add('hidden')
  ;($('engine') as HTMLSelectElement).value = info.config.engine ?? settings.engine
  refreshProjectUi()
  scheduleComments()
  refreshIndex()
  refreshGit()
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
  view.dispatch({ effects: [dimCompartment.reconfigure(dimExtension(focusOn && settings.focusDim)), spellCompartment.reconfigure(spellExtension(settings.spellcheck))] })
  hideBubble()
  updateWords()
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
  if (paths.some((p) => p.endsWith('.tex'))) scheduleComments()
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

// ---------- Comments ----------
let commentsTimer = 0
function scheduleComments(): void {
  clearTimeout(commentsTimer)
  commentsTimer = window.setTimeout(renderComments, 400)
}

function textOf(path: string): string | null {
  if (path === active) return view.state.doc.toString()
  return files.get(path)?.state.doc.toString() ?? null
}

async function allThreads(): Promise<CommentThread[]> {
  if (!project) return []
  const out: CommentThread[] = []
  for (const f of allFiles(project.tree, (p) => p.endsWith('.tex'))) {
    const text = textOf(f) ?? (await api.readFile(f).catch(() => ''))
    if (text.includes('%@')) out.push(...parseComments(text, f))
  }
  return out
}

async function renderComments(): Promise<void> {
  const threads = await allThreads()
  const open = threads.filter((t) => !t.resolved).length
  $('comment-count').textContent = open ? String(open) : ''
  $('btn-comment').innerHTML = $('btn-comment').innerHTML.replace(/<span class="count">.*?<\/span>/, '') + (open ? `<span class="count">${open}</span>` : '')
  if (!layout.isVisible('comments')) return
  const showResolved = ($('show-resolved') as HTMLInputElement).checked
  const list = $('comments-list')
  const shown = threads.filter((t) => showResolved || !t.resolved)
  if (!shown.length) {
    list.innerHTML = `<div class="c-empty">${threads.length ? 'No open comments.' : 'No comments yet. Select some text in the editor or the PDF and click <b>+ Comment</b>, or right-click it. You can also press Ctrl/Cmd+Shift+M on any line.'}</div>`
    return
  }
  list.replaceChildren(
    ...shown.map((t) => {
      const card = document.createElement('div')
      card.className = `c-card${t.resolved ? ' resolved' : ''}`
      const entry = (e: { author: string; date: string; text: string }, cls = ''): HTMLElement => {
        const d = document.createElement('div')
        d.className = cls
        d.innerHTML = `<div class="c-meta"><b></b><span></span></div><div class="c-text"></div>`
        d.querySelector('b')!.textContent = e.author || 'Anonymous'
        d.querySelector('.c-meta span')!.textContent = e.date
        d.querySelector('.c-text')!.textContent = e.text
        return d
      }
      if (t.quote) {
        const q = document.createElement('div')
        q.className = 'c-quote'
        q.textContent = `“${t.quote}”`
        card.appendChild(q)
      }
      card.appendChild(entry(t))
      t.replies.forEach((r) => card.appendChild(entry(r, 'c-reply')))
      const ctx = document.createElement('div')
      ctx.className = 'c-ctx'
      ctx.textContent = `${t.file}:${t.targetLine}  ${t.context}`
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
      btn('Reply', () => commentAction(t, 'reply'))
      btn(t.resolved ? 'Reopen' : 'Resolve', () => commentAction(t, t.resolved ? 'reopen' : 'resolve'))
      btn('Delete', () => commentAction(t, 'delete'))
      card.appendChild(actions)
      card.onclick = async () => {
        await openFile(t.file)
        goToLine(view, t.targetLine)
      }
      return card
    })
  )
}

async function authorName(): Promise<string | null> {
  if (settings.authorName) return settings.authorName
  const name = await promptText('Your name, shown on comments you write:', '')
  if (name) await updateSettings({ authorName: name })
  return name
}

/**
 * Add a comment. With no target it uses the editor selection (or the cursor's line).
 * From the PDF, `target` names the source file and line found with SyncTeX.
 */
async function addComment(target?: { file: string; line: number; quote: string }): Promise<void> {
  if (!target && (!active || !active.endsWith('.tex'))) {
    await ask('Open a .tex file and select the text (or put the cursor on the line) you want to comment on.', ['OK'])
    return
  }
  const sel = view.state.selection.main
  const quote = target ? target.quote : view.state.sliceDoc(sel.from, sel.to)
  const fromPos = sel.from
  hideBubble()
  const name = await authorName()
  if (!name) return
  const text = await promptText(quote ? `Comment on “${quote.length > 80 ? quote.slice(0, 80) + '…' : quote}”:` : 'Comment:')
  if (!text) return
  if (target) {
    await openFile(target.file)
    goToLine(view, target.line)
  }
  const line = target ? view.state.doc.line(Math.min(target.line, view.state.doc.lines)) : view.state.doc.lineAt(fromPos)
  const indent = line.text.match(/^\s*/)![0]
  view.dispatch({ changes: { from: line.from, insert: entryLine('comment', name, text, indent, quote) + '\n' } })
  layout.show('comments')
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
    if (!sel.empty || !items.length) items.push([sel.empty ? 'Add comment on this line' : 'Add comment on selection', () => addComment()])
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

function updatePanelButtons(): void {
  $('btn-sidebar').classList.toggle('on', layout.isVisible('files'))
  $('btn-pdf').classList.toggle('on', layout.isVisible('pdf'))
  $('btn-comment').classList.toggle('on', layout.isVisible('comments'))
}

function panelsMenu(): void {
  const r = $('btn-panels').getBoundingClientRect()
  const items: [string, () => void][] = layout.ids().map((id) => [`${layout.isShown(id) ? '✓' : '\u2003'}  ${layout.title(id)}`, () => (layout.isShown(id) ? layout.hide(id) : layout.show(id))])
  items.push(['Reset layout', () => layout.reset()])
  contextMenu(r.left - 120, r.bottom + 4, items)
}

/** Edit a thread in the editor (so it can be undone), after re-finding it in the current text. */
async function commentAction(t: CommentThread, kind: 'reply' | 'resolve' | 'reopen' | 'delete'): Promise<void> {
  let reply = ''
  let name = ''
  if (kind === 'reply') {
    name = (await authorName()) ?? ''
    if (!name) return
    reply = (await promptText('Reply:')) ?? ''
    if (!reply) return
  }
  if (kind === 'delete' && (await ask('Delete this comment thread?', ['Delete', 'Cancel'])) !== 0) return
  await openFile(t.file)
  const cur = parseComments(view.state.doc.toString(), t.file).find((x) => x.line === t.line && x.text === t.text)
  if (!cur) {
    scheduleComments()
    return
  }
  const doc = view.state.doc
  const end = doc.line(cur.endLine)
  if (kind === 'reply') {
    // Replies go before the resolved marker, if any.
    const at = cur.resolved ? doc.line(cur.endLine - 1).to : end.to
    view.dispatch({ changes: { from: at, insert: '\n' + entryLine('reply', name, reply, cur.indent) } })
  } else if (kind === 'resolve') {
    view.dispatch({ changes: { from: end.to, insert: `\n${cur.indent}%@resolved` } })
  } else if (kind === 'reopen') {
    view.dispatch({ changes: { from: doc.line(cur.endLine - 1).to, to: end.to } })
  } else {
    const start = doc.line(cur.line).from
    view.dispatch({ changes: { from: start, to: Math.min(end.to + 1, doc.length) } })
  }
  scheduleComments()
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
  settings: () => openSettings(settings, themes, tex, api, updateSettings, allPlugins),
  focus: () => project && setFocus(!focusOn),
  'toggle-sidebar': () => layout.toggle('files'),
  'toggle-pdf': () => layout.toggle('pdf'),
  compile: () => compile(),
  'add-comment': () => addComment(),
  'install-tinytex': () => installTinyTex(),
  'show-comments': () => layout.show('comments'),
  'sync-forward': () => syncForward(),
  'zoom-in': () => zoom(1),
  'zoom-out': () => zoom(-1),
  'zoom-reset': () => zoom(0),
  'show-log': () => {
    $('log-text').textContent = lastLog || 'No compile yet.'
    ;($('log-dialog') as HTMLDialogElement).showModal()
  }
}

function wire(): void {
  api.on('menu', (a: string) => actions[a]?.())
  api.on('tex:progress', (line: string) => progressSink?.(line))
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
  $('btn-comment').onclick = () => layout.toggle('comments')
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
  if (settings.lastProject) await setProject(await api.openProject(settings.lastProject))
}

init()
