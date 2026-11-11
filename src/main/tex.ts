import { spawn, ChildProcess } from 'child_process'
import { existsSync, readdirSync, promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'path'
import { CompileResult, Engine, Problem, TexInfo } from '../shared/types'

const isWin = process.platform === 'win32'
const exe = (name: string): string => (isWin ? `${name}.exe` : name)
const ENGINES: Engine[] = ['pdflatex', 'xelatex', 'lualatex']

/** Folders where TeX distributions usually put their binaries (GUI apps don't get the shell PATH on macOS). */
function candidateDirs(): string[] {
  const home = homedir()
  const dirs: string[] = []
  const withYears = (base: string, sub: string): void => {
    if (!existsSync(base)) return
    for (const y of readdirSync(base).filter((d) => /^\d{4}$/.test(d)).sort().reverse()) dirs.push(join(base, y, sub))
  }
  if (process.platform === 'darwin') {
    dirs.push('/Library/TeX/texbin')
    for (const a of ['universal-darwin', 'x86_64-darwin', 'aarch64-darwin']) dirs.push(join(home, 'Library/TinyTeX/bin', a))
    withYears('/usr/local/texlive', 'bin/universal-darwin')
    dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  } else if (isWin) {
    const appData = process.env.APPDATA ?? join(home, 'AppData/Roaming')
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData/Local')
    dirs.push(join(appData, 'TinyTeX/bin/windows'), join(appData, 'TinyTeX/bin/win32'))
    const progData = process.env.ProgramData ?? 'C:\\ProgramData'
    dirs.push(join(progData, 'TinyTeX/bin/windows'))
    dirs.push(join(local, 'Programs/MiKTeX/miktex/bin/x64'), 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64')
    withYears('C:\\texlive', 'bin\\windows')
    withYears('C:\\texlive', 'bin\\win32')
  } else {
    dirs.push(join(home, '.TinyTeX/bin/x86_64-linux'), join(home, 'bin'))
    withYears('/usr/local/texlive', 'bin/x86_64-linux')
    dirs.push('/usr/bin', '/usr/local/bin')
  }
  return [...dirs, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
}

export function detectTex(override: string): TexInfo {
  const dirs = override ? [override] : candidateDirs()
  for (const d of dirs) {
    const engines = ENGINES.filter((e) => existsSync(join(d, exe(e))))
    if (engines.length) return { found: true, binDir: d, latexmk: existsSync(join(d, exe('latexmk'))), engines }
  }
  return { found: false, binDir: null, latexmk: false, engines: [] }
}

interface RunOut {
  code: number | null
  output: string
}

let current: ChildProcess | null = null
let cancelled = false

function run(cmd: string, args: string[], cwd: string, binDir: string): Promise<RunOut> {
  return new Promise((done) => {
    const env = { ...process.env, PATH: binDir + delimiter + (process.env.PATH ?? '') }
    let output = ''
    const p = spawn(join(binDir, exe(cmd)), args, { cwd, env, windowsHide: true })
    current = p
    const timer = setTimeout(() => p.kill(), 5 * 60_000)
    p.stdout.on('data', (d) => (output += d))
    p.stderr.on('data', (d) => (output += d))
    p.on('error', (e) => {
      clearTimeout(timer)
      done({ code: -1, output: output + `\n${e.message}` })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      current = null
      done({ code, output })
    })
  })
}

export function cancelCompile(): void {
  if (current) {
    cancelled = true
    current.kill()
  }
}

export async function compile(root: string, mainFile: string, engine: Engine, tex: TexInfo, useLatexmk: boolean): Promise<CompileResult> {
  const start = Date.now()
  cancelled = false
  const mainAbs = resolve(root, mainFile)
  const cwd = dirname(mainAbs)
  const name = basename(mainAbs)
  const stem = name.replace(/\.tex$/i, '')
  const binDir = tex.binDir!
  if (!tex.engines.includes(engine)) engine = tex.engines[0]
  const common = ['-synctex=1', '-interaction=nonstopmode', '-file-line-error']
  let log = ''

  let usedLatexmk = false
  if (useLatexmk && tex.latexmk) {
    const flag = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }[engine]
    const r = await run('latexmk', [flag, '-f', ...common, name], cwd, binDir)
    log += r.output
    // latexmk needs Perl; MiKTeX on Windows often lacks it. Fall back to running the engine directly.
    usedLatexmk = !/perl/i.test(r.output.slice(0, 2000)) || existsSync(join(cwd, `${stem}.pdf`))
  }
  if (!usedLatexmk && !cancelled) {
    log = ''
    let r = await run(engine, [...common, name], cwd, binDir)
    log += r.output
    const aux = await fs.readFile(join(cwd, `${stem}.aux`), 'utf8').catch(() => '')
    let rerun = /Rerun to get|Label\(s\) may have changed/.test(r.output)
    if (existsSync(join(cwd, `${stem}.bcf`)) && existsSync(join(binDir, exe('biber')))) {
      log += (await run('biber', [stem], cwd, binDir)).output
      rerun = true
    } else if (/\\bibdata/.test(aux)) {
      log += (await run('bibtex', [stem], cwd, binDir)).output
      rerun = true
    }
    for (let i = 0; rerun && i < 2 && !cancelled; i++) {
      r = await run(engine, [...common, name], cwd, binDir)
      log += r.output
      rerun = /Rerun to get|Label\(s\) may have changed/.test(r.output)
    }
  }

  // The .log file has the cleanest record of the final pass.
  const texLog = await fs.readFile(join(cwd, `${stem}.log`), 'latin1').catch(() => '')
  const pdfAbs = join(cwd, `${stem}.pdf`)
  const { problems, missingFiles } = parseLog(texLog || log, root, cwd)
  const hasPdf = existsSync(pdfAbs)
  return {
    ok: hasPdf && !problems.some((p) => p.severity === 'error'),
    pdf: hasPdf ? relative(root, pdfAbs).split(sep).join('/') : null,
    log: log + (texLog ? `\n\n===== ${stem}.log =====\n` + texLog : ''),
    problems,
    missingFiles,
    durationMs: Date.now() - start,
    cancelled
  }
}

export function parseLog(log: string, root: string, cwd: string): { problems: Problem[]; missingFiles: string[] } {
  const problems: Problem[] = []
  const missingFiles = new Set<string>()
  const toRel = (f: string): string => relative(root, resolve(cwd, f)).split(sep).join('/')
  const seen = new Set<string>()
  const add = (p: Problem): void => {
    const key = `${p.severity}|${p.file}|${p.line}|${p.message}`
    if (!seen.has(key)) {
      seen.add(key)
      problems.push(p)
    }
  }
  const lines = log.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // -file-line-error format: ./chapter.tex:12: Undefined control sequence.
    const m = l.match(/^(.*?\.(?:tex|sty|cls|bib|ltx|dtx)):(\d+): (.*)$/)
    if (m) {
      let msg = m[3]
      // TeX puts the offending text on the following "l.N ..." line.
      const ctx = lines.slice(i + 1, i + 4).find((x) => /^l\.\d+/.test(x))
      if (ctx) msg += `  (${ctx.replace(/^l\.\d+\s*/, '').trim()})`
      add({ severity: 'error', file: toRel(m[1]), line: Number(m[2]), message: msg })
    } else if (/^! /.test(l)) {
      const lm = lines.slice(i + 1, i + 6).join('\n').match(/^l\.(\d+)/m)
      add({ severity: 'error', file: null, line: lm ? Number(lm[1]) : null, message: l.slice(2) })
    }
    const missing = l.match(/File `([^']+)' not found/)
    if (missing) missingFiles.add(missing[1])
    const w = l.match(/^(?:LaTeX|Package (\S+)) Warning: (.*)$/)
    if (w) {
      let msg = w[2]
      let j = i + 1
      while (j < lines.length && lines[j].trim() && !/Warning:/.test(lines[j]) && j - i < 4) msg += ' ' + lines[j++].trim()
      const ln = msg.match(/on input line (\d+)/)
      add({ severity: 'warning', file: null, line: ln ? Number(ln[1]) : null, message: (w[1] ? `${w[1]}: ` : '') + msg })
    }
  }
  return { problems, missingFiles: [...missingFiles] }
}
