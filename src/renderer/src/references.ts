// Finding the places in .tex files that name a file by its path, so they can follow a rename or
// move: \input, \include, \subfile (with or without .tex), \includegraphics (with or without an
// extension, also relative to \graphicspath) and \bibliography / \addbibresource for .bib files.
//
// Paths in LaTeX are relative to the folder the main file is compiled in. As a fallback (the
// subfiles and import packages), a path relative to the file that contains it is accepted too.

export interface RefEdit {
  file: string // the referring file's path before the move
  from: number
  to: number
  expect: string // the text being replaced
  insert: string
  line: number
  excerpt: string
}

type Kind = 'tex' | 'img' | 'bib' | 'gpath'

const IMG_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.PDF', '.PNG', '.JPG', '.JPEG', '.EPS']
const HAS_IMG_EXT = /\.(pdf|png|jpe?g|eps|svg|gif|tiff?|bmp|webp|mps)$/i

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** Join a relative path onto a project folder; null if it leaves the project. */
export function joinPath(base: string, rel: string): string | null {
  const parts = base ? base.split('/') : []
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** Relative path from a project folder to a project path ("../figures/plot.png"). */
export function relPath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split('/') : []
  const b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

/** True when the character at `index` sits after an unescaped % on its line. */
function inComment(text: string, index: number): boolean {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const before = text.slice(start, index)
  return /(^|[^\\])(\\\\)*%/.test(before)
}

export interface Move {
  from: string
  to: string
  dir: boolean
}

export function mapPath(m: Move, p: string): string | null {
  if (p === m.from) return m.to
  if (m.dir && p.startsWith(m.from + '/')) return m.to + p.slice(m.from.length)
  return null
}
const mapped = (m: Move, p: string): string => mapPath(m, p) ?? p

/**
 * Every reference whose text must change after `move`. `texts` holds the .tex files (live text for
 * open ones), `allPaths` every file in the project before the move, `main` the main file.
 */
export function findReferences(move: Move, texts: { path: string; text: string }[], allPaths: Set<string>, main: string | null): RefEdit[] {
  const out: RefEdit[] = []
  const oldRoot = main ? dirOf(main) : ''
  const newRoot = main ? dirOf(mapped(move, main)) : ''
  const isDir = (d: string): boolean => d === '' || [...allPaths].some((p) => p.startsWith(d + '/'))

  // \graphicspath entries, usually in the main file's preamble. Relative to the compile folder.
  const gpaths: string[] = []
  for (const { text } of texts) {
    for (const m of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})*)\s*\}/g)) {
      if (inComment(text, m.index!)) continue
      for (const g of m[1].matchAll(/\{([^}]*)\}/g)) {
        const d = joinPath(oldRoot, g[1].trim().replace(/^"|"$/g, ''))
        if (d !== null && !gpaths.includes(d)) gpaths.push(d)
      }
    }
  }

  const candidates = (kind: Kind, ref: string): string[] => {
    if (kind === 'tex') return /\.tex$/i.test(ref) ? [ref] : [`${ref}.tex`, ref]
    if (kind === 'bib') return /\.bib$/i.test(ref) ? [ref] : [`${ref}.bib`]
    return HAS_IMG_EXT.test(ref) ? [ref] : IMG_EXT.map((e) => ref + e)
  }

  /** The new text for one path argument, or null when it doesn't change. */
  const rewrite = (kind: Kind, file: string, raw: string): string | null => {
    const quoted = /^".*"$/.test(raw)
    const ref = quoted ? raw.slice(1, -1) : raw
    if (!ref || /[#\\$]/.test(ref)) return null // macros and parameters can't be followed
    const ownOld = dirOf(file)
    const ownNew = dirOf(mapped(move, file))
    const bases: [string, string][] = [[oldRoot, newRoot], [ownOld, ownNew]]
    if (kind === 'img') for (const g of gpaths) bases.push([g, mapped(move, g)])
    for (const [oldBase, newBase] of bases) {
      for (const c of candidates(kind, ref)) {
        const target = joinPath(oldBase, c)
        if (target === null || !allPaths.has(target)) continue
        const newTarget = mapped(move, target)
        // Graphics found through \graphicspath stay short when the folder still holds them.
        const base = kind === 'img' && oldBase !== oldRoot && oldBase !== ownOld && !newTarget.startsWith(newBase + '/') ? newRoot : newBase
        let next = relPath(base, newTarget)
        if (c !== ref) next = next.slice(0, next.length - (c.length - ref.length)) // keep the extension left out
        if (ref.startsWith('./') && !next.startsWith('../')) next = './' + next
        return next === ref ? null : quoted ? `"${next}"` : next
      }
    }
    return null
  }

  const add = (file: string, text: string, from: number, expect: string, insert: string): void => {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1
    const lineEnd = text.indexOf('\n', from)
    const line = text.slice(0, from).split('\n').length
    out.push({ file, from, to: from + expect.length, expect, insert, line, excerpt: text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim() })
  }

  /** Rewrite each comma-separated item of an argument starting at `at`. */
  const items = (kind: Kind, file: string, text: string, arg: string, at: number, list: boolean): void => {
    let offset = 0
    for (const part of list ? arg.split(',') : [arg]) {
      const lead = part.length - part.trimStart().length
      const item = part.trim()
      const next = item && rewrite(kind, file, item)
      if (next) add(file, text, at + offset + lead, item, next)
      offset += part.length + 1
    }
  }

  const PATTERNS: [Kind, RegExp, boolean][] = [
    ['tex', /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]*)\}/g, false],
    ['img', /\\includegraphics\s*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g, false],
    ['bib', /\\(?:bibliography|nobibliography)\s*\{([^}]*)\}/g, true],
    ['bib', /\\(?:addbibresource|addglobalbib)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g, false]
  ]
  for (const { path, text } of texts) {
    for (const [kind, re, list] of PATTERNS) {
      for (const m of text.matchAll(re)) {
        if (inComment(text, m.index!)) continue
        const at = m.index! + m[0].length - 1 - m[1].length
        items(kind, path, text, m[1], at, list)
      }
    }
    // "% !TEX root = ../main.tex" names the main file relative to this file's folder.
    for (const m of text.matchAll(/^%\s*!TEX\s+root\s*=\s*(.*?)\s*$/gim)) {
      const raw = m[1]
      const target = joinPath(dirOf(path), raw)
      if (!raw || target === null || !allPaths.has(target)) continue
      const next = relPath(dirOf(mapped(move, path)), mapped(move, target))
      if (next !== raw) add(path, text, m.index! + m[0].lastIndexOf(raw), raw, next)
    }
    // A moved folder that \graphicspath names, or a moved main file: keep the entries pointing at the same folders.
    if (move.dir || newRoot !== oldRoot) {
      for (const m of text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\})*)\s*\}/g)) {
        if (inComment(text, m.index!)) continue
        const start = m.index! + m[0].indexOf(m[1])
        for (const g of m[1].matchAll(/\{([^}]*)\}/g)) {
          const raw = g[1].trim()
          const d = joinPath(oldRoot, raw)
          if (d === null || !isDir(d)) continue
          const rel = relPath(newRoot, mapped(move, d))
          const next = (rel || '.') + (raw.endsWith('/') ? '/' : '')
          if (next !== raw) add(path, text, start + g.index! + 1 + g[1].indexOf(raw), raw, next)
        }
      }
    }
  }
  return out
}
