// SyncTeX lookups (PDF <-> source) and git status, using command-line tools when present.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, normalize, relative, resolve, sep } from 'path'

const isWin = process.platform === 'win32'

function exec(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 10_000 }, (err, stdout) => done(err ? null : stdout))
  })
}

function synctexBin(binDir: string | null): string | null {
  if (!binDir) return null
  const p = join(binDir, isWin ? 'synctex.exe' : 'synctex')
  return existsSync(p) ? p : null
}

const field = (out: string, name: string): string | undefined => out.match(new RegExp(`^${name}:(.*)$`, 'm'))?.[1]?.trim()

export interface PdfBox {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** Source line -> box in the PDF (units: PDF points from the page's top-left). */
export async function synctexForward(binDir: string | null, root: string, file: string, line: number, pdf: string): Promise<PdfBox | null> {
  const bin = synctexBin(binDir)
  if (!bin) return null
  const pdfAbs = resolve(root, pdf)
  const out = await exec(bin, ['view', '-i', `${line}:1:${resolve(root, file)}`, '-o', pdfAbs], dirname(pdfAbs))
  if (!out || !field(out, 'Page')) return null
  const h = Number(field(out, 'H'))
  return { page: Number(field(out, 'Page')), x: Number(field(out, 'h')), y: Number(field(out, 'v')) - h, w: Number(field(out, 'W')), h }
}

/** Point in the PDF -> source file and line. */
export async function synctexInverse(binDir: string | null, root: string, pdf: string, page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
  const bin = synctexBin(binDir)
  if (!bin) return null
  const pdfAbs = resolve(root, pdf)
  const out = await exec(bin, ['edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${pdfAbs}`], dirname(pdfAbs))
  const input = out && field(out, 'Input')
  const line = out && Number(field(out, 'Line'))
  if (!input || !line) return null
  const rel = relative(root, normalize(input)).split(sep).join('/')
  return rel.startsWith('..') ? null : { file: rel, line }
}

/** Branch and number of changed files, or null when the folder isn't a git repository. */
export async function gitStatus(root: string): Promise<{ branch: string; changed: number } | null> {
  if (!existsSync(join(root, '.git'))) return null
  const out = await exec('git', ['status', '--porcelain', '--branch'], root)
  if (out === null) return null
  const lines = out.split('\n').filter(Boolean)
  const branch = (lines[0] ?? '').replace(/^## /, '').replace(/\.\.\..*$/, '').replace(/^No commits yet on /, '')
  return { branch, changed: lines.length - 1 }
}
