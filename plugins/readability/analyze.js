// Readability analysis for LaTeX source. Pure functions, no DOM: works in the plugin page and in Node.
// Offsets in every result point into the original .tex text, so the editor can highlight them.
;(function (root) {
  // ---------- 1. LaTeX → prose mask ----------
  // We blank out (with spaces) everything that isn't prose, keeping the text the same length,
  // so word positions in the mask are positions in the source.
  const DROP_WITH_ARGS = new Set([
    'cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'nocite',
    'ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref', 'label', 'includegraphics', 'usepackage', 'documentclass',
    'bibliography', 'bibliographystyle', 'addbibresource', 'input', 'include', 'url', 'href', 'hypersetup',
    'newcommand', 'renewcommand', 'providecommand', 'DeclareMathOperator', 'setlength', 'addtolength', 'vspace', 'hspace',
    'begin', 'end', 'thanks', 'affiliation', 'affil', 'email', 'author', 'date', 'maketitle', 'tableofcontents',
    'graphicspath', 'pagestyle', 'thispagestyle', 'setcounter', 'newenvironment', 'definecolor', 'footnotemark'
  ])
  const HEADINGS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'title'])
  const SKIP_ENVS = /^(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath|math|tabular\w*|array|verbatim|lstlisting|minted|tikzpicture|algorithmic|algorithm2e|thebibliography|comment)\*?$/

  function blank(chars, from, to) {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' '
  }

  /** Index just past the balanced group starting at `i` (which must be `open`). */
  function skipGroup(t, i, open, close) {
    let depth = 0
    for (let j = i; j < t.length; j++) {
      const c = t[j]
      if (c === '\\') { j++; continue }
      if (c === open) depth++
      else if (c === close && --depth === 0) return j + 1
    }
    return t.length
  }

  function mask(t) {
    const c = t.split('')
    const headings = [] // { from, to, level, title }
    // Preamble and anything after \end{document}.
    const b = t.indexOf('\\begin{document}')
    if (b >= 0) blank(c, 0, b + 16)
    const e = t.indexOf('\\end{document}')
    if (e >= 0) blank(c, e, t.length)

    let i = 0
    while (i < t.length) {
      if (c[i] === ' ' && t[i] !== ' ' && t[i] !== '\n') { i++; continue } // already blanked
      const ch = t[i]
      if (ch === '%') {
        let j = t.indexOf('\n', i)
        if (j < 0) j = t.length
        blank(c, i, j)
        i = j
      } else if (ch === '$') {
        const dbl = t[i + 1] === '$'
        const close = dbl ? t.indexOf('$$', i + 2) : findDollar(t, i + 1)
        const end = close < 0 ? t.length : close + (dbl ? 2 : 1)
        blank(c, i, end)
        c[i] = 'ⓜ' // a placeholder "word" so inline math still counts as one token
        i = end
      } else if (ch === '\\') {
        const m = /^\\([A-Za-z@]+\*?|.)/.exec(t.slice(i, i + 40))
        if (!m) { i++; continue }
        const name = m[1].replace(/\*$/, '')
        let j = i + m[0].length
        if (name === '[' || name === '(') {
          const close = t.indexOf(name === '[' ? '\\]' : '\\)', j)
          const end = close < 0 ? t.length : close + 2
          blank(c, i, end)
          if (name === '(') c[i] = 'ⓜ'
          i = end
          continue
        }
        if (name === 'begin') {
          const env = /^\{([^}]*)\}/.exec(t.slice(j))
          if (env && SKIP_ENVS.test(env[1])) {
            const endTag = `\\end{${env[1]}}`
            const k = t.indexOf(endTag, j)
            const end = k < 0 ? t.length : k + endTag.length
            blank(c, i, end)
            i = end
            continue
          }
        }
        if (DROP_WITH_ARGS.has(name) || HEADINGS.has(name)) {
          while (j < t.length && /\s/.test(t[j]) && t[j] !== '\n') j++
          if (t[j] === '[') j = skipGroup(t, j, '[', ']')
          const argFrom = j
          if (t[j] === '{') j = skipGroup(t, j, '{', '}')
          if (name === 'href' && t[j] === '{') { blank(c, i, j); c[j] = ' '; i = j + 1; continue } // keep link text
          if (HEADINGS.has(name)) headings.push({ from: i, to: j, level: name, title: t.slice(argFrom + 1, j - 1).replace(/\\[a-zA-Z]+|[{}]/g, '').trim() })
          blank(c, i, j)
          i = j
          continue
        }
        // Any other command: drop the name, keep its argument text (\textbf{word} -> word).
        blank(c, i, j)
        if (/[A-Za-z]/.test(name[0]) || name === '\\') { i = j; continue }
        // Escaped symbols like \% \& \_: keep as a neutral character.
        i = j
      } else if (ch === '{' || ch === '}' || ch === '~' || ch === '&') {
        c[i] = ' '
        i++
      } else i++
    }
    return { text: c.join(''), headings }
  }

  function findDollar(t, from) {
    for (let j = from; j < t.length; j++) {
      if (t[j] === '\\') { j++; continue }
      if (t[j] === '$') return j
      if (t[j] === '\n' && t[j + 1] === '\n') return j // unclosed: stop at paragraph end
    }
    return -1
  }

  // ---------- 2. Word lists ----------
  // Function words: anything here is not a content word (lexical density = content / all words).
  const FUNCTION_WORDS = new Set(`a about above across after afterwards again against all almost alone along already also although always am among amongst an and another any anyhow anyone anything anyway anywhere are around as at back be became because become becomes becoming been before beforehand behind being below beside besides between beyond both but by can cannot could did do does doing done down during each either else elsewhere enough etc even ever every everyone everything everywhere except few for former formerly from further had has have having he hence her here hereafter hereby herein hers herself him himself his how however i ie if in indeed into is it its itself just last latter latterly least less many may me meanwhile might mine more moreover most mostly much must my myself namely neither never nevertheless next no nobody none noone nor not nothing now nowhere of off often on once one only onto or other others otherwise our ours ourselves out over own per perhaps please quite rather same several she should since so some somehow someone something sometime sometimes somewhere still such than that the their theirs them themselves then thence there thereafter thereby therefore therein thereupon these they this those though through throughout thru thus to together too toward towards under until up upon us very via was we well were what whatever when whence whenever where whereafter whereas whereby wherein whereupon wherever whether which while whither who whoever whole whom whose why will with within without would yet you your yours yourself yourselves eg e g cf vs i.e e.g let lets get got gets make made makes go goes went gone come came take took put say said says do`.split(/\s+/))
  const BE = new Set(['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', "isn't", "aren't", "wasn't", "weren't"])
  const IRREGULAR_PARTICIPLES = new Set('known shown seen given taken found made done built chosen drawn driven grown held kept led left lost meant paid put read run said sent set shot sold spent split spread struck taught thought told understood undertaken won written begun broken brought bought caught dealt fed felt fought forgotten frozen hidden hit hung hurt laid lain lit met mistaken overcome proven rewritten risen sought shaken shed shut sunk slain spun stolen stuck sworn swept torn thrown woken worn wound withdrawn'.split(' '))
  const NOT_PARTICIPLES = new Set(['need', 'red', 'bed', 'seed', 'feed', 'speed', 'indeed', 'embed', 'shed', 'hundred', 'ted', 'used'])
  const HEDGES = ['may', 'might', 'could', 'possibly', 'perhaps', 'presumably', 'apparently', 'seemingly', 'arguably', 'likely', 'unlikely', 'potentially', 'somewhat', 'relatively', 'fairly', 'suggests', 'suggest', 'appears to', 'appear to', 'seems to', 'seem to', 'to some extent', 'tends to', 'tend to']
  const BOOSTERS = ['clearly', 'obviously', 'undoubtedly', 'certainly', 'definitely', 'of course', 'without doubt', 'it is well known', 'it is evident', 'undeniably', 'always', 'never', 'proves', 'prove']
  const FILLERS = ['very', 'really', 'basically', 'actually', 'quite', 'just', 'simply', 'literally', 'extremely', 'totally', 'in order to', 'a lot of', 'lots of', 'kind of', 'sort of', 'due to the fact that', 'it is important to note that', 'it should be noted that', 'it is worth noting that', 'needless to say', 'in terms of', 'the fact that', 'at this point in time', 'in the event that']
  const NOMINAL = /(tion|tions|sion|sions|ment|ments|ness|nesses|ity|ities|ance|ances|ence|ences|ism|isms|ization|izations|isation|isations)$/
  const NOMINAL_EXCEPT = new Set(['city', 'pity', 'nation', 'station', 'ration', 'mention', 'cement', 'moment', 'element', 'elements', 'comment', 'comments', 'segment', 'since', 'hence', 'fence', 'once', 'dance', 'chance', 'prism', 'business', 'witness', 'experiment', 'experiments', 'equation', 'equations', 'section', 'sections'])
  const ABBREV = /(?:\b(?:e\.g|i\.e|et al|etc|Fig|Figs|Eq|Eqs|Ref|Refs|Sec|Tab|vs|cf|Dr|Mr|Mrs|Ms|Prof|approx|resp|ca|No|Vol|pp|Ch|al)\.|\b[A-Z]\.)$/

  // ---------- 3. Tokens and sentences ----------
  function syllables(w) {
    w = w.toLowerCase().replace(/[^a-z]/g, '')
    if (!w) return 0
    if (w.length <= 3) return 1
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
    const g = w.match(/[aeiouy]{1,2}/g)
    return Math.max(1, g ? g.length : 1)
  }

  function sentencesOf(m) {
    const out = []
    const wordRe = /ⓜ|[A-Za-z][A-Za-z'’\-]*/g
    // Split into paragraphs first (blank lines), then on sentence punctuation.
    const paraRe = /\n[ \t]*\n/g
    let paraStart = 0
    const paras = []
    let pm
    while ((pm = paraRe.exec(m))) { paras.push([paraStart, pm.index]); paraStart = pm.index + pm[0].length }
    paras.push([paraStart, m.length])
    for (const [pa, pb] of paras) {
      let words = []
      let start = -1
      const flush = (end) => {
        if (words.length) out.push({ from: start, to: end, words })
        words = []
        start = -1
      }
      const seg = m.slice(pa, pb)
      const re = /ⓜ|[A-Za-z][A-Za-z'’\-]*|[.?!]+/g
      let tm
      while ((tm = re.exec(seg))) {
        const at = pa + tm.index
        const tok = tm[0]
        if (/^[.?!]/.test(tok)) {
          if (!words.length) continue
          const before = m.slice(Math.max(pa, at - 12), at + 1)
          if (tok === '.' && ABBREV.test(before)) continue
          // Only a real end if followed by whitespace+capital, a math token, or the paragraph end.
          const after = m.slice(at + tok.length, at + tok.length + 40).replace(/^[)\]'"’”\s]*/, '')
          if (after && /^[a-z]/.test(after)) continue
          flush(at + tok.length)
        } else {
          if (start < 0) start = at
          words.push({ from: at, to: at + tok.length, w: tok === 'ⓜ' ? 'ⓜ' : tok.toLowerCase().replace(/’/g, "'") })
        }
      }
      if (words.length) flush(words[words.length - 1].to)
    }
    void wordRe
    return out
  }

  // ---------- 4. Flags ----------
  function phraseHits(ws, list, kind, why) {
    const hits = []
    const phrases = list.map((p) => p.split(' '))
    for (let i = 0; i < ws.length; i++) {
      for (const p of phrases) {
        let ok = true
        for (let k = 0; k < p.length; k++) if (ws[i + k]?.w !== p[k]) { ok = false; break }
        if (ok) { hits.push({ from: ws[i].from, to: ws[i + p.length - 1].to, kind, title: why(p.join(' ')) }); break }
      }
    }
    return hits
  }

  function flagsOf(ws) {
    const flags = []
    for (let i = 0; i < ws.length; i++) {
      if (!BE.has(ws[i].w)) continue
      let j = i + 1
      if (ws[j] && /ly$/.test(ws[j].w) && ws[j].w.length > 4) j++ // "was carefully measured"
      if (ws[j] && ws[j].w === 'not') j++
      const p = ws[j]?.w
      if (p && ((/ed$/.test(p) && p.length > 4 && !NOT_PARTICIPLES.has(p)) || IRREGULAR_PARTICIPLES.has(p))) {
        flags.push({ from: ws[i].from, to: ws[j].to, kind: 'passive', title: `Passive voice: “${ws.slice(i, j + 1).map((x) => x.w).join(' ')}”. Fine in Methods; elsewhere consider who did it.` })
      }
    }
    flags.push(...phraseHits(ws, HEDGES, 'hedge', (p) => `Hedge: “${p}”. One hedge per claim is enough.`))
    flags.push(...phraseHits(ws, BOOSTERS, 'hedge', (p) => `Booster: “${p}”. Let the evidence make it clear.`))
    flags.push(...phraseHits(ws, FILLERS, 'filler', (p) => `Filler: “${p}” can usually be cut or shortened.`))
    return flags
  }

  // ---------- 5. Metrics ----------
  const fkGrade = (words, sents, syl) => (sents && words ? 0.39 * (words / sents) + 11.8 * (syl / words) - 15.59 : 0)
  const readingEase = (words, sents, syl) => (sents && words ? 206.835 - 1.015 * (words / sents) - 84.6 * (syl / words) : 0)

  /** Moving-average type/token ratio: length-independent lexical diversity. */
  function mattr(list, win = 50) {
    if (list.length === 0) return 0
    if (list.length <= win) return new Set(list).size / list.length
    const counts = new Map()
    let uniq = 0
    for (let i = 0; i < win; i++) { const n = (counts.get(list[i]) || 0) + 1; counts.set(list[i], n); if (n === 1) uniq++ }
    let sum = uniq
    for (let i = win; i < list.length; i++) {
      const out = list[i - win]
      const n0 = counts.get(out) - 1
      counts.set(out, n0)
      if (n0 === 0) uniq--
      const n = (counts.get(list[i]) || 0) + 1
      counts.set(list[i], n)
      if (n === 1) uniq++
      sum += uniq
    }
    return sum / (list.length - win + 1) / win
  }

  function statsOf(sents) {
    let words = 0, content = 0, syl = 0, nominal = 0
    const lens = []
    const list = []
    for (const s of sents) {
      let n = 0
      for (const x of s.words) {
        if (x.w === 'ⓜ') continue
        n++
        list.push(x.w)
        syl += syllables(x.w)
        if (!FUNCTION_WORDS.has(x.w)) content++
        if (x.w.length > 6 && NOMINAL.test(x.w) && !NOMINAL_EXCEPT.has(x.w)) nominal++
      }
      words += n
      if (n) lens.push(n)
    }
    const mean = lens.length ? words / lens.length : 0
    const sd = lens.length ? Math.sqrt(lens.reduce((a, l) => a + (l - mean) ** 2, 0) / lens.length) : 0
    return {
      words, sentences: lens.length,
      density: words ? content / words : 0,
      diversity: mattr(list),
      grade: fkGrade(words, lens.length, syl),
      ease: readingEase(words, lens.length, syl),
      sentenceLength: mean, sentenceSd: sd,
      nominal: words ? (100 * nominal) / words : 0
    }
  }

  function analyze(text) {
    const { text: m, headings } = mask(text)
    const sents = sentencesOf(m)
    const flags = []
    for (const s of sents) {
      s.flags = flagsOf(s.words)
      flags.push(...s.flags)
    }
    // Per sentence, measure a 3-sentence window around it: single short sentences are too noisy.
    sents.forEach((s, i) => {
      s.own = statsOf([s])
      s.win = statsOf(sents.slice(Math.max(0, i - 1), i + 2))
    })
    const doc = statsOf(sents)
    doc.flags = { passive: 0, hedge: 0, filler: 0 }
    for (const f of flags) doc.flags[f.kind]++
    // Sections: sentences between headings.
    const sections = []
    const hs = headings.filter((h) => h.level !== 'title')
    const bounds = hs.map((h) => h.from)
    const first = { title: hs.length ? 'Opening' : 'Document', from: 0 }
    const groups = [first, ...hs.map((h) => ({ title: h.title || h.level, from: h.from, level: h.level }))]
    for (let g = 0; g < groups.length; g++) {
      const from = groups[g].from
      const to = g + 1 < groups.length ? groups[g + 1].from : Infinity
      const ss = sents.filter((s) => s.from >= from && s.from < to)
      if (!ss.length) continue
      sections.push({ ...groups[g], to: Math.min(to, text.length), stats: statsOf(ss) })
    }
    void bounds
    return { doc, sentences: sents.map(({ from, to, own, win, flags }) => ({ from, to, own, win, flags })), sections }
  }

  // ---------- 6. Targets ----------
  // Rough bands, tuned on published papers; they're guides, not rules.
  const PRESETS = {
    specialist: { name: 'Specialist journal', density: [0.52, 0.64], diversity: [0.74, 0.86], grade: [13, 18], sentenceLength: [16, 27], nominal: [3, 7] },
    general: { name: 'Broad journal (Nature, Science)', density: [0.5, 0.6], diversity: [0.73, 0.85], grade: [12, 16], sentenceLength: [14, 24], nominal: [2, 5.5] },
    thesis: { name: 'Thesis', density: [0.5, 0.63], diversity: [0.72, 0.86], grade: [13, 19], sentenceLength: [15, 29], nominal: [2.5, 7] },
    lay: { name: 'Grant summary / lay abstract', density: [0.47, 0.58], diversity: [0.7, 0.84], grade: [10, 14], sentenceLength: [12, 22], nominal: [1.5, 4] }
  }

  /** Where a value sits against a band: negative = below (simpler), positive = above (denser), 0 inside. In band widths. */
  function deviation(v, [lo, hi]) {
    const w = hi - lo
    if (v < lo) return (v - lo) / w
    if (v > hi) return (v - hi) / w
    return 0
  }

  root.Readability = { analyze, mask, syllables, mattr, PRESETS, deviation }
  if (typeof module !== 'undefined') module.exports = root.Readability
})(typeof window !== 'undefined' ? window : globalThis)
