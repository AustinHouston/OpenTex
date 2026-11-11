// Lava Lamp: the panel is the inside of a lava lamp. Warm wax rises from a pool at the bottom,
// stretches, splits and merges, cools near the top and sinks back. The wax is a set of metaballs
// on a small grid of chunky cells (about 45 on the panel's short side), scaled up by whole pixels.
;(function () {
  const cv = document.getElementById('lava')
  const g = cv.getContext('2d')
  const bar = document.getElementById('bar')

  // ---------- Colours ----------
  const WHITE = [255, 255, 255]
  const BLACK = [0, 0, 0]
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
  const pack = (c) => ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255
  const css = (c) => `rgb(${c.join(',')})`

  // Wax and liquid run dark to light; the liquid is darkest at the top and lit by the bulb below.
  const SCHEMES = [
    { id: 'classic', name: 'Classic', wax: ['#6e0c12', '#b5151b', '#e2342a', '#ff9a6a'], liquid: ['#a8600f', '#cc8a1a', '#e8ae2c', '#ffd75e'] },
    { id: 'ocean', name: 'Ocean', wax: ['#13307e', '#2456d4', '#4787f4', '#a9cdff'], liquid: ['#1d0a34', '#341858', '#4c257e', '#6838a8'] },
    { id: 'lagoon', name: 'Lagoon', wax: ['#0f5a1c', '#25a333', '#56d24c', '#c0f88a'], liquid: ['#042a31', '#09464f', '#0e646e', '#16878e'] },
    { id: 'sunset', name: 'Sunset', wax: ['#8a2a06', '#e05d0e', '#ff8f1f', '#ffd68a'], liquid: ['#2e071f', '#4c0d30', '#721442', '#9c2254'] },
    { id: 'bubblegum', name: 'Bubblegum', wax: ['#9a1a5a', '#e2408c', '#ff72b8', '#ffd0e8'], liquid: ['#220e40', '#391966', '#50288c', '#6b3bb2'] },
    { id: 'midnight', name: 'Midnight', wax: ['#7d8db2', '#c4d0ea', '#eef3ff', '#ffffff'], liquid: ['#040920', '#091236', '#101c4e', '#1a2b6e'] },
    { id: 'theme', name: 'Theme accent' }
  ]

  let schemeId = 'classic'
  let theme = null
  let P = null

  function readTheme() {
    const s = getComputedStyle(document.documentElement)
    const v = (k) => rgb(s.getPropertyValue(k))
    const panel = v('--panel')
    return { panel, accent: v('--accent'), dark: lum(panel) < 0.45 }
  }

  function schemeColours(id) {
    const sc = SCHEMES.find((s) => s.id === id) || SCHEMES[0]
    if (sc.id !== 'theme') return { wax: sc.wax.map(rgb), liquid: sc.liquid.map(rgb) }
    // Monochrome in the OpenTex accent: dark liquid in dark themes, pale liquid in light ones.
    const A = theme.accent
    if (theme.dark) return { wax: [mix(A, BLACK, 0.45), A, mix(A, WHITE, 0.32), mix(A, WHITE, 0.72)], liquid: [0.12, 0.19, 0.27, 0.36].map((x) => mix(BLACK, A, x)) }
    return { wax: [mix(A, BLACK, 0.5), mix(A, BLACK, 0.2), A, mix(A, WHITE, 0.6)], liquid: [0.42, 0.32, 0.22, 0.12].map((x) => mix(WHITE, A, x)) }
  }

  function buildPalette() {
    const c = schemeColours(schemeId)
    P = { wax: c.wax.map(pack), liq: c.liquid.map(pack) }
  }

  // 4x4 ordered dither, so tone changes break up into a pixel pattern instead of smooth bands.
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5)

  // ---------- Simulation, in grid cells ----------
  const INV = 1 / 0.5625 // the kernel is 0.5625 at a blob's surface; scale so the surface is at 1
  let W = 0
  let H = 0
  let img = null
  let buf = null
  let F = new Float32Array(0)
  const rnd = Math.random
  const sim = { t: 0, pool: 0, pd: 0, blobs: [], next: 0, rmax: 1, want: 3, wide: 1 }

  function newBlob(r, x, y, T) {
    return { x, y, vx: 0, vy: 0, r, T, sx: 1, sy: 1, cool: 0.017 + 0.014 * rnd(), ph: rnd() * 6.283, w: 0.1 + 0.12 * rnd(), vmax: (H / 15) * (0.8 + 0.4 * rnd()), nm: 2 }
  }

  // Blob size and count follow the panel: a wide strip gets more, wider blobs; a tall one a longer climb.
  function fitSim(oldW, oldH) {
    const short = Math.min(W, H)
    const aspect = W / H
    const rmax = 0.17 * short
    sim.want = Math.max(4, Math.min(12, Math.round(1.8 + 2 * aspect)))
    sim.wide = 1 + 0.35 * Math.min(1, Math.max(0, (aspect - 1.2) / 2.5))
    if (oldW) {
      const kx = W / oldW
      const ky = H / oldH
      const kr = rmax / sim.rmax
      for (const b of sim.blobs) {
        b.x *= kx
        b.y *= ky
        b.r *= kr
        b.vy *= ky
        b.vmax *= ky
      }
      sim.pool *= kx * ky
      sim.pd *= ky
    } else {
      sim.pool = 0.05 * H * W
      sim.pd = 0.08 * H
    }
    sim.rmax = rmax
  }

  const poolTarget = () => 0.07 * H + sim.pool / W

  function step(dt) {
    const s = sim
    s.t += dt
    s.pd += (poolTarget() - s.pd) * Math.min(1, dt * 0.5)
    // The heated pool sends up a new blob every few seconds, until there are enough in the liquid.
    s.next -= dt
    if (s.next <= 0) {
      s.next = (2 + 4 * rnd()) * Math.min(1, 4 / s.want + 0.3)
      const r = s.rmax * (0.5 + 0.5 * rnd())
      if (s.blobs.length < s.want && s.pool > r * r) {
        s.pool -= r * r
        s.blobs.push(newBlob(r, r + rnd() * Math.max(1, W - 2 * r), H - s.pd * 0.3, 1))
      }
    }
    const bl = s.blobs
    for (const b of bl) {
      b.nm -= dt
      b.T = Math.max(0, b.T - dt * (b.cool + (b.y < H * 0.2 ? 0.05 : 0)))
      const buoy = Math.max(-1, Math.min(1, (b.T - 0.42) * 4)) // +1 hot and rising .. -1 cold and sinking
      b.vy += (-buoy * b.vmax - b.vy) * Math.min(1, dt * 0.7)
      b.vx += (Math.sin(s.t * b.w + b.ph) * s.rmax * 0.12 * s.wide - b.vx) * Math.min(1, dt * 0.5)
      b.x += b.vx * dt
      b.y += b.vy * dt
      const ymin = b.r * 0.7
      if (b.y < ymin) {
        b.y = ymin
        if (b.vy < 0) b.vy *= 0.5
      }
      b.x = Math.max(b.r * 0.4, Math.min(W - b.r * 0.4, b.x))
      // Moving wax stretches along its path (area kept the same); in wide panels it spreads sideways.
      const st = 1 + Math.min(0.55, (Math.abs(b.vy) / b.vmax) * 0.45)
      b.sy += (st - b.sy) * Math.min(1, dt * 2)
      b.sx = s.wide / Math.sqrt(b.sy)
    }
    // Sinking wax melts back into the pool.
    for (let i = bl.length - 1; i >= 0; i--) {
      const b = bl[i]
      if (b.vy > 0 && b.y > H - s.pd * 0.55) {
        s.pool += b.r * b.r
        bl.splice(i, 1)
      }
    }
    // Blobs that run into each other merge; big ones split now and then.
    for (let i = 0; i < bl.length; i++) {
      for (let j = bl.length - 1; j > i; j--) {
        const a = bl[i]
        const b = bl[j]
        if (a.nm > 0 || b.nm > 0) continue
        if (Math.hypot((a.x - b.x) / s.wide, a.y - b.y) < 0.45 * (a.r + b.r)) {
          const m = a.r * a.r + b.r * b.r
          const w = (b.r * b.r) / m
          a.x += (b.x - a.x) * w
          a.y += (b.y - a.y) * w
          a.vy += (b.vy - a.vy) * w
          a.T += (b.T - a.T) * w
          a.r = Math.min(s.rmax * 1.25, Math.sqrt(m))
          s.pool += m - a.r * a.r
          bl.splice(j, 1)
        }
      }
    }
    for (let i = bl.length - 1; i >= 0; i--) {
      const b = bl[i]
      if (bl.length < s.want + 2 && b.r > s.rmax * 0.8 && b.nm <= 0 && b.y > H * 0.25 && b.y < H * 0.75 && rnd() < dt * 0.05) {
        const r = b.r / Math.SQRT2
        const c = newBlob(r, b.x + (rnd() - 0.5), b.y + r * 0.5, b.T - 0.1)
        c.vy = b.vy
        c.vmax = b.vmax
        c.nm = b.nm = 5
        b.r = r
        b.y -= r * 0.5
        b.T = Math.min(1, b.T + 0.08)
        bl.push(c)
      }
    }
  }

  // ---------- Drawing ----------
  function layout() {
    const vw = Math.max(1, innerWidth)
    const vh = Math.max(1, innerHeight)
    const dpr = window.devicePixelRatio || 1
    // Chunky cells: about 45 across the short side, and never more than ~14k cells in all.
    let S = Math.max(3, Math.round(Math.min(vw, vh) / 45))
    while ((vw / S) * (vh / S) > 14000) S++
    const D = Math.max(1, Math.round(S * dpr))
    const oldW = W
    const oldH = H
    W = Math.ceil((vw * dpr) / D)
    H = Math.ceil((vh * dpr) / D)
    cv.width = W
    cv.height = H
    cv.style.width = `${(W * D) / dpr}px`
    cv.style.height = `${(H * D) / dpr}px`
    img = g.createImageData(W, H)
    buf = new Uint32Array(img.data.buffer)
    F = new Float32Array(W * H)
    if (oldW !== W || oldH !== H) fitSim(oldW, oldH)
    render()
  }

  function computeField() {
    const s = sim
    F.fill(0)
    // The pool: a wavy layer of wax along the bottom.
    for (let x = 0; x < W; x++) {
      const pd = s.pd * (1 + 0.1 * Math.sin(x * 0.16 + s.t * 0.4) + 0.06 * Math.sin(x * 0.37 - s.t * 0.27))
      const y0 = Math.max(0, Math.floor(H - 2 * pd))
      for (let y = y0; y < H; y++) {
        const q = (H - y - 0.5) / (2 * pd)
        if (q < 1) {
          const a = 1 - q * q
          F[y * W + x] += a * a * INV
        }
      }
    }
    for (const b of s.blobs) {
      const R = 2 * b.r
      const rx = R * b.sx
      const ry = R * b.sy
      const x0 = Math.max(0, Math.floor(b.x - rx))
      const x1 = Math.min(W - 1, Math.ceil(b.x + rx))
      const y0 = Math.max(0, Math.floor(b.y - ry))
      const y1 = Math.min(H - 1, Math.ceil(b.y + ry))
      for (let y = y0; y <= y1; y++) {
        const dy = (y + 0.5 - b.y) / ry
        const row = y * W
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5 - b.x) / rx
          const q = dx * dx + dy * dy
          if (q < 1) {
            const a = 1 - q
            F[row + x] += a * a * INV
          }
        }
      }
    }
  }

  let clock = 0
  function render() {
    if (!buf || !P) return
    computeField()
    const breath = 0.035 * Math.sin(clock * 0.35)
    const t = sim.t
    for (let y = 0; y < H; y++) {
      const yf = (y + 0.5) / H
      const bulb = 0.3 * Math.max(0, 1 - (1 - yf) / 0.38)
      const lvBase = 0.1 + 0.55 * yf + bulb + breath
      const wvBase = 0.36 + 0.32 * yf + breath
      const row = y * W
      for (let x = 0; x < W; x++) {
        const i = row + x
        const f = F[i]
        const d = BAYER[((y & 3) << 2) | (x & 3)]
        if (f >= 1) {
          // Wax: lit from below by the bulb, darker on top, with a glint on the upper-left rim.
          const fl = x > 0 ? F[i - 1] : f - 0.5
          const fr = x < W - 1 ? F[i + 1] : f - 0.5
          const fu = y > 0 ? F[i - W] : f - 0.5
          const fd = y < H - 1 ? F[i + W] : f
          const gx = fr - fl
          const gy = fd - fu
          const gl = Math.hypot(gx, gy) || 1
          const nx = -gx / gl
          const ny = -gy / gl
          const e = Math.max(0, Math.min(1, (1.7 - f) / 0.7)) // 1 at the edge, 0 deep inside
          const v = wvBase + 0.5 * e * ny + 0.16 * (1 - e)
          let k = Math.max(0, Math.min(2, Math.floor(v * 2 + 0.5 + d * 0.4)))
          if (e > 0.35 && -0.6 * nx - 0.8 * ny > 0.86) k = 3
          buf[i] = P.wax[k]
        } else {
          // Liquid: dark at the top, glowing near the bulb and around the wax, with slow faint currents.
          const v = lvBase + (f > 0.72 ? 0.11 : 0) + 0.04 * Math.sin(x * 0.21 + yf * 3 + t * 0.15)
          buf[i] = P.liq[Math.max(0, Math.min(3, Math.floor(v * 3 + 0.5 + d * 0.45)))]
        }
      }
    }
    g.putImageData(img, 0, 0)
  }

  // ---------- Colour swatches ----------
  function swatchStyle(id) {
    const c = schemeColours(id)
    return `radial-gradient(circle at 50% 58%, ${css(c.wax[2])} 0 42%, ${css(c.wax[1])} 43% 50%, ${css(c.liquid[2])} 51%)`
  }
  function buildBar() {
    bar.innerHTML = ''
    for (const sc of SCHEMES) {
      const b = document.createElement('button')
      b.className = 'sw'
      b.title = sc.name
      b.setAttribute('aria-label', sc.name)
      b.setAttribute('aria-pressed', String(sc.id === schemeId))
      b.style.background = swatchStyle(sc.id)
      b.onclick = () => setScheme(sc.id, true)
      bar.appendChild(b)
    }
  }
  function setScheme(id, save) {
    if (!SCHEMES.some((s) => s.id === id)) return
    schemeId = id
    if (save) OpenTex.storage.set('scheme', id)
    buildPalette()
    ;[...bar.children].forEach((b, i) => b.setAttribute('aria-pressed', String(SCHEMES[i].id === id)))
    render()
  }

  // The swatches fade in while the pointer moves over the panel and fade out after a short rest.
  let hideTimer = 0
  function showBar(ms) {
    bar.classList.add('show')
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => bar.classList.remove('show'), ms)
  }
  addEventListener('pointermove', () => showBar(1800))
  addEventListener('pointerdown', () => showBar(3000))
  addEventListener('keydown', () => showBar(3000))
  document.documentElement.addEventListener('pointerleave', () => {
    clearTimeout(hideTimer)
    bar.classList.remove('show')
  })

  // ---------- Start ----------
  function applyTheme() {
    theme = readTheme()
    buildPalette()
    buildBar()
    render()
  }
  theme = readTheme()
  buildPalette()
  buildBar()
  layout()
  // Start mid-flow rather than with an empty lamp.
  for (let i = 0; i < 900; i++) step(1 / 15)
  render()
  OpenTex.onTheme(() => applyTheme())
  OpenTex.storage.get('scheme').then((id) => {
    if (id && id !== schemeId) setScheme(id, false)
  })

  let resizeTimer = 0
  addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(layout, 60)
  })

  // About 16 frames a second, and nothing at all while the panel is hidden.
  const SPEED = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.5 : 1
  let last = performance.now()
  let looping = false
  function frame(now) {
    if (document.hidden) {
      looping = false
      return
    }
    requestAnimationFrame(frame)
    if (now - last < 60) return
    const dt = Math.min(0.12, (now - last) / 1000) * SPEED
    last = now
    clock += dt
    step(dt)
    render()
  }
  function loop() {
    if (looping || document.hidden) return
    looping = true
    last = performance.now()
    requestAnimationFrame(frame)
  }
  document.addEventListener('visibilitychange', loop)
  loop()
})()
