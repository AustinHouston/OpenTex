// Types shared by the main process, preload and renderer.

export type Engine = 'pdflatex' | 'xelatex' | 'lualatex'

export interface Settings {
  theme: string
  fontFamily: string
  fontSize: number
  lineHeight: number
  texPath: string // folder containing latexmk/pdflatex; '' = auto-detect
  engine: Engine
  compileOnSave: boolean
  useLatexmk: boolean
  focusWidth: number // characters
  focusDim: boolean
  focusFullscreen: boolean
  authorName: string
  lastProject: string
  recentProjects: string[]
  uiZoom: number
  spellcheck: boolean
  liveCompile: boolean
  disabledPlugins: string[]
  showInsertBar: boolean
  layout?: unknown // panel arrangement, see renderer/src/layout.ts
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'Light',
  fontFamily: "'SF Mono', Menlo, Consolas, 'Cascadia Mono', monospace",
  fontSize: 14,
  lineHeight: 1.6,
  texPath: '',
  engine: 'pdflatex',
  compileOnSave: true,
  useLatexmk: true,
  focusWidth: 80,
  focusDim: true,
  focusFullscreen: false,
  authorName: '',
  lastProject: '',
  recentProjects: [],
  uiZoom: 1,
  spellcheck: true,
  liveCompile: false,
  disabledPlugins: [],
  showInsertBar: true
}

/** Stored in <project>/.opentex/project.json so collaborators share it. */
export interface ProjectConfig {
  mainFile?: string
  engine?: Engine
  design?: { custom?: unknown } // see renderer/src/design.ts (CustomDesign)
}

export interface TreeNode {
  name: string
  path: string // relative to project root, '/'-separated
  dir: boolean
  children?: TreeNode[]
}

export interface ProjectInfo {
  root: string
  name: string
  tree: TreeNode[]
  mainFile: string | null
  config: ProjectConfig
}

export interface TexInfo {
  found: boolean
  binDir: string | null
  latexmk: boolean
  engines: Engine[]
}

export interface Problem {
  severity: 'error' | 'warning'
  file: string | null // relative to project root
  line: number | null
  message: string
}

export interface CompileResult {
  ok: boolean
  pdf: string | null // relative path of produced PDF
  log: string
  problems: Problem[]
  missingFiles: string[] // e.g. ['siunitx.sty'] for the TinyTeX helper
  durationMs: number
  cancelled?: boolean
}

export interface PluginInfo {
  id: string
  name: string
  description: string
  version: string
  panel: string
  icon: string
  builtIn: boolean
}

export interface Theme {
  name: string
  dark: boolean
  colors: Record<string, string>
  syntax: Record<string, string>
}
