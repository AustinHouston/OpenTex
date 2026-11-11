import { Compartment, EditorState, Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration, DecorationSet, drawSelection, dropCursor, EditorView,
  highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
  ViewPlugin, ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { CompletionData, latexCompletions, spellCompartment, spellExtension } from './assist'
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

/**
 * Like CodeMirror's highlightActiveLine, but only for an empty selection: the active-line
 * background sits above the selection layer, so it would hide text you're selecting.
 */
const activeLine = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>()
      const sel = view.state.selection
      if (sel.ranges.length === 1 && sel.main.empty) b.add(view.lineBlockAt(sel.main.head).from, view.lineBlockAt(sel.main.head).from, Decoration.line({ class: 'cm-activeLine' }))
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

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

/** Highlights a plugin asked for (sentence tints, style-flag underlines). Kept per file and moved along with edits. */
export interface PluginMark {
  from: number
  to: number
  kind: string
  title?: string
}
const MARK_KINDS = new Set(['dense', 'dense2', 'simple', 'simple2', 'passive', 'hedge', 'filler', 'focus'])
export const setPluginMarks = StateEffect.define<PluginMark[]>()
export const pluginMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setPluginMarks)) continue
      const len = tr.state.doc.length
      const ranges = e.value
        .filter((m) => MARK_KINDS.has(m.kind) && m.from >= 0 && m.to <= len && m.from < m.to)
        .slice(0, 5000)
        .map((m) => Decoration.mark({ class: `ot-mk ot-mk-${m.kind}`, attributes: m.title ? { title: String(m.title).slice(0, 300) } : {} }).range(m.from, m.to))
      deco = Decoration.set(ranges, true)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

export interface EditorHooks {
  onChange: () => void
  onCursor: (line: number, col: number) => void
  onSelection?: (view: EditorView) => void
  onTyped?: (chars: number) => void
}

export function makeExtensions(hooks: EditorHooks, dimOn: boolean, completion: () => CompletionData): Extension[] {
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
    activeLine,
    pluginMarks,
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    StreamLanguage.define(stex),
    syntaxHighlighting(latexHighlight),
    baseTheme,
    dimCompartment.of(dimExtension(dimOn)),
    spellCompartment.of(spellExtension(false)),
    latexCompletions(completion),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        hooks.onChange()
        // Count characters typed or deleted by the user (not reloads from disk).
        if (u.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('delete'))) {
          let n = 0
          u.changes.iterChanges((fa, ta, fb, tb) => (n += Math.max(ta - fa, tb - fb)))
          hooks.onTyped?.(Math.min(n, 50))
        }
      }
      if (u.selectionSet || u.docChanged || u.viewportChanged || u.geometryChanged) hooks.onSelection?.(u.view)
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
