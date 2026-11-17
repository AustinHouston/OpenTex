// The ribbon across the top, like Word: tabs (File, Insert, Design, Citations, Review, Plugins,
// Settings) with buttons in each. The Insert tab is built in insert.ts; this file builds the tabs
// and the other panes. Citations and Review are built the first time they are shown.

import type { EditorView } from '@codemirror/view'
import { startCompletion } from '@codemirror/autocomplete'
import type { PluginInfo } from '../../shared/types'
import { designThumb, PRESETS } from './design'
import { insertAtCursor } from './insert'

export interface RibbonHost {
  run: (action: string) => void
  recentMenu: (x: number, y: number) => void // Open Folder…, the recent folders, Example Paper, Close Folder
  bibMenu: (x: number, y: number) => void // open the project's .bib file (choose one if there are several)
  view: () => EditorView | null // null when no .tex file is open
  notice: (msg: string) => void
  plugins: () => { list: PluginInfo[]; disabled: string[] }
  setPlugin: (id: string, on: boolean) => void
  openPluginsFolder: () => void
  design: () => { current: string | null; hasCustom: boolean } // current is null when there's no main file
  applyDesign: (id: string) => void
  editPreamble: () => void
}

const I = (d: string): string => `<svg viewBox="0 0 20 20">${d}</svg>`
const ICON = {
  newProject: I('<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M10 9v6M7 12h6"/>'),
  recent: I('<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>'),
  word: I('<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M7 9.5l1 4 2-3 2 3 1-4"/>'),
  wordOut: I('<path d="M11.5 2.5H5a.5.5 0 0 0-.5.5v14a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V10"/><path d="M7 10.5l1 4 2-3 2 3 1-4M12.5 2.5h5v5M17.5 2.5l-5.5 5.5"/>'),
  review: I('<path d="M11.5 2.5H5a.5.5 0 0 0-.5.5v14a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V6.5z"/><path d="M7 8h4M7 10.5h4M7 13h3"/><path d="M13 8.5h4.5v4h-2l-1.5 1.3v-1.3h-1z"/>'),
  refs: I('<path d="M4 3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v11.5H5.5A1.5 1.5 0 0 1 4 15z"/><path d="M4 15a1.5 1.5 0 0 1 1.5-1.5H15M7.5 6.5h4.5M7.5 9h3"/>'),
  save: I('<path d="M4 3.5h10l2.5 2.5v10.5H4z"/><path d="M7 3.5v4h6v-4M7 16.5v-5h6v5"/>'),
  history: I('<path d="M3.6 11.5A6.5 6.5 0 1 0 5.4 5.4"/><path d="M5.6 2.8v2.8H2.8M10 6.5V10l2.5 1.5"/>'),
  window: I('<rect x="2.5" y="5.5" width="11" height="10" rx="1.5"/><path d="M6.5 5.5V4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 4v7a1.5 1.5 0 0 1-1.5 1.5h-2.5"/>'),
  settings: I('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>'),
  folder: I('<path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.8h7.5a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>'),
  help: I('<circle cx="10" cy="10" r="7"/><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2V12M10 14.5v.5"/>'),
  code: I('<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>'),
  cite: I('<path d="M3.5 15.5V11c0-3.5 1.5-5.5 4.5-6.5M3.5 11h4v4.5h-4M11 15.5V11c0-3.5 1.5-5.5 4.5-6.5M11 11h4v4.5h-4"/>'),
  doi: I('<path d="M10 16.5H5.5A1.5 1.5 0 0 1 4 15V3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v3.5M4 15a1.5 1.5 0 0 1 1.5-1.5H9.5M7.5 6.5h4.5"/><circle cx="13.5" cy="13" r="2.5"/><path d="M15.3 14.8l2 2"/>'),
  bib: I('<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M8.5 9c-1 0-1 .4-1 1.5s0 1.5-1 1.5c1 0 1 .4 1 1.5s0 1.5 1 1.5M11.5 9c1 0 1 .4 1 1.5s0 1.5 1 1.5c-1 0-1 .4-1 1.5s0 1.5-1 1.5"/>'),
  comment: I('<path d="M3 4.5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1z"/><path d="M10 6v5M7.5 8.5h5"/>'),
  comments: I('<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M11 3.5v13M13 6.5h3V9h-1.2l-.9.8V9H13zM13 11.5h3V14h-1.2l-.9.8V14H13z"/>'),
  bug: I('<path d="M7 6.5a3 3 0 0 1 6 0"/><rect x="6" y="6.5" width="8" height="10" rx="4"/><path d="M10 9.5v7M6 10H3M14 10h3M6 13.5H3.5M14 13.5h2.5M7.5 4L6 2.5M12.5 4L14 2.5"/>'),
  idea: I('<path d="M7.5 14.5v-1.6c0-1-.6-1.6-1.3-2.4a5 5 0 1 1 7.6 0c-.7.8-1.3 1.4-1.3 2.4v1.6z"/><path d="M8 17h4"/>'),
  issues: I('<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="1.2"/>'),
  changes: I('<path d="M11.5 2.5H5a.5.5 0 0 0-.5.5v14a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V6.5z"/><path d="M10 6.5v4M8 8.5h4M8 13.5h4"/>')
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const btn = (attrs: string, icon: string, label: string, title: string, caret = false): string =>
  `<button class="rb-btn" ${attrs} title="${esc(title)}">${icon}<span>${esc(label)}</span>${caret ? '<i class="rb-caret">▾</i>' : ''}</button>`

export class Ribbon {
  private tab: string

  constructor(private root: HTMLElement, private host: RibbonHost) {
    this.tab = ((): string => {
      try {
        const t = localStorage.getItem('ribbon-tab') || 'insert'
        // Settings has no pane; a remembered tab that no longer exists falls back to Insert too.
        return t !== 'settings' && root.querySelector(`.rb-pane[data-pane="${CSS.escape(t)}"]`) ? t : 'insert'
      } catch {
        return 'insert'
      }
    })()
    root.querySelectorAll<HTMLButtonElement>('.rb-tab').forEach((t) => {
      // The Settings tab opens the Settings window, like the old gear button; it has no pane.
      t.onclick = () => (t.dataset.tab === 'settings' ? this.host.run('settings') : this.select(t.dataset.tab!, true))
    })
    // Ribbon buttons shouldn't take the keyboard focus away from the editor.
    root.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault()
    })
    this.buildFile()
    this.renderDesign()
    this.renderPlugins()
    this.select(this.tab, false)
  }

  /** Show a tab. Clicking the tab that's already open collapses the ribbon to just its tabs. */
  select(tab: string, fromClick: boolean): void {
    if (fromClick && tab === this.tab) {
      document.body.classList.toggle('ribbon-collapsed')
      return
    }
    document.body.classList.remove('ribbon-collapsed')
    this.tab = tab
    try {
      localStorage.setItem('ribbon-tab', tab)
    } catch {
      /* the tab just won't be remembered */
    }
    this.root.querySelectorAll<HTMLElement>('.rb-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab))
    this.root.querySelectorAll<HTMLElement>('.rb-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab))
    if (tab === 'design') this.renderDesign()
    if (tab === 'plugins') this.renderPlugins()
    if (tab === 'citations') this.buildCitations()
    if (tab === 'review') this.buildReview()
    if (tab === 'report') this.buildReport()
  }

  /** Buttons with data-run run that action; data-menu buttons open a drop-down under themselves. */
  private wire(el: HTMLElement, menus: Record<string, (x: number, y: number) => void> = {}): void {
    el.querySelectorAll<HTMLButtonElement>('[data-run]').forEach((b) => (b.onclick = () => this.host.run(b.dataset.run!)))
    el.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation()
        const r = b.getBoundingClientRect()
        menus[b.dataset.menu!]?.(r.left, r.bottom + 4)
      }
    })
  }

  private buildFile(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=file]')!
    el.innerHTML = `
      <div class="rb-group">
        ${btn('data-run="new-project"', ICON.newProject, 'New Project', 'Start a new paper from a blank or example template')}
        ${btn('data-run="new-window"', ICON.window, 'New Window', 'Work on another folder at the same time')}
        ${btn('data-menu="recent"', ICON.recent, 'Open Recent', 'Open a folder, one you opened recently, or the example paper', true)}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="save"', ICON.save, 'Save', 'Save the current file (Ctrl/Cmd+S)')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="import-word"', ICON.word, 'Import Word', 'Turn a .docx into a LaTeX project')}
        ${btn('data-run="export-word"', ICON.wordOut, 'Export Word', 'Save the paper as a Word file for co-authors or a journal')}
      </div>`
    this.wire(el, { recent: (x, y) => this.host.recentMenu(x, y) })
  }

  private buildCitations(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=citations]')!
    if (el.childElementCount) return
    el.innerHTML = `
      <div class="rb-group">
        ${btn('data-cite', ICON.cite, 'Cite', 'Insert \\cite{…} at the cursor and pick a reference from your .bib files')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="add-doi"', ICON.doi, 'Add by DOI', 'Look up a paper by its DOI or arXiv ID and add it to your .bib file')}
        ${btn('data-run="import-refs"', ICON.refs, 'Import References', 'Add references from EndNote, Zotero or Mendeley')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-menu="bib"', ICON.bib, 'Open .bib', 'Open the .bib file that holds your references')}
      </div>`
    this.wire(el, { bib: (x, y) => this.host.bibMenu(x, y) })
    el.querySelector<HTMLButtonElement>('[data-cite]')!.onclick = () => {
      const v = this.host.view()
      if (!v) return this.host.notice('Open a .tex file and put the cursor where the citation goes.')
      insertAtCursor(v, '~\\cite{¦}')
      setTimeout(() => startCompletion(v), 0)
    }
  }

  private buildReview(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=review]')!
    if (el.childElementCount) return
    el.innerHTML = `
      <div class="rb-group">
        ${btn('data-run="add-comment"', ICON.comment, 'Add Comment', 'Comment on the selected text (Ctrl/Cmd+Shift+M)')}
        ${btn('data-run="toggle-comments"', ICON.comments, 'Comments', 'Show or hide the Comments panel')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="export-review"', ICON.review, 'Review PDF', 'Save a PDF with the comments in the margin and the changes marked, for co-authors')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="history"', ICON.history, 'Version History', 'Earlier versions of this file, and what changed in the project')}
        ${btn('data-run="changes-since"', ICON.changes, 'Changes Since…', 'Everything that changed in the project since a day or version you choose')}
      </div>`
    this.wire(el)
  }

  private buildReport(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=report]')!
    if (el.childElementCount) return
    el.innerHTML = `
      <div class="rb-group">
        ${btn('data-run="report-bug"', ICON.bug, 'Report a Bug', 'Tell us what went wrong. OpenTex shows you what it will send before opening a GitHub issue.')}
        ${btn('data-run="suggest-feature"', ICON.idea, 'Suggest a Feature', 'Something OpenTex should do. Opens a GitHub issue for you to fill in.')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-issues', ICON.issues, 'See All Issues', 'Known bugs and ideas on GitHub, in your browser')}
      </div>`
    this.wire(el)
    el.querySelector<HTMLButtonElement>('[data-issues]')!.onclick = () => window.open('https://github.com/AustinHouston/OpenTex/issues')
  }

  renderDesign(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=design]')!
    const { current, hasCustom } = this.host.design()
    const card = (id: string, name: string, desc: string, thumb: string, disabled = false): string =>
      `<button class="ds-card${current === id ? ' on' : ''}" data-design="${id}" ${disabled ? 'disabled' : ''} title="${esc(desc)}">${thumb}<span>${esc(name)}</span></button>`
    const customDesc = hasCustom || current === 'custom' ? 'Your own setup. It is saved automatically whenever you switch to a preset, so you can always come back to it.' : 'Your own setup will be saved here automatically when you first pick a preset.'
    el.innerHTML = `
      <div class="rb-group ds-gallery">
        ${card('custom', 'Custom', customDesc, designThumb(null), !(hasCustom || current === 'custom'))}
        ${PRESETS.map((p) => card(p.id, p.name, p.desc, designThumb(p.look))).join('')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">${btn('data-preamble', ICON.code, 'Edit Setup', 'Open the preamble of the main file (everything before \\begin{document})')}</div>
      <div class="ds-note">${current === null ? 'Open a project to change its design.' : 'Changes the class, margins, font, line spacing and citation style of the main file. Your text isn’t touched. For a final submission, use the journal’s own template.'}</div>`
    el.querySelectorAll<HTMLButtonElement>('[data-design]').forEach((b) => (b.onclick = () => b.dataset.design !== current && this.host.applyDesign(b.dataset.design!)))
    el.querySelector<HTMLButtonElement>('[data-preamble]')!.onclick = () => this.host.editPreamble()
  }

  renderPlugins(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=plugins]')!
    const { list, disabled } = this.host.plugins()
    el.innerHTML = `
      <div class="rb-group pl-tiles">${list
        .map((p) => {
          const on = !disabled.includes(p.id)
          return `<button class="pl-tile${on ? ' on' : ''}" data-plugin="${esc(p.id)}" title="${esc(p.description)}"><span class="pl-icon">${esc(p.icon || '🧩')}</span><span class="pl-name">${esc(p.name)}</span><span class="pl-state">${on ? 'On' : 'Off'}</span></button>`
        })
        .join('')}</div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-pl-folder', ICON.folder, 'Plugins Folder', 'Put your own plugins here')}
        ${btn('data-pl-help', ICON.help, 'Make a Plugin', 'How to write your own plugin')}
      </div>`
    el.querySelectorAll<HTMLButtonElement>('[data-plugin]').forEach((b) => (b.onclick = () => this.host.setPlugin(b.dataset.plugin!, !b.classList.contains('on'))))
    el.querySelector<HTMLButtonElement>('[data-pl-folder]')!.onclick = () => this.host.openPluginsFolder()
    el.querySelector<HTMLButtonElement>('[data-pl-help]')!.onclick = () => window.open('https://github.com/AustinHouston/OpenTex#plugins')
  }
}
