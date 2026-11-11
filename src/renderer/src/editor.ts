import { Compartment, EditorState, Extension, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration, DecorationSet, drawSelection, dropCursor, EditorView, highlightActiveLine,
  highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
  ViewPlugin, ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags as t } from '@lezer/highlight'

// Syntax colors come from CSS variables, so switching theme needs no editor reconfiguration.
const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--syn-command)' },
  { tag: [t.keyword, t.string], color: 'var(--syn-math)' },
  { tag: [t.atom, t.standard(t.variableName)], color: 'var(--syn-env)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.bracket, color: 'var(--syn-bracket)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: t.invalid, color: 'var(--error)' }
])

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--editor-font)', lineHeight: 'var(--editor-line-height)' },
  '.cm-content': { caretColor: 'var(--cursor)', padding: '12px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cursor)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--activeLine)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--activeLine)', color: 'var(--text)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--panelAlt)', outline: '1px solid var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-line.ot-dim': { opacity: '0.28', transition: 'opacity 0.2s' }
})

/** Focus-mode dimming: fade every line outside the paragraph that holds the cursor. */
export const dimCompartment = new Compartment()
const dimPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const doc = view.state.doc
      const cur = doc.lineAt(view.state.selection.main.head).number
      let from = cur
      let to = cur
      while (from > 1 && doc.line(from - 1).text.trim()) from--
      while (to < doc.lines && doc.line(to + 1).text.trim()) to++
      const b = new RangeSetBuilder<Decoration>()
      const dim = Decoration.line({ class: 'ot-dim' })
      for (const { from: vf, to: vt } of view.visibleRanges) {
        for (let n = doc.lineAt(vf).number; n <= doc.lineAt(vt).number; n++) {
          if (n < from || n > to) b.add(doc.line(n).from, doc.line(n).from, dim)
        }
      }
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)
export const dimExtension = (on: boolean): Extension => (on ? dimPlugin : [])

export interface EditorHooks {
  onChange: () => void
  onCursor: (line: number, col: number) => void
}

export function makeExtensions(hooks: EditorHooks, dimOn: boolean): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    StreamLanguage.define(stex),
    syntaxHighlighting(latexHighlight),
    baseTheme,
    dimCompartment.of(dimExtension(dimOn)),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange()
      if (u.selectionSet || u.docChanged) {
        const pos = u.state.selection.main.head
        const line = u.state.doc.lineAt(pos)
        hooks.onCursor(line.number, pos - line.from + 1)
      }
    })
  ]
}

export function goToLine(view: EditorView, line: number): void {
  const n = Math.max(1, Math.min(line, view.state.doc.lines))
  const pos = view.state.doc.line(n).from
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
  view.focus()
}
