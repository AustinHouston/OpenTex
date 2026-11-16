// One-click TinyTeX install (no admin rights needed) and on-demand package installs.
// TinyTeX: https://yihui.org/tinytex/ (a small, standard TeX Live).
import { net } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, existsSync, promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

const RELEASES = 'https://github.com/rstudio/tinytex-releases/releases/download/daily'
const isWin = process.platform === 'win32'

type Log = (line: string) => void

function run(cmd: string, args: string[], log: Log, opts: { cwd?: string; shell?: boolean } = {}): Promise<number> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { ...opts, windowsHide: true })
    const out = (d: Buffer): void => d.toString().split(/\r?\n/).filter(Boolean).forEach(log)
    p.stdout.on('data', out)
    p.stderr.on('data', out)
    p.on('error', (e) => {
      log(e.message)
      done(-1)
    })
    p.on('close', (code) => done(code ?? -1))
  })
}

async function download(url: string, dest: string, log: Log): Promise<void> {
  log(`Downloading ${url}`)
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let lastPct = -10
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (pct >= lastPct + 10) {
      lastPct = pct
      log(`  ${pct}%  (${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`)
    }
  })
  await pipeline(body, createWriteStream(dest))
}

/** Where TinyTeX ends up on each platform (tex.ts also looks here). */
export function tinytexRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'TinyTeX')
  if (isWin) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'TinyTeX')
  return join(homedir(), '.TinyTeX')
}

export async function installTinyTex(log: Log): Promise<boolean> {
  const root = tinytexRoot()
  if (existsSync(root)) {
    log(`TinyTeX already exists at ${root}. Remove that folder first if you want to reinstall.`)
    return false
  }
  const work = await fs.mkdtemp(join(tmpdir(), 'opentex-tinytex-'))
  try {
    if (isWin) {
      // The official Windows installer works per-user without admin rights.
      const ps1 = join(work, 'install-bin-windows.ps1')
      await download('https://tinytex.yihui.org/install-bin-windows.ps1', ps1, log)
      log('Running the TinyTeX installer (this takes a few minutes)…')
      const code = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], log, { cwd: work })
      if (code !== 0) throw new Error(`Installer exited with code ${code}`)
    } else {
      // macOS / Linux: unpack the prebuilt bundle into the home folder. We skip the official
      // script's PATH step because it needs sudo; OpenTex finds TinyTeX on its own.
      const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
      const name = process.platform === 'darwin' ? 'TinyTeX-1-darwin.tar.xz' : `TinyTeX-1-linux-${arch}.tar.xz`
      const file = join(work, name)
      await download(`${RELEASES}/${name}`, file, log)
      log('Unpacking…')
      const parent = join(root, '..')
      await fs.mkdir(parent, { recursive: true })
      const code = await run(existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar', ['-xf', file, '-C', parent], log) // the system tar, not one earlier on the PATH
      if (code !== 0) throw new Error(`Unpacking failed (code ${code})`)
      const bin = await tinytexBin()
      if (bin) await run(join(bin, 'tlmgr'), ['postaction', 'install', 'script', 'xetex'], log)
    }
    const ok = Boolean(await tinytexBin())
    log(ok ? 'TinyTeX is installed.' : 'Install finished, but TinyTeX was not found where expected.')
    return ok
  } catch (e) {
    log(`Install failed: ${(e as Error).message}`)
    return false
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

async function tinytexBin(): Promise<string | null> {
  // On Windows the installer uses ProgramData when the APPDATA path has spaces or non-ASCII characters.
  const roots = [tinytexRoot(), ...(isWin ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'TinyTeX')] : [])]
  for (const r of roots) {
    const binRoot = join(r, 'bin')
    const dirs = await fs.readdir(binRoot).catch(() => [] as string[])
    for (const d of dirs) if (existsSync(join(binRoot, d, isWin ? 'pdflatex.exe' : 'pdflatex'))) return join(binRoot, d)
  }
  return null
}

/** True when this TeX is a TinyTeX the user owns, so tlmgr can install packages without admin rights. */
export function isTinyTex(binDir: string | null): boolean {
  return Boolean(binDir && /tinytex/i.test(binDir))
}

/** Ask TeX which of these files it can't find (kpsewhich prints the path of each one it finds). */
async function notFound(binDir: string, files: string[], cwd?: string): Promise<string[]> {
  if (!files.length) return []
  const out = await new Promise<string>((done) => {
    let text = ''
    const p = spawn(join(binDir, isWin ? 'kpsewhich.exe' : 'kpsewhich'), files, { cwd, windowsHide: true })
    p.stdout.on('data', (d) => (text += d))
    p.on('close', () => done(text))
    p.on('error', () => done(''))
  })
  const found = new Set(out.split(/\r?\n/).map((l) => l.trim().split(/[\\/]/).pop()!.toLowerCase()).filter(Boolean))
  return files.filter((f) => !found.has(f.toLowerCase()))
}

/** Every package, class and bibliography style the paper's .tex files ask for (skipping comments). */
async function wantedFiles(root: string): Promise<string[]> {
  const wanted = new Set<string>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
      else if (e.isFile() && /\.tex$/i.test(e.name)) {
        const text = (await fs.readFile(p, 'utf8').catch(() => '')).replace(/(^|[^\\])%.*$/gm, '$1')
        for (const m of text.matchAll(/\\(usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g))
          for (const n of m[2].split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9._-]+$/.test(x)))
            wanted.add(n + (m[1] === 'documentclass' ? '.cls' : '.sty'))
        for (const m of text.matchAll(/\\bibliographystyle\s*\{([A-Za-z0-9._-]+)\}/g)) wanted.add(m[1] + '.bst')
      }
    }
  }
  await walk(root, 0)
  return [...wanted]
}

/** Find the TeX Live packages that provide the missing files, then install them. With the project
 *  folder, also everything else the paper uses that isn't installed yet, so a fresh TinyTeX gets them
 *  all in one go instead of one compile (and one question) per package. */
export async function installMissing(binDir: string, files: string[], log: Log, root?: string): Promise<boolean> {
  const tlmgr = isWin ? join(binDir, 'tlmgr.bat') : join(binDir, 'tlmgr')
  const exec = (args: string[]): Promise<number> => (isWin ? run('cmd.exe', ['/c', tlmgr, ...args], log) : run(tlmgr, args, log))
  let todo = [...new Set(files)]
  if (root) {
    log('Checking what else this paper needs…')
    const more = (await notFound(binDir, await wantedFiles(root), root)).filter((f) => !todo.includes(f))
    if (more.length) log(`Also not installed yet: ${more.join(', ')}`)
    todo = [...todo, ...more]
  }
  // Most packages are named after their file (setspace.sty is in "setspace"): try those all at once,
  // which is one download of the package list instead of one search per file.
  const named = todo.filter((f) => /\.(sty|cls)$/i.test(f)).map((f) => f.replace(/\.[^.]+$/, ''))
  if (named.length) {
    log(`Installing ${named.join(', ')}…`)
    await exec(['install', ...named])
  }
  let left = await notFound(binDir, todo, root)
  // The rest (and anything whose package has another name, like angew.bst): look up the package.
  const pkgs = new Set<string>()
  for (const f of left) {
    let out = ''
    const p = isWin ? spawn('cmd.exe', ['/c', tlmgr, 'search', '--global', '--file', `/${f}`], { windowsHide: true }) : spawn(tlmgr, ['search', '--global', '--file', `/${f}`])
    log(`Looking up ${f}…`)
    await new Promise<void>((done) => {
      p.stdout.on('data', (d) => (out += d))
      p.on('close', () => done())
      p.on('error', () => done())
    })
    // Output lists "package:" lines followed by indented file paths.
    const pkg = out.split(/\r?\n/).find((l) => /^[A-Za-z0-9._-]+:$/.test(l))
    if (pkg) pkgs.add(pkg.slice(0, -1))
    else log(`No package found that provides ${f}.`)
  }
  if (pkgs.size) {
    log(`Installing ${[...pkgs].join(', ')}…`)
    await exec(['install', ...pkgs])
    left = await notFound(binDir, left, root)
  }
  if (left.length) log(`Still missing: ${left.join(', ')}`)
  // Done if the files this compile stopped on are there now (an optional extra may still be missing).
  return files.every((f) => !left.includes(f))
}
