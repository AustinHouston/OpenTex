// Forest Timer: a Pomodoro timer whose pixel forest grows across the focus sessions of a cycle,
// turns to autumn during short breaks and to winter during the long break, then starts a new spring.
;(function () {
  const W = 96
  const H = 60
  const GROUND = 46
  const cv = document.getElementById('scene')
  const g = cv.getContext('2d')
  const $ = (id) => document.getElementById(id)

  // ---------- Timer state ----------
  const cfg = { focus: 25, short: 5, long: 15, cycles: 4, autoFocus: false }
  const st = { phase: 'focus', done: 0, running: false, endsAt: 0, remaining: 25 * 60e3, phaseStart: Date.now(), today: 0, day: '' }
  const minutes = (p) => (p === 'focus' ? cfg.focus : p === 'short' ? cfg.short : cfg.long) * 60e3
  const todayKey = () => new Date().toDateString()
  const save = () => {
    OpenTex.storage.set('cfg', cfg)
    OpenTex.storage.set('state', st)
  }

  function remaining() {
    return st.running ? Math.max(0, st.endsAt - Date.now()) : st.remaining
  }
  function start() {
    st.running = true
    st.endsAt = Date.now() + st.remaining
    save()
  }
  function pause() {
    st.remaining = remaining()
    st.running = false
    save()
  }
  function setPhase(p, autoStart) {
    st.phase = p
    st.phaseStart = Date.now()
    st.remaining = minutes(p)
    st.running = false
    if (autoStart) start()
    save()
  }
  function finishPhase(fromTimer) {
    if (st.phase === 'focus') {
      st.done += 1
      if (st.day !== todayKey()) {
        st.day = todayKey()
        st.today = 0
      }
      st.today += 1
      const long = st.done >= cfg.cycles
      if (fromTimer) {
        chime()
        OpenTex.notify(long ? 'Time for a long break' : 'Time for a short break', long ? 'The forest is resting for winter.' : 'Autumn leaves are falling. Stretch a little.')
      }
      setPhase(long ? 'long' : 'short', true)
    } else {
      if (st.phase === 'long') st.done = 0 // a new spring
      if (fromTimer) {
        chime()
        OpenTex.notify('Break is over', 'Back to writing. Your forest is waiting to grow.')
      }
      setPhase('focus', cfg.autoFocus)
    }
  }
  function resetCycle() {
    st.done = 0
    setPhase('focus', false)
  }

  let audio = null
  function chime() {
    try {
      audio = audio || new AudioContext()
      ;[523.25, 659.25, 783.99].forEach((f, i) => {
        const o = audio.createOscillator()
        const v = audio.createGain()
        o.type = 'triangle'
        o.frequency.value = f
        const t = audio.currentTime + i * 0.16
        v.gain.setValueAtTime(0.0001, t)
        v.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
        v.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
        o.connect(v).connect(audio.destination)
        o.start(t)
        o.stop(t + 0.65)
      })
    } catch {
      /* sound is optional */
    }
  }

  // ---------- Forest ----------
  // Fixed layout: back row (small, higher) and front row (larger, lower). `at` is when each tree sprouts (0..1).
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const trees = []
  for (let i = 0; i < 14; i++) {
    const back = i % 2 === 0
    trees.push({
      x: 5 + ((i * 6.6 + rand() * 4) % 88),
      base: back ? GROUND - 3 : GROUND + 4 + Math.floor(rand() * 4),
      scale: back ? 0.65 + rand() * 0.15 : 0.9 + rand() * 0.25,
      pine: rand() < 0.35,
      at: 0,
      hue: Math.floor(rand() * 3)
    })
  }
  const order = trees.map((_, i) => i).sort(() => rand() - 0.5)
  order.forEach((ti, k) => (trees[ti].at = (k / trees.length) * 0.85))
  trees.sort((a, b) => a.base - b.base) // draw back to front

  const PAL = {
    summer: { sky: ['#8fd3ff', '#bfe8ff', '#e5f7ff'], hill: '#7cbf6a', ground: '#5fae4f', groundDark: '#4b9440', leaf: [['#3f9c3a', '#57b84a', '#2f7d2c'], ['#4aa63f', '#6cc957', '#367f2e'], ['#38913f', '#4fb35a', '#2a7531']], pine: ['#2f7d4a', '#3f9a5c', '#245f39'], trunk: '#7a5230' },
    autumn: { sky: ['#ffc98f', '#ffe0b3', '#fff1dc'], hill: '#c79a52', ground: '#b8923f', groundDark: '#9a7a33', leaf: [['#e2722b', '#f39a45', '#b8531c'], ['#d94a2b', '#ef7151', '#a8361f'], ['#e8b030', '#f6d05a', '#c48a1e']], pine: ['#3d7346', '#4f8d58', '#2c5935'], trunk: '#6e4627' },
    winter: { sky: ['#b8c7d9', '#d3deea', '#eef3f8'], hill: '#e6edf4', ground: '#f4f8fb', groundDark: '#d9e3ec', leaf: null, pine: ['#3a6650', '#4b7d63', '#2c4f3e'], trunk: '#5b4030' }
  }
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const mix = (a, b, t) => {
    const x = hex(a)
    const y = hex(b)
    return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`
  }
  const px = (x, y, c) => {
    g.fillStyle = c
    g.fillRect(Math.round(x), Math.round(y), 1, 1)
  }

  function season() {
    return st.phase === 'focus' ? 'summer' : st.phase === 'short' ? 'autumn' : 'winter'
  }

  function drawTree(t, growth, pal, s, fade) {
    const size = Math.max(0, Math.min(1, (growth - t.at) / 0.22))
    if (size <= 0) return
    const x = Math.round(t.x)
    const y = t.base
    if (size < 0.12) {
      px(x, y - 1, pal.leaf ? pal.leaf[t.hue][1] : '#7da36a') // sprout
      return
    }
    const k = t.scale * (0.35 + 0.65 * size)
    const trunkH = Math.max(2, Math.round(7 * k))
    g.fillStyle = pal.trunk
    g.fillRect(x, y - trunkH, k > 0.8 ? 2 : 1, trunkH)
    if (t.pine) {
      const [mid, light, dark] = pal.pine
      const layers = Math.max(2, Math.round(4 * k))
      const top = y - trunkH - Math.round(11 * k)
      for (let l = 0; l < layers; l++) {
        const ly = top + Math.round((l * 11 * k) / layers)
        const half = Math.round(1 + ((l + 1) * 4.2 * k) / layers)
        const rows = Math.max(2, Math.round((11 * k) / layers) + 1)
        for (let r = 0; r < rows; r++) {
          const w = Math.round((half * (r + 1)) / rows)
          for (let dx = -w; dx <= w; dx++) {
            const c = dx < -w / 3 ? light : dx > w / 3 ? dark : mid
            px(x + dx, ly + r, c)
            if (s === 'winter' && r === 0) px(x + dx, ly + r, '#ffffff')
          }
        }
      }
      return
    }
    const r = Math.max(1, Math.round(4.6 * k))
    const cy = y - trunkH - r + 1
    if (!pal.leaf) {
      // Winter: bare branches with a little snow.
      for (let i = 1; i <= r; i++) {
        px(x - i, cy + r - i, pal.trunk)
        px(x + i + (k > 0.8 ? 1 : 0), cy + r - i, pal.trunk)
        if (i === r) {
          px(x - i, cy + r - i - 1, '#ffffff')
          px(x + i + (k > 0.8 ? 1 : 0), cy + r - i - 1, '#ffffff')
        }
      }
      g.fillStyle = pal.trunk
      g.fillRect(x, cy, 1, r)
      px(x, cy - 1, '#ffffff')
      return
    }
    const [mid, light, dark] = pal.leaf[t.hue]
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r * 0.6) continue
        // Autumn trees thin out as the break goes on.
        if (s === 'autumn' && fade > 0 && ((dx * 7 + dy * 13 + t.hue * 5) & 7) < fade * 5) continue
        const c = dy < -r / 3 && dx < r / 3 ? light : dy > r / 3 || dx > r / 2 ? dark : mid
        px(x + dx + (k > 0.8 ? 0.5 : 0), cy + dy, c)
      }
    }
  }

  const particles = []
  function spawnParticles(s, growth) {
    if (s === 'winter' && particles.length < 40 && Math.random() < 0.5) particles.push({ x: Math.random() * W, y: -1, vx: (Math.random() - 0.5) * 0.08, vy: 0.12 + Math.random() * 0.12, c: '#ffffff', sway: Math.random() * 6 })
    if (s === 'autumn' && particles.length < 25 && Math.random() < 0.18) {
      const grown = trees.filter((t) => !t.pine && growth - t.at > 0.1)
      const t = grown[Math.floor(Math.random() * grown.length)]
      if (t) particles.push({ x: t.x + (Math.random() - 0.5) * 6, y: t.base - 12 * t.scale, vx: 0.05, vy: 0.08 + Math.random() * 0.06, c: PAL.autumn.leaf[t.hue][Math.floor(Math.random() * 2)], sway: Math.random() * 6 })
    }
  }

  function draw() {
    const s = season()
    const pal = PAL[s]
    const p = st.phase === 'focus' ? 1 - remaining() / minutes('focus') : 0
    const growth = st.phase === 'focus' ? (st.done + p) / cfg.cycles : st.done === 0 && st.phase === 'long' ? 1 : st.done / cfg.cycles
    const brk = st.phase === 'focus' ? 0 : 1 - remaining() / minutes(st.phase)
    // Sky: three bands with a dithered edge, brightening from early spring to summer during focus.
    for (let y = 0; y < GROUND; y++) {
      const band = y < 14 ? 0 : y < 30 ? 1 : 2
      for (let x = 0; x < W; x++) {
        const b = (y === 14 || y === 30) && (x + y) % 2 ? band - 1 : band
        let c = pal.sky[Math.max(0, b)]
        if (s === 'summer' && growth < 0.25) c = mix(c, '#d9ecd0', 0.35 - growth)
        px(x, y, c)
      }
    }
    // Sun (summer/autumn) or pale disc (winter).
    const sunX = 78
    const sunY = s === 'summer' ? 10 - Math.round(p * 3) : 14
    const sunC = s === 'winter' ? '#f8fbff' : s === 'autumn' ? '#ffb347' : '#fff3a0'
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 10) px(sunX + dx, sunY + dy, sunC)
    // Distant hills.
    for (let x = 0; x < W; x++) {
      const hy = Math.round(GROUND - 5 - 3 * Math.sin(x / 11) - 2 * Math.sin(x / 5.3 + 1))
      for (let y = hy; y < GROUND; y++) px(x, y, pal.hill)
    }
    // Ground with a grass edge, and flowers once the forest is half grown.
    for (let y = GROUND; y < H; y++) for (let x = 0; x < W; x++) px(x, y, (x * 3 + y * 5) % 11 === 0 ? pal.groundDark : pal.ground)
    if (s === 'summer' && growth > 0.45) for (let i = 0; i < 9; i++) px((i * 23 + 7) % W, GROUND + 2 + ((i * 7) % 10), i % 2 ? '#ffffff' : '#ffd84a')
    trees.forEach((t) => drawTree(t, growth, pal, s, brk))
    // Falling leaves / snow.
    spawnParticles(s, growth)
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i]
      q.sway += 0.08
      q.x += q.vx + Math.sin(q.sway) * 0.08
      q.y += q.vy
      if (q.y > H || (s === 'autumn' && q.y > GROUND + 10) || (s === 'summer' && q.c !== '#ffffff')) particles.splice(i, 1)
      else px(q.x, q.y, q.c)
    }
    if (s !== 'winter') for (let i = particles.length - 1; i >= 0; i--) if (particles[i].c === '#ffffff') particles.splice(i, 1)
  }

  // ---------- UI ----------
  function ui() {
    const ms = remaining()
    const m = Math.floor(ms / 60e3)
    const sec = Math.floor((ms % 60e3) / 1000)
    $('time').textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    $('phase').textContent = st.phase === 'focus' ? `Focus · ${Math.min(st.done + 1, cfg.cycles)} of ${cfg.cycles}` : st.phase === 'short' ? 'Short break · autumn' : 'Long break · winter'
    $('start').textContent = st.running ? 'Pause' : remaining() < minutes(st.phase) ? 'Resume' : st.phase === 'focus' ? 'Start focus' : 'Start break'
    $('dots').innerHTML = Array.from({ length: cfg.cycles }, (_, i) => `<span class="dot${i < st.done ? ' done' : i === st.done && st.phase === 'focus' ? ' now' : ''}"></span>`).join('')
    const today = st.day === todayKey() ? st.today : 0
    $('today').textContent = today ? `${today} focus session${today === 1 ? '' : 's'} today` : ''
    document.title = st.running ? `${$('time').textContent} · Forest Timer` : 'Forest Timer'
  }

  function tick() {
    if (st.running && remaining() <= 0) finishPhase(true)
    ui()
  }

  $('start').onclick = () => {
    if (audio === null) {
      try {
        audio = new AudioContext() // unlock sound with this click
      } catch {
        /* ignore */
      }
    }
    st.running ? pause() : start()
    ui()
  }
  $('skip').onclick = () => {
    finishPhase(false)
    ui()
  }
  $('reset').onclick = () => {
    resetCycle()
    ui()
  }
  const inputs = { focus: 's-focus', short: 's-short', long: 's-long', cycles: 's-cycles' }
  function showCfg() {
    for (const [k, id] of Object.entries(inputs)) $(id).value = cfg[k]
    $('s-auto').checked = cfg.autoFocus
  }
  for (const [k, id] of Object.entries(inputs)) {
    $(id).onchange = () => {
      const v = Math.max(1, Math.round(Number($(id).value) || cfg[k]))
      cfg[k] = v
      if (!st.running && k === st.phase) st.remaining = minutes(st.phase)
      if (k === 'cycles') st.done = Math.min(st.done, v - 1)
      save()
      ui()
    }
  }
  $('s-auto').onchange = () => {
    cfg.autoFocus = $('s-auto').checked
    save()
  }

  Promise.all([OpenTex.storage.get('cfg'), OpenTex.storage.get('state')]).then(([c, s]) => {
    if (c) Object.assign(cfg, c)
    if (s) Object.assign(st, s)
    // If a phase ended while OpenTex was closed, move on without notifications.
    if (st.running && st.endsAt <= Date.now()) finishPhase(false)
    showCfg()
    ui()
  })
  showCfg()
  ui()
  setInterval(tick, 250)
  let last = 0
  const frame = (t) => {
    if (t - last > 90) {
      draw()
      last = t
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})()
