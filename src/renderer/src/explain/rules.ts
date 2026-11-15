// What each TeX/BibTeX message means in plain English, and how to fix it.
//
// RULES is checked top to bottom; the first rule whose `match` fits the message (with
// "LaTeX Error:" / "Package x Error:" taken off the front) explains it. A rule can return
// null to let a later rule try. To support a new message: compile a small example, copy
// the message from the log, and add a rule. The lookup tables live in data.ts.
import { BIB_STYLES, COMMAND_PACKAGES, ALSO_FROM, ENV_PACKAGES, FONT_SERIES, FONT_SHAPES, INTERNAL_NAMES, INVISIBLE, KERNEL_COMMANDS, KNOWN_ENVS, KNOWN_PACKAGES, MATH_ONLY, SI_UNITS, THEOREM_LIKE, UNICODE } from './data'
import { addToPreamble, closest, compileFix, Ctx, deleteLine, Explanation, Fix, insertLines, orderedTexFiles, packageFix, reEsc, replaceAllInFile, replaceAt, replaceInLine, searchProject, Spot, stripComment, tick } from './tools'

export interface Rule {
  /** The message, as TeX writes it (for people reading this table). */
  name: string
  match: RegExp
  explain(m: RegExpMatchArray, c: Ctx): Explanation | null | Promise<Explanation | null>
}

// ---------- Small helpers for the rules ----------

const spot = (c: Ctx, col: number, len: number): Spot | undefined => (c.file && c.line ? { file: c.file, line: c.line, col, len } : undefined)

/** The character just before where TeX stopped, as a spot. */
function lastChar(c: Ctx, ch: string): Spot | undefined {
  if (c.col == null || !c.lineText || c.lineText[c.col - 1] !== ch) return undefined
  return spot(c, c.col - 1, 1)
}

/** An earlier problem in the list matching re (optionally on the same line). */
const earlier = (c: Ctx, re: RegExp, sameLine = false, near = 0): boolean =>
  c.all.some((q, i) => i < c.index && re.test(q.message) && (!sameLine || (q.line != null && c.line != null && q.line <= c.line && c.line - q.line <= near && (q.file ?? c.file) === c.file)))

/** How a command name reads to the author (internal @-names in words). */
const nameOf = (cs: string): string => {
  const n = cs.replace(/^\\/, '')
  return INTERNAL_NAMES[n] ?? (n.includes('@') ? 'a command' : tick('\\' + n))
}

/** The command TeX complained about: the last control sequence before the error point. */
function undefinedName(c: Ctx): string | null {
  const lines = c.log.split('\n')
  const k = lines.findIndex((l) => /Undefined control sequence/.test(l))
  const next = k >= 0 ? lines[k + 1] ?? '' : ''
  const top = /^l\.\d+ /.test(next) ? next.replace(/^l\.\d+ /, '') : next
  const m = (top || c.shown).match(/(\\(?:[A-Za-z@]+|.))\s*$/)
  return m ? m[1] : null
}

/** The occurrence of a command on the source line closest to where TeX stopped. */
function commandSpot(c: Ctx, cs: string): Spot | undefined {
  if (!c.lineText) return undefined
  const re = new RegExp(reEsc(cs) + (/[A-Za-z]$/.test(cs) ? '(?![A-Za-z])' : ''), 'g')
  const hits = [...stripComment(c.lineText).matchAll(re)]
  if (!hits.length) return undefined
  const best = c.col == null ? hits[0] : hits.reduce((a, b) => (Math.abs(b.index! + cs.length - c.col!) < Math.abs(a.index! + cs.length - c.col!) ? b : a))
  return spot(c, best.index!, cs.length)
}

/** The run of text around a spot that belongs in a formula (a_b, x^2, \frac{1}{2}). */
function mathWord(text: string, at: number): { from: number; to: number } {
  let from = at
  let to = at
  while (from > 0 && /[^\s$]/.test(text[from - 1])) from--
  // a command: take it and its {…} arguments
  if (text[to] === '\\') to++
  while (to < text.length && /[^\s$]/.test(text[to])) {
    if (text[to] === '{') {
      let depth = 0
      for (; to < text.length; to++) {
        if (text[to] === '{') depth++
        else if (text[to] === '}' && --depth === 0) break
      }
    }
    to++
  }
  while (to > at + 1 && /[.,;:!?)\]]/.test(text[to - 1])) to--
  while (from < at && /[(\[]/.test(text[from])) from++
  return { from, to: Math.min(to, text.length) }
}

/** A fix that puts part of the line between $…$. */
function wrapMathFix(c: Ctx, at: number): Fix | null {
  if (!c.lineText || !c.file || !c.line) return null
  const { from, to } = mathWord(c.lineText, at)
  const word = c.lineText.slice(from, to)
  if (!word.trim() || word.length > 60) return null
  if (/^(https?:|www\.)/.test(word)) {
    return {
      label: `Write it as ${tick(`\\url{${word}}`)}`,
      run: async () => {
        const ok = await replaceAt(c.host, { file: c.file!, line: c.line!, col: from, len: word.length }, word, `\\url{${word}}`)
        if (ok && !c.host.hasPackage('url') && !c.host.hasPackage('hyperref')) await addToPreamble(c.host, '\\usepackage{url}')
        return ok
      }
    }
  }
  return { label: `Make it a formula: ${tick(`$${word}$`)}`, run: () => replaceAt(c.host, { file: c.file!, line: c.line!, col: from, len: word.length }, word, `$${word}$`) }
}

/** Is the line inside a display-math environment? (Looks back through the file.) */
async function insideMath(c: Ctx): Promise<string | null> {
  if (!c.file || !c.line) return null
  const text = (await c.read(c.file)) ?? ''
  const before = text.split('\n').slice(0, c.line - 1).map(stripComment).join('\n')
  const envs = [...before.matchAll(/\\(begin|end)\{(equation\*?|align\*?|gather\*?|multline\*?|flalign\*?|alignat\*?|eqnarray\*?|displaymath|math)\}|\\\[|\\\]/g)]
  const open: string[] = []
  for (const e of envs) {
    if (e[0] === '\\[') open.push('\\[')
    else if (e[0] === '\\]') open.pop()
    else if (e[1] === 'begin') open.push(e[2])
    else open.pop()
  }
  return open.pop() ?? null
}

/** Where a runaway argument starts: TeX prints its text after "Runaway argument?". */
async function runawayStart(c: Ctx): Promise<Spot | null> {
  const lines = c.log.split('\n')
  const k = lines.findIndex((l) => /^Runaway argument\?/.test(l))
  if (k < 0 || !lines[k + 1]) return null
  const raw = lines[k + 1].split(/\\par\b/)[0].replace(/(\\[A-Za-z]+) (?=[{[\\])/g, '$1')
  const text = raw.replace(/^\{/, '')
  for (const n of [30, 20, 12, 6]) {
    const probe = text.slice(0, n).trimEnd()
    if (probe.trim().length < 3 && n > 6) continue
    if (!probe.trim()) return null
    const files = [...new Set([c.file, ...orderedTexFiles(c.host)].filter((f): f is string => Boolean(f)))]
    for (const f of files) {
      const src = await c.read(f)
      if (!src) continue
      const i = src.indexOf(raw.startsWith('{') ? '{' + probe : probe)
      if (i < 0) continue
      const line = src.slice(0, i).split('\n').length
      const col = i - src.lastIndexOf('\n', i - 1) - 1
      return { file: f, line, col, len: 1 }
    }
  }
  return null
}

const where = (s: Spot, c: Ctx): string => `line ${s.line}${s.file !== c.file ? ` of ${s.file}` : ''}`

/** Files in the project that could be the one asked for (different case, extension or folder). */
function nearFiles(c: Ctx, wanted: string, exts: string[]): string[] {
  const base = (p: string): string => p.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase()
  const noExt = (p: string): string => p.replace(/\.[^./]+$/, '').toLowerCase()
  const dir = (c.host.target() ?? '').split('/').slice(0, -1).join('/')
  const full = (dir ? dir + '/' : '') + wanted.replace(/^\.\//, '')
  const files = c.host.files().filter((f) => !exts.length || exts.some((e) => f.toLowerCase().endsWith(e)))
  const exact = files.filter((f) => noExt(f) === noExt(full))
  if (exact.length) return exact
  const same = files.filter((f) => base(f) === base(wanted))
  if (same.length) return same
  const near = closest(base(wanted), files.map(base), { ignoreCase: true })
  return near ? files.filter((f) => base(f) === near) : []
}

/** A path relative to the compiled file's folder, as you'd write it in \includegraphics. */
function relPath(c: Ctx, f: string): string {
  const dir = (c.host.target() ?? '').split('/').slice(0, -1)
  const parts = f.split('/')
  let i = 0
  while (i < dir.length && dir[i] === parts[i]) i++
  return [...Array(dir.length - i).fill('..'), ...parts.slice(i)].join('/')
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.eps']

// ---------- The rules ----------

export const RULES: Rule[] = [
  // ----- Commands -----
  {
    name: 'Undefined control sequence.',
    match: /^Undefined control sequence/,
    explain(_m, c) {
      const cs = undefinedName(c)
      if (!cs) return { text: 'TeX met a command it doesn’t know. Check the spelling of the commands on this line, or whether a `\\usepackage{…}` is missing.', short: 'Unknown command' }
      const name = cs.slice(1)
      const at = commandSpot(c, cs)
      if (name.includes('@'))
        return {
          text: `The error happened inside another command on this line (TeX names its internal part ${tick(cs)}). Look at the commands used here${earlier(c, /./, true) ? ', and fix the problem listed above for this line first' : ''}.`,
          short: 'Error inside a command',
          followOn: earlier(c, /./, true)
        }
      const fixes: Fix[] = []
      const pkg = COMMAND_PACKAGES[name]
      if (SI_UNITS.has(name) && (!pkg || pkg === 'siunitx')) {
        if (c.host.hasPackage('siunitx'))
          return { text: `${tick(cs)} is a unit from siunitx, so it only works inside ${tick('\\qty{…}{…}')}, ${tick('\\SI{…}{…}')} or ${tick('\\unit{…}')}, for example ${tick(`\\qty{3}{${cs}}`)}.`, short: `${cs} only works inside \\qty or \\SI`, at }
        return { text: `${tick(cs)} is a unit from the siunitx package, which your paper doesn’t load yet. Units work inside ${tick('\\SI{…}{…}')} or ${tick('\\qty{…}{…}')}.`, short: `${cs} needs the siunitx package`, fixes: [packageFix(c.host, 'siunitx')], at }
      }
      if (pkg) {
        const also = ALSO_FROM[name] ? ` (${ALSO_FROM[name]})` : ''
        if (c.host.hasPackage(pkg))
          return { text: `${tick(cs)} comes from the ${pkg} package${also}. Your paper loads it, so check the spelling and that ${tick(cs)} is used the way the package expects.`, short: `Problem with ${cs}`, at }
        if (pkg === 'biblatex' && c.host.hasPackage('natbib')) {
          return { text: `${tick(cs)} is a biblatex command, but your paper uses natbib. With natbib, write ${tick('\\citep{…}')} (in brackets) or ${tick('\\citet{…}')} (in the sentence).`, short: `${cs} is a biblatex command`, at }
        }
        if (pkg === 'natbib' && c.host.hasPackage('biblatex')) {
          const alt = name.startsWith('citet') ? '\\textcite' : '\\parencite'
          fixes.push({ label: `Change to ${tick(alt)}`, run: () => replaceInLine(c.host, c.file!, c.line!, new RegExp(reEsc(cs) + '(?![A-Za-z])'), alt, c.col) })
          return { text: `${tick(cs)} is a natbib command, but your paper uses biblatex. Write ${tick(alt + '{…}')} instead.`, short: `${cs} is a natbib command`, fixes: c.file && c.line ? fixes : [], at }
        }
        return { text: `${tick(cs)} comes from the ${pkg} package${also}, which your paper doesn’t load yet.`, short: `${cs} needs the ${pkg} package`, fixes: [packageFix(c.host, pkg)], at }
      }
      const known = [...KERNEL_COMMANDS, ...Object.keys(COMMAND_PACKAGES), ...c.host.commands()]
      const guess = closest(name, known)
      if (guess && c.file && c.line) {
        fixes.push({ label: `Change to ${tick('\\' + guess)}`, run: () => replaceInLine(c.host, c.file!, c.line!, new RegExp(reEsc(cs) + '(?![A-Za-z])'), '\\' + guess, c.col) })
        const where = COMMAND_PACKAGES[guess] && !c.host.hasPackage(COMMAND_PACKAGES[guess]) ? ` (it comes from the ${COMMAND_PACKAGES[guess]} package)` : ''
        return { text: `TeX doesn’t know ${tick(cs)}. Did you mean ${tick('\\' + guess)}${where}?`, short: `Unknown command ${cs} (did you mean \\${guess}?)`, fixes, at }
      }
      return {
        text: `TeX doesn’t know the command ${tick(cs)}. Check its spelling. If it comes from a package or a journal template, that package has to be loaded with ${tick('\\usepackage{…}')}.`,
        short: `Unknown command ${cs}`,
        at
      }
    }
  },
  {
    name: 'LaTeX Error: Command \\x already defined.',
    match: /^Command (\\\S+?)\.? already defined/,
    explain(m, c) {
      const cs = m[1]
      const fixes: Fix[] = []
      if (c.file && c.line && c.lineText && /\\newcommand/.test(c.lineText))
        fixes.push({ label: `Use ${tick('\\renewcommand')} to replace it`, run: () => replaceInLine(c.host, c.file!, c.line!, /\\newcommand(?=\*?\{?\\)/, '\\renewcommand') })
      return { text: `${tick(cs)} already exists (LaTeX or a package defines it). Give yours a different name, or use ${tick('\\renewcommand')} if you really mean to replace it.`, short: `${cs} already exists`, fixes }
    }
  },
  {
    name: 'LaTeX Error: Can be used only in preamble.',
    match: /^Can be used only in preamble/,
    explain(_m, c) {
      const use = c.lineText?.match(/\\usepackage(\[[^\]]*\])?\{[^}]*\}/)
      const fixes: Fix[] = []
      if (use && c.file && c.line)
        fixes.push({
          label: `Move ${tick(use[0])} to the preamble`,
          run: async () => (await replaceInLine(c.host, c.file!, c.line!, use[0], '')) && addToPreamble(c.host, use[0])
        })
      return { text: `${use ? tick(use[0]) : 'This command'} has to go in the preamble, before ${tick('\\begin{document}')}.`, short: 'Command belongs in the preamble', fixes }
    }
  },
  {
    name: 'LaTeX Error: Missing \\begin{document}.',
    match: /^Missing \\begin\{document\}/,
    explain: () => ({
      text: `There’s text in the preamble (the settings part before ${tick('\\begin{document}')}), or a ${tick('\\usepackage')} line is broken. Move the text below ${tick('\\begin{document}')}. If this file is ${tick('\\input')} into your paper, it shouldn’t have its own ${tick('\\documentclass')}.`,
      short: 'Text before \\begin{document}'
    })
  },
  {
    name: 'LaTeX Error: \\x allowed only in math mode.',
    match: /^(\\\S+) allowed only in math mode/,
    explain(m, c) {
      const at = commandSpot(c, m[1])
      const fix = at ? wrapMathFix(c, at.col) : null
      return { text: `${tick(m[1])} only works in a formula. Put it between ${tick('$…$')}.`, short: `${m[1]} only works in math`, at, fixes: fix ? [fix] : [] }
    }
  },

  // ----- Math -----
  {
    name: 'Missing $ inserted.',
    match: /^Missing \$ inserted/,
    async explain(_m, c) {
      const lt = c.lineText
      if (lt != null && c.col != null && c.shown) {
        const before = lt.slice(0, c.col)
        const ch = before.slice(-1)
        const cm = before.match(/\\([A-Za-z]+)\*?(?:\{[^{}]*\}|\[[^\]]*\])*\s*$/)
        if (ch === '_' || ch === '^') {
          const at = spot(c, c.col - 1, 1)
          const fixes: Fix[] = []
          if (ch === '_' && at) fixes.push({ label: `Change ${tick('_')} to ${tick('\\_')}`, run: () => replaceAt(c.host, at, '_', '\\_') })
          const wrap = wrapMathFix(c, c.col - 1)
          if (wrap) fixes.push(wrap)
          return {
            text: ch === '_'
              ? `You used ${tick('_')} outside math. In normal text write ${tick('\\_')}; for a subscript in a formula, put it between ${tick('$…$')}.`
              : `You used ${tick('^')} outside math. For a power or superscript, put it in a formula: ${tick('$x^2$')}. In normal text, ${tick('\\textsuperscript{…}')} raises text.`,
            short: `${ch} used outside math`,
            at,
            fixes
          }
        }
        if (cm && MATH_ONLY.has(cm[1])) {
          const at = spot(c, before.length - cm[0].length, cm[1].length + 1)
          const wrap = at ? wrapMathFix(c, at.col) : null
          return { text: `${tick('\\' + cm[1])} only works in a formula. Put it between ${tick('$…$')}, like ${tick(`$${cm[0].trim()}$`)}.`, short: `\\${cm[1]} used outside math`, at, fixes: wrap ? [wrap] : [] }
        }
        if (cm && c.host.commands().includes(cm[1])) {
          const at = spot(c, before.length - cm[0].length, cm[1].length + 1)
          const wrap = at ? wrapMathFix(c, at.col) : null
          return { text: `Your command ${tick('\\' + cm[1])} contains math (like ${tick('_')}, ${tick('^')} or ${tick('\\alpha')}), so use it between ${tick('$…$')}.`, short: `\\${cm[1]} needs math mode`, at, fixes: wrap ? [wrap] : [] }
        }
      }
      const env = await insideMath(c)
      if (env && lt != null && !lt.trim()) {
        const fixes: Fix[] = c.file && c.line ? [{ label: 'Remove the blank line', run: () => deleteLine(c.host, c.file!, c.line!, (t) => !t.trim()) }] : []
        return { text: `There’s a blank line inside ${env === '\\[' ? 'a `\\[ … \\]` formula' : `the ${tick(env)} environment`}. Formulas can’t contain empty lines: delete it, or put a ${tick('%')} on it.`, short: 'Blank line inside a formula', fixes, at: spot(c, 0, 0) }
      }
      if (earlier(c, /^Missing \$ inserted|^Display math should end/)) {
        return { text: 'This follows from the earlier “Missing $” problem: TeX was still treating text as a formula when the paragraph ended. Fix that one first.', short: 'Follows from an earlier math error', followOn: true }
      }
      return {
        text: `Something on this line only works in a formula (like ${tick('_')}, ${tick('^')}, ${tick('\\alpha')} or ${tick('\\frac')}), or a formula is missing its closing ${tick('$')}. Put formulas between ${tick('$…$')}.`,
        short: 'Math used outside a formula',
        at: c.col != null ? spot(c, Math.max(0, c.col - 1), 1) : undefined
      }
    }
  },
  {
    name: 'Display math should end with $$.',
    match: /^Display math should end with \$\$/,
    async explain(_m, c) {
      if (earlier(c, /^Missing \$ inserted|^Display math/, true, 3) || ((await insideMath(c)) && c.lineText != null && !c.lineText.trim()))
        return { text: 'This follows from the problem just above (the formula was cut short).', short: 'Follows from an earlier math error', followOn: true }
      return { text: `A displayed formula wasn’t closed properly. Start and end it the same way, preferably ${tick('\\[ … \\]')}, and keep blank lines out of it.`, short: 'Formula not closed' }
    }
  },
  {
    name: 'LaTeX Error: Bad math environment delimiter.',
    match: /^Bad math environment delimiter/,
    explain: (_m, c) =>
      earlier(c, /^Missing \$ inserted|^Display math/)
        ? { text: 'This follows from the earlier math problem (the formula was cut short).', short: 'Follows from an earlier math error', followOn: true }
        : { text: `${tick('\\[')} or ${tick('\\(')} was used inside a formula that is already open, or ${tick('\\]')} / ${tick('\\)')} without its opening partner. Often a missing ${tick('$')} or a blank line in an equation causes this.`, short: 'Formula brackets don’t match' }
  },
  {
    name: "You can't use `\\x' in y mode.",
    match: /^You can't use `(.+?)' in (\w+) mode/,
    explain: (m, c) =>
      earlier(c, /./)
        ? { text: `This follows from an earlier problem in the list: fix that first.`, short: 'Follows from an earlier error', followOn: true }
        : { text: `${tick(m[1])} can’t be used here (TeX was in ${m[2]} mode). Check the commands on this line; a missing ${tick('$')} or brace is a common cause.`, short: `${m[1]} used in the wrong place` }
  },
  {
    name: 'Double subscript. / Double superscript.',
    match: /^Double (subscript|superscript)/,
    explain(m, c) {
      const sym = m[1] === 'subscript' ? '_' : '^'
      return {
        text: `A formula has two ${m[1]}s in a row, like ${tick(`x${sym}a${sym}b`)}. Group them with braces: ${tick(`x${sym}{a${sym}b}`)} or ${tick(`x${sym}{ab}`)}.`,
        short: `Double ${m[1]}`,
        at: lastChar(c, sym)
      }
    }
  },
  {
    name: 'Missing } inserted. / Missing { inserted.',
    match: /^Missing ([{}]) inserted/,
    explain: (m, c) => ({
      text:
        m[1] === '}'
          ? `A ${tick('{')} was opened but not closed before TeX needed it to be, usually in a formula (${tick('\\frac{a}{b')} or ${tick('x^{2')}), or a ${tick('\\left(')} without its ${tick('\\right)')}. Add the missing ${tick('}')}.`
          : `TeX expected a ${tick('{')} here, often because a formula has a ${tick('}')} too many, or a command that needs braces is missing them.`,
      short: `A ${m[1] === '}' ? '} is missing' : '{ is missing'}`,
      at: c.col != null ? spot(c, Math.max(0, c.col - 1), 1) : undefined
    })
  },
  {
    name: 'Missing \\right. inserted / Extra \\right.',
    match: /^(Missing \\right\. inserted|Extra \\right)/,
    explain: () => ({ text: `${tick('\\left(')} and ${tick('\\right)')} must come in pairs inside the same formula (and on the same line of an ${tick('align')}). Use ${tick('\\right.')} for an invisible closing partner.`, short: '\\left and \\right don’t pair up' })
  },

  // ----- Braces -----
  {
    name: "Too many }'s. / Extra }, or forgotten \\endgroup.",
    match: /^(Too many \}'s|Extra \}, or forgotten \\endgroup)/,
    explain(_m, c) {
      if (earlier(c, /^Paragraph ended before|^File ended while/, true, 3))
        return { text: 'This follows from the problem just above: the blank line cut the command short, so its closing `}` has nothing to close. Fix that one first.', short: 'Follows from an earlier brace error', followOn: true }
      const at = lastChar(c, '}')
      return {
        text: `There’s a ${tick('}')} here with no ${tick('{')} to match it. Delete it, or add the ${tick('{')} that’s missing earlier on the line.`,
        short: 'An extra }',
        at,
        fixes: at ? [{ label: `Delete this ${tick('}')}`, run: () => replaceAt(c.host, at, '}', '') }] : []
      }
    }
  },
  {
    name: 'Extra }, or forgotten $.',
    match: /^Extra \}, or forgotten \$/,
    explain(_m, c) {
      if (earlier(c, /^Missing \$ inserted/, true))
        return { text: 'This follows from the “Missing $” problem on this line: the formula needs to be between `$…$`. Fix that first.', short: 'Follows from an earlier math error', followOn: true }
      const at = lastChar(c, '}')
      return {
        text: `Inside a formula there’s a ${tick('}')} without a matching ${tick('{')}, or the formula is missing its closing ${tick('$')}.`,
        short: 'An extra } in a formula',
        at,
        fixes: at ? [{ label: `Delete this ${tick('}')}`, run: () => replaceAt(c.host, at, '}', '') }] : []
      }
    }
  },
  {
    name: 'File ended while scanning use of \\x. (Runaway argument?)',
    match: /^File ended while scanning (?:use|definition) of (\\\S+?)\s*\.?$/,
    async explain(m, c) {
      const start = await runawayStart(c)
      return {
        text: `The ${tick('{')} after ${nameOf(m[1])} is never closed, so TeX read to the end of the file looking for its ${tick('}')}.${start ? ` It starts on ${where(start, c)}: add the ${tick('}')} where that part should end.` : ' Add the missing `}`.'}`,
        short: `A { after ${m[1].includes('@') ? 'a command' : m[1]} is never closed`,
        at: start ?? undefined
      }
    }
  },
  {
    name: 'Paragraph ended before \\x was complete.',
    match: /^Paragraph ended before (\\\S+) was complete/,
    async explain(m, c) {
      const start = await runawayStart(c)
      return {
        text: `The ${tick('{…}')} after ${nameOf(m[1])} was still open when a blank line started a new paragraph. A ${tick('}')} is probably missing${start ? ` (it opens on ${where(start, c)})` : ''}, or the blank line shouldn’t be there.`,
        short: `Unclosed { before a blank line`,
        at: start ?? undefined
      }
    }
  },

  // ----- Tables and alignment -----
  {
    name: 'Misplaced alignment tab character &.',
    match: /^Misplaced alignment tab character &/,
    explain(_m, c) {
      const env = c.all.find((q, i) => i < c.index && q.line === c.line && /Environment (\S+) undefined/.test(q.message))
      if (env) {
        const name = env.message.match(/Environment (\S+) undefined/)![1]
        return { text: `This follows from the problem above: LaTeX didn’t know the ${tick(name)} environment, so its ${tick('&')} is out of place. Fix that one and this goes away.`, short: 'Follows from an earlier error', followOn: true }
      }
      const at = lastChar(c, '&')
      return {
        text: `${tick('&')} separates columns in tables and aligned equations. In normal text, write ${tick('\\&')} to print an ampersand.`,
        short: '& in normal text (write \\&)',
        at,
        fixes: at ? [{ label: `Change ${tick('&')} to ${tick('\\&')}`, run: () => replaceAt(c.host, at, '&', '\\&') }] : []
      }
    }
  },
  {
    name: 'Extra alignment tab has been changed to \\cr.',
    match: /^Extra alignment tab has been changed/,
    async explain(_m, c) {
      const text = c.file ? (await c.read(c.file)) ?? '' : ''
      const upto = text.split('\n').slice(0, c.line ?? 0).join('\n')
      const begin = [...upto.matchAll(/\\begin\{(tabular\*?|tabularx|longtable|array)\}(\{[^}]*\})?\{((?:[^{}]|\{[^{}]*\})*)\}/g)].pop()
      const fixes: Fix[] = []
      let cols = 0
      if (begin) {
        cols = begin[3].replace(/\{[^{}]*\}/g, '').replace(/[|@!>< ]/g, '').length
        const cells = (c.shown.split('\\\\').pop() ?? '').split('&').length
        const extra = Math.max(1, cells - cols)
        const letter = begin[3].replace(/\{[^{}]*\}/g, '').match(/[lcr](?=[^lcr]*$)/)?.[0] ?? 'l'
        const spec = begin[3] + letter.repeat(extra)
        const line = upto.slice(0, begin.index).split('\n').length
        if (c.file)
          fixes.push({ label: `Add a column: ${tick(`{${spec}}`)}`, run: () => replaceInLine(c.host, c.file!, line, `{${begin[3]}}`, `{${spec}}`) })
      }
      return {
        text: `This table row has more cells (separated by ${tick('&')}) than the table has columns${cols ? ` (${tick(begin![3])} makes ${cols})` : ''}. Add a column letter to ${tick('\\begin{tabular}{…}')}, or remove an ${tick('&')}.`,
        short: 'Too many & in a table row',
        at: lastChar(c, '&'),
        fixes
      }
    }
  },

  // ----- Environments -----
  {
    name: 'LaTeX Error: \\begin{x} on input line N ended by \\end{y}.',
    match: /^\\begin\{([^}]+)\}(?: on input line (\d+))? ended by \\end\{([^}]+)\}/,
    explain(m, c) {
      const [, b, bl, e] = m
      if (b === 'document') {
        if (earlier(c, new RegExp(`Environment ${reEsc(e)} undefined`)))
          return { text: `This follows from the problem above about ${tick(e)}.`, short: 'Follows from an earlier error', followOn: true }
        return {
          text: `There’s an ${tick(`\\end{${e}}`)} with no ${tick(`\\begin{${e}}`)} before it. Delete it, or add the missing ${tick(`\\begin{${e}}`)}.`,
          short: `\\end{${e}} without \\begin{${e}}`,
          at: commandSpot(c, `\\end{${e}}`),
          fixes: c.file && c.line ? [{ label: `Delete ${tick(`\\end{${e}}`)}`, run: () => replaceInLine(c.host, c.file!, c.line!, `\\end{${e}}`, '') }] : []
        }
      }
      const fixes: Fix[] = []
      if (c.file && c.line) fixes.push({ label: `Change to ${tick(`\\end{${b}}`)}`, run: () => replaceInLine(c.host, c.file!, c.line!, `\\end{${e}}`, `\\end{${b}}`) })
      return {
        text: `The ${tick(`\\begin{${b}}`)}${bl ? ` on line ${bl}` : ''} is closed by ${tick(`\\end{${e}}`)}. They have to match: change this to ${tick(`\\end{${b}}`)}, or add the ${tick(`\\end{${b}}`)} that’s missing before it.`,
        short: `\\begin{${b}} ended by \\end{${e}}`,
        at: commandSpot(c, `\\end{${e}}`),
        fixes
      }
    }
  },
  {
    name: 'LaTeX Error: Environment x undefined.',
    match: /^Environment (\S+) undefined/,
    explain(m, c) {
      const env = m[1]
      const at = commandSpot(c, `\\begin{${env}}`)
      const pkg = ENV_PACKAGES[env]
      if (pkg && !c.host.hasPackage(pkg))
        return { text: `The ${tick(env)} environment comes from the ${pkg} package, which your paper doesn’t load yet.`, short: `The ${env} environment needs ${pkg}`, fixes: [packageFix(c.host, pkg)], at }
      if (THEOREM_LIKE.includes(env.replace(/\*$/, ''))) {
        const name = env.replace(/\*$/, '')
        const line = `\\newtheorem{${name}}{${name[0].toUpperCase() + name.slice(1)}}`
        return { text: `${tick(env)} has to be set up in the preamble before you use it, with ${tick(line)}.`, short: `The ${env} environment isn't set up`, fixes: [{ label: `Add ${tick(line)}`, key: `thm:${name}`, run: () => addToPreamble(c.host, line) }], at }
      }
      const guess = closest(env, KNOWN_ENVS)
      if (guess && c.file && c.line) {
        const fix: Fix = {
          label: `Change to ${tick(guess)}`,
          run: async () => {
            const text = (await c.read(c.file!)) ?? ''
            const lines = text.split('\n')
            const endLine = lines.findIndex((l, i) => i >= c.line! - 1 && l.includes(`\\end{${env}}`))
            const ok = await replaceInLine(c.host, c.file!, c.line!, `\\begin{${env}}`, `\\begin{${guess}}`)
            if (ok && endLine >= 0) await replaceInLine(c.host, c.file!, endLine + 1, `\\end{${env}}`, `\\end{${guess}}`)
            return ok
          }
        }
        return { text: `LaTeX doesn’t know an environment called ${tick(env)}. Did you mean ${tick(guess)}?${ENV_PACKAGES[guess] && !c.host.hasPackage(ENV_PACKAGES[guess]) ? ` (It needs the ${ENV_PACKAGES[guess]} package.)` : ''}`, short: `Unknown environment ${env}`, fixes: [fix], at }
      }
      return { text: `LaTeX doesn’t know an environment called ${tick(env)}. Check the spelling, or load the package that provides it.`, short: `Unknown environment ${env}`, at }
    }
  },
  {
    name: "LaTeX Error: Unknown float option `H'.",
    match: /^Unknown float option `(.+?)'/,
    explain(m, c) {
      const H = m[1].includes('H')
      return {
        text: H
          ? `${tick('[H]')} (“exactly here”) needs the float package.`
          : `${tick(m[1])} isn’t a placement LaTeX knows. Use letters from ${tick('h')} (here), ${tick('t')} (top), ${tick('b')} (bottom), ${tick('p')} (own page) and ${tick('!')} (try harder), like ${tick('[htbp]')}.`,
        short: H ? '[H] needs the float package' : `Unknown placement ${m[1]}`,
        fixes: H && !c.host.hasPackage('float') ? [packageFix(c.host, 'float')] : []
      }
    }
  },
  {
    name: 'LaTeX Error: \\caption outside float.',
    match: /^\\caption outside float/,
    explain(_m, c) {
      const fixes: Fix[] = []
      if (c.file && c.line && c.lineText?.includes('\\caption{'))
        fixes.push({
          label: `Use ${tick('\\captionof{figure}{…}')}`,
          run: async () => {
            const ok = await replaceInLine(c.host, c.file!, c.line!, '\\caption{', '\\captionof{figure}{')
            if (ok && !c.host.hasPackage('caption')) await addToPreamble(c.host, '\\usepackage{caption}')
            return ok
          }
        })
      return { text: `${tick('\\caption')} only works inside a ${tick('figure')} or ${tick('table')} environment. Elsewhere (in a minipage, say), use ${tick('\\captionof{figure}{…}')} from the caption package.`, short: '\\caption outside a figure or table', fixes, at: commandSpot(c, '\\caption') }
    }
  },
  {
    name: 'LaTeX Error: Not in outer par mode.',
    match: /^Not in outer par mode/,
    explain: () => ({ text: `A figure or table was put inside something that can’t hold floating items (a minipage, a box, a table cell or another figure). Move it out, or use ${tick('[H]')} from the float package or ${tick('\\captionof')} instead.`, short: 'Figure or table in the wrong place' })
  },
  {
    name: "LaTeX Error: Something's wrong--perhaps a missing \\item.",
    match: /^Something's wrong--perhaps a missing \\item/,
    explain: () => ({ text: `A list (${tick('itemize')}, ${tick('enumerate')} or the bibliography) has no ${tick('\\item')} in it, or there is text before its first ${tick('\\item')}.`, short: 'List without \\item' })
  },
  {
    name: 'LaTeX Error: Lonely \\item--perhaps a missing list environment.',
    match: /^Lonely \\item/,
    async explain(_m, c) {
      const fixes: Fix[] = []
      if (c.file && c.line) {
        const lines = ((await c.read(c.file)) ?? '').split('\n')
        let last = c.line - 1
        while (last + 1 < lines.length && lines[last + 1].trim() && !/\\(begin|end)\{/.test(lines[last + 1])) last++
        fixes.push({
          label: `Put it in a list (${tick('itemize')})`,
          run: async () => (await insertLines(c.host, c.file!, last + 2, '\\end{itemize}')) && insertLines(c.host, c.file!, c.line!, '\\begin{itemize}')
        })
      }
      return { text: `${tick('\\item')} only works inside a list. Put the items between ${tick('\\begin{itemize}')} and ${tick('\\end{itemize}')} (or ${tick('enumerate')} for a numbered list).`, short: '\\item outside a list', fixes, at: commandSpot(c, '\\item') }
    }
  },

  // ----- Spacing and lengths -----
  {
    name: "LaTeX Error: There's no line here to end.",
    match: /^There's no line here to end/,
    explain(_m, c) {
      const at = commandSpot(c, '\\\\')
      return {
        text: `${tick('\\\\')} (new line) was used where no line has started yet, such as at the start of a paragraph, after a blank line or after a heading. Delete it. For extra space between paragraphs, use a blank line or ${tick('\\vspace{1em}')}.`,
        short: '\\\\ where there is no line to end',
        at,
        fixes: at ? [{ label: `Delete the ${tick('\\\\')}`, run: () => replaceAt(c.host, at, '\\\\', '') }] : []
      }
    }
  },
  {
    name: 'Missing number, treated as zero.',
    match: /^Missing number, treated as zero/,
    async explain(_m, c) {
      if (c.shown.startsWith('[') && c.file && c.line && c.line > 1) {
        const prev = ((await c.read(c.file)) ?? '').split('\n')[c.line - 2] ?? ''
        if (/\\\\\s*$/.test(stripComment(prev)))
          return {
            text: `The line before ends with ${tick('\\\\')} and this one starts with ${tick('[')}, so LaTeX reads it as ${tick('\\\\[length]')} (extra space) and finds no length. Put ${tick('{}')} before the ${tick('[')}.`,
            short: '\\\\ followed by [',
            at: spot(c, 0, 1),
            fixes: [{ label: `Insert ${tick('{}')} before ${tick('[')}`, run: () => replaceInLine(c.host, c.file!, c.line!, /^(\s*)\[/, (s) => s.replace('[', '{}[')) }]
          }
      }
      if (earlier(c, /./, true)) return { text: 'This follows from the problem above on the same line.', short: 'Follows from an earlier error', followOn: true }
      return { text: `TeX expected a number or a length here (like ${tick('2')}, ${tick('2cm')} or ${tick('0.5\\textwidth')}) but found something else${c.shown ? `: look at ${tick(c.shown.slice(-30))}` : ''}.`, short: 'A number is missing' }
    }
  },
  {
    name: 'Illegal unit of measure (pt inserted).',
    match: /^Illegal unit of measure/,
    explain: (_m, c) =>
      earlier(c, /^Missing number/, true)
        ? { text: 'This follows from the “Missing number” problem on the same line.', short: 'Follows from an earlier error', followOn: true }
        : { text: `A length needs a unit LaTeX knows: ${tick('cm')}, ${tick('mm')}, ${tick('in')}, ${tick('pt')}, ${tick('em')} or a fraction like ${tick('0.5\\textwidth')}. For example ${tick('\\vspace{2mm}')}, not ${tick('\\vspace{2}')}.`, short: 'A length without a unit' }
  },
  {
    name: 'Dimension too large.',
    match: /^Dimension too large/,
    explain: () => ({ text: 'A number or length is too big for TeX (over about 5.7 metres). This often happens in plots with very large values or with big scale factors.', short: 'A length is too large' })
  },

  // ----- Packages and characters -----
  {
    name: 'LaTeX Error: Option clash for package x.',
    match: /^Option clash for package (\S+?)\.?$/,
    async explain(m, c) {
      const pkg = m[1]
      const uses = await searchProject(c.host, new RegExp(`\\\\usepackage(?:\\[([^\\]]*)\\])?\\{[^}]*\\b${reEsc(pkg)}\\b[^}]*\\}`))
      const opts = [...new Set(uses.flatMap((u) => (u.match[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)))]
      const keys = opts.map((o) => o.split('=')[0].trim())
      const conflict = keys.find((k, i) => keys.indexOf(k) !== i)
      const fixes: Fix[] = []
      if (uses.length >= 2 && conflict) {
        const second = uses[1]
        fixes.push({ label: `Keep line ${uses[0].line}, delete line ${second.line}`, run: () => replaceInLine(c.host, second.file, second.line, second.match[0], '') })
        return {
          text: `The ${pkg} package is loaded ${uses.length} times with different settings for ${tick(conflict)} (lines ${uses.map((u) => u.line).join(' and ')}). Keep one ${tick('\\usepackage')} line, with the setting you want.`,
          short: `${pkg} loaded twice`,
          fixes,
          at: { file: second.file, line: second.line, col: second.col, len: second.match[0].length }
        }
      }
      if (uses.length >= 2 && uses.every((u) => u.file === uses[0].file && u.match[0].includes(`{${pkg}}`))) {
        const merged = `\\usepackage${opts.length ? `[${opts.join(',')}]` : ''}{${pkg}}`
        fixes.push({
          label: `Combine into ${tick(merged)}`,
          run: async () => {
            for (const u of uses.slice(1).reverse()) {
              const ok = await deleteLine(c.host, u.file, u.line, (t) => t.trim() === u.match[0] || t.trim().startsWith(u.match[0]))
              if (!ok) await replaceInLine(c.host, u.file, u.line, u.match[0], '')
            }
            return replaceInLine(c.host, uses[0].file, uses[0].line, uses[0].match[0], merged)
          }
        })
        return { text: `The ${pkg} package is loaded ${uses.length} times with different options (lines ${uses.map((u) => u.line).join(' and ')}). Load it once with all the options together.`, short: `${pkg} loaded twice`, fixes, at: { file: uses[1].file, line: uses[1].line, col: uses[1].col, len: uses[1].match[0].length } }
      }
      const mine = uses.find((u) => u.match[1])
      const main = c.host.mainFile()
      if (mine && main)
        fixes.push({
          label: `Pass the options early with ${tick(`\\PassOptionsToPackage{${mine.match[1]}}{${pkg}}`)}`,
          run: async () => {
            const text = (await c.read(main)) ?? ''
            const dc = text.split('\n').findIndex((l) => /^\s*\\documentclass/.test(l))
            return insertLines(c.host, main, dc >= 0 ? dc + 1 : 1, `\\PassOptionsToPackage{${mine.match[1]}}{${pkg}}`)
          }
        })
      return {
        text: `The ${pkg} package was already loaded (by the document class or another package) with different options before your ${tick(`\\usepackage[…]{${pkg}}`)}. Load yours earlier, or hand over the options before ${tick('\\documentclass')} with ${tick(`\\PassOptionsToPackage{…}{${pkg}}`)}.`,
        short: `Option clash for ${pkg}`,
        fixes,
        at: mine ? { file: mine.file, line: mine.line, col: mine.col, len: mine.match[0].length } : undefined
      }
    }
  },
  {
    name: "LaTeX Error: File `x.sty' not found. (a package that isn't installed)",
    match: /^File `([^']+)\.(sty|cls)' not found/,
    async explain(m, c) {
      const name = m[1]
      const guess = closest(name, KNOWN_PACKAGES, { ignoreCase: true })
      const fixes: Fix[] = []
      let at: Spot | undefined
      if (guess) {
        const hits = await searchProject(c.host, new RegExp(`\\\\(usepackage|documentclass)(\\[[^\\]]*\\])?\\{[^}]*\\b${reEsc(name)}\\b`))
        if (hits[0]) {
          const h = hits[0]
          at = { file: h.file, line: h.line, col: h.col + h.match[0].lastIndexOf(name), len: name.length }
          fixes.push({ label: `Change to ${tick(guess)}`, run: () => replaceInLine(c.host, h.file, h.line, new RegExp(`\\b${reEsc(name)}\\b`), guess) })
        }
      }
      const kind = m[2] === 'cls' ? 'document class' : 'package'
      return {
        text: guess
          ? `There’s no ${kind} called ${tick(name)}. Did you mean ${tick(guess)}?`
          : `The ${kind} ${tick(name)} isn’t installed on this computer${m[2] === 'cls' ? '. Journal classes usually come with the journal’s template: put its .cls file in your project folder' : '. If it’s a real package, OpenTex offers to install it'}.`,
        short: guess ? `No package ${name} (did you mean ${guess}?)` : `${kind[0].toUpperCase() + kind.slice(1)} ${name} not installed`,
        fixes,
        at
      }
    }
  },
  {
    name: "File `x' not found. (a picture or \\input file)",
    match: /File `([^']+)' not found/,
    async explain(m, c) {
      const wanted = m[1]
      const ext = (wanted.match(/\.[^./]+$/)?.[0] ?? '').toLowerCase()
      const isTexFile = ext === '.tex' || (!ext && /\\(input|include)\b/.test(c.lineText ?? ''))
      const exts = isTexFile ? ['.tex'] : ext ? [ext, ...IMAGE_EXTS] : IMAGE_EXTS
      if (/\.(bbl|aux|toc|out|ind|gls)$/.test(wanted)) return null
      const near = nearFiles(c, wanted, exts)
      // The command that names the file, to change it there.
      const stem = wanted.replace(/\.tex$/i, '')
      const hits = await searchProject(c.host, new RegExp(`\\{\\s*(${reEsc(stem)}(?:\\.[A-Za-z]+)?)\\s*\\}`))
      const hit = hits.find((h) => h.file === c.file && h.line === c.line) ?? hits[0]
      const at = hit ? { file: hit.file, line: hit.line, col: hit.col + hit.match[0].indexOf(hit.match[1]), len: hit.match[1].length } : undefined
      const fixes: Fix[] = []
      const thing = isTexFile ? 'file' : 'picture'
      if (near.length === 1 && hit) {
        let rel = relPath(c, near[0])
        if (!/\.[^./]+$/.test(hit.match[1])) rel = rel.replace(/\.[^./]+$/, '') // keep the author's style: no extension
        fixes.push({ label: `Use ${tick(rel)}`, run: () => replaceAt(c.host, at!, hit.match[1], rel) })
        return { text: `There’s no ${thing} at ${tick(wanted)}, but your project has ${tick(near[0])}. File names must match exactly, including capital letters and the folder.`, short: `${thing[0].toUpperCase() + thing.slice(1)} not found: ${wanted}`, fixes, at }
      }
      if (near.length > 1)
        return { text: `There’s no ${thing} at ${tick(wanted)}. Did you mean one of: ${near.map(tick).join(', ')}? File names must match exactly, including capital letters and the folder.`, short: `${thing} not found: ${wanted}`, at }
      return {
        text: `There’s no ${thing} called ${tick(wanted)} in your project. Check the name and folder (paths are relative to ${tick(c.host.target() ?? 'the main file')}), or add the ${thing} to the project folder.`,
        short: `${thing[0].toUpperCase() + thing.slice(1)} not found: ${wanted}`,
        at
      }
    }
  },
  {
    name: 'LaTeX Error: Unicode character α (U+03B1) not set up for use with LaTeX.',
    match: /^Unicode character .*?\(U\+([0-9A-Fa-f]+)\)/,
    async explain(m, c) {
      const ch = String.fromCodePoint(parseInt(m[1], 16))
      const map = UNICODE[ch]
      const invisible = INVISIBLE[ch] ?? (ch.charCodeAt(0) < 32 || ch === '\u007f' ? '' : undefined)
      const fixes: Fix[] = []
      const col = c.lineText?.indexOf(ch) ?? -1
      const at = col >= 0 ? spot(c, col, ch.length) : undefined
      const show = invisible !== undefined ? `an invisible character (U+${m[1].toUpperCase()})` : `${tick(ch)} (U+${m[1].toUpperCase()})`
      if ((map || invisible !== undefined) && c.file) {
        let tex = invisible ?? map.tex
        // A math symbol in normal text needs $…$ around it.
        if (map?.math) {
          const before = stripComment(c.lineText ?? '').slice(0, Math.max(0, col))
          const inMath = (before.match(/(?<!\\)\$/g) ?? []).length % 2 === 1 || (await insideMath(c)) != null
          if (!inMath) tex = `$${tex}$`
        }
        const count = ((await c.read(c.file)) ?? '').split(ch).length - 1
        const pkg = map?.pkg
        fixes.push({
          label: invisible === '' ? `Remove ${count > 1 ? `all ${count}` : 'it'}` : `Change ${count > 1 ? `every ${ch}` : ch} to ${tick(tex)}`,
          key: `uni:${m[1]}:${c.file}`,
          run: async () => {
            const n = await replaceAllInFile(c.host, c.file!, ch, tex)
            if (n && pkg && !c.host.hasPackage(pkg)) await addToPreamble(c.host, `\\usepackage{${pkg}}`)
            return n > 0
          }
        })
      }
      if (invisible !== undefined)
        return { text: `There’s ${show} here, usually from pasting out of Word or a PDF. pdfLaTeX can’t handle it; remove it${invisible ? ` or write ${tick(invisible)}` : ''}.`, short: 'Invisible character in the text', at, fixes }
      if (c.host.engine() === 'pdflatex')
        fixes.push({
          label: 'Switch to XeLaTeX',
          key: 'engine',
          recompile: false,
          run: () => {
            c.host.setEngine('xelatex')
            c.host.compile()
          }
        })
      return {
        text: `pdfLaTeX can’t print ${show} as typed${map ? `; write ${tick(map.math ? `$${map.tex}$` : map.tex)} instead${map.pkg ? ` (from the ${map.pkg} package)` : ''}` : ''}. Or switch the engine to XeLaTeX, which reads such characters directly (the font must have them).`,
        short: `Character ${ch} not supported by pdfLaTeX`,
        at,
        fixes
      }
    }
  },
  {
    name: 'Text line contains an invalid character.',
    match: /^Text line contains an invalid character/,
    explain: (_m, c) => ({
      text: 'An invisible control character (usually from pasting out of Word or a PDF) is on this line. OpenTex can remove it.',
      short: 'Invisible character on the line',
      fixes: c.file && c.line ? [{ label: 'Remove invisible characters', run: () => replaceInLine(c.host, c.file!, c.line!, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/, '') }] : []
    })
  },
  {
    name: "LaTeX Font Warning: Font shape `T1/ptm/bx/sc' undefined using `T1/ptm/b/sc' instead",
    match: /^Font shape `([^/']+)\/([^/']+)\/([^/']+)\/([^']+)' undefined(?:.*?using `[^/']+\/([^/']+)\/([^/']+)\/([^']+)' instead)?/,
    explain(m) {
      const want = [FONT_SERIES[m[3]] ?? m[3], FONT_SHAPES[m[4]] ?? m[4]].filter((s) => s !== 'regular' && s !== 'upright').join(' ') || 'regular'
      const got = m[6] ? [FONT_SERIES[m[6]] ?? m[6], FONT_SHAPES[m[7]] ?? m[7]].filter((s) => s !== 'regular' && s !== 'upright').join(' ') || 'regular' : null
      return {
        text: `The font (${tick(m[2])}) has no ${want} style, so LaTeX used ${got ? `${got} ` : 'another style '}instead. The PDF is fine, but some text may not look exactly as asked. This is usually harmless; some fonts don’t have every combination, such as bold small caps.`,
        short: `Font has no ${want} style`
      }
    }
  },
  {
    name: 'LaTeX Font Warning: Some font shapes were not available, defaults substituted.',
    match: /^Some font shapes were not available/,
    explain: () => ({ text: 'A summary of the font warnings above. Usually harmless.', followOn: true })
  },

  // ----- Layout warnings -----
  {
    name: 'Overfull \\hbox (12.3pt too wide) in paragraph at lines 4--5',
    match: /^Overfull \\hbox \(([\d.]+)pt too wide\) (?:in paragraph|in alignment|detected) at lines? (\d+)(?:--(\d+))?/,
    async explain(m, c) {
      const mm = Number(m[1]) * 0.3515
      const size = mm < 1 ? 'a little' : `about ${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`
      const a = Number(m[2])
      const b = Number(m[3] ?? m[2])
      const lines = c.file ? ((await c.read(c.file)) ?? '').split('\n').slice(a - 1, b) : []
      const text = lines.join('\n')
      const url = text.match(/(?<!\\url\{|\\href\{)(https?:\/\/[^\s}]+|www\.[^\s}]+)/)
      const fixes: Fix[] = []
      let why = 'usually a long word, web address or formula that LaTeX can’t break'
      if (url) {
        why = `probably the web address ${tick(url[1].slice(0, 40) + (url[1].length > 40 ? '…' : ''))}`
        const off = lines.findIndex((l) => l.includes(url[1]))
        if (c.file && off >= 0)
          fixes.push({
            label: `Wrap the address in ${tick('\\url{…}')}`,
            run: async () => {
              const ok = await replaceInLine(c.host, c.file!, a + off, url[1], `\\url{${url[1]}}`)
              if (ok && !c.host.hasPackage('url') && !c.host.hasPackage('hyperref')) await addToPreamble(c.host, '\\usepackage{url}')
              return ok
            }
          })
      } else if (/\\url\{/.test(text)) why = `probably the ${tick('\\url{…}')}: try ${tick('\\usepackage{xurl}')}, which lets addresses break anywhere`
      else if (/\$[^$]{30,}\$/.test(text)) why = 'probably a long formula in the text: try putting it on its own line with `\\[ … \\]`'
      else if (/\\includegraphics|\\begin\{tabular/.test(text)) why = 'probably a picture or table wider than the text: try `width=\\linewidth` or a smaller font'
      return {
        text: `A line ${a === b ? `from line ${a}` : `in lines ${a}–${b}`} sticks out ${size} into the right margin; ${why}. Rephrase it, or help LaTeX break it (${tick('\\-')} marks where a word may break). Tiny overhangs are safe to ignore.`,
        short: `A line sticks into the margin (${size})`,
        fixes
      }
    }
  },
  {
    name: "LaTeX Warning: Float too large for page by 12.3pt",
    match: /^Float too large for page by ([\d.]+)pt/,
    explain: (m) => ({ text: `A figure or table is ${Math.round(Number(m[1]) * 0.3515)} mm taller than the page. Make it smaller, for example ${tick('\\includegraphics[width=0.8\\linewidth]{…}')}, or split it.`, short: 'Figure or table taller than the page' })
  },
  {
    name: "LaTeX Warning: `h' float specifier changed to `ht'.",
    match: /^`(!?h)' float specifier changed to `(!?ht)'/,
    explain: () => ({ text: `LaTeX couldn’t put a figure or table exactly “here”, so it may go to the top of the next page. Usually fine. Giving it more choice with ${tick('[htbp]')} avoids this.`, short: 'Figure moved' })
  },
  {
    name: 'Package hyperref Warning: Token not allowed in a PDF string',
    match: /Token not allowed in a PDF string/,
    explain: () => ({ text: `A heading contains a formula or command that can’t go into the PDF’s bookmarks, so it was left out there (the page itself is fine). To choose what the bookmark shows, write ${tick('\\texorpdfstring{$x^2$}{x2}')}.`, short: 'Heading has math (bookmark text simplified)' })
  },

  // ----- Citations, references and labels -----
  {
    name: "LaTeX Warning: Citation `x' on page 1 undefined",
    match: /Citation `([^']+)'(?: on page \S*)? undefined|entry could not be found.*?in the database: (?:\(biblatex\)\s*)?(\S+)/,
    async explain(m, c) {
      const key = m[1] ?? m[2]
      const keys = c.host.citations().map((x) => x.key)
      const fixes: Fix[] = []
      const uses = await searchProject(c.host, new RegExp(`\\\\\\w*cite\\w*\\*?(?:\\[[^\\]]*\\])*\\{[^}]*?(?<=[{,\\s])(${reEsc(key)})(?=[,}\\s])`))
      const use = uses.find((u) => u.file === c.file && u.line === c.line) ?? uses[0]
      const at = use ? { file: use.file, line: use.line, col: use.col + use.match[0].lastIndexOf(key), len: key.length } : undefined
      if (keys.includes(key)) {
        const main = c.host.target() ?? c.host.mainFile()
        const mainText = main ? ((await c.read(main)) ?? '') : ''
        if (!/\\(bibliography|addbibresource|printbibliography)\b/.test(mainText.split('\n').map(stripComment).join('\n')) && !/\\input\{/.test(mainText)) {
          const bib = c.host.files().find((f) => f.endsWith('.bib'))
          if (main && bib)
            fixes.push({
              label: `Add a bibliography (${tick(bib)})`,
              run: async () => {
                const text = (await c.read(main)) ?? ''
                const end = text.split('\n').findIndex((l) => /^\s*\\end\{document\}/.test(l))
                return insertLines(c.host, main, end >= 0 ? end + 1 : text.split('\n').length + 1, `\\bibliographystyle{plain}\n\\bibliography{${relPath(c, bib).replace(/\.bib$/, '')}}`)
              }
            })
          return { text: `${tick(key)} is in your .bib file, but the paper has no ${tick('\\bibliography{…}')} line, so the reference list is never made.`, short: `No bibliography for ${key}`, fixes, at }
        }
        return { text: `${tick(key)} is in your .bib file, so it just needs another compile to show up. If it stays, check that ${tick('\\bibliography{…}')} names the right .bib file.`, short: `Citation ${key}: compile again`, fixes: [compileFix(c.host)], at }
      }
      const guess = closest(key, keys, { ignoreCase: true })
      if (guess && use) {
        fixes.push({ label: `Use the closest key ${tick(guess)}`, run: () => replaceAt(c.host, at!, key, guess) })
        const title = c.host.citations().find((x) => x.key === guess)?.title
        return { text: `There’s no reference with the key ${tick(key)} in your .bib files. The closest is ${tick(guess)}${title ? ` (“${title}”)` : ''}.`, short: `Unknown citation ${key} (did you mean ${guess}?)`, fixes, at }
      }
      fixes.push({ label: 'Import references…', recompile: false, run: () => c.host.importRefs() })
      return {
        text: `There’s no reference with the key ${tick(key)} in your .bib files. Add it: import it from your reference manager (File → Import References), or paste its BibTeX entry into your .bib file.${keys.length ? '' : ' Your project has no references yet.'}`,
        short: `Unknown citation ${key}`,
        fixes,
        at
      }
    }
  },
  {
    name: "LaTeX Warning: Reference `x' on page 1 undefined",
    match: /(?:Hyper )?[Rr]eference `([^']+)'(?: on page \S*)? undefined/,
    async explain(m, c) {
      const key = m[1]
      const labels = c.host.labels()
      const uses = await searchProject(c.host, new RegExp(`\\\\\\w*ref\\*?\\{[^}]*?(?<=[{,])\\s*(${reEsc(key)})\\s*(?=[,}])`, 'i'))
      const use = uses.find((u) => u.file === c.file && u.line === c.line) ?? uses[0]
      const at = use ? { file: use.file, line: use.line, col: use.col + use.match[0].lastIndexOf(key), len: key.length } : undefined
      if (labels.includes(key)) return { text: `${tick(`\\label{${key}}`)} exists, so this just needs another compile.`, short: `Reference ${key}: compile again`, fixes: [compileFix(c.host)], at }
      const guess = closest(key, labels, { ignoreCase: true })
      if (guess && at)
        return { text: `There’s no ${tick(`\\label{${key}}`)} anywhere in your paper. The closest label is ${tick(guess)}.`, short: `Unknown label ${key} (did you mean ${guess}?)`, fixes: [{ label: `Use ${tick(guess)}`, run: () => replaceAt(c.host, at, key, guess) }], at }
      return { text: `There’s no ${tick(`\\label{${key}}`)} anywhere in your paper, so LaTeX prints “??”. Add ${tick(`\\label{${key}}`)} right after the ${tick('\\caption')} of the figure or table (or after the ${tick('\\section')}) you mean.`, short: `Unknown label ${key}`, at }
    }
  },
  {
    name: "LaTeX Warning: Label `x' multiply defined.",
    match: /Label `([^']+)' multiply defined/,
    async explain(m, c) {
      const key = m[1]
      const defs = await searchProject(c.host, new RegExp(`\\\\label\\{\\s*${reEsc(key)}\\s*\\}`))
      const second = defs[1]
      const fixes: Fix[] = []
      if (second) {
        const at = { file: second.file, line: second.line, col: second.col + second.match[0].indexOf(key), len: key.length }
        const free = (n: number): string => (defs.length && !c.host.labels().includes(`${key}-${n}`) ? `${key}-${n}` : free(n + 1))
        const name = free(2)
        fixes.push({ label: `Rename the second one to ${tick(name)}`, run: () => replaceAt(c.host, at, key, name) })
        return { text: `${tick(`\\label{${key}}`)} is used ${defs.length} times (${defs.map((d) => `${d.file}:${d.line}`).join(', ')}). Each label must be unique, or ${tick(`\\ref{${key}}`)} can’t know which one you mean. Rename one, and update the ${tick('\\ref')}s that should point to it.`, short: `Label ${key} used twice`, fixes, at }
      }
      return { text: `${tick(`\\label{${key}}`)} is used more than once. Each label must be unique. (If you just renamed it, compile again.)`, short: `Label ${key} used twice`, fixes: [compileFix(c.host)] }
    }
  },
  {
    name: 'LaTeX Warning: There were undefined references. / multiply-defined labels.',
    match: /^There were (undefined references|undefined citations|multiply-defined labels)/,
    explain: (m, c) =>
      c.all.some((q) => q !== c.p && /undefined|multiply defined/.test(q.message))
        ? { text: 'A summary of the warnings above.', followOn: true }
        : { text: m[1] === 'multiply-defined labels' ? 'Two labels have the same name. Compile again to see which.' : 'Some citations or cross-references were not found yet. Compile again; if this stays, check the warnings.', fixes: [compileFix(c.host)] }
  },
  {
    name: 'Label(s) may have changed. Rerun to get cross-references right.',
    match: /Rerun to get|Please \(re\)run|Please rerun/,
    explain: (_m, c) => ({ text: 'Numbers for references changed during this compile. Compile once more to settle them.', short: 'Compile again', fixes: [compileFix(c.host)] })
  },
  {
    name: "LaTeX Warning: Empty `thebibliography' environment",
    match: /Empty `thebibliography' environment/,
    explain: (_m, c) =>
      c.all.some((q) => /^(BibTeX|Biber):/.test(q.message))
        ? { text: 'The reference list is empty because of the BibTeX problem listed here.', short: 'Empty bibliography', followOn: true }
        : { text: `The reference list is empty: nothing was cited with ${tick('\\cite{…}')}, or BibTeX hasn’t run yet. Cite something and compile again.`, short: 'Empty bibliography', fixes: [compileFix(c.host)] }
  },
  {
    name: 'Package natbib Error: Bibliography not compatible with author-year citations.',
    match: /Bibliography not compatible with author-year citations|Author undefined for citation/,
    async explain(_m, c) {
      const hits = await searchProject(c.host, /\\bibliographystyle\{(plain|unsrt|abbrv|alpha)\}/)
      const h = hits[0]
      const fixes: Fix[] = h ? [{ label: `Use ${tick(h.match[1] === 'alpha' ? 'plainnat' : h.match[1] + 'nat')}`, run: () => replaceInLine(c.host, h.file, h.line, `{${h.match[1]}}`, `{${h.match[1] === 'alpha' ? 'plainnat' : h.match[1] + 'nat'}}`) }] : []
      return { text: `natbib’s author–year citations need a matching style, such as ${tick('plainnat')}. Change ${tick('\\bibliographystyle{…}')}, or load natbib with ${tick('\\usepackage[numbers]{natbib}')} for numbered citations.`, short: 'Bibliography style doesn’t suit natbib', fixes }
    }
  },

  // ----- BibTeX and Biber (from the .blg file) -----
  {
    name: "BibTeX: I couldn't open database file x.bib / Biber: Cannot find 'x.bib'",
    match: /^(?:BibTeX: I couldn't open database file|Biber: Cannot find) '?([^'\s]+?)'?!?$/,
    async explain(m, c) {
      const name = m[1].replace(/\.bib$/, '')
      const bibs = c.host.files().filter((f) => f.endsWith('.bib'))
      const hits = await searchProject(c.host, new RegExp(`\\\\(bibliography|addbibresource)\\{([^}]*\\b${reEsc(name)}(?:\\.bib)?)\\b`))
      const guess = closest(name.split('/').pop()!, bibs.map((b) => b.split('/').pop()!.replace(/\.bib$/, '')), { ignoreCase: true }) ?? (bibs.length === 1 ? bibs[0].split('/').pop()!.replace(/\.bib$/, '') : null)
      const bib = guess ? bibs.find((b) => b.split('/').pop()!.replace(/\.bib$/, '') === guess)! : null
      const fixes: Fix[] = []
      const h = hits[0]
      const at = h ? { file: h.file, line: h.line, col: h.col + h.match[0].indexOf(name), len: name.length } : undefined
      if (bib && h) {
        const rel = relPath(c, bib).replace(h.match[1] === 'addbibresource' ? /$/ : /\.bib$/, '')
        fixes.push({ label: `Use ${tick(rel)}`, run: () => replaceAt(c.host, at!, name + (h.match[2].endsWith('.bib') && h.match[1] === 'addbibresource' ? '.bib' : ''), rel) })
      }
      if (!bibs.length) fixes.push({ label: 'Import references…', recompile: false, run: () => c.host.importRefs() })
      return {
        text: `Your paper asks for ${tick(name + '.bib')}, but there’s no such file${bib ? `. Your project has ${tick(bib)}` : bibs.length ? '' : ', and the project has no .bib file yet. Import your references to make one'}. Without it, every citation shows as “?”.`,
        short: `Can't find ${name}.bib`,
        fixes,
        at
      }
    }
  },
  {
    name: "BibTeX: I couldn't open style file x.bst",
    match: /^BibTeX: I couldn't open style file (\S+?)(?:\.bst)?$/,
    async explain(m, c) {
      const guess = closest(m[1], BIB_STYLES, { ignoreCase: true })
      const hits = await searchProject(c.host, new RegExp(`\\\\bibliographystyle\\{\\s*(${reEsc(m[1])})\\s*\\}`))
      const h = hits[0]
      const at = h ? { file: h.file, line: h.line, col: h.col + h.match[0].indexOf(m[1]), len: m[1].length } : undefined
      return {
        text: `There’s no bibliography style called ${tick(m[1])}.${guess ? ` Did you mean ${tick(guess)}?` : ` Common ones are ${tick('plain')}, ${tick('unsrt')} (in citation order) and ${tick('plainnat')} (author–year with natbib); a journal’s own .bst file goes in your project folder.`}`,
        short: `Unknown bibliography style ${m[1]}`,
        fixes: guess && at ? [{ label: `Use ${tick(guess)}`, run: () => replaceAt(c.host, at, m[1], guess) }] : [],
        at
      }
    }
  },
  {
    name: 'BibTeX: Repeated entry / Biber: Duplicate entry key',
    match: /^(?:BibTeX: Repeated entry ?(\S*)|Biber: Duplicate entry key '([^']+)')/,
    explain: (m) => {
      const key = m[1] || m[2]
      return { text: `Two entries in your .bib file have the same key${key ? ` ${tick(key)}` : ''}. BibTeX uses the first and skips the other. Delete the duplicate, or give it a different key (and update its ${tick('\\cite')}).`, short: `Duplicate reference ${key}` }
    }
  },
  {
    name: 'BibTeX: I found no \\citation commands',
    match: /^BibTeX: I found no \\citation commands/,
    async explain(_m, c) {
      const hits = await searchProject(c.host, /\\bibliography\{/)
      const h = hits[0]
      return {
        text: `Your paper has a bibliography but doesn’t cite anything with ${tick('\\cite{…}')}, so the reference list is empty. Cite something, or add ${tick('\\nocite{*}')} to list every entry in your .bib file.`,
        short: 'Nothing cited, so no references',
        fixes: h ? [{ label: `List every reference (${tick('\\nocite{*}')})`, run: () => insertLines(c.host, h.file, h.line, '\\nocite{*}') }] : []
      }
    }
  },
  {
    name: 'BibTeX: I found no \\bibdata / \\bibstyle commands',
    match: /^BibTeX: I found no \\(bibdata|bibstyle) commands/,
    async explain(m, c) {
      const fixes: Fix[] = []
      const main = c.host.target() ?? c.host.mainFile()
      const bib = c.host.files().find((f) => f.endsWith('.bib'))
      if (m[1] === 'bibstyle') {
        const h = (await searchProject(c.host, /\\bibliography\{/))[0]
        if (h) fixes.push({ label: `Add ${tick('\\bibliographystyle{plain}')}`, run: () => insertLines(c.host, h.file, h.line, '\\bibliographystyle{plain}') })
        return { text: `There’s no ${tick('\\bibliographystyle{…}')} line, so BibTeX doesn’t know how to format the references. Add one next to ${tick('\\bibliography{…}')}.`, short: 'No bibliography style', fixes }
      }
      if (main && bib)
        fixes.push({
          label: `Add ${tick(`\\bibliography{${relPath(c, bib).replace(/\.bib$/, '')}}`)}`,
          run: async () => {
            const lines = ((await c.read(main)) ?? '').split('\n')
            const end = lines.findIndex((l) => /^\s*\\end\{document\}/.test(l))
            const style = lines.some((l) => /\\bibliographystyle/.test(l)) ? '' : '\\bibliographystyle{plain}\n'
            return insertLines(c.host, main, end >= 0 ? end + 1 : lines.length + 1, `${style}\\bibliography{${relPath(c, bib).replace(/\.bib$/, '')}}`)
          }
        })
      return { text: `There’s no ${tick('\\bibliography{…}')} line naming your .bib file, so BibTeX has no references to work with. Add it where the reference list should go, usually just before ${tick('\\end{document}')}.`, short: 'No \\bibliography line', fixes }
    }
  },
  {
    name: 'Biber: ERROR - …',
    match: /^Biber: (.*)$/,
    explain: (m) => ({ text: `Biber (which builds the reference list for biblatex) reported: “${m[1]}”. Check the .bib entry it names; a missing comma or brace is the usual cause.`, short: 'Biber reported a problem' })
  },

  // ----- Knock-on effects -----
  {
    name: 'Emergency stop.',
    match: /^Emergency stop/,
    explain: (_m, c) => ({ text: c.index > 0 ? 'TeX had to stop here because of the problem above. Fix that and compile again.' : 'TeX had to stop here. Check the line shown, and the log for details.', short: 'TeX stopped', followOn: c.index > 0 })
  },
  {
    name: '==> Fatal error occurred, no output PDF file produced!',
    match: /Fatal error occurred, no output PDF/,
    explain: () => ({ text: 'Because of the problems above, no PDF was made this time.', short: 'No PDF made', followOn: true })
  },
  {
    name: "Package keyval Error: x undefined.",
    match: /^(\S+) undefined\.?$/,
    explain: (m, c) =>
      /keyval|Package \S+ Error/.test(c.p.message)
        ? { text: `${tick(m[1])} isn’t an option this command or package knows. Check its spelling (for pictures: ${tick('width')}, ${tick('height')}, ${tick('scale')}, ${tick('angle')}).`, short: `Unknown option ${m[1]}` }
        : null
  }
]
