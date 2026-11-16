// LaTeX project -> Word (.docx), using Pandoc. The project's own files are never changed:
// OpenTex copies the .tex/.bib files to a temporary folder, marks where each comment goes, points
// \includegraphics at the right picture files, runs Pandoc there and saves the result.
import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, nativeImage, shell } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from 'path'
import { findPandoc, pandocVersion, run } from './pandoc'
import type { Project } from './project'
import { detectTex } from './tex'
import { loadSettings } from './settings'

export interface ExportComment {
  file: string // project-relative path of the .tex file
  from: number // character offsets of the commented text in that file, as saved on disk
  to: number
  author: string
  date: string
  text: string
  replies: { author: string; date: string; text: string }[]
}

export interface WordExportResult {
  ok: boolean
  out: string
  log: string
  comments: number // placed in the Word file
  commentsMissed: number
  figures: number
  missingFigures: string[] // pictures Word can't show (not found, or a format that couldn't be converted)
  citations: 'text' | 'none' | 'no-bib'
  error?: string // plain-English reason when ok is false
}

type Log = (line: string) => void

const SKIP_DIRS = new Set(['.git', 'node_modules', '.opentex', '.svn', '__pycache__'])
const COPY_EXT = /\.(tex|bib|tikz|pgf|ltx)$/i
const IMAGE_EXTS = ['', '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.gif', '.PNG', '.JPG', '.JPEG', '.PDF', '.EPS']

/** Every file worth copying (sources and bibliographies), as project-relative paths. */
async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length > 3000) return
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1)
      } else if (COPY_EXT.test(e.name)) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  await walk(root, 0)
  return out
}

// ---------- Placing comment markers in the copies ----------
// A comment becomes two plain-text markers (XQOTXS7QX ... XQOTXE7QX) that the Lua filter below
// turns into Word comment ranges. The markers must land in ordinary text: not inside math, a
// LaTeX comment, \verb, or the argument of a command like \cite or \label, so they're moved out
// of those first.

const mark = (kind: 'S' | 'E', n: number): string => `XQOTX${kind}${n}QX`

/** Spans of text where a marker must not go: math, % comments and \verb. */
export function noGoZones(text: string): [number, number][] {
  const zones: [number, number][] = []
  const re = /\\verb\*?(.)|\\\\|\\[$%()[\]]|\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math|flalign|alignat)(\*?)\}|\$\$|\$|%/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const a = m.index
    let b = -1
    const tok = m[0]
    if (m[1]) b = text.indexOf(m[1], a + tok.length) + 1 // \verb|...|
    else if (tok === '\\\\' || tok === '\\$' || tok === '\\%') continue
    else if (tok === '\\(') b = text.indexOf('\\)', a + 2) + 2
    else if (tok === '\\[') b = text.indexOf('\\]', a + 2) + 2
    else if (tok === '\\)' || tok === '\\]') continue
    else if (m[2]) {
      const end = `\\end{${m[2]}${m[3]}}`
      const i = text.indexOf(end, a + tok.length)
      b = i < 0 ? -1 : i + end.length
    } else if (tok === '$$') b = text.indexOf('$$', a + 2) + 2
    else if (tok === '$') {
      // the closing $, skipping \$
      let i = a + 1
      while ((i = text.indexOf('$', i)) >= 0 && text[i - 1] === '\\') i++
      b = i < 0 ? -1 : i + 1
    } else if (tok === '%') {
      const i = text.indexOf('\n', a)
      b = i < 0 ? text.length : i
    }
    if (b <= a) b = text.length // unclosed: to the end, so nothing goes in there
    zones.push([a, b])
    re.lastIndex = b
  }
  return zones
}

// Commands whose argument is ordinary text, so a comment may start or end inside it.
const TEXT_COMMANDS = new Set(
  'section subsection subsubsection paragraph subparagraph chapter part caption emph textbf textit textsl textsc textsf textrm textup textmd underline uline mbox title author textnormal'.split(' ')
)

/** The innermost unclosed `{` before p that belongs to a command with a non-text argument. */
function enclosingCommand(text: string, skip: Uint8Array, p: number): { start: number; end: number } | null {
  let depth = 0
  const floor = Math.max(0, p - 4000)
  for (let i = p - 1; i >= floor; i--) {
    if (skip[i]) continue // braces in math, % comments or \verb don't count
    const c = text[i]
    if (text[i - 1] === '\\' && (c === '{' || c === '}')) continue
    if (c === '}') depth++
    else if (c === '{') {
      if (depth > 0) {
        depth--
        continue
      }
      // Walk back over earlier [opt] and {arg} groups to the command name.
      let j = i
      for (;;) {
        while (j > 0 && /\s/.test(text[j - 1])) j--
        const close = text[j - 1]
        if (close !== ']' && close !== '}') break
        const open = close === ']' ? '[' : '{'
        let d = 0
        let k = j - 1
        for (; k >= floor; k--) {
          if (skip[k]) continue
          if (text[k] === close) d++
          else if (text[k] === open && --d === 0) break
        }
        if (k < floor) break
        j = k
      }
      const name = text.slice(Math.max(0, j - 40), j).match(/\\([A-Za-z@]+)\*?$/)
      if (!name) continue // a plain {group}: fine, keep looking outward
      if (TEXT_COMMANDS.has(name[1])) return null
      // Find where this command's arguments end.
      let end = i
      let d = 0
      for (; end < text.length; end++) {
        if (skip[end]) continue
        if (text[end] === '{' && text[end - 1] !== '\\') d++
        else if (text[end] === '}' && text[end - 1] !== '\\' && --d === 0) break
      }
      if (end >= text.length) return null // unbalanced braces: leave the spot alone
      end++
      while (end < text.length && (text[end] === '{' || text[end] === '[')) {
        const open = text[end]
        const close = open === '{' ? '}' : ']'
        let dd = 0
        for (; end < text.length; end++) {
          if (skip[end]) continue
          if (text[end] === open) dd++
          else if (text[end] === close && --dd === 0) break
        }
        end++
      }
      return { start: j - name[0].length, end: Math.min(end, text.length) }
    }
  }
  return null
}

/** Move a marker position out of places where it would break the LaTeX or get lost. */
export function safeSpot(text: string, zones: [number, number][], skip: Uint8Array, p: number, isEnd: boolean): number {
  for (let guard = 0; guard < 12; guard++) {
    const before = p
    // Not between a backslash and the character it escapes (\%, \&…), nor inside a command name,
    // nor between a command and its arguments.
    const name = text.slice(Math.max(0, p - 40), p).match(/\\[A-Za-z@]+$/)
    if (name && /[A-Za-z@{[*]/.test(text[p] ?? '')) p -= name[0].length
    else if (text[p - 1] === '\\' && !/\\\\$/.test(text.slice(Math.max(0, p - 2), p))) p--
    // A comment that starts at a heading or caption starts inside it, not in an empty paragraph before it.
    const head = isEnd ? null : text.slice(p, p + 40).match(/^\\(?:section|subsection|subsubsection|paragraph|chapter|caption)\*?\s*\{/)
    if (head) p += head[0].length
    const zone = zones.find(([a, b]) => p > a && p < b)
    if (zone) p = isEnd && text[zone[0]] !== '%' ? zone[1] : zone[0]
    const cmd = enclosingCommand(text, skip, p)
    if (cmd) p = isEnd ? cmd.end : cmd.start
    if (p === before) break
  }
  return p
}

/** Insert the markers for the comments in one file. */
function insertMarkers(text: string, marks: { n: number; from: number; to: number }[]): string {
  const zones = noGoZones(text)
  const skip = new Uint8Array(text.length)
  for (const [a, b] of zones) skip.fill(1, a, b)
  const inserts: { at: number; s: string; order: number }[] = []
  for (const m of marks) {
    if (m.from < 0 || m.to > text.length || m.from > m.to) continue
    const from = safeSpot(text, zones, skip, m.from, false)
    const to = Math.max(from, safeSpot(text, zones, skip, m.to, true))
    inserts.push({ at: from, s: mark('S', m.n), order: 0 }, { at: to, s: mark('E', m.n), order: 1 })
  }
  // Insert from the end so earlier offsets stay valid. At the same spot, ends go before starts.
  inserts.sort((a, b) => b.at - a.at || a.order - b.order)
  let out = text
  for (const ins of inserts) {
    // After a command name (\LaTeX|), an empty group keeps the marker from joining the name.
    const glue = /\\[A-Za-z@]+$/.test(out.slice(Math.max(0, ins.at - 40), ins.at)) ? '{}' : ''
    out = out.slice(0, ins.at) + glue + ins.s + out.slice(ins.at)
  }
  return out
}

// ---------- The Lua filter ----------
const luaString = (s: string): string =>
  '"' + s.replace(/[\\"]/g, (c) => '\\' + c).replace(/[\x00-\x1f]/g, (c) => '\\' + String(c.charCodeAt(0)).padStart(3, '0')) + '"'

/** A Word comment date: Word wants a full date-time. */
const wordDate = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : /^\d{4}-\d{2}-\d{2}T/.test(d) ? d : '')

function luaComments(comments: ExportComment[]): string {
  let id = 0
  const entries = comments.map((c, n) => {
    const parts = [{ author: c.author, date: c.date, text: c.text }, ...c.replies].map(
      (p) => `{ id = "${++id}", author = ${luaString(p.author || 'OpenTex')}, date = ${luaString(wordDate(p.date))}, text = ${luaString(p.text || '')} }`
    )
    return `  [${n + 1}] = { ${parts.join(', ')} }`
  })
  return `COMMENTS = {\n${entries.join(',\n')}\n}\n`
}

const FILTER = String.raw`
-- Written by OpenTex for one export; deleted afterwards.
-- 1. Comment markers -> Word comment ranges.  2. Equation numbers.  3. Tidy up.
local MARK = 'XQOTX([SE])(%d+)QX'
local seenS, seenE = {}, {}
local partOf = {}
for n, parts in pairs(COMMENTS) do for _, p in ipairs(parts) do partOf[p.id] = n end end

local function lines(text)
  local out = pandoc.Inlines{}
  local first = true
  for line in (text .. '\n'):gmatch('(.-)\r?\n') do
    if not first then out:insert(pandoc.LineBreak()) end
    first = false
    out:extend(pandoc.Inlines(line))
  end
  return out
end

local function spans(kind, n)
  local out = pandoc.Inlines{}
  for _, p in ipairs(COMMENTS[n] or {}) do
    if kind == 'S' then
      local attrs = { author = p.author }
      if p.date ~= '' then attrs.date = p.date end
      out:insert(pandoc.Span(lines(p.text), pandoc.Attr(p.id, {'comment-start'}, attrs)))
    else
      out:insert(pandoc.Span({}, pandoc.Attr(p.id, {'comment-end'}, {})))
    end
  end
  return out
end

local function note(kind, n)
  if kind == 'S' then seenS[n] = true else seenE[n] = true end
  return spans(kind, n)
end

-- Split a piece of text at the markers; make(text) rebuilds the pieces in between.
local function split(s, make)
  if not s:find('XQOTX', 1, true) then return nil end
  local out = pandoc.Inlines{}
  local pos = 1
  while true do
    local a, b, kind, n = s:find(MARK, pos)
    if not a then break end
    if a > pos then out:insert(make(s:sub(pos, a - 1))) end
    out:extend(note(kind, tonumber(n)))
    pos = b + 1
  end
  if pos <= #s then out:insert(make(s:sub(pos))) end
  return out
end

-- Markers that ended up inside something without text (math, raw LaTeX): put them around it.
local function around(el, field)
  local s = el[field]
  if not s:find('XQOTX', 1, true) then return nil end
  local starts, ends = pandoc.Inlines{}, pandoc.Inlines{}
  el[field] = s:gsub(MARK, function(kind, n)
    if kind == 'S' then starts:extend(note(kind, tonumber(n))) else ends:extend(note(kind, tonumber(n))) end
    return ''
  end)
  local out = pandoc.Inlines{}
  out:extend(starts)
  out:insert(el)
  out:extend(ends)
  return out
end

local markers = {
  Str = function(el) return split(el.text, pandoc.Str) end,
  Code = function(el) return split(el.text, function(t) return pandoc.Code(t, el.attr) end) end,
  Math = function(el) return around(el, 'text') end,
  RawInline = function(el) return around(el, 'text') end,
  CodeBlock = function(el) el.text = el.text:gsub(MARK, '') return el end,
  RawBlock = function(el) el.text = el.text:gsub(MARK, '') return el end,
}

-- Equation numbers, which Word doesn't add by itself: "(1)" after each numbered equation, and
-- \ref / \eqref to an equation label become that number.
local NUMBERED = { equation = true, align = true, gather = true, multline = true, eqnarray = true, flalign = true, alignat = true }
local count = 0
local labels = {}

-- Split at \\ that isn't inside braces or a nested environment.
local function rows(body)
  local out, depth, env, start, i = {}, 0, 0, 1, 1
  while i <= #body do
    local c = body:sub(i, i)
    if c == '\\' then
      local nxt = body:sub(i + 1, i + 1)
      if nxt == '\\' and depth == 0 and env == 0 then
        out[#out + 1] = body:sub(start, i - 1)
        start = i + 2
        i = i + 2
      elseif body:sub(i, i + 6) == '\\begin{' then env = env + 1 i = i + 7
      elseif body:sub(i, i + 4) == '\\end{' then env = env - 1 i = i + 5
      else i = i + 2 end
    else
      if c == '{' then depth = depth + 1 elseif c == '}' then depth = depth - 1 end
      i = i + 1
    end
  end
  out[#out + 1] = body:sub(start)
  return out
end

local function numberRow(row, all)
  if all and row:match('^%s*$') then return row, {} end
  local tag = row:match('\\tag%*?%s*(%b{})')
  local skip = row:find('\\nonumber', 1, true) or row:find('\\notag', 1, true)
  local num
  if tag then num = tag:sub(2, -2)
  elseif not skip then count = count + 1 num = tostring(count) end
  local labs = {}
  for l in row:gmatch('\\label%s*(%b{})') do labs[#labs + 1] = l:sub(2, -2) end
  if num then for _, l in ipairs(labs) do labels[l] = num end end
  row = row:gsub('\\label%s*%b{}', ''):gsub('\\tag%*?%s*%b{}', ''):gsub('\\nonumber', ''):gsub('\\notag', '')
  if num then row = row:gsub('%s*$', '') .. ' \\qquad (' .. num .. ')' end
  return row, labs
end

local function numberMath(el)
  if el.mathtype ~= 'DisplayMath' then return nil end
  local t = el.text
  local env, star = t:match('^%s*\\begin{(%a+)(%*?)}')
  if not env or not NUMBERED[env] or star == '*' then
    el.text = t:gsub('\\label%s*%b{}', '')
    return el
  end
  local head = t:match('^%s*\\begin{' .. env .. '}')
  if env == 'alignat' then head = t:match('^%s*\\begin{alignat}%s*%b{}') or head end
  local tail = '\\end{' .. env .. '}'
  local stop = t:find(tail, #head + 1, true)
  if not stop then return nil end
  local body = t:sub(#head + 1, stop - 1)
  local ids = {}
  if env == 'equation' or env == 'multline' then
    local whole, labs = numberRow(body, false)
    body = whole
    ids = labs
  else
    local parts = rows(body)
    for k, row in ipairs(parts) do
      local r, labs = numberRow(row, true)
      parts[k] = r
      for _, l in ipairs(labs) do ids[#ids + 1] = l end
    end
    body = table.concat(parts, '\\\\')
  end
  el.text = head .. body .. tail .. t:sub(stop + #tail)
  -- A bookmark for each label, so the equation's references link to it in Word.
  local out = el
  for _, l in ipairs(ids) do out = pandoc.Span({ out }, pandoc.Attr(l)) end
  return out
end

local function fixRef(el)
  local kind = el.attributes['reference-type']
  local num = labels[el.attributes['reference'] or '']
  if not kind or not num then return nil end
  if kind == 'eqref' then el.content = { pandoc.Str('(' .. num .. ')') }
  elseif kind == 'ref' then el.content = { pandoc.Str(num) }
  else el.content = { pandoc.Str('Equation\u{a0}' .. num) } end
  return el
end

local function equations(doc)
  doc = doc:walk({ Math = numberMath })
  return doc:walk({ Link = fixRef })
end

-- A comment whose end marker was lost becomes a comment at one spot; a lone end is dropped.
local function tidy(doc)
  local placed, missed = 0, 0
  for n, _ in pairs(COMMENTS) do
    if seenS[n] then placed = placed + 1 else missed = missed + 1 end
  end
  io.stderr:write('OPENTEX-COMMENTS ' .. placed .. ' ' .. missed .. '\n')
  doc = doc:walk({
    Inlines = function(ils)
      local out = pandoc.Inlines{}
      local changed = false
      for i, el in ipairs(ils) do
        local n = el.t == 'Span' and partOf[el.identifier]
        if n and el.classes:includes('comment-end') and not seenS[n] then
          changed = true
        else
          out:insert(el)
          if n and el.classes:includes('comment-start') and not seenE[n] then
            local nextEl = ils[i + 1]
            local lastOfThread = not (nextEl and nextEl.t == 'Span' and partOf[nextEl.identifier] == n and nextEl.classes:includes('comment-start'))
            if lastOfThread then out:extend(spans('E', n)) changed = true end
          end
        end
      end
      if changed then return out end
    end
  })
  -- A paragraph holding nothing but comment marks (a comment that starts just before a figure,
  -- say) would show as an empty line in Word: move the marks into the next paragraph.
  local function onlyMarks(b)
    if b.t ~= 'Para' and b.t ~= 'Plain' then return false end
    local any = false
    for _, el in ipairs(b.content) do
      if el.t == 'Span' and partOf[el.identifier] then any = true
      elseif el.t ~= 'Space' and el.t ~= 'SoftBreak' then return false end
    end
    return any
  end
  return doc:walk({
    Blocks = function(blocks)
      local out = pandoc.Blocks{}
      local carry = nil
      for _, b in ipairs(blocks) do
        if onlyMarks(b) then
          carry = carry or pandoc.Inlines{}
          for _, el in ipairs(b.content) do if el.t == 'Span' then carry:insert(el) end end
        else
          if carry and (b.t == 'Para' or b.t == 'Plain' or b.t == 'Header') then
            local c = pandoc.Inlines{}
            c:extend(carry)
            c:extend(b.content)
            b.content = c
          elseif carry then
            out:insert(pandoc.Para(carry))
          end
          carry = nil
          out:insert(b)
        end
      end
      if carry then out:insert(pandoc.Para(carry)) end
      return out
    end
  })
end

return { markers, { Pandoc = equations }, { Pandoc = tidy } }
`

// ---------- Tables ----------
/** Pandoc misreads some table code (the kind its own Word import writes): simplify it in the copy. */
function simplifyTables(text: string): string {
  return (
    text
      // >{\raggedright\arraybackslash}p{…} makes Pandoc drop every cell after the first in a row.
      .replace(/>\{\\(?:raggedright|raggedleft|centering)\\arraybackslash\}/g, '')
      // p{(\linewidth - 2\tabcolsep) * \real{0.42}} -> p{0.42\linewidth}
      .replace(/p\{\([^{}]*\)\s*\*\s*\\real\{([\d.]+)\}\}/g, 'p{$1\\linewidth}')
      // A longtable's repeated page header would show up as a second header row.
      .replace(/\\endfirsthead[\s\S]*?\\endhead/g, '\\endhead')
  )
}

// ---------- Figures ----------
/** \graphicspath{{figures/}{img/}} folders, absolute. */
function graphicsPaths(texts: string[], mainDir: string): string[] {
  const out: string[] = []
  for (const t of texts) {
    for (const m of t.matchAll(/^[^%\n]*\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/gm)) {
      for (const g of m[1].matchAll(/\{([^}]*)\}/g)) out.push(resolve(mainDir, g[1].trim()))
    }
  }
  return out
}

/** Find the picture file LaTeX would use for \includegraphics{name}. */
function findImage(name: string, dirs: string[]): string | null {
  for (const dir of dirs) for (const ext of IMAGE_EXTS) {
    const p = resolve(dir, name + ext)
    if (ext === '' && !extname(name)) continue
    if (existsSync(p)) return p
  }
  return null
}

/** Word can't show PDF or EPS pictures: turn them into PNG. The system's thumbnail maker does it on
 *  macOS; Windows has none for PDFs unless Adobe Reader is installed, so then use the Ghostscript
 *  that comes with TeX Live and TinyTeX on Windows (rungs). */
async function toPng(src: string, dest: string): Promise<boolean> {
  try {
    const img = await nativeImage.createThumbnailFromPath(src, { width: 2000, height: 2000 })
    if (!img.isEmpty()) {
      await fs.writeFile(dest, img.toPNG())
      return true
    }
  } catch {
    /* no thumbnail maker for this file type: try Ghostscript */
  }
  const binDir = detectTex((await loadSettings()).texPath).binDir
  const gs = binDir && [join(binDir, process.platform === 'win32' ? 'rungs.exe' : 'rungs')].find((p) => existsSync(p))
  if (!gs) return false
  const r = await run(gs, ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m', '-r220', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dFirstPage=1', '-dLastPage=1', '-dEPSCrop', `-sOutputFile=${dest}`, src])
  return r.code === 0 && existsSync(dest)
}

// ---------- The export ----------
export async function exportWord(project: Project, mainFile: string, out: string, comments: ExportComment[], log: Log): Promise<WordExportResult> {
  const result: WordExportResult = { ok: false, out, log: '', comments: 0, commentsMissed: comments.length, figures: 0, missingFigures: [], citations: 'none' }
  const pandoc = await findPandoc()
  if (!pandoc) return { ...result, error: 'Pandoc isn’t installed, so OpenTex can’t make Word files yet.' }
  const version = (await pandocVersion(pandoc)) ?? '0'
  const modern = Number(version.split('.')[0]) >= 3 // Lua filter features used below
  const main = project.abs(mainFile)
  if (!existsSync(main)) return { ...result, error: `The main file (${mainFile}) can’t be found.` }
  const tmp = await fs.mkdtemp(join(tmpdir(), 'opentex-export-'))
  try {
    log('Collecting the paper’s files…')
    const root = project.root
    const mirror = join(tmp, 'project')
    const rels = await sourceFiles(root)
    const texts = new Map<string, string>()
    for (const rel of rels) {
      const text = await fs.readFile(join(root, rel), 'utf8').catch(() => null)
      if (text !== null) texts.set(rel, text)
    }

    // Comments: mark their places in the copies.
    if (modern) {
      const byFile = new Map<string, { n: number; from: number; to: number }[]>()
      comments.forEach((c, i) => {
        if (!texts.has(c.file)) return
        byFile.set(c.file, [...(byFile.get(c.file) ?? []), { n: i + 1, from: c.from, to: c.to }])
      })
      for (const [rel, marks] of byFile) texts.set(rel, insertMarkers(texts.get(rel)!, marks))
    }

    for (const [rel, text] of texts) if (rel.endsWith('.tex') && /\\begin\{(longtable|tabular)/.test(text)) texts.set(rel, simplifyTables(text))

    // Figures: copy each picture to a short path and point \includegraphics at it.
    const mainDir = dirname(main)
    const all = [...texts.values()]
    const dirs = [mainDir, ...graphicsPaths(all, mainDir), root]
    const imgDir = join(tmp, 'img')
    await fs.mkdir(imgDir, { recursive: true })
    const done = new Map<string, string | null>() // source picture -> copy (null: unusable)
    // Only the files this paper includes: another document in the folder (a supplement, say) has
    // its own figures, which shouldn't be converted, counted or reported missing here.
    const inPaper = new Set<string>()
    const mainRel = relative(root, main).split(sep).join('/')
    const visit = (rel: string): void => {
      if (inPaper.has(rel) || !texts.has(rel)) return
      inPaper.add(rel)
      const text = texts.get(rel)!.replace(/(^|[^\\])%.*$/gm, '$1')
      for (const m of text.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
        const name = m[1].trim()
        const base = relative(root, resolve(mainDir, name)).split(sep).join('/')
        visit(/\.tex$/i.test(base) ? base : `${base}.tex`)
      }
    }
    visit(mainRel)
    for (const [rel, text] of texts) {
      if (!rel.endsWith('.tex') || !inPaper.has(rel)) continue
      const re = /\\includegraphics(\s*\[[^\]]*\])?\s*\{([^}]*)\}/g
      let next = ''
      let last = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const name = m[2].trim().replace(/^"(.*)"$/, '$1')
        let src = findImage(name, [...dirs, join(root, dirname(rel))])
        // For a PDF or EPS picture, a PNG or JPEG of the same name next to it is the better choice.
        const raster = src && /\.(pdf|eps)$/i.test(src) ? ['.png', '.jpg', '.jpeg'].map((x) => src!.replace(/\.(pdf|eps)$/i, x)).find((p) => existsSync(p)) : undefined
        if (raster) src = raster
        let copy: string | null = null
        if (src && done.has(src)) copy = done.get(src)!
        else if (src) {
          const ext = extname(src).toLowerCase()
          const dest = join(imgDir, `fig${done.size + 1}${ext === '.pdf' || ext === '.eps' ? '.png' : ext}`)
          copy = ext === '.pdf' || ext === '.eps' ? ((await toPng(src, dest)) ? dest : null) : await fs.copyFile(src, dest).then(() => dest, () => null)
          done.set(src, copy)
        }
        if (!copy) result.missingFigures.push(src ? relative(root, src).split(sep).join('/') : name)
        next += text.slice(last, m.index) + `\\includegraphics${m[1] ?? ''}{${(copy ?? name).split(sep).join('/')}}`
        last = m.index + m[0].length
      }
      if (last) texts.set(rel, next + text.slice(last))
    }
    result.figures = new Set([...done.values()].filter(Boolean)).size
    result.missingFigures = [...new Set(result.missingFigures)]

    for (const [rel, text] of texts) {
      await fs.mkdir(dirname(join(mirror, rel)), { recursive: true })
      await fs.writeFile(join(mirror, rel), text)
    }

    // Citations: the .bib files the paper names, or else any in the project.
    const named: string[] = []
    for (const t of all) {
      for (const m of t.matchAll(/^[^%\n]*\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/gm)) {
        for (const b of m[1].split(',')) {
          const p = resolve(mainDir, b.trim().endsWith('.bib') ? b.trim() : `${b.trim()}.bib`)
          if (b.trim() && existsSync(p)) named.push(p)
        }
      }
    }
    const bibs = named.length ? [...new Set(named)] : rels.filter((r) => r.endsWith('.bib')).map((r) => join(root, r))
    const cites = all.some((t) => /\\[A-Za-z]*cite[A-Za-z]*\*?\s*[[{]/.test(t))
    result.citations = !cites ? 'none' : bibs.length ? 'text' : 'no-bib'

    const filter = join(tmp, 'opentex-export.lua')
    await fs.writeFile(filter, luaComments(comments) + FILTER)
    const cwd = join(mirror, relative(root, mainDir))
    const docx = join(tmp, 'out.docx')
    const args = [basename(main), '-f', 'latex', '-t', 'docx+native_numbering', '-o', docx, '--resource-path', [cwd, mainDir, root, imgDir].join(delimiter)]
    if (modern) args.push('--lua-filter', filter)
    if (all.some((t) => /^[^%\n]*\\(section|chapter)\s*\{/m.test(t))) args.push('--number-sections')
    if (result.citations === 'text') {
      args.push('--citeproc', '-M', 'link-citations=true', '-M', 'reference-section-title=References')
      for (const b of bibs) args.push(`--bibliography=${b}`)
    }
    log('Converting with Pandoc…')
    let r = await run(pandoc, args, cwd)
    if (r.code !== 0 && /native_numbering/.test(r.out)) r = await run(pandoc, args.map((a) => (a === 'docx+native_numbering' ? 'docx' : a)), cwd)
    const counted = r.out.match(/OPENTEX-COMMENTS (\d+) (\d+)/)
    if (counted) {
      result.comments = Number(counted[1])
      result.commentsMissed = Number(counted[2])
    } else if (!modern) result.commentsMissed = comments.length
    result.log = r.out
      .replace(/OPENTEX-COMMENTS.*\n?/g, '')
      .split(tmp)
      .join('…')
      .trim()
    if (r.code !== 0 || !existsSync(docx)) return { ...result, error: 'Pandoc couldn’t convert this paper. The details below may say which part it stumbled on.' }

    log('Saving the Word file…')
    try {
      await fs.copyFile(docx, out)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return {
        ...result,
        error:
          code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
            ? `OpenTex couldn’t save “${basename(out)}”. If it’s open in Word, close it there and export again, or choose another name.`
            : `OpenTex couldn’t save “${basename(out)}” (${(e as Error).message}).`
      }
    }
    return { ...result, ok: true }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** IPC for File → Export to Word…. `need` gives the window's open project. */
export function registerWordExportIpc(need: (e: IpcMainInvokeEvent) => Project): void {
  const chosen = new Map<number, string>() // per window: the file the user picked in the Save dialog
  ipcMain.handle('word:exportChoose', async (e) => {
    const project = need(e)
    const win = BrowserWindow.fromWebContents(e.sender)
    const name = basename(project.root).replace(/[\\/:*?"<>|]+/g, '-') || 'paper'
    const opts = { title: 'Export to Word', buttonLabel: 'Export', defaultPath: join(project.root, `${name}.docx`), filters: [{ name: 'Word document', extensions: ['docx'] }] }
    // OPENTEX_TEST_EXPORT_PATH answers the Save dialog in automated tests only.
    const test = process.env.OPENTEX_TEST_EXPORT_PATH
    const r = test ? { canceled: false, filePath: test } : win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const file = /\.docx$/i.test(r.filePath) ? r.filePath : `${r.filePath}.docx`
    chosen.set(e.sender.id, file)
    return file
  })
  ipcMain.handle('word:export', async (e, mainFile: string, comments: ExportComment[]) => {
    const out = chosen.get(e.sender.id)
    if (!out) throw new Error('Choose where to save the Word file first.')
    return exportWord(need(e), mainFile, out, Array.isArray(comments) ? comments : [], (line) => !e.sender.isDestroyed() && e.sender.send('tex:progress', line))
  })
  ipcMain.handle('word:revealExport', (e) => {
    const out = chosen.get(e.sender.id)
    if (out && existsSync(out)) shell.showItemInFolder(out)
  })
}
