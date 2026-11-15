// Extra reading of the TeX log, used by tex.ts after parseLog():
//  - keeps the raw log lines around each problem (the renderer's explain.ts reads them),
//  - works out which file a warning came from (TeX only says "on input line N"),
//  - adds problems parseLog() doesn't look for: overfull lines, missing font shapes,
//    and BibTeX/Biber trouble from the .blg file and latexmk's own output.
import { existsSync, promises as fs } from 'fs'
import { join, relative, resolve, sep } from 'path'
import { Problem } from '../shared/types'

// TeX cuts log lines at 79 characters, which splits error messages in half. TeX Live and
// TinyTeX read this setting from the environment (MiKTeX ignores it), and run() in tex.ts
// passes process.env on to every TeX program.
if (!process.env.max_print_line) process.env.max_print_line = '10000'

const FILE_RE = /^(.*?\.(?:tex|sty|cls|bib|ltx|dtx)):(\d+): (.*)$/
const WARN_RE = /^(?:LaTeX|Package (\S+)) Warning: (.*)$/
const OPEN_FILE = /^\(((?:\.{0,2}\/|\/|[A-Za-z]:[\\/])?[^\s()[\]{}"]+\.[A-Za-z0-9]{1,8})/

/** For each log line, the file TeX was reading then (from the "(./file.tex ... )" nesting). */
function fileAtLines(lines: string[]): (string | null)[] {
  const stack: (string | null)[] = []
  const out: (string | null)[] = []
  let skip = false // inside an error's context or a box's contents, where brackets are the paper's text
  for (const l of lines) {
    out.push([...stack].reverse().find((f) => f) ?? null)
    if (FILE_RE.test(l) || /^! /.test(l) || /^(Over|Under)full \\[hv]box/.test(l)) {
      skip = true
      continue
    }
    if (skip) {
      if (!l.trim()) skip = false
      continue
    }
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '(') {
        const m = l.slice(i).match(OPEN_FILE)
        stack.push(m ? m[1] : null)
        if (m) i += m[0].length - 1
      } else if (l[i] === ')') stack.pop()
    }
  }
  return out
}

/** The first words of a problem's message as they appear in the log. */
function head(p: Problem): string {
  const msg = p.severity === 'error' ? p.message.replace(/  \(.*\)$/s, '') : p.message.replace(/^[^\s:]+: /, '')
  return msg.slice(0, 30)
}

export async function addLogExtras(problems: Problem[], texLog: string, runLog: string, root: string, cwd: string, stem: string): Promise<void> {
  const lines = texLog.split(/\r?\n/)
  // Only the paper's own source files: a warning "in" a .bbl or .aux should point at the paper.
  const inProject = (f: string): string | null => {
    const rel = relative(root, resolve(cwd, f))
    return rel.startsWith('..') || !/\.(tex|ltx|bib|sty|cls)$/i.test(rel) || !existsSync(join(root, rel)) ? null : rel.split(sep).join('/')
  }
  const files = fileAtLines(lines)

  // 1. Raw log lines around each problem, and the file for warnings.
  let from = 0
  for (const p of problems) {
    // The log is read as Latin-1, so a UTF-8 character in "Unicode character α (U+03B1)" arrives garbled.
    if (/Unicode character /.test(p.message)) p.message = Buffer.from(p.message, 'latin1').toString('utf8')
    const h = head(p)
    if (!h) continue
    let i = lines.findIndex((l, k) => k >= from && l.includes(h))
    if (i < 0) i = lines.findIndex((l) => l.includes(h))
    if (i < 0) continue
    from = i + 1
    p.context = lines.slice(Math.max(0, i - 3), i + 8).join('\n')
    if (!p.file && p.line && files[i]) p.file = inProject(files[i]!)
  }

  // 2. Lines that stick out into the margin (only ones big enough to see, at most 20).
  let overfull = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const o = l.match(/^Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\) (?:in paragraph|in alignment|detected) at lines? (\d+)/)
    if (o && Number(o[1]) >= 1 && overfull++ < 20) {
      const file = files[i] ? inProject(files[i]!) : null
      problems.push({ severity: 'warning', file, line: Number(o[2]), message: l, context: lines.slice(i, i + 3).join('\n') })
    }
    // 3. "LaTeX Font Warning: Font shape `T1/ptm/ux/n' undefined" / "(Font) using `T1/ptm/m/n' instead on input line 4."
    const f = l.match(/^LaTeX Font Warning: (Font shape .* undefined)/)
    if (f) {
      const msg = [f[1], ...lines.slice(i + 1, i + 3).filter((x) => /^\(Font\)/.test(x)).map((x) => x.replace(/^\(Font\)\s*/, ''))].join(' ')
      const ln = msg.match(/on input line (\d+)/)
      const file = ln && files[i] ? inProject(files[i]!) : null
      problems.push({ severity: 'warning', file, line: ln ? Number(ln[1]) : null, message: msg, context: lines.slice(i, i + 3).join('\n') })
    }
  }

  // 4. BibTeX / Biber.
  const bibProblems: Problem[] = []
  const missingBib = runLog.match(/Bib file\(s\) not found in search path:\s*\n((?:[ \t]+\S.*\n?)+)/)
  if (missingBib) {
    for (const name of missingBib[1].split('\n').map((s) => s.trim()).filter(Boolean))
      bibProblems.push({ severity: 'error', file: null, line: null, message: `BibTeX: I couldn't open database file ${name}` })
  } else {
    // Only trust the .blg when the paper still uses BibTeX/Biber; otherwise it is left over.
    const aux = await fs.readFile(join(cwd, `${stem}.aux`), 'utf8').catch(() => '')
    const usesBib = /\\bibdata|\\abx@aux/.test(aux) || existsSync(join(cwd, `${stem}.bcf`))
    const blg = usesBib ? await fs.readFile(join(cwd, `${stem}.blg`), 'utf8').catch(() => '') : ''
    const bl = blg.split(/\r?\n/)
    for (let i = 0; i < bl.length; i++) {
      const l = bl[i]
      let m: RegExpMatchArray | null
      if ((m = l.match(/^I couldn't open (database|style|auxiliary) file (\S+)/)))
        bibProblems.push({ severity: 'error', file: null, line: null, message: `BibTeX: I couldn't open ${m[1]} file ${m[2]}` })
      else if ((m = l.match(/^Repeated entry---line (\d+) of file (\S+)/))) {
        const key = (bl[i + 1] ?? '').match(/@\w+\s*[{(]\s*([^,\s]+)/)
        bibProblems.push({ severity: 'warning', file: inProject(m[2]), line: Number(m[1]), message: `BibTeX: Repeated entry${key ? ` ${key[1]}` : ''} (line ${m[1]} of ${m[2]})` })
      } else if ((m = l.match(/^I found no \\(citation|bibdata|bibstyle) commands?/)))
        bibProblems.push({ severity: m[1] === 'citation' ? 'warning' : 'error', file: null, line: null, message: `BibTeX: I found no \\${m[1]} commands` })
      else if ((m = l.match(/\bERROR - (.*)$/)))
        bibProblems.push({ severity: 'error', file: null, line: null, message: `Biber: ${m[1]}` })
      else if ((m = l.match(/\bWARN - (Duplicate entry key .*)$/)))
        bibProblems.push({ severity: 'warning', file: null, line: null, message: `Biber: ${m[1]}` })
    }
  }
  // "No \bibdata" usually comes with "no \citation" and "no \bibstyle"; keep one message.
  if (bibProblems.some((p) => /no \\bibdata/.test(p.message))) bibProblems.splice(0, bibProblems.length, ...bibProblems.filter((p) => !/no \\(bibstyle|citation)/.test(p.message)))
  const seen = new Set(problems.map((p) => p.message))
  for (const p of bibProblems) if (!seen.has(p.message)) seen.add(p.message) && problems.push(p)
}
