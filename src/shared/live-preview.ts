// Live preview: types shared by the main process (src/main/live-preview.ts), preload and renderer.
import type { Engine, Settings } from './types'

export interface LiveRequest {
  target: string // project-relative .tex file to build
  engine: Engine
  /** Unsaved editor text, written into the private build folder instead of the user's files. */
  files: { path: string; text: string }[]
}

export interface LiveResult {
  ok: boolean
  pdf?: Uint8Array
  /** The first error, for the "Paused: error on line N" chip. */
  error?: { file: string | null; line: number | null; message: string }
  ms: number // wall time of the whole background build
  passes: number // engine passes (1 when the old .aux/.bbl could be reused)
  bib: boolean // BibTeX/Biber ran because citations changed
  rerun: boolean // cross-references changed; one more pass would settle them
  cancelled?: boolean
  skipped?: 'hidden' | 'no-tex' | 'outside'
}

export interface LiveBox {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** "Compile while typing" (save + full compile) became Live preview, which never touches the user's files. */
export function migrateLiveSettings(s: Settings): Settings {
  return s.liveCompile ? { ...s, liveCompile: false, livePreview: true } : s
}
