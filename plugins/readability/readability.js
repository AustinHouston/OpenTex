// Readability panel: gauges against a target band, a document map, per-section table, style flags,
// the five sentences furthest from the target, and highlights in the editor.
// Blue means simpler than the target, amber means denser; inside the band gets no colour.
;(function () {
  const R = window.Readability
  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  const METRICS = {
    density: { name: 'Lexical density', hint: 'Share of content words (nouns, verbs, adjectives…) vs. function words', fmt: (v) => `${Math.round(v * 100)}%`, range: [0.3, 0.8], d: (a, b) => `${Math.round((a - b) * 100)}%` },
    diversity: { name: 'Lexical diversity', hint: 'Moving-average type/token ratio (MATTR, 50-word window): how little you repeat words', fmt: (v) => v.toFixed(2), range: [0.55, 0.95], d: (a, b) => (a - b).toFixed(2) },
    grade: { name: 'Grade level', hint: 'Flesch–Kincaid: years of schooling needed. Higher = denser, not worse', fmt: (v) => v.toFixed(1), range: [0, 26], d: (a, b) => (a - b).toFixed(1) },
    sentenceLength: { name: 'Words per sentence', hint: 'Mean sentence length', fmt: (v, s) => `${v.toFixed(1)}${s ? ` <span class="delta">± ${s.sentenceSd.toFixed(0)}</span>` : ''}`, range: [0, 40], d: (a, b) => (a - b).toFixed(1) },
    nominal: { name: 'Nominalizations', hint: 'Abstract nouns (-tion, -ment, -ity, -ness…) per 100 words: the hallmark of scientific register', fmt: (v) => v.toFixed(1), range: [0, 12], d: (a, b) => (a - b).toFixed(1) }
  }
  // Metrics combined into the overall "register" score and the "Combined" heat map.
  const COMBINED = ['grade', 'sentenceLength', 'density', 'nominal']

  const state = { preset: 'specialist', heat: 'combined', flags: { passive: true, hedge: true, filler: true } }
  let doc = null // { file, text, version }
  let result = null
  const baselines = new Map() // file -> doc stats when first analyzed this session

  const preset = () => R.PRESETS[state.preset] || R.PRESETS.specialist
  const dev = (key, stats) => R.deviation(stats[key], preset()[key])
  const combined = (stats) => COMBINED.reduce((a, k) => a + dev(k, stats), 0) / COMBINED.length

  /** Heat for one sentence on the chosen metric: signed deviation, or null if too short to judge. */
  function heatOf(s) {
    if (state.heat === 'off') return null
    if (state.heat === 'sentenceLength') return s.own.words ? dev('sentenceLength', s.own) : null
    if (s.win.words < 12) return null
    return state.heat === 'combined' ? combined(s.win) : dev(state.heat, s.win)
  }
  const heatClass = (h) => (h == null || Math.abs(h) < 0.25 ? '' : `${h < 0 ? 'simple' : 'dense'}${Math.abs(h) >= 1 ? '2' : ''}`)

  // ---------- Settings ----------
  const sel = $('preset')
  sel.innerHTML = Object.entries(R.PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')
  sel.onchange = () => { state.preset = sel.value; save(); render() }
  const save = () => OpenTex.storage.set('state', state)
  OpenTex.storage.get('state').then((s) => {
    if (s) Object.assign(state, s, { flags: { ...state.flags, ...(s.flags || {}) } })
    sel.value = state.preset
    render()
  })

  // ---------- Analysis ----------
  OpenTex.onDocument((d) => {
    doc = d
    result = d ? R.analyze(d.text) : null
    if (d && result && !baselines.has(d.file)) baselines.set(d.file, result.doc)
    render()
  })

  function highlight() {
    if (!doc || !result) return
    const marks = []
    for (const s of result.sentences) {
      const c = heatClass(heatOf(s))
      if (c) marks.push({ from: s.from, to: s.to, kind: c, title: tip(s) })
      for (const f of s.flags) if (state.flags[f.kind]) marks.push(f)
    }
    OpenTex.highlight(doc, marks)
  }

  function tip(s) {
    const o = s.own
    return `${o.words} words · grade ${o.grade.toFixed(1)} · density ${Math.round(o.density * 100)}% · ${((n) => `${n} nominalization${n === 1 ? '' : 's'}`)(Math.round((o.nominal * o.words) / 100))}${s.flags.some((f) => f.kind === 'passive') ? ' · passive' : ''}`
  }

  // ---------- Rendering ----------
  function render() {
    const out = $('out')
    if (!doc || !result) {
      out.innerHTML = '<div class="empty">Open a .tex file to analyze it.</div>'
      return
    }
    const d = result.doc
    if (d.words < 30) {
      out.innerHTML = '<div class="empty">Write a little more (30+ words of prose) to get meaningful numbers.</div>'
      OpenTex.highlight(doc, [])
      return
    }
    const p = preset()
    const base = baselines.get(doc.file)
    const overall = combined(d)
    out.innerHTML = [
      verdict(d, overall, p),
      `<h3>Measures <span style="text-transform:none;font-weight:400">· click one to map it</span></h3>`,
      Object.keys(METRICS).map((k) => gauge(k, d, base)).join(''),
      sectionMap(),
      sectionsTable(),
      flagsBox(d),
      worst(),
      `<div class="note">${d.words.toLocaleString()} words in ${d.sentences} sentences, ignoring commands, math, citations and comments. Bands are rough guides from published papers. ${base && base !== d ? '<button id="rebase">Reset change markers</button>' : ''}</div>`
    ].join('')
    wire()
    highlight()
  }

  function verdict(d, overall, p) {
    const pos = Math.max(0, Math.min(100, 50 + (overall / 1.5) * 50))
    const off = COMBINED.map((k) => [k, dev(k, d)]).filter(([, v]) => Math.abs(v) >= 0.25).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    let text
    if (Math.abs(overall) < 0.25 && !off.length) text = `<b>On target</b> for a ${esc(p.name)}.`
    else {
      const dir = overall < 0 ? 'Simpler' : 'Denser'
      const why = off.slice(0, 2).map(([k, v]) => `${METRICS[k].name.toLowerCase()} ${v < 0 ? 'low' : 'high'}`).join(', ')
      text = `<b>${Math.abs(overall) < 0.25 ? 'Mixed' : dir}</b> than typical for a ${esc(p.name)}${why ? ` (${why})` : ''}.`
    }
    return `<div class="verdict">${text}</div>
      <div class="meter" title="Overall register: combined grade level, sentence length, density and nominalizations"><i style="left:${pos}%"></i></div>
      <div class="ends"><span>Conversational</span><span>Target</span><span>Overly dense</span></div>`
  }

  function gauge(k, d, base) {
    const m = METRICS[k]
    const [lo, hi] = m.range
    const at = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))
    const band = preset()[k]
    const v = d[k]
    const dv = R.deviation(v, band)
    const cls = Math.abs(dv) < 0.0001 ? 'ok' : dv < 0 ? 'simple' : 'dense'
    const change = base && base !== d && Math.abs(v - base[k]) > (hi - lo) / 400 ? `<span class="delta">${v > base[k] ? '▲' : '▼'} ${m.d(v, base[k]).replace('-', '')}</span>` : ''
    const heatable = k !== 'diversity'
    return `<div class="gauge" ${heatable ? `role="button" tabindex="0" data-heat="${k}" aria-pressed="${state.heat === k}"` : ''} title="${esc(m.hint)}">
      <span class="name">${m.name}</span><span class="val">${m.fmt(v, d)}${change}</span>
      <div class="track"><div class="band" style="left:${at(band[0])}%;width:${at(band[1]) - at(band[0])}%"></div><div class="dot ${cls}" style="left:${at(v)}%"></div></div>
    </div>`
  }

  function sectionMap() {
    const names = { combined: 'all measures', grade: 'grade level', sentenceLength: 'sentence length', density: 'lexical density', nominal: 'nominalizations' }
    const spans = result.sentences.map((s, i) => {
      const c = heatClass(heatOf(s))
      const col = !c ? 'transparent' : `color-mix(in srgb, var(--${c.startsWith('simple') ? 'simple' : 'dense'}) ${c.endsWith('2') ? 75 : 38}%, var(--bg))`
      return `<span data-s="${i}" style="background:${col}" title="${esc(tip(s))}"></span>`
    })
    return `<h3>Document map</h3>
      <div class="row" style="margin-bottom:5px"><span class="grow" style="color:var(--muted)">Highlighting by ${names[state.heat] || 'nothing'}</span>
        <select id="heat"><option value="combined">All measures</option><option value="grade">Grade level</option><option value="sentenceLength">Sentence length</option><option value="density">Lexical density</option><option value="nominal">Nominalizations</option><option value="off">Off</option></select></div>
      <div class="map" id="map">${spans.join('')}</div>
      <div class="legend"><span class="s">simpler than target</span><span class="d">denser than target</span></div>`
  }

  function sectionsTable() {
    if (result.sections.length < 2) return ''
    const cell = (k, s) => {
      const v = R.deviation(s[k], preset()[k])
      const c = Math.abs(v) < 0.25 ? '' : v < 0 ? 'cell-simple' : 'cell-dense'
      return `<td class="${c}">${k === 'density' ? Math.round(s[k] * 100) + '%' : s[k].toFixed(k === 'sentenceLength' ? 0 : 1)}</td>`
    }
    return `<h3>Sections</h3><table><tr><th>Section</th><th>Words</th><th>Grade</th><th>Len</th><th>Dens</th><th>Nom</th></tr>
      ${result.sections.map((s, i) => `<tr class="sec" data-sec="${i}"><td title="${esc(s.title)}">${esc(s.title)}</td><td>${s.stats.words}</td>${cell('grade', s.stats)}${cell('sentenceLength', s.stats)}${cell('density', s.stats)}${cell('nominal', s.stats)}</tr>`).join('')}</table>`
  }

  function flagsBox(d) {
    const per = (n) => (d.words ? ((1000 * n) / d.words).toFixed(0) : 0)
    const row = (k, label) => `<label><input type="checkbox" data-flag="${k}" ${state.flags[k] ? 'checked' : ''}><span class="sw ${k}"></span>${label}<span class="count">${d.flags[k]} · ${per(d.flags[k])}/1k</span></label>`
    return `<h3>Style flags</h3><div class="flags">
      ${row('passive', 'Passive voice')}${row('hedge', 'Hedges &amp; boosters')}${row('filler', 'Filler words')}</div>`
  }

  function worst() {
    const scored = result.sentences
      .filter((s) => s.own.words >= 6)
      .map((s) => {
        const g = dev('grade', s.own)
        const l = dev('sentenceLength', s.own)
        return { s, score: Math.abs(g) + Math.abs(l), dir: g + l }
      })
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
    if (!scored.length) return ''
    return `<h3>Furthest from target</h3><ol>${scored
      .map(({ s, dir }) => {
        const raw = doc.text.slice(s.from, s.to).replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?|[{}$%~]/g, ' ').replace(/\s+([.,;:?!])/g, '$1').replace(/\s+/g, ' ').trim()
        return `<li data-from="${s.from}" data-to="${s.to}"><div class="txt">${esc(raw)}</div><div class="why">${dir < 0 ? 'Simpler' : 'Denser'}: ${esc(tip(s))}</div></li>`
      })
      .join('')}</ol>`
  }

  function wire() {
    const heatSel = $('heat')
    if (heatSel) {
      heatSel.value = state.heat
      heatSel.onchange = () => { state.heat = heatSel.value; save(); render() }
    }
    for (const g of document.querySelectorAll('[data-heat]')) {
      const pick = () => { state.heat = state.heat === g.dataset.heat ? 'combined' : g.dataset.heat; save(); render() }
      g.onclick = pick
      g.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick())
    }
    for (const c of document.querySelectorAll('[data-flag]')) c.onchange = () => { state.flags[c.dataset.flag] = c.checked; save(); highlight() }
    const go = (from, to) => OpenTex.goTo(doc.file, from, to)
    $('map')?.addEventListener('click', (e) => {
      const s = result.sentences[Number(e.target.dataset?.s)]
      if (s) go(s.from, s.to)
    })
    for (const li of document.querySelectorAll('li[data-from]')) li.onclick = () => go(Number(li.dataset.from), Number(li.dataset.to))
    for (const tr of document.querySelectorAll('tr[data-sec]')) tr.onclick = () => { const s = result.sections[Number(tr.dataset.sec)]; go(s.from, s.from) }
    const rb = $('rebase')
    if (rb) rb.onclick = () => { baselines.set(doc.file, result.doc); render() }
  }
})()
