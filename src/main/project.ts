import { promises as fs, watch, FSWatcher } from 'fs'
import { basename, join, relative, resolve, sep } from 'path'
import { ProjectConfig, ProjectInfo, TreeNode } from '../shared/types'

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.opentex', '.svn', '__pycache__'])
// LaTeX build by-products are hidden from the file tree.
const BUILD_EXT = /\.(aux|log|fls|fdb_latexmk|synctex\.gz|synctex|out|toc|lof|lot|bbl|blg|bcf|run\.xml|xdv|nav|snm|vrb|idx|ind|ilg|glo|gls|glg|ist|dvi)$/i

export class Project {
  watcher: FSWatcher | null = null
  constructor(public root: string) {}

  /** Resolve a project-relative path, refusing anything outside the project. */
  abs(rel: string): string {
    const p = resolve(this.root, rel)
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error(`Path outside project: ${rel}`)
    return p
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/')
  }

  async tree(dir = this.root, depth = 0): Promise<TreeNode[]> {
    if (depth > 8) return []
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: TreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.latexmkrc') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue
        nodes.push({ name: e.name, path: this.rel(full), dir: true, children: await this.tree(full, depth + 1) })
      } else if (!BUILD_EXT.test(e.name) && e.name !== 'comments.opentex.json') {
        nodes.push({ name: e.name, path: this.rel(full), dir: false })
      }
    }
    return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  }

  async readConfig(): Promise<ProjectConfig> {
    try {
      return JSON.parse(await fs.readFile(join(this.root, '.opentex', 'project.json'), 'utf8'))
    } catch {
      return {}
    }
  }

  async writeConfig(patch: ProjectConfig): Promise<ProjectConfig> {
    const next = { ...(await this.readConfig()), ...patch }
    await fs.mkdir(join(this.root, '.opentex'), { recursive: true })
    await fs.writeFile(join(this.root, '.opentex', 'project.json'), JSON.stringify(next, null, 2))
    return next
  }

  /** Main file: project config, then `% !TEX root`, then a file with \documentclass. */
  async detectMainFile(tree: TreeNode[], config: ProjectConfig): Promise<string | null> {
    if (config.mainFile) return config.mainFile
    const texFiles: string[] = []
    const walk = (ns: TreeNode[]): void =>
      ns.forEach((n) => (n.dir ? walk(n.children ?? []) : n.name.endsWith('.tex') && texFiles.push(n.path)))
    walk(tree)
    // Prefer shallow paths and conventional names.
    texFiles.sort((a, b) => a.split('/').length - b.split('/').length || score(a) - score(b))
    for (const f of texFiles) {
      const head = (await fs.readFile(this.abs(f), 'utf8').catch(() => '')).slice(0, 4000)
      const root = head.match(/^%\s*!TEX\s+root\s*=\s*(.+)$/im)
      if (root) return this.rel(resolve(this.abs(f), '..', root[1].trim()))
      if (/^[^%\n]*\\documentclass/m.test(head)) return f
    }
    return texFiles[0] ?? null
  }

  async info(): Promise<ProjectInfo> {
    const [tree, config] = await Promise.all([this.tree(), this.readConfig()])
    return { root: this.root, name: basename(this.root), tree, config, mainFile: await this.detectMainFile(tree, config) }
  }

  /** Watch the folder (recursive works on macOS and Windows) and report changed files. */
  watch(onChange: (paths: string[]) => void): void {
    let pending = new Set<string>()
    let timer: NodeJS.Timeout | null = null
    try {
      this.watcher = watch(this.root, { recursive: true }, (_evt, filename) => {
        if (!filename) return
        const rel = filename.toString().split(sep).join('/')
        if (rel.split('/').some((p) => IGNORED_DIRS.has(p))) return
        pending.add(rel)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const list = [...pending]
          pending = new Set()
          onChange(list)
        }, 250)
      })
    } catch (e) {
      console.warn('File watching unavailable:', e)
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }
}

function score(p: string): number {
  const n = basename(p).toLowerCase()
  return ['main.tex', 'paper.tex', 'manuscript.tex', 'thesis.tex'].includes(n) ? 0 : 1
}
