// Hover previews in the editor: rest the mouse on \ref{…}, \cite{…}, math or \includegraphics{…}
// to see what it points to. This part is always loaded and does nothing until the mouse rests on
// the text; the previews themselves (hover-preview.ts, and KaTeX for math) load on first use.
import { EditorView, hoverTooltip } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import type { OpenTexApi } from '../../preload/index'
import type { HoverHost } from './hover-preview'

export type { HoverHost }
type Previews = typeof import('./hover-preview')

/** The editor extension: previews after the mouse rests for 300 ms, never while typing or selecting. */
export function hoverPreviews(host: HoverHost): Extension {
  const api = (window as unknown as { opentex: OpenTexApi }).opentex
  let loading: Promise<Previews> | null = null
  let loaded: Previews | null = null
  api.on('project:changed', (paths: string[]) => loaded?.changed(paths))
  let lastKey = 0
  let down = false
  return [
    hoverTooltip(
      async (view, pos) => {
        if (down || Date.now() - lastKey < 800 || !host.project()) return null
        try {
          loading ??= import('./hover-preview').then((m) => (m.setHost(host), (loaded = m)))
          return await (await loading).preview(view, pos)
        } catch (e) {
          if (!loaded) loading = null // try loading again next time
          console.warn('hover preview failed', e)
          return null
        }
      },
      { hoverTime: 300, hideOnChange: true }
    ),
    // Observers, not handlers: they see every key, even ones a keymap has already handled.
    EditorView.domEventObservers({
      keydown: () => void (lastKey = Date.now()),
      mousedown: () => {
        down = true
        window.addEventListener('mouseup', () => (down = false), { once: true, capture: true })
      }
    })
  ]
}
