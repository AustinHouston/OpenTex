// What the file-management (fileops.ts) and Find in Project (search.ts) modules need from the app
// in main.ts. main.ts builds one AppHost object and hands it to both.
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ProjectInfo } from '../../shared/types'
import type { OpenTexApi } from '../../preload/index'
import type { Thread } from './review'

export interface HostFile {
  path: string
  state: EditorState
  saved: string
  dirty: boolean
}

export interface AppHost {
  api: OpenTexApi
  /** The focused file window's editor. */
  view: EditorView
  /** The editor showing this file, if it is the active tab of a file window. */
  viewOf: (path: string) => EditorView | null
  files: Map<string, HostFile>
  project: () => ProjectInfo | null
  active: () => string | null
  /** Every open tab (text files and pictures), in all file windows. */
  openTabs: () => string[]
  /** Copy the editors' current states into `files` (before reading every open file's state). */
  syncStates: () => void
  /** Files were renamed or moved: point the tabs at their new paths. */
  renamed: (map: (path: string) => string | null) => void
  openFile: (path: string) => Promise<void>
  closeTab: (path: string) => Promise<void>
  newFile: (prefix?: string) => Promise<void>
  renderTabs: () => void
  reloadTree: () => Promise<void>
  setMainFile: (path: string) => Promise<void>
  threads: () => Thread[]
  saveComments: () => Promise<void>
  scheduleComments: () => void
  lastPdf: () => string | null
  showPdf: (path: string) => Promise<void>
  forgetPdf: () => void
  /** Refresh autocomplete, design and other things that read the project's files. */
  refresh: () => void
  status: (text: string, cls?: string) => void
}

/** Live text of an open file, or null when it isn't open. */
export function liveText(host: AppHost, path: string): string | null {
  const v = host.viewOf(path)
  if (v) return v.state.doc.toString()
  return host.files.get(path)?.state.doc.toString() ?? null
}

/**
 * Change an open file through its editor, so Undo works and the tab shows it as unsaved.
 * Each change is checked against the text it expects to replace; returns how many were applied.
 */
export function editOpenFile(host: AppHost, path: string, changes: { from: number; to: number; expect: string; insert: string }[]): number {
  const f = host.files.get(path)
  if (!f) return 0
  const v = host.viewOf(path)
  const state = v ? v.state : f.state
  const ok = changes
    .filter((c) => c.to <= state.doc.length && state.sliceDoc(c.from, c.to) === c.expect)
    .sort((a, b) => a.from - b.from)
    .filter((c, i, all) => i === 0 || c.from >= all[i - 1].to) // never overlapping
  if (!ok.length) return 0
  const spec = { changes: ok.map(({ from, to, insert }) => ({ from, to, insert })), userEvent: 'input.replace' }
  if (v) v.dispatch(spec)
  else f.state = f.state.update(spec).state
  f.dirty = true
  host.renderTabs()
  return ok.length
}

/** Apply checked changes to text (for files that aren't open). */
export function editText(text: string, changes: { from: number; to: number; expect: string; insert: string }[]): { text: string; applied: number } {
  const ok = changes
    .filter((c) => text.slice(c.from, c.to) === c.expect)
    .sort((a, b) => a.from - b.from)
    .filter((c, i, all) => i === 0 || c.from >= all[i - 1].to)
  let out = ''
  let at = 0
  for (const c of ok) {
    out += text.slice(at, c.from) + c.insert
    at = c.to
  }
  return { text: out + text.slice(at), applied: ok.length }
}

export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
