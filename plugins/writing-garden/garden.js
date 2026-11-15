// Writing Garden: a pixel windowsill where each day's writing grows a plant. Today's plant grows
// with the words you add (net, never below zero), past days rest on a shelf, and milestones bring
// rare plants. It is drawn on a tiny canvas scaled up by whole pixels, and only redrawn when
// something changes: no animation loop, and nothing at all while the panel is hidden.
;(function () {
  const cv = document.getElementById('garden')
  const g = cv.getContext('2d')
  const $ = (id) => document.getElementById(id)
  const scene = $('scene')
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------- Days ----------
  const pad = (n) => String(n).padStart(2, '0')
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const dayKey = () => keyOf(new Date())
  const parseDay = (k) => {
    const [y, m, d] = k.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const addDays = (k, n) => {
    const d = parseDay(k)
    d.setDate(d.getDate() + n)
    return keyOf(d)
  }
  const niceDay = (k) => parseDay(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const fmt = (n) => Math.round(n).toLocaleString()
  const hash = (s) => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return h >>> 0
  }
  const rngFrom = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // ---------- Saved data (one JSON value in plugin storage, on this computer only) ----------
  // days[day][project] = { n: net words added that day (may dip below 0; shown as 0), sp: 'species:variant' }
  // base[project \n file] = { w: last word count seen, d: the day it was seen }
  const data = { v: 1, days: {}, goal: 0, unlocked: {}, finished: {}, base: {} }
  let saveTimer = 0
  const saveNow = () => {
    clearTimeout(saveTimer)
    saveTimer = 0
    OpenTex.storage.set('garden', data)
  }
  const save = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, 1500)
  }
  addEventListener('pagehide', () => saveTimer && saveNow())

  const DEFAULT_GOAL = 750
  const goal = () => data.goal || DEFAULT_GOAL
  /** 0 = a seed; 1 = the first flower opens (the daily goal, or about 750 words without one); up to 1.6 for extra flowers. */
  const growth = (n) => (n <= 0 ? 0 : Math.min(1.6, Math.pow(n / goal(), 0.75)))
  const STAGES = [
    [1.35, 'In full bloom'],
    [1, 'In bloom'],
    [0.75, 'Budding'],
    [0.4, 'A young plant'],
    [0.15, 'A seedling'],
    [0.000001, 'A sprout'],
    [0, 'A seed, ready to sprout']
  ]
  const stageOf = (n) => STAGES.findIndex(([at]) => growth(n) >= at)

  const RARE = [
    { id: 'sunflower', icon: '🌻', name: 'Sunflower', how: '1,000 words in one paper', note: 'A sunflower! You have grown 1,000 words in this paper.' },
    { id: 'cactus', icon: '🌵', name: 'Moon cactus', how: '10,000 words in one paper', note: '10,000 words in this paper. A rare moon cactus has come to stay.' },
    { id: 'blossom', icon: '🌸', name: 'Seasonal blossom', how: 'Write 7 days in a row', note: 'Seven days in a row! A blossom tree joins your garden. It changes with the seasons.' },
    { id: 'laurel', icon: '🏅', name: 'Golden laurel', how: 'Mark a paper as finished', note: 'Paper finished! A golden laurel for your windowsill. Well done.' }
  ]

  let project = null // name of the open project ('' if none)
  const seen = new Set() // project+file keys seen since this panel opened

  const entry = (day, p) => data.days[day]?.[p]
  const wordsOn = (day, p) => Math.max(0, entry(day, p)?.n || 0)
  const wroteOn = (day) => Object.values(data.days[day] || {}).some((e) => e.n > 0)
  function totalFor(p) {
    let t = 0
    for (const day of Object.keys(data.days)) t += wordsOn(day, p)
    return t
  }
  /** Days in a row with some writing (any paper), counting today only once you've written. */
  function streak() {
    let k = dayKey()
    if (!wroteOn(k)) k = addDays(k, -1)
    let n = 0
    while (wroteOn(k)) {
      n++
      k = addDays(k, -1)
    }
    return n
  }
  function pickSpecies(p, day) {
    const h = hash(day + '\n' + p)
    const pool = ['leafy', 'leafy', 'tulip', ...RARE.map((r) => r.id).filter((id) => data.unlocked[id])]
    return `${pool[h % pool.length]}:${(h >>> 8) % 6}`
  }

  // ---------- Words ----------
  // Word counts come from OpenTex for the open file. Only changes within the same project and file
  // count, so switching files or projects never looks like writing.
  function onContext(c) {
    const p = c.project || ''
    const changed = p !== project
    project = p
    if (c.file && /\.tex$/i.test(c.file)) {
      const key = p + '\n' + c.file
      const w = Math.max(0, Math.round(Number(c.words) || 0))
      const today = dayKey()
      const b = data.base[key]
      data.base[key] = { w, d: today }
      // Seen earlier in this session: every change counts. Seen earlier today (before the panel was
      // opened or moved): what changed since then was written today too.
      if (b && (seen.has(key) || b.d === today) && w !== b.w) addWords(p, w - b.w)
      seen.add(key)
      save()
    }
    if (changed) {
      page = 0
      refresh()
    }
  }

  function addWords(p, delta) {
    const today = dayKey()
    const day = (data.days[today] ||= {})
    const e = (day[p] ||= { n: 0 })
    const before = Math.max(0, e.n)
    e.n += delta
    const after = Math.max(0, e.n)
    if (after > 0 && !e.sp) e.sp = pickSpecies(p, today)
    if (after > before) checkMilestones(p)
    if (p === project && after !== before) refresh(after > before ? (stageOf(after) < stageOf(before) ? 'grow' : 'sway') : '')
  }

  function checkMilestones(p) {
    const t = totalFor(p)
    if (t >= 1000) unlock('sunflower', p)
    if (t >= 10000) unlock('cactus', p)
    if (streak() >= 7) unlock('blossom', p)
  }

  function unlock(id, p) {
    if (data.unlocked[id]) return
    const today = dayKey()
    data.unlocked[id] = today
    const e = entry(today, p)
    if (e) e.sp = `${id}:0` // today's plant becomes the new one
    const r = RARE.find((x) => x.id === id)
    showNote(`${r.icon} ${r.note}`)
    save()
    refresh('grow')
  }

  // ---------- Colours ----------
  const probe = document.createElement('canvas').getContext('2d')
  function rgb(c) {
    probe.fillStyle = '#000'
    probe.fillStyle = (c || '').trim() || '#000'
    const s = probe.fillStyle
    if (s[0] === '#') return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
    const m = s.match(/[\d.]+/g)
    return m ? m.slice(0, 3).map(Number) : [0, 0, 0]
  }
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
  const WHITE = [255, 255, 255]
  const BLACK = [0, 0, 0]

  let theme = null
  let C = null
  function palette() {
    const s = getComputedStyle(document.documentElement)
    const v = (k) => rgb(s.getPropertyValue(k))
    const panel = v('--panel')
    const text = v('--text')
    const accent = v('--accent')
    const dark = theme ? !!theme.dark : lum(panel) < 0.45
    const wood = mix(dark ? [112, 80, 56] : [204, 158, 112], panel, 0.18)
    const pot = mix([198, 108, 66], accent, 0.16) // terracotta, tinted with the theme's accent
    const sky = dark ? ['#121a30', '#18223d', '#1f2b4b'] : ['#9ed0f0', '#b6dcf5', '#cfe8f9']
    return {
      dark,
      wall: hex(panel),
      frame: hex(dark ? mix(panel, text, 0.17) : mix(panel, WHITE, 0.7)),
      frameEdge: hex(mix(panel, text, dark ? 0.08 : 0.2)),
      sky: sky.map((c) => hex(mix(rgb(c), panel, 0.22))),
      star: dark ? '#e9edff' : '#ffffff',
      moon: '#f6efc4',
      woodTop: hex(mix(wood, WHITE, dark ? 0.12 : 0.25)),
      wood: hex(wood),
      woodDark: hex(mix(wood, BLACK, 0.25)),
      shadow: hex(mix(panel, BLACK, dark ? 0.35 : 0.18)),
      potLight: hex(mix(pot, WHITE, 0.25)),
      pot: hex(pot),
      potDark: hex(mix(pot, BLACK, 0.25)),
      soil: dark ? '#3b281c' : '#5a3b28',
      seed: '#a0703f',
      can: hex(mix([150, 172, 190], panel, 0.15)),
      canDark: hex(mix([110, 130, 150], panel, 0.15))
    }
  }

  const GREEN = { stem: '#3f8f36', mid: '#4faa3e', light: '#84d160', dark: '#2e7a2b' }
  const GOLD = { stem: '#9a7420', mid: '#d6a52a', light: '#f6d65e', dark: '#a87a14' }
  const CACTUS = { stem: '#4c9a5c', mid: '#5fae6e', light: '#93d69d', dark: '#3a7d4a' }
  const PETALS = [['#f8a5c2', '#d8577f'], ['#ffd95a', '#e0a82e'], ['#ffffff', '#cfd2e6'], ['#c2a8ec', '#8a6fc0'], ['#ff9b73', '#e0603c'], ['#8fd0fa', '#4b98d6']]
  const TULIPS = [['#ff7a7a', '#d63e4e'], ['#ffd95a', '#e09a2e'], ['#f8a5c2', '#d8577f'], ['#c9a2f2', '#9a6cd4'], ['#ffffff', '#d4d6e8'], ['#ffaa55', '#e07020']]

  // ---------- Drawing ----------
  let LW = 110 // scene size in art pixels
  let LH = 110
  let scale = 2 // CSS pixels per art pixel
  const rect = (x, y, w, h, c) => {
    g.fillStyle = c
    g.fillRect(x, y, w, h)
  }

  // Plants are drawn through P(), which leans the upper part of the plant by `sway` art pixels.
  let pb = 0
  let ph = 1
  let sway = 0
  function P(x, y, c) {
    const t = (pb - y) / ph
    const dx = sway && t > 0.3 ? Math.round(sway * Math.min(1, t) ** 1.5) : 0
    g.fillStyle = c
    g.fillRect(x + dx, y, 1, 1)
  }

  /** A leaf reaching out and a little up from the stem at (x, y); long leaves get a light top and a dark underside. */
  function leaf(x, y, side, L, pal) {
    for (let i = 1; i <= L; i++) {
      const yy = y - Math.round((i - 1) * 0.45)
      P(x + side * i, yy, i === L ? pal.light : pal.mid)
      if (L >= 3 && i > 1 && i < L) P(x + side * i, yy + 1, pal.dark)
      if (L >= 4 && i > 1 && i < L - 1) P(x + side * i, yy - 1, pal.light)
    }
  }

  function flower(x, y, r, petal, petalDark, center) {
    if (r <= 1) {
      P(x, y - 1, petal)
      P(x - 1, y, petal)
      P(x + 1, y, petal)
      P(x, y + 1, petalDark)
      P(x, y, center)
      return
    }
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const d = dx * dx + dy * dy
        if (d > 5) continue
        P(x + dx, y + dy, d === 0 ? center : dy > 0 && d > 2 ? petalDark : petal)
      }
    if (r >= 3) {
      // A bigger bloom: four rounded petals around the middle.
      for (const [dx, dy] of [[-3, -1], [-3, 0], [-3, 1], [3, -1], [3, 0], [3, 1], [-1, -3], [0, -3], [1, -3], [-1, 3], [0, 3], [1, 3]]) P(x + dx, y + dy, dy > 1 || dx > 2 ? petalDark : petal)
      P(x + 1, y, center)
      P(x, y + 1, center)
    }
  }

  function sprout(cx, base, h, pal) {
    for (let i = 1; i <= h; i++) P(cx, base - i, pal.stem)
    P(cx - 1, base - h, pal.light)
    P(cx + 1, base - h, pal.mid)
    if (h >= 3) P(cx - 2, base - h - 1, pal.light)
  }

  function leafy(cx, base, maxH, gr, rnd, pal, petals, big) {
    const gg = Math.min(1, gr)
    const h = Math.max(3, Math.round(maxH * (0.15 + 0.78 * gg)))
    ph = h
    const bend = rnd() < 0.5 ? -1 : 1
    const xAt = (dy) => cx + Math.round(bend * Math.sin((dy / h) * Math.PI) * (big ? 1.4 : 0.6))
    for (let dy = 0; dy < h; dy++) P(xAt(dy), base - 1 - dy, pal.stem)
    const gap = big ? 4 : 3
    let side = rnd() < 0.5 ? -1 : 1
    const tips = []
    for (let dy = big ? 3 : 2; dy < h - 2; dy += gap) {
      const t = dy / h
      const L = big ? Math.max(2, Math.round((6.5 - 3.5 * t) * (0.45 + 0.55 * gg))) : gg > 0.7 && dy === 2 ? 3 : gg > 0.25 && t < 0.75 ? 2 : 1
      leaf(xAt(dy), base - 1 - dy, side, L, pal)
      tips.push([xAt(dy) + side * L, base - 1 - dy - Math.floor((L - 1) / 2) - 1])
      side = -side
    }
    const tx = xAt(h - 1)
    const ty = base - h
    const [pl, pd] = petals
    const center = pl === '#ffd95a' ? '#9c5b2a' : '#f6c445'
    if (gr >= 1) {
      flower(tx, ty - (big ? 3 : 1), big ? 3 : 1, pl, pd, center)
      // Past the goal, more flowers open on the upper leaves.
      const extra = Math.min(tips.length, Math.floor((gr - 1) / (big ? 0.12 : 0.3)))
      for (let i = 0; i < extra; i++) {
        const [x, y] = tips[tips.length - 1 - i]
        flower(x, y, 1, pl, pd, center)
      }
    } else if (gr >= 0.75) {
      P(tx, ty - 1, pd)
      if (big) P(tx, ty - 2, pl)
      P(tx - 1, ty, pal.light)
      P(tx + 1, ty, pal.mid)
    } else {
      P(tx - 1, ty, pal.light)
      P(tx + 1, ty, pal.mid)
    }
  }

  function tulip(cx, base, maxH, gr, rnd, petals, big) {
    const gg = Math.min(1, gr)
    const h = Math.max(3, Math.round(maxH * (0.15 + 0.8 * gg)))
    ph = h
    for (let dy = 0; dy < h; dy++) P(cx, base - 1 - dy, GREEN.stem)
    // Two long blades from the soil.
    const bl = Math.max(2, Math.round(h * 0.55))
    const step = big ? 4 : 3
    for (let i = 0; i < bl; i++) {
      const o = 1 + Math.floor(i / step)
      const c = i > bl - 2 ? GREEN.light : GREEN.mid
      P(cx - o, base - 1 - i, c)
      if (i < bl - 2) P(cx + o, base - 1 - Math.round(i * 0.85), i > bl - 4 ? GREEN.light : GREEN.dark)
      if (big && i < bl - 3) P(cx - o - 1, base - 1 - i, GREEN.dark)
    }
    const [pl, pd] = petals
    const ty = base - h
    if (gr >= 1 && big) {
      // An open cup with a notched top.
      P(cx - 2, ty - 5, pl)
      P(cx, ty - 5, pl)
      P(cx + 2, ty - 5, pd)
      for (let r = 4; r >= 2; r--) for (let dx = -2; dx <= 2; dx++) P(cx + dx, ty - r, dx < 0 ? pl : dx > 0 ? pd : pl)
      for (let dx = -1; dx <= 1; dx++) P(cx + dx, ty - 1, pd)
      if (gr >= 1.3) {
        P(cx - 3, ty - 4, pl)
        P(cx + 3, ty - 4, pd)
      }
    } else if (gr >= 1) {
      P(cx - 1, ty - 3, pl)
      P(cx + 1, ty - 3, pl)
      for (let dx = -1; dx <= 1; dx++) P(cx + dx, ty - 2, dx > 0 ? pd : pl)
      P(cx, ty - 1, pd)
    } else if (gr >= 0.75) {
      P(cx, ty - 1, pd)
      P(cx, ty - 2, pl)
      if (big) {
        P(cx - 1, ty - 1, GREEN.mid)
        P(cx + 1, ty - 1, GREEN.dark)
        P(cx, ty - 3, pl)
      }
    }
  }

  function sunflower(cx, base, maxH, gr, rnd, big) {
    const gg = Math.min(1, gr)
    const h = Math.max(3, Math.round(maxH * (0.18 + 0.82 * gg)))
    ph = h
    const w = big && gg > 0.4 ? 2 : 1
    for (let dy = 0; dy < h; dy++) for (let i = 0; i < w; i++) P(cx + i, base - 1 - dy, GREEN.stem)
    let side = -1
    for (let dy = big ? 4 : 2; dy < h - 3; dy += big ? 6 : 4) {
      leaf(side < 0 ? cx : cx + w - 1, base - 1 - dy, side, big ? Math.max(3, Math.round(5 * (0.5 + 0.5 * gg))) : 2, GREEN)
      side = -side
    }
    const ty = base - h
    if (gr >= 1) {
      const R = big ? 10.5 : 2.5
      const r = big ? 2.5 : 0.5
      const o = big ? 3 : 1
      const fx = cx + (w - 1) / 2
      for (let dy = -o - 1; dy <= o + 1; dy++)
        for (let dx = -o - 1; dx <= o + 1; dx++) {
          const d = dx * dx + dy * dy
          if (d > R) continue
          const x = Math.round(fx + dx)
          if (d <= r) P(x, ty - o + dy, dy > 0 ? '#5a3416' : '#7a4a22')
          else P(x, ty - o + dy, (dx + dy) & 1 ? '#ffd23f' : '#f3b51f')
        }
    } else if (gr >= 0.75) {
      P(cx, ty - 1, GREEN.mid)
      P(cx - 1, ty - 1, '#f3b51f')
      P(cx + w, ty - 1, '#f3b51f')
      P(cx, ty - 2, '#ffd23f')
    } else {
      P(cx - 1, ty, GREEN.light)
      P(cx + w, ty, GREEN.mid)
    }
  }

  function cactus(cx, base, maxH, gr, rnd, big) {
    const gg = Math.min(1, gr)
    const h = Math.max(2, Math.round(maxH * 0.72 * (0.2 + 0.8 * gg)))
    ph = h + 3
    const hw = big ? 2 : 1 // half width
    for (let dy = 0; dy < h; dy++)
      for (let dx = -hw; dx <= hw; dx++) {
        if (dy === h - 1 && Math.abs(dx) === hw) continue // rounded top
        const spine = (dy + dx * 2) % 3 === 0 && dx !== 0
        P(cx + dx, base - 1 - dy, spine ? CACTUS.light : dx < 0 ? CACTUS.mid : dx > 0 ? CACTUS.dark : CACTUS.mid)
      }
    // Arms.
    const arms = big ? [[-1, 0.4, 0.4], [1, 0.6, 0.6]] : [[-1, 0.45, 0.5]]
    for (const [s, at, need] of arms) {
      if (gg < need) continue
      const y = base - 1 - Math.round(h * at)
      const len = big ? 3 : 1
      for (let i = 1; i <= len; i++) P(cx + s * (hw + i), y, CACTUS.mid)
      const up = big ? 4 : 2
      for (let j = 1; j <= up; j++) {
        P(cx + s * (hw + len), y - j, s < 0 ? CACTUS.light : CACTUS.dark)
        if (big) P(cx + s * (hw + len - 1), y - j, CACTUS.mid)
      }
      if (gr >= 1.2) P(cx + s * (hw + len), y - up - 1, '#ff7eb6')
    }
    const ty = base - h
    if (gr >= 1) {
      for (let dx = -1; dx <= 1; dx++) P(cx + dx, ty - 1, dx ? '#ff7eb6' : '#ffd23f')
      P(cx, ty - 2, '#ff9fc9')
      if (big) {
        P(cx - 2, ty - 2, '#ff7eb6')
        P(cx + 2, ty - 2, '#e0569a')
        P(cx, ty - 3, '#ff7eb6')
      }
    } else if (gr >= 0.75) P(cx, ty - 1, '#ff9fc9')
  }

  function season(day) {
    const m = parseDay(day).getMonth()
    return m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'autumn' : 'winter'
  }
  const CANOPY = {
    spring: { leaf: ['#5cb85c', '#8ad46a', '#3c8f3f'], dots: ['#ffc0dc', '#f78fb8'] },
    summer: { leaf: ['#3f9c3a', '#62bf4f', '#2c7a2c'], dots: ['#ffffff', '#fff2a8'] },
    autumn: { leaf: ['#e07b2a', '#f3b437', '#b8501f'], dots: ['#c43d24', '#f6d05a'] },
    winter: { leaf: ['#3f7a55', '#5a9670', '#2d5c40'], dots: ['#e0484a', '#ffffff'] }
  }
  function blossom(cx, base, maxH, gr, rnd, big, day) {
    const gg = Math.min(1, gr)
    const sz = season(day)
    const k = CANOPY[sz]
    const h = Math.max(4, Math.round(maxH * (0.25 + 0.75 * gg)))
    ph = h
    const r = Math.max(1, Math.round(h * (big ? 0.3 : 0.32)))
    const th = h - r * 2 + 1
    const tw = big && gg > 0.4 ? 2 : 1
    for (let dy = 0; dy < th; dy++) for (let i = 0; i < tw; i++) P(cx + i - (tw > 1 ? 1 : 0), base - 1 - dy, i ? '#5e3d22' : '#7a5230')
    const cy = base - th - r
    const dots = gr >= 0.75 ? (gr >= 1 ? 0.3 : 0.12) * Math.min(1.6, gr) : 0
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r * 0.7) continue
        let c = dy < -r / 3 && dx < r / 3 ? k.leaf[1] : dy > r / 3 || dx > r / 2 ? k.leaf[2] : k.leaf[0]
        if (sz === 'winter' && dy <= -r + 1 && dx * dx + dy * dy <= r * r) c = '#ffffff'
        else if (dots && rnd() < dots) c = rnd() < 0.6 ? k.dots[0] : k.dots[1]
        P(cx + dx, cy + dy, c)
      }
  }

  function laurel(cx, base, maxH, gr, rnd, big) {
    leafy(cx, base, maxH, gr, rnd, GOLD, ['#ffffff', '#f0dfa0'], big)
    if (gr >= 1) {
      const top = base - ph
      const pts = big ? [[-5, 4], [5, 1], [-3, -3], [4, 9]] : [[-3, 1], [3, 3]]
      for (const [dx, dy] of pts) P(cx + dx, top + dy, '#fff6c0')
    }
  }

  /** Draws a plant whose soil line is at `base`, at most `maxH` art pixels tall. */
  function plant(spec, day, project, cx, base, maxH, gr, big) {
    const rnd = rngFrom(hash(day + project))
    const [kind, vs] = (spec || 'leafy:0').split(':')
    const v = Number(vs) || 0
    pb = base
    ph = maxH
    if (gr <= 0) {
      P(cx, base - 1, C.seed) // a seed waiting in the soil
      if (big) P(cx + 1, base - 1, C.soil)
      return
    }
    if (gr < 0.15 && kind !== 'cactus') return sprout(cx, base, Math.max(1, Math.round((gr / 0.15) * (big ? 5 : 3))), kind === 'laurel' ? GOLD : GREEN)
    if (kind === 'tulip') tulip(cx, base, maxH, gr, rnd, TULIPS[v % TULIPS.length], big)
    else if (kind === 'sunflower') sunflower(cx, base, maxH, gr, rnd, big)
    else if (kind === 'cactus') cactus(cx, base, maxH, gr, rnd, big)
    else if (kind === 'blossom') blossom(cx, base, maxH, gr, rnd, big, day)
    else if (kind === 'laurel') laurel(cx, base, maxH, gr, rnd, big)
    else leafy(cx, base, maxH, gr, rnd, GREEN, PETALS[v % PETALS.length], big)
  }

  /** A pot standing on `y` (its bottom). Returns the soil line. */
  function pot(cx, y, big) {
    const rimW = big ? 20 : 9
    const rimH = big ? 3 : 2
    const bodyH = big ? 11 : 5
    const top = y - rimH - bodyH
    for (let r = 0; r < bodyH; r++) {
      const w = Math.round((big ? 16 : 7) - ((big ? 4 : 2) * r) / (bodyH - 1))
      const x0 = cx - Math.floor(w / 2)
      rect(x0, top + rimH + r, w, 1, C.pot)
      rect(x0, top + rimH + r, 1, 1, C.potLight)
      rect(x0 + w - (big ? 3 : 1), top + rimH + r, big ? 3 : 1, 1, C.potDark)
    }
    const x0 = cx - Math.floor(rimW / 2)
    rect(x0, top, rimW, rimH, C.pot)
    rect(x0, top, rimW, 1, C.potLight)
    rect(x0, top + rimH - 1, rimW, 1, C.potDark)
    rect(x0 + 1, top, rimW - 2, 1, C.soil)
    return top
  }

  // Scene layout in art pixels (set by fit()).
  let sillTop = 0
  let shelfY = 0
  let slots = 0
  let slotW = 13
  let shelfX0 = 0
  let stars = []

  function fit() {
    sillTop = LH - 7
    shelfY = 27
    slotW = 13
    slots = Math.max(1, Math.min(14, Math.floor((LW - 12) / slotW)))
    shelfX0 = Math.floor((LW - slots * slotW) / 2)
    const rnd = rngFrom(hash('stars' + LW + 'x' + LH))
    stars = []
    for (let i = 0; i < Math.round((LW * sillTop) / 260); i++) stars.push([6 + Math.floor(rnd() * (LW - 12)), 6 + Math.floor(rnd() * (sillTop - 10)), rnd() < 0.12])
  }

  function background() {
    rect(0, 0, LW, LH, C.wall)
    // Window: frame, sky in three dithered bands, and a centre bar.
    const x0 = 4
    const x1 = LW - 4
    const y0 = 3
    const y1 = sillTop
    rect(x0, y0, x1 - x0, y1 - y0, C.frame)
    rect(x0, y1 - 1, x1 - x0, 1, C.frameEdge)
    const gx0 = x0 + 3
    const gy0 = y0 + 3
    const gw = x1 - x0 - 6
    const gh = y1 - y0 - 3
    const b1 = gy0 + Math.round(gh * 0.35)
    const b2 = gy0 + Math.round(gh * 0.7)
    rect(gx0, gy0, gw, b1 - gy0, C.sky[0])
    rect(gx0, b1, gw, b2 - b1, C.sky[1])
    rect(gx0, b2, gw, gy0 + gh - b2, C.sky[2])
    for (let x = gx0 + 1; x < gx0 + gw - 1; x += 2) {
      rect(x + (b1 & 1), b1, 1, 1, C.sky[0])
      rect(x + (b2 & 1), b2, 1, 1, C.sky[1])
    }
    if (C.dark) {
      for (const [x, y, big] of stars) {
        if (x < gx0 || x >= gx0 + gw || y < gy0 || y >= gy0 + gh) continue
        rect(x, y, 1, 1, C.star)
        if (big) {
          rect(x - 1, y, 3, 1, C.star)
          rect(x, y - 1, 1, 3, C.star)
        }
      }
      // A crescent moon in the top corner.
      const mx = gx0 + gw - 9
      const my = shelfY + 12
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 10 && (dx - 1.5) ** 2 + (dy + 1) ** 2 > 6) rect(mx + dx, my + dy, 1, 1, C.moon)
    } else {
      // Two small clouds.
      const cloud = (x, y) => {
        rect(x + 1, y, 4, 1, C.star)
        rect(x, y + 1, 8, 1, C.star)
        rect(x + 4, y - 1, 2, 1, C.star)
      }
      cloud(gx0 + Math.round(gw * 0.12), gy0 + 5)
      cloud(gx0 + Math.round(gw * 0.66), gy0 + Math.round(gh * 0.42))
    }
    const mid = Math.floor(LW / 2) - 1
    rect(mid, y0, 2, y1 - y0, C.frame)
    rect(x0, y0, x1 - x0, 1, C.frameEdge)
  }

  function shelf(hist) {
    const x0 = 5
    const x1 = LW - 5
    rect(x0, shelfY, x1 - x0, 1, C.woodTop)
    rect(x0, shelfY + 1, x1 - x0, 2, C.wood)
    rect(x0, shelfY + 3, x1 - x0, 1, C.shadow)
    for (const bx of [x0 + 4, x1 - 7]) {
      rect(bx, shelfY + 3, 3, 1, C.woodDark)
      rect(bx + 1, shelfY + 4, 2, 1, C.woodDark)
      rect(bx + 2, shelfY + 5, 1, 1, C.woodDark)
    }
    const items = hist.slice(page * slots, page * slots + slots).reverse() // oldest on the left
    items.forEach((day, i) => {
      const cx = shelfX0 + i * slotW + Math.floor(slotW / 2)
      const soil = pot(cx, shelfY, false)
      const e = entry(day, project)
      plant(e.sp, day, project, cx, soil, Math.min(14, soil - 5), growth(e.n), false)
    })
  }

  function sill() {
    rect(0, sillTop, LW, 2, C.woodTop)
    rect(0, sillTop + 2, LW, LH - sillTop - 2, C.wood)
    rect(0, LH - 1, LW, 1, C.woodDark)
  }

  function rosette(x, y) {
    // A little golden medal on the sill: this paper is finished.
    rect(x - 1, y - 2, 1, 3, '#d94848')
    rect(x + 1, y - 2, 1, 3, '#b83a3a')
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 5) rect(x + dx, y - 6 + dy, 1, 1, dx + dy < 0 ? '#ffe27a' : '#e0a92a')
    rect(x, y - 6, 1, 1, '#fff6c0')
  }

  function wateringCan(x, y) {
    rect(x, y - 5, 6, 5, C.can)
    rect(x + 5, y - 5, 1, 5, C.canDark)
    rect(x + 1, y - 7, 4, 1, C.canDark)
    rect(x, y - 6, 1, 1, C.canDark)
    rect(x + 5, y - 6, 1, 1, C.canDark)
    rect(x - 1, y - 4, 1, 1, C.canDark)
    rect(x - 2, y - 5, 1, 1, C.canDark)
    rect(x - 3, y - 6, 2, 1, C.can)
  }

  // ---------- Frames: only when something changes ----------
  let page = 0
  let dirty = true
  let burst = 0
  let burstKind = ''
  let frameNo = 0
  let burstTimer = 0
  const showing = () => !document.hidden && innerWidth > 0 && innerHeight > 0 && scene.clientWidth > 0

  function history() {
    const today = dayKey()
    return Object.keys(data.days)
      .filter((k) => k < today && (entry(k, project)?.n || 0) > 0)
      .sort()
      .reverse()
  }

  function draw() {
    if (!showing()) {
      dirty = true
      return
    }
    dirty = false
    C ||= palette()
    background()
    const hist = history()
    page = Math.max(0, Math.min(page, Math.ceil(hist.length / slots) - 1))
    shelf(hist)
    sill()
    const today = dayKey()
    const cx = Math.floor(LW / 2)
    const e = entry(today, project)
    const n = Math.max(0, e?.n || 0)
    rect(cx - 10, sillTop, 21, 1, C.shadow)
    const soil = pot(cx, sillTop, true)
    const maxH = Math.min(84, soil - shelfY - 10)
    sway = burst > 0 && !reduceMotion ? [0, 1, 1, 0, -1, -1][frameNo % 6] * (maxH > 40 ? 2 : 1) : 0
    plant(e?.sp || pickSpecies(project, today), today, project, cx, soil, maxH, growth(n), true)
    sway = 0
    if (burst > 0 && burstKind === 'grow') {
      // A few twinkles around the plant while it grows a stage.
      const rnd = rngFrom(frameNo * 7919)
      for (let i = 0; i < 4; i++) {
        const x = cx + Math.round((rnd() - 0.5) * 30)
        const y = soil - 4 - Math.round(rnd() * Math.max(8, maxH * Math.min(1, growth(n))))
        rect(x, y, 1, 1, '#fff7b0')
        if (rnd() < 0.5) {
          rect(x - 1, y, 3, 1, '#fff7b0')
          rect(x, y - 1, 1, 3, '#fff7b0')
        }
      }
    }
    if (data.finished[project]) rosette(cx - 17, sillTop)
    if (LW >= 120) wateringCan(cx + 17, sillTop)
    pager(hist)
  }

  function step() {
    burstTimer = 0
    frameNo++
    burst = showing() ? burst - 1 : 0
    draw()
    if (burst > 0) burstTimer = setTimeout(step, 200) // 5 frames a second, for a couple of seconds
    else burstKind = ''
  }

  /** Redraw and update the text; kind 'sway' or 'grow' adds a short burst of movement. */
  function refresh(kind) {
    text()
    if (kind && !reduceMotion && showing()) {
      burst = Math.max(burst, kind === 'grow' ? 14 : 6)
      if (kind === 'grow' || !burstKind) burstKind = kind
      if (!burstTimer) step()
      return
    }
    if (!burstTimer) draw()
  }

  // ---------- Words and settings text ----------
  let lastText = ''
  function text() {
    const today = dayKey()
    const n = wordsOn(today, project)
    const gr = growth(n)
    const stage = STAGES[stageOf(n)][1]
    let line2 = stage
    if (data.goal) line2 += gr >= 1 ? ' · goal reached' : ` · ${Math.floor((n / data.goal) * 100)}% of your ${fmt(data.goal)}-word goal`
    else if (n === 0) line2 = 'A seed, ready to sprout when you write'
    const s = streak()
    const total = totalFor(project)
    const parts = []
    if (data.finished[project]) parts.push('Paper finished!')
    if (s >= 2) parts.push(`${s} days in a row`)
    if (total) parts.push(`${fmt(total)} in this paper`)
    if (!parts.length) parts.push(project === null ? 'Open a paper to start your garden.' : 'Each day you write, a plant joins the shelf.')
    const words = `<b>${fmt(n)}</b> ${n === 1 ? 'word' : 'words'} today`
    const key = words + line2 + parts.join()
    if (key === lastText) return
    lastText = key
    $('words').innerHTML = words
    $('stage').textContent = line2
    $('streak').textContent = parts.join(' · ')
    cv.setAttribute('aria-label', `Writing garden. Today: ${fmt(n)} words, ${stage.toLowerCase()}.`)
  }

  // ---------- Shelf paging and hover ----------
  const older = $('older')
  const newer = $('newer')
  function pager(hist) {
    const more = hist.length > slots
    older.classList.toggle('show', more && (page + 1) * slots < hist.length)
    newer.classList.toggle('show', more && page > 0)
    if (!more) return
    // Just under the shelf, inside the brackets.
    older.style.left = `${cv.offsetLeft + 10 * scale}px`
    newer.style.left = `${cv.offsetLeft + (LW - 10) * scale - 18}px`
    older.style.top = newer.style.top = `${cv.offsetTop + (shelfY + 5) * scale}px`
  }
  older.onclick = () => {
    page++
    draw()
  }
  newer.onclick = () => {
    page = Math.max(0, page - 1)
    draw()
  }

  cv.addEventListener('mousemove', (ev) => {
    const x = ev.offsetX / scale
    const y = ev.offsetY / scale
    let tip = ''
    if (y < shelfY + 2 && y > shelfY - 26) {
      const hist = history()
      const items = hist.slice(page * slots, page * slots + slots).reverse()
      const i = Math.floor((x - shelfX0) / slotW)
      const day = items[i]
      if (day) tip = `${niceDay(day)} · ${fmt(wordsOn(day, project))} words`
    } else if (y > shelfY + 6 && Math.abs(x - LW / 2) < 14) tip = `Today · ${fmt(wordsOn(dayKey(), project))} words`
    if (cv.title !== tip) cv.title = tip
  })

  // ---------- Unlock note ----------
  // Shown one after another if two arrive together; kept for later if the panel is hidden.
  const note = $('note')
  const notes = []
  let noteTimer = 0
  function showNote(msg) {
    if (msg) notes.push(msg)
    if (noteTimer || !notes.length || !showing()) return
    note.textContent = notes.shift()
    note.classList.add('show')
    noteTimer = setTimeout(hideNote, 8000)
  }
  function hideNote() {
    clearTimeout(noteTimer)
    note.classList.remove('show')
    noteTimer = notes.length ? setTimeout(() => ((noteTimer = 0), showNote()), 700) : 0
  }
  note.onclick = hideNote

  // ---------- Settings popover ----------
  const pop = $('pop')
  const gear = $('gear')
  function showSettings() {
    $('goal-on').checked = !!data.goal
    $('goal').value = data.goal || 500
    $('goal').disabled = !data.goal
    $('finished').checked = !!data.finished[project]
    $('finished').disabled = !project
    $('finished-label').textContent = project ? `“${project}” is finished` : 'Open a paper to mark it finished'
    $('rare').innerHTML = ''
    for (const r of RARE) {
      const li = document.createElement('li')
      const got = data.unlocked[r.id]
      li.className = got ? '' : 'locked'
      li.textContent = got ? `${r.icon} ${r.name}, since ${niceDay(got)}` : `· ${r.name}: ${r.how}`
      $('rare').appendChild(li)
    }
  }
  function setPop(open) {
    if (open) showSettings()
    pop.classList.toggle('show', open)
    gear.setAttribute('aria-expanded', String(open))
  }
  gear.onclick = () => setPop(!pop.classList.contains('show'))
  document.addEventListener('pointerdown', (e) => {
    if (pop.classList.contains('show') && !pop.contains(e.target) && !gear.contains(e.target)) setPop(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setPop(false)
  })
  const setGoal = () => {
    const on = $('goal-on').checked
    $('goal').disabled = !on
    data.goal = on ? Math.max(50, Math.min(20000, Math.round(Number($('goal').value) || 500))) : 0
    if (on) $('goal').value = data.goal
    save()
    refresh()
  }
  $('goal-on').onchange = setGoal
  $('goal').onchange = setGoal
  $('finished').onchange = () => {
    if (!project) return
    if ($('finished').checked) {
      data.finished[project] = dayKey()
      unlock('laurel', project)
    } else delete data.finished[project]
    save()
    refresh()
    showSettings()
  }

  // ---------- Size, visibility and the day changing ----------
  function layout() {
    const cw = scene.clientWidth
    const ch = scene.clientHeight
    if (!cw || !ch) {
      dirty = true
      return
    }
    // Whole device pixels per art pixel keeps the pixels crisp; the scene is about 105 art pixels across.
    const dpr = devicePixelRatio || 1
    const dev = Math.max(2, Math.min(8, Math.floor(Math.min((cw * dpr) / 105, (ch * dpr) / 96))))
    scale = dev / dpr
    LW = Math.max(80, Math.floor(cw / scale))
    LH = Math.max(80, Math.min(Math.floor(ch / scale), Math.round(LW * 1.15), 170))
    cv.width = LW
    cv.height = LH
    cv.style.width = `${LW * scale}px`
    cv.style.height = `${LH * scale}px`
    fit()
    draw()
    showNote()
  }
  let resizeTimer = 0
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(layout, 80)
  }).observe(scene)
  document.addEventListener('visibilitychange', () => {
    if (!showing()) return
    showNote()
    if (dirty) layout()
    text()
  })
  function atMidnight() {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
    setTimeout(() => {
      page = 0
      refresh()
      atMidnight()
    }, next - now)
  }

  OpenTex.onTheme((t) => {
    theme = t
    C = null
    draw()
  })
  OpenTex.storage.get('garden').then((saved) => {
    if (saved && typeof saved === 'object') {
      for (const k of ['days', 'unlocked', 'finished', 'base']) if (saved[k] && typeof saved[k] === 'object') data[k] = saved[k]
      data.goal = Math.max(0, Number(saved.goal) || 0)
    }
    // Forget word counts of files not seen for a month.
    const old = addDays(dayKey(), -30)
    for (const [k, b] of Object.entries(data.base)) if (!b || b.d < old) delete data.base[k]
    OpenTex.onContext(onContext)
    if (project === null) refresh()
    atMidnight()
  })
  layout()
  text()
})()
