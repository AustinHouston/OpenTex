// Word (.docx) -> LaTeX project, using Pandoc (https://pandoc.org), the standard open-source
// document converter. OpenTex uses an installed Pandoc if there is one; otherwise it can download
// the official Pandoc release into its own folder (no administrator rights needed).
import { app, net } from 'electron'
import { execFile } from 'child_process'
import { createWriteStream, existsSync, promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, delimiter, dirname, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { restructure } from './word-layout'

const isWin = process.platform === 'win32'
const exe = isWin ? 'pandoc.exe' : 'pandoc'
type Log = (line: string) => void

const ownDir = (): string => join(app.getPath('userData'), 'pandoc')
const FALLBACK_VERSION = '3.13'

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
    )
  })
}

async function findIn(dir: string, depth = 3): Promise<string | null> {
  if (depth < 0) return null
  const direct = join(dir, exe)
  if (existsSync(direct)) return direct
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) {
      const hit = await findIn(join(dir, e.name), depth - 1)
      if (hit) return hit
    }
  }
  return null
}

/** Path to a working pandoc, or null. */
export async function findPandoc(): Promise<string | null> {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, exe)),
    '/opt/homebrew/bin/pandoc',
    '/usr/local/bin/pandoc',
    '/usr/bin/pandoc',
    join(local, 'Pandoc', exe), // the per-user Windows installer
    'C:\\Program Files\\Pandoc\\pandoc.exe'
  ]
  const own = existsSync(ownDir()) ? await findIn(ownDir()) : null
  for (const p of [own, ...candidates]) if (p && existsSync(p)) return p
  return null
}

export async function pandocVersion(path: string): Promise<string | null> {
  const r = await run(path, ['--version'])
  return r.code === 0 ? (r.out.match(/pandoc(?:\.exe)? ([\d.]+)/)?.[1] ?? null) : null
}

/** Download the official Pandoc release for this computer into OpenTex's own folder. */
export async function installPandoc(log: Log): Promise<boolean> {
  try {
    // The "latest" page redirects to the newest tag; this avoids GitHub's rate-limited API.
    // If that lookup fails, fall back to a release known to work.
    let version = FALLBACK_VERSION
    try {
      const latest = await net.fetch('https://github.com/jgm/pandoc/releases/latest')
      version = (latest.url || '').match(/\/tag\/v?([\d.]+)\/?$/)?.[1] ?? FALLBACK_VERSION
    } catch {
      log('Could not check for the newest Pandoc; using a known version.')
    }
    const asset =
      process.platform === 'darwin'
        ? `pandoc-${version}-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-macOS.zip`
        : isWin
          ? `pandoc-${version}-windows-x86_64.zip`
          : `pandoc-${version}-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`
    const url = `https://github.com/jgm/pandoc/releases/download/${version}/${asset}`
    log(`Downloading Pandoc ${version}…`)
    const res = await net.fetch(url)
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}) from ${url}`)
    const total = Number(res.headers.get('content-length')) || 0
    const tmp = await fs.mkdtemp(join(tmpdir(), 'opentex-pandoc-'))
    const file = join(tmp, asset)
    let got = 0
    let lastPct = -20
    const body = Readable.fromWeb(res.body as never)
    body.on('data', (c: Buffer) => {
      got += c.length
      const pct = total ? Math.floor((got / total) * 100) : 0
      if (pct >= lastPct + 20) {
        lastPct = pct
        log(`  ${pct}%`)
      }
    })
    await pipeline(body, createWriteStream(file))
    log('Unpacking…')
    await fs.rm(ownDir(), { recursive: true, force: true })
    await fs.mkdir(ownDir(), { recursive: true })
    // bsdtar (macOS, and Windows 10+) reads zip files too.
    const r = await run('tar', ['-xf', file, '-C', ownDir()])
    await fs.rm(tmp, { recursive: true, force: true })
    if (r.code !== 0) throw new Error(`Unpacking failed: ${r.out.slice(0, 300)}`)
    const p = await findPandoc()
    const v = p && (await pandocVersion(p))
    log(v ? `Pandoc ${v} is ready.` : 'Pandoc was unpacked but does not run on this computer.')
    return Boolean(v)
  } catch (e) {
    log(`Could not get Pandoc: ${(e as Error).message}`)
    return false
  }
}

// Pandoc Lua filter: accept tracked changes, and turn Word comments into OpenTex comment lines
// (%@comment[Author, date]{commented text}: comment), which LaTeX ignores.
const FILTER = String.raw`
local function clean(s, extra)
  s = (s or ''):gsub('[\r\n]+', ' '):gsub('%%', ''):gsub('^%s+', ''):gsub('%s+$', '')
  if extra then s = s:gsub(extra, '') end
  return s
end

function Span(el)
  if el.classes:includes('insertion') or el.classes:includes('paragraph-insertion') then return el.content end
  if el.classes:includes('deletion') or el.classes:includes('paragraph-deletion') then return {} end
end

local KEEP = PANDOC_STATE and true

function Inlines(inlines)
  if not KEEP_COMMENTS then
    local out = pandoc.Inlines{}
    for _, el in ipairs(inlines) do
      if not (el.t == 'Span' and (el.classes:includes('comment-start') or el.classes:includes('comment-end'))) then out:insert(el) end
    end
    return out
  end
  local out = pandoc.Inlines{}
  local open = {}
  for _, el in ipairs(inlines) do
    if el.t == 'Span' and el.classes:includes('comment-start') then
      open[el.identifier] = { pos = #out + 1, author = el.attributes.author, date = el.attributes.date, text = pandoc.utils.stringify(el.content) }
      out:insert(pandoc.RawInline('latex', ''))
    elseif el.t == 'Span' and el.classes:includes('comment-end') then
      local c = open[el.identifier]
      if c then
        local quoted = {}
        for i = c.pos + 1, #out do quoted[#quoted + 1] = out[i] end
        local q = clean(pandoc.utils.stringify(pandoc.Inlines(quoted)), '[{}]'):sub(1, 160)
        out[c.pos] = pandoc.RawInline('latex', '\n%@comment[' .. clean(c.author, '[%],]') .. ', ' .. (c.date or ''):sub(1, 10) .. ']' ..
          (q ~= '' and ('{' .. q .. '}') or '') .. ': ' .. clean(c.text) .. '\n')
        open[el.identifier] = nil
      end
    else
      out:insert(el)
    end
  end
  for _, c in pairs(open) do
    out[c.pos] = pandoc.RawInline('latex', '\n%@comment[' .. clean(c.author, '[%],]') .. ', ' .. (c.date or ''):sub(1, 10) .. ']: ' .. clean(c.text) .. '\n')
  end
  return out
end

return {
  { Span = Span },
  { Inlines = Inlines }
}
`

export interface WordImportResult {
  ok: boolean
  folder: string
  mainFile: string
  log: string
  citations: number
  comments: number
  images: number
  unsupportedImages: string[] // EMF/WMF pictures LaTeX can't include
}

/** Create `<parent>/<name>` (adding -2, -3… if taken) and convert the Word file into it. */
export async function importWord(pandoc: string, docx: string, parent: string, keepComments: boolean): Promise<WordImportResult> {
  const name = basename(docx).replace(/\.docx$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'paper'
  let folder = join(parent, name)
  for (let i = 2; existsSync(folder); i++) folder = join(parent, `${name}-${i}`)
  await fs.mkdir(folder, { recursive: true })
  const filter = join(folder, '.opentex-import.lua')
  await fs.writeFile(filter, FILTER.replace('local KEEP = PANDOC_STATE and true', `KEEP_COMMENTS = ${keepComments ? 'true' : 'false'}`))
  let log = ''
  // 1. References embedded by Zotero / Mendeley / EndNote citation fields, if Pandoc can read them.
  let citations = 0
  let fmt = 'docx+citations'
  const bib = await run(pandoc, [docx, '-f', fmt, '-t', 'bibtex', '-o', 'refs.bib'], folder)
  if (bib.code !== 0) {
    fmt = 'docx' // older Pandoc without the citations extension
    log += bib.out
  } else {
    const text = await fs.readFile(join(folder, 'refs.bib'), 'utf8').catch(() => '')
    citations = (text.match(/^@/gm) ?? []).length
    if (!citations) await fs.rm(join(folder, 'refs.bib'), { force: true })
  }
  // 2. The document itself.
  const args = [docx, '-f', fmt, '-t', 'latex', '--standalone', '--wrap=none', '--track-changes=all', '--extract-media=.', '--lua-filter', filter, '-o', 'main.tex']
  if (citations) args.push('--natbib', '--bibliography=refs.bib')
  const r = await run(pandoc, args, folder)
  log += r.out
  await fs.rm(filter, { force: true })
  const tex = await fs.readFile(join(folder, 'main.tex'), 'utf8').catch(() => '')
  if (r.code !== 0 || !tex) return { ok: false, folder, mainFile: 'main.tex', log, citations, comments: 0, images: 0, unsupportedImages: [] }

  // 3. Lay it out like the example paper: main.tex, sections/, figures/, original/.
  const lay = restructure(tex, { source: basename(docx), citations: citations > 0 })
  await fs.mkdir(join(folder, 'figures'), { recursive: true })
  for (const [from, to] of lay.media) await fs.rename(join(folder, from), join(folder, to)).catch(() => {})
  // Pictures the text doesn't use (rare) go to figures/ under their own names.
  for (const f of await fs.readdir(join(folder, 'media')).catch(() => [] as string[])) await fs.rename(join(folder, 'media', f), join(folder, 'figures', f)).catch(() => {})
  await fs.rm(join(folder, 'media'), { recursive: true, force: true })
  for (const f of lay.files) {
    await fs.mkdir(dirname(join(folder, f.path)), { recursive: true })
    await fs.writeFile(join(folder, f.path), f.text)
  }
  await fs.mkdir(join(folder, 'original'), { recursive: true })
  await fs.copyFile(docx, join(folder, 'original', basename(docx))).catch(() => {})
  const figures = await fs.readdir(join(folder, 'figures')).catch(() => [] as string[])
  if (!figures.length) await fs.rmdir(join(folder, 'figures')).catch(() => {})
  return {
    ok: true,
    folder,
    mainFile: 'main.tex',
    log,
    citations,
    comments: lay.files.reduce((n, f) => n + (f.text.match(/^\s*%@comment\[/gm) ?? []).length, 0),
    images: figures.length,
    unsupportedImages: figures.filter((f) => /\.(emf|wmf)$/i.test(f)).map((f) => `figures/${f}`)
  }
}
