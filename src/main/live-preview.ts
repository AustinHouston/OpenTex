// Live preview: rebuilds the PDF in the background while the user types.
//
// The build runs in a private folder per project (in the system temp folder), never in the
// user's folder: unsaved editor text is written there and found first through TEXINPUTS, and
// TeX's output (.aux, .log, .pdf, .synctex.gz) goes there through -output-directory. The user's
// files are only ever written by Save or Autosave.
//
// To be fast it reuses the .aux/.bbl of the last full compile and runs a single engine pass,
// runs BibTeX/Biber only when the citations or .bib files change, turns PNG figures into
// ready-made PDFs once (pdfTeX otherwise re-encodes every PNG with transparency on every pass),
// runs TeX at low priority, and never runs more than one build at a time in the whole app.
import { BrowserWindow, ipcMain, IpcMainInvokeEvent, powerMonitor } from 'electron'
import { ChildProcess, spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { constants as osConstants, setPriority, tmpdir } from 'os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { LiveBox, LiveRequest, LiveResult } from '../shared/live-preview'
import type { TexInfo } from '../shared/types'
import type { Project } from './project'
import { detectTex, parseLog } from './tex'
import { loadSettings } from './settings'
import { synctexForward, synctexInverse } from './extras'

const isWin = process.platform === 'win32'
const exe = (name: string): string => (isWin ? `${name}.exe` : name)
const hash = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex')

/** One private build folder per project folder + main-file folder. */
interface Shadow {
  dir: string
  root: string
  cwd: string // folder of the main file, where TeX runs
  written: Map<string, string> // path inside dir -> hash of the text written there
  seededAt: number // mtime of the project's .aux we last copied in
  citeSig: string
  scannedAt: number
  images: Map<string, string> // png path -> "mtime:size" turned into a PDF
  lastPdf: string | null
}
const shadows = new Map<string, Shadow>()
const lastShadowOf = new Map<string, Shadow>() // project root -> folder of the last good build

let current: { root: string; proc: ChildProcess } | null = null
let activeRoot: string | null = null // project whose build is running
let cancelledRoot: string | null = null
let queue: Promise<unknown> = Promise.resolve()

let texCache: { at: number; tex: TexInfo } | null = null
async function tex(): Promise<TexInfo> {
  if (texCache && Date.now() - texCache.at < 30_000) return texCache.tex
  const t = detectTex((await loadSettings()).texPath)
  texCache = { at: Date.now(), tex: t }
  return t
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, root: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    let out = ''
    const p = spawn(cmd, args, { cwd, env, windowsHide: true })
    current = { root, proc: p }
    // Below normal priority, so typing, scrolling and other apps always come first.
    try {
      if (p.pid) setPriority(p.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
    } catch {
      /* not allowed here; run at normal priority */
    }
    const timer = setTimeout(() => p.kill(), timeoutMs)
    p.stdout?.on('data', (d) => (out += d))
    p.stderr?.on('data', (d) => (out += d))
    p.on('error', (e) => {
      clearTimeout(timer)
      if (current?.proc === p) current = null
      done({ code: -1, out: out + `\n${e.message}` })
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (current?.proc === p) current = null
      done({ code, out })
    })
  })
}

const copyIfExists = (from: string, to: string): Promise<void> => fs.copyFile(from, to).catch(() => {})
const mtime = async (p: string): Promise<number> => (await fs.stat(p).catch(() => null))?.mtimeMs ?? 0

/** Folders under the main file's folder (for \include .aux files) and the PNG figures in them. */
async function scan(cwd: string): Promise<{ dirs: string[]; pngs: string[] }> {
  const dirs: string[] = []
  const pngs: string[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(join(cwd, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? join(rel, e.name) : e.name
      if (e.isDirectory() && depth < 4) {
        dirs.push(r)
        await walk(r, depth + 1)
      } else if (e.isFile() && /\.png$/i.test(e.name) && pngs.length < 80) pngs.push(r)
    }
  }
  await walk('', 0)
  return { dirs, pngs }
}

/** Unsaved text left in the private folder by an earlier session must never hide the saved files. */
async function forgetOldCopies(dir: string, depth = 0): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth < 5) await forgetOldCopies(p, depth + 1)
    else if (/\.(tex|bib|sty|cls|bst|ltx)$/i.test(e.name)) await fs.rm(p, { force: true })
  }
}

/**
 * Turn PNG figures into one-page PDFs in the private folder. \includegraphics{figures/plot}
 * (no extension) then finds plot.pdf there first, which pdfTeX copies as is instead of
 * decompressing and re-compressing the picture on every pass. Same size, same look.
 */
async function cacheImages(sh: Shadow, pngs: string[], binDir: string, env: NodeJS.ProcessEnv, stem: string): Promise<void> {
  const pdftex = join(binDir, exe('pdftex'))
  if (!existsSync(pdftex)) return
  const before = JSON.stringify([...sh.images])
  // A picture that was deleted or replaced by a real PDF must not live on in the preview.
  for (const rel of [...sh.images.keys()]) {
    if (pngs.includes(rel) && !existsSync(join(sh.cwd, rel.replace(/\.png$/i, '.pdf')))) continue
    sh.images.delete(rel)
    await fs.rm(join(sh.dir, rel.replace(/\.png$/i, '.pdf')), { force: true })
  }
  for (const rel of pngs) {
    const src = join(sh.cwd, rel)
    const pdfRel = rel.replace(/\.png$/i, '.pdf')
    if (pdfRel === `${stem}.pdf` || existsSync(join(sh.cwd, pdfRel))) continue // a real PDF of that name wins
    const st = await fs.stat(src).catch(() => null)
    if (!st || st.size > 30 * 2 ** 20) continue
    const key = `${st.mtimeMs}:${st.size}`
    const out = join(sh.dir, pdfRel)
    if (sh.images.get(rel) === key && existsSync(out)) continue
    const work = join(sh.dir, '.img')
    await fs.mkdir(work, { recursive: true })
    const name = basename(src).replace(/[{}%#\\]/g, '')
    if (name !== basename(src)) continue
    const tex = `\\pdfoutput=1\\pdfhorigin=0pt\\pdfvorigin=0pt\\pdfximage{${name}}\\setbox0=\\hbox{\\pdfrefximage\\pdflastximage}\\pdfpagewidth=\\wd0\\pdfpageheight=\\ht0\\shipout\\box0\\end`
    const r = await run(pdftex, ['-interaction=batchmode', '-halt-on-error', `-output-directory=${work}`, '-jobname=img', tex], dirname(src), env, sh.root, 20_000)
    if (r.code === 0 && existsSync(join(work, 'img.pdf'))) {
      await fs.mkdir(dirname(out), { recursive: true })
      await fs.rename(join(work, 'img.pdf'), out)
      sh.images.set(rel, key)
    }
  }
  if (JSON.stringify([...sh.images]) !== before) await fs.writeFile(join(sh.dir, 'images.json'), JSON.stringify(Object.fromEntries(sh.images)))
}

/** The lines of the .aux files that decide what BibTeX/Biber produce, plus the .bib files themselves. */
async function citeSignature(sh: Shadow, stem: string, overrides: Map<string, string>): Promise<{ sig: string; needed: boolean }> {
  const aux = await fs.readFile(join(sh.dir, `${stem}.aux`), 'utf8').catch(() => '')
  let lines = aux.split('\n').filter((l) => /^\\(citation|bibdata|bibstyle|abx@aux@cite)/.test(l))
  for (const m of aux.matchAll(/^\\@input\{(.+?)\}/gm)) {
    const sub = await fs.readFile(join(sh.dir, m[1]), 'utf8').catch(() => '')
    lines = lines.concat(sub.split('\n').filter((l) => /^\\(citation|abx@aux@cite)/.test(l)))
  }
  const bcf = existsSync(join(sh.dir, `${stem}.bcf`))
  const bibdata = aux.match(/^\\bibdata\{(.+?)\}/m)?.[1]
  if (!bibdata && !bcf) return { sig: '', needed: false }
  const bibs = bibdata ? bibdata.split(',').map((b) => resolve(sh.cwd, b.trim().replace(/\.bib$/i, '') + '.bib')) : []
  if (bcf) {
    lines.push(hash(await fs.readFile(join(sh.dir, `${stem}.bcf`)).catch(() => '')))
    for (const f of await fs.readdir(sh.cwd).catch(() => [])) if (/\.bib$/i.test(f)) bibs.push(join(sh.cwd, f))
  }
  for (const b of bibs) lines.push(overrides.has(b) ? hash(overrides.get(b)!) : `${b}:${await mtime(b)}`)
  return { sig: hash(lines.join('\n')), needed: true }
}

async function build(project: Project, req: LiveRequest): Promise<LiveResult> {
  const start = Date.now()
  const result = (r: Partial<LiveResult>): LiveResult => ({ ok: false, ms: Date.now() - start, passes: 0, bib: false, rerun: false, ...r })
  const t = await tex()
  if (!t.found || !t.binDir) return result({ skipped: 'no-tex' })
  const root = project.root
  const mainAbs = project.abs(req.target)
  const cwd = dirname(mainAbs)
  const name = basename(mainAbs)
  const stem = name.replace(/\.tex$/i, '')
  const dir = join(tmpdir(), 'OpenTex-live', hash(root + '\0' + cwd).slice(0, 16))
  let sh = shadows.get(dir)
  if (!sh) {
    sh = { dir, root, cwd, written: new Map(), seededAt: 0, citeSig: '', scannedAt: 0, images: new Map(), lastPdf: null }
    shadows.set(dir, sh)
    await forgetOldCopies(dir)
    try {
      const manifest = await fs.readFile(join(dir, 'images.json'), 'utf8')
      for (const [k, v] of Object.entries(JSON.parse(manifest) as Record<string, string>)) sh.images.set(k, v)
    } catch {
      /* first time, or unreadable: the pictures are converted again */
    }
  }
  const binDir = t.binDir
  const engine = t.engines.includes(req.engine) ? req.engine : t.engines[0]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: binDir + delimiter + (process.env.PATH ?? ''),
    // The private folder first, then the usual places (the empty entry), which include the main file's folder.
    TEXINPUTS: dir + delimiter + (process.env.TEXINPUTS ?? ''),
    BIBINPUTS: dir + delimiter + cwd + delimiter + (process.env.BIBINPUTS ?? ''),
    BSTINPUTS: cwd + delimiter + (process.env.BSTINPUTS ?? ''),
    max_print_line: '10000' // one error per line, so file names in the log aren't wrapped
  }
  await fs.mkdir(dir, { recursive: true })

  // Folders (TeX can't create them for \include) and figures, every half minute at most.
  if (Date.now() - sh.scannedAt > 30_000) {
    sh.scannedAt = Date.now()
    const { dirs, pngs } = await scan(cwd)
    for (const d of dirs) await fs.mkdir(join(dir, d), { recursive: true }).catch(() => {})
    await cacheImages(sh, pngs, binDir, env, stem)
  }

  // Reuse the cross-references and bibliography of the last full compile.
  const projAux = join(cwd, `${stem}.aux`)
  const projAuxTime = await mtime(projAux)
  if (projAuxTime > sh.seededAt) {
    sh.seededAt = projAuxTime
    for (const ext of ['aux', 'bbl', 'toc', 'lof', 'lot', 'out', 'bcf', 'nav', 'snm']) await copyIfExists(join(cwd, `${stem}.${ext}`), join(dir, `${stem}.${ext}`))
    const aux = await fs.readFile(projAux, 'utf8').catch(() => '')
    for (const m of aux.matchAll(/^\\@input\{(.+?)\}/gm)) await copyIfExists(join(cwd, m[1]), join(dir, m[1]))
    sh.citeSig = (await citeSignature(sh, stem, new Map())).sig
  }

  // The unsaved text. Files saved since the last build are dropped so TeX reads the user's copy again.
  const overrides = new Map<string, string>() // absolute project path -> text
  const keep = new Set<string>()
  for (const f of req.files) {
    const abs = project.abs(f.path)
    const rel = relative(cwd, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue // outside the main file's folder: TeX reads the saved copy
    overrides.set(abs, f.text)
    const dest = join(dir, rel)
    keep.add(dest)
    const h = hash(f.text)
    if (sh.written.get(dest) !== h || !existsSync(dest)) {
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, f.text, 'utf8')
      sh.written.set(dest, h)
    }
  }
  for (const dest of [...sh.written.keys()]) {
    if (keep.has(dest)) continue
    await fs.rm(dest, { force: true })
    sh.written.delete(dest)
  }

  const auxFile = join(dir, `${stem}.aux`)
  const goodAux = auxFile + '.good'
  await copyIfExists(auxFile, goodAux)
  if (cancelledRoot === root) return result({ cancelled: true })
  const args = ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', `-output-directory=${dir}`, name]
  const pass = (): Promise<{ code: number | null; out: string }> => run(join(binDir, exe(engine)), args, cwd, env, root)
  let r = await pass()
  let passes = 1
  let bib = false
  if (cancelledRoot === root) return result({ cancelled: true, passes })
  const pdfAbs = join(dir, `${stem}.pdf`)
  if (r.code === 0) {
    const cite = await citeSignature(sh, stem, overrides)
    if (cite.needed && (cite.sig !== sh.citeSig || !existsSync(join(dir, `${stem}.bbl`)))) {
      const biber = existsSync(join(dir, `${stem}.bcf`)) && existsSync(join(binDir, exe('biber')))
      await run(join(binDir, exe(biber ? 'biber' : 'bibtex')), [stem], dir, env, root)
      if (cancelledRoot === root) return result({ cancelled: true, passes })
      sh.citeSig = cite.sig
      bib = true
      r = await pass()
      passes++
      if (cancelledRoot === root) return result({ cancelled: true, passes })
    }
  }
  if (r.code === 0 && existsSync(pdfAbs)) {
    // Kept under its own name: a later failed pass deletes <stem>.pdf, but SyncTeX must keep working.
    const good = join(dir, `${stem}-live.pdf`)
    await fs.rename(pdfAbs, good)
    await fs.rename(join(dir, `${stem}.synctex.gz`), join(dir, `${stem}-live.synctex.gz`)).catch(() => {})
    sh.lastPdf = good
    lastShadowOf.set(root, sh)
    const pdf = new Uint8Array(await fs.readFile(good))
    return result({ ok: true, pdf, passes, bib, rerun: /Rerun to get|Label\(s\) may have changed/.test(r.out) })
  }

  // Failed: keep the last good cross-references, and report the first error in the user's terms.
  await copyIfExists(goodAux, auxFile)
  const texLog = await fs.readFile(join(dir, `${stem}.log`), 'latin1').catch(() => '')
  const log = (texLog || r.out).split(dir + sep).join(cwd + sep)
  const { problems, missingFiles } = parseLog(log, root, cwd)
  const first = problems.find((p) => p.severity === 'error' && p.file && p.line && !p.file.startsWith('..')) ?? problems.find((p) => p.severity === 'error')
  const message = missingFiles.length ? `Missing package file: ${missingFiles.join(', ')}` : (first?.message ?? 'TeX stopped without a PDF')
  const inProject = first?.file && !first.file.startsWith('..') ? first.file : null
  return result({ passes, error: { file: inProject, line: inProject ? (first?.line ?? null) : null, message } })
}

/** Source line -> box in the live PDF. Unsaved files were built from their copy in the private folder. */
async function forward(project: Project, file: string, line: number): Promise<LiveBox | null> {
  const sh = lastShadowOf.get(project.root)
  const t = await tex()
  if (!sh?.lastPdf || !t.binDir) return null
  const abs = project.abs(file)
  const copy = join(sh.dir, relative(sh.cwd, abs))
  return synctexForward(t.binDir, project.root, sh.written.has(copy) ? copy : abs, line, sh.lastPdf)
}

/** Point in the live PDF -> project file and line. */
async function inverse(project: Project, page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
  const sh = lastShadowOf.get(project.root)
  const t = await tex()
  if (!sh?.lastPdf || !t.binDir) return null
  const inCopy = await synctexInverse(t.binDir, sh.dir, sh.lastPdf, page, x, y)
  if (inCopy) return { file: relative(project.root, join(sh.cwd, inCopy.file)).split(sep).join('/'), line: inCopy.line }
  return synctexInverse(t.binDir, project.root, sh.lastPdf, page, x, y)
}

function cancel(root: string): void {
  if (activeRoot !== root) return
  cancelledRoot = root
  if (current?.root === root) current.proc.kill()
}

export function registerLivePreviewIpc(need: (e: IpcMainInvokeEvent) => Project): void {
  ipcMain.handle('live:build', (e, req: LiveRequest) => {
    const project = need(e)
    // One build at a time in the whole app; the page itself never asks for a second while one runs.
    const job = queue.then(async (): Promise<LiveResult> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win || win.isMinimized() || !win.isVisible()) return { ok: false, ms: 0, passes: 0, bib: false, rerun: false, skipped: 'hidden' }
      if (cancelledRoot === project.root) cancelledRoot = null
      activeRoot = project.root
      try {
        return await build(project, req)
      } finally {
        activeRoot = null
      }
    })
    queue = job.catch(() => {})
    return job
  })
  ipcMain.handle('live:cancel', (e) => {
    try {
      cancel(need(e).root)
    } catch {
      /* the folder is already closed; its build finishes on its own and is ignored */
    }
  })
  ipcMain.handle('live:forward', (e, file: string, line: number) => forward(need(e), file, line))
  ipcMain.handle('live:inverse', (e, page: number, x: number, y: number) => inverse(need(e), page, x, y))
  ipcMain.handle('live:onBattery', () => powerMonitor.isOnBatteryPower())
  const tell = (onBattery: boolean): void => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('live:power', onBattery))
  powerMonitor.on('on-battery', () => tell(true))
  powerMonitor.on('on-ac', () => tell(false))
}
