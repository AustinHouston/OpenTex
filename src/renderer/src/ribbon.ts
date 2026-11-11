// The ribbon across the top, like Word: tabs (File, Insert, Design, Plugins) with buttons in each.
// The Insert tab is built in insert.ts; this file builds the tabs, File, Design and Plugins.

import type { PluginInfo } from '../../shared/types'
import { designThumb, PRESETS } from './design'

export interface RibbonHost {
  run: (action: string) => void
  recentMenu: (x: number, y: number) => void
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
  open: I('<path d="M2.5 15V5.5a1 1 0 0 1 1-1h4l1.5 1.8h6.5a1 1 0 0 1 1 1V8.5"/><path d="M2.5 15l2.2-6.5h13l-2.2 6.5z"/>'),
  recent: I('<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>'),
  word: I('<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M7 9.5l1 4 2-3 2 3 1-4"/>'),
  refs: I('<path d="M4 3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v11.5H5.5A1.5 1.5 0 0 1 4 15z"/><path d="M4 15a1.5 1.5 0 0 1 1.5-1.5H15M7.5 6.5h4.5M7.5 9h3"/>'),
  save: I('<path d="M4 3.5h10l2.5 2.5v10.5H4z"/><path d="M7 3.5v4h6v-4M7 16.5v-5h6v5"/>'),
  close: I('<path d="M2.5 15V5.5a1 1 0 0 1 1-1h4l1.5 1.8h6.5a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/><path d="M8 9l4 4M12 9l-4 4"/>'),
  window: I('<rect x="2.5" y="5.5" width="11" height="10" rx="1.5"/><path d="M6.5 5.5V4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 4v7a1.5 1.5 0 0 1-1.5 1.5h-2.5"/>'),
  example: I('<path d="M3 4.5c2.5-1 5-1 7 .5 2-1.5 4.5-1.5 7-.5v11c-2.5-1-5-1-7 .5-2-1.5-4.5-1.5-7-.5z"/><path d="M10 5v11"/>'),
  settings: I('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>'),
  folder: I('<path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.8h7.5a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>'),
  help: I('<circle cx="10" cy="10" r="7"/><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2V12M10 14.5v.5"/>'),
  code: I('<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>')
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const btn = (attrs: string, icon: string, label: string, title: string, caret = false): string =>
  `<button class="rb-btn" ${attrs} title="${esc(title)}">${icon}<span>${esc(label)}</span>${caret ? '<i class="rb-caret">▾</i>' : ''}</button>`

export class Ribbon {
  private tab: string

  constructor(private root: HTMLElement, private host: RibbonHost) {
    this.tab = ((): string => {
      try {
        return localStorage.getItem('ribbon-tab') || 'insert'
      } catch {
        return 'insert'
      }
    })()
    root.querySelectorAll<HTMLButtonElement>('.rb-tab').forEach((t) => {
      t.onclick = () => this.select(t.dataset.tab!, true)
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
  }

  private buildFile(): void {
    const el = this.root.querySelector<HTMLElement>('[data-pane=file]')!
    el.innerHTML = `
      <div class="rb-group">
        ${btn('data-run="new-project"', ICON.newProject, 'New Project', 'Start a new paper from a blank or example template')}
        ${btn('data-run="open-folder"', ICON.open, 'Open Folder', 'Open the folder that holds a paper')}
        ${btn('data-recent', ICON.recent, 'Open Recent', 'Folders you opened recently', true)}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="import-word"', ICON.word, 'Import Word', 'Turn a .docx into a LaTeX project')}
        ${btn('data-run="import-refs"', ICON.refs, 'Import References', 'Add references from EndNote, Zotero or Mendeley')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="save"', ICON.save, 'Save', 'Save the current file (Ctrl/Cmd+S)')}
        ${btn('data-run="close-folder"', ICON.close, 'Close Folder', 'Close this project and go back to the start page')}
        ${btn('data-run="new-window"', ICON.window, 'New Window', 'Work on another folder at the same time')}
      </div><div class="rb-sep"></div>
      <div class="rb-group">
        ${btn('data-run="open-example"', ICON.example, 'Example Paper', 'A short paper that teaches LaTeX as you read it')}
        ${btn('data-run="settings"', ICON.settings, 'Settings', 'Themes, fonts, compiling, focus mode')}
      </div>`
    el.querySelectorAll<HTMLButtonElement>('[data-run]').forEach((b) => (b.onclick = () => this.host.run(b.dataset.run!)))
    el.querySelector<HTMLButtonElement>('[data-recent]')!.onclick = (e) => {
      e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      this.host.recentMenu(r.left, r.bottom + 4)
    }
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
