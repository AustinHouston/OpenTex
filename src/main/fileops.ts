// File management for the file list (rename, move, new folder, duplicate, move to Trash) and
// batch reading for Find in Project. Every path is project-relative and checked with
// Project.abs(), so nothing can reach outside the project folder.
import { ipcMain, IpcMainInvokeEvent, MenuItemConstructorOptions, shell } from 'electron'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import type { Project } from './project'

type Need = (e: IpcMainInvokeEvent) => Project

const BAD_CHARS = /[\\/:*?"<>|]/

/** Throw a friendly error when a file or folder name can't be used. */
function checkName(name: string): void {
  if (!name.trim()) throw new Error('Please type a name.')
  if (BAD_CHARS.test(name)) throw new Error('Names can’t contain any of these characters: / \\ : * ? " < > |')
  if (name.startsWith('.')) throw new Error('Names can’t start with a dot (files like that are hidden).')
  if (name.endsWith('.') || name !== name.trim()) throw new Error('Names can’t end with a dot or a space.')
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

/** True when two paths name the same file, e.g. Intro.tex and intro.tex on macOS or Windows. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)])
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.opentex', '.svn', '__pycache__'])

/** SyncTeX files in the project (they sit next to the PDFs they belong to). */
async function synctexFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return []
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await synctexFiles(full, depth + 1)))
    } else if (/\.synctex(\.gz)?$/i.test(e.name)) out.push(full)
  }
  return out
}

/**
 * SyncTeX data records each source file's full path. After a .tex file (or a folder holding some)
 * moves, point those records at the new place so "Show in PDF" keeps working until the next compile.
 */
async function fixSynctex(root: string, from: string, to: string): Promise<void> {
  const fold = (p: string): string => (process.platform === 'linux' ? p : p.toLowerCase())
  const old = fold(from)
  for (const file of await synctexFiles(root)) {
    try {
      const raw = await fs.readFile(file)
      const gz = /\.gz$/i.test(file)
      const text = (gz ? gunzipSync(raw) : raw).toString('utf8')
      let changed = false
      const next = text.replace(/^Input:(\d+):(.*)$/gm, (line, n: string, p: string) => {
        const abs = normalize(resolve(dirname(file), p))
        const f = fold(abs)
        if (f !== old && !f.startsWith(old + sep)) return line
        changed = true
        return `Input:${n}:${to}${abs.slice(from.length)}`
      })
      if (changed) await fs.writeFile(file, gz ? gzipSync(Buffer.from(next, 'utf8')) : next)
    } catch {
      // A damaged SyncTeX file only affects PDF <-> source jumps; the next compile rewrites it.
    }
  }
}

/** "intro.tex" -> "intro copy.tex", then "intro copy 2.tex", … */
async function copyName(abs: string, isDir: boolean): Promise<string> {
  const dir = dirname(abs)
  const ext = isDir ? '' : extname(abs)
  const stem = basename(abs, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('Too many copies already exist.')
}

export function registerFileOpsIpc(need: Need): void {
  /**
   * Rename or move a file or folder. With `companions`, a moved .tex file takes its PDF and SyncTeX
   * file along (used for the main file, so the PDF panel and Show in PDF keep working).
   */
  ipcMain.handle('files:move', async (e, from: string, to: string, companions: boolean) => {
    const p = need(e)
    const a = p.abs(from)
    const b = p.abs(to)
    if (a === p.root || b === p.root) throw new Error('The project folder itself can’t be moved or renamed here.')
    checkName(basename(b))
    if (a === b) return { companions: [] }
    if (b.startsWith(a + sep)) throw new Error('A folder can’t be moved into itself.')
    if (!(await exists(a))) throw new Error(`“${from}” isn’t there any more. It may have been moved or deleted outside OpenTex.`)
    const caseOnly = a.toLowerCase() === b.toLowerCase() && (await sameFile(a, b))
    if (!caseOnly && (await exists(b))) throw new Error(`There is already a file or folder named “${basename(b)}” there.`)
    await fs.mkdir(dirname(b), { recursive: true })
    await fs.rename(a, b)
    const moved: [string, string][] = []
    if (companions && /\.tex$/i.test(a)) {
      for (const ext of ['.pdf', '.synctex.gz', '.synctex']) {
        const ca = a.replace(/\.tex$/i, ext)
        const cb = b.replace(/\.tex$/i, ext)
        if ((await exists(ca)) && !(await exists(cb))) {
          await fs.rename(ca, cb).then(() => moved.push([p.rel(ca), p.rel(cb)]), () => {})
        }
      }
    }
    await fixSynctex(p.root, a, b)
    return { companions: moved }
  })

  ipcMain.handle('files:mkdir', async (e, rel: string) => {
    const p = need(e)
    const abs = p.abs(rel)
    checkName(basename(abs))
    if (await exists(abs)) throw new Error(`There is already a file or folder named “${basename(abs)}” there.`)
    await fs.mkdir(abs, { recursive: true })
  })

  /** Copy a file or folder next to itself; returns the copy's path. */
  ipcMain.handle('files:duplicate', async (e, rel: string) => {
    const p = need(e)
    const abs = p.abs(rel)
    if (abs === p.root) throw new Error('The project folder itself can’t be copied here.')
    const isDir = (await fs.stat(abs)).isDirectory()
    const dest = await copyName(abs, isDir)
    await fs.cp(abs, dest, { recursive: true, errorOnExist: true, force: false })
    return p.rel(dest)
  })

  /** Move to the Trash (macOS, Linux) or Recycle Bin (Windows). Never deletes permanently. */
  ipcMain.handle('files:trash', async (e, rel: string) => {
    const p = need(e)
    const abs = p.abs(rel)
    if (abs === p.root) throw new Error('The project folder itself can’t be deleted here.')
    await shell.trashItem(abs)
  })

  /** Read several text files at once (Find in Project). Missing or very large files come back as null. */
  ipcMain.handle('files:readMany', async (e, rels: string[]) => {
    const p = need(e)
    return Promise.all(
      rels.map(async (rel): Promise<[string, string | null]> => {
        try {
          const abs = p.abs(rel)
          if ((await fs.stat(abs)).size > 8 * 1024 * 1024) return [rel, null]
          return [rel, await fs.readFile(abs, 'utf8')]
        } catch {
          return [rel, null]
        }
      })
    )
  })
}

/** The Edit menu: the usual commands plus Find in Project. */
export function editMenu(isMac: boolean, findInProject: () => void, find: () => void): MenuItemConstructorOptions {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: find },
      { label: 'Find in All Files…', accelerator: 'CmdOrCtrl+Shift+F', click: findInProject }
    ]
  }
}
