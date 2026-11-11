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
      const code = await run('tar', ['-xf', file, '-C', parent], log)
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

/** Find the TeX Live packages that provide the missing files, then install them. */
export async function installMissing(binDir: string, files: string[], log: Log): Promise<boolean> {
  const tlmgr = isWin ? join(binDir, 'tlmgr.bat') : join(binDir, 'tlmgr')
  const exec = (args: string[]): Promise<number> => (isWin ? run('cmd.exe', ['/c', tlmgr, ...args], log) : run(tlmgr, args, log))
  const pkgs = new Set<string>()
  for (const f of files) {
    let out = ''
    const p = isWin ? spawn('cmd.exe', ['/c', tlmgr, 'search', '--global', '--file', `/${f}`]) : spawn(tlmgr, ['search', '--global', '--file', `/${f}`])
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
  if (!pkgs.size) return false
  log(`Installing ${[...pkgs].join(', ')}…`)
  const code = await exec(['install', ...pkgs])
  return code === 0
}
