// Starship: a little pixel spaceship flying into the screen, past asteroids, planets, suns,
// black holes, nebulae, comets and the odd space station. Typing makes it go faster: a smoothed
// typing rate (characters per second) pushes the throttle up, and it eases back to a slow cruise
// over about fifteen seconds once you stop. Click the ship for a boost.
// Everything is drawn into a small pixel buffer (one Uint32 per pixel) and scaled up by whole pixels.
;(function () {
  'use strict'
  const frameEl = document.getElementById('frame')
  const cv = document.getElementById('space')
  const g = cv.getContext('2d', { alpha: false })

  // ---------- Palette: PICO-8 and its extended colours, for a consistent retro look ----------
  const HEX = {
    void: '#05060f', ink: '#0b0f22', navy: '#111d35', blue: '#1d2b53', plum: '#7e2553', green: '#008751', brown: '#ab5236', grey: '#5f574f',
    silver: '#c2c3c7', white: '#fff1e8', red: '#ff004d', orange: '#ffa300', yellow: '#ffec27', lime: '#00e436', sky: '#29adff', lav: '#83769c',
    pink: '#ff77a8', peach: '#ffccaa', umber: '#291814', deep: '#111d35', wine: '#422136', teal: '#125359', rust: '#742f29', mauve: '#49333b',
    tan: '#a28879', lemon: '#f3ef7d', crimson: '#be1250', tangerine: '#ff6c24', chartreuse: '#a8e72e', jade: '#00b543', cobalt: '#065ab5',
    grape: '#754665', salmon: '#ff6e59', apricot: '#ff9d81', black: '#000000', bg1: '#0d1229', bg2: '#151a3a', bg3: '#1d1c46', bg4: '#2a2257'
  }
  const pack = (h) => {
    const n = parseInt(h.slice(1), 16)
    return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0
  }
  const K = {}
  for (const k in HEX) K[k] = pack(HEX[k])
  const ramp = (s) => s.split(' ').map((n) => K[n])
  const cr = (c) => c & 255
  const cg = (c) => (c >>> 8) & 255
  const cb = (c) => (c >>> 16) & 255

  const RAMPS = {
    rockGrey: ramp('umber mauve grey lav silver'),
    rockBrown: ramp('umber mauve grey tan peach'),
    rockRed: ramp('umber rust brown tan apricot'),
    jovA: ramp('umber rust brown tangerine apricot'),
    jovB: ramp('mauve grey tan peach white'),
    jovC: ramp('umber rust brown tan peach'),
    iceA: ramp('navy cobalt sky silver white'),
    iceB: ramp('navy teal cobalt sky silver'),
    candyA: ramp('wine plum grape pink apricot'),
    candyB: ramp('wine grape lav silver white'),
    sandA: ramp('umber mauve tan peach white'),
    sandB: ramp('umber brown tan lemon peach'),
    ocean: ramp('navy blue cobalt sky sky'),
    land: ramp('umber teal green jade chartreuse'),
    snow: ramp('blue lav silver white white'),
    dune: ramp('umber rust brown tangerine apricot'),
    duneDark: ramp('umber mauve rust brown tan'),
    basalt: ramp('void umber wine mauve grey'),
    frost: ramp('navy blue lav silver white'),
    spot: ramp('umber rust crimson salmon apricot')
  }
  const GAS = [
    [RAMPS.jovA, RAMPS.jovB, RAMPS.jovC],
    [RAMPS.iceA, RAMPS.iceB],
    [RAMPS.candyA, RAMPS.candyB],
    [RAMPS.sandA, RAMPS.sandB]
  ]
  const RINGS = [ramp('grey tan peach white'), ramp('lav silver white sky'), ramp('mauve tan apricot peach'), ramp('grape lav pink white')]
  const SUNS = [
    { body: ramp('tangerine orange yellow lemon white'), corona: ramp('rust tangerine orange yellow'), flare: K.yellow },
    { body: ramp('crimson red tangerine orange apricot'), corona: ramp('wine crimson red tangerine'), flare: K.salmon },
    { body: ramp('cobalt sky silver white white'), corona: ramp('blue cobalt sky silver'), flare: K.sky }
  ]
  const NEBULAE = [ramp('plum pink apricot'), ramp('teal cobalt sky'), ramp('rust crimson salmon'), ramp('grape lav pink')]
  const DISK = ramp('wine rust crimson tangerine orange yellow white')
  const BG = ramp('void ink bg1 bg2 bg3 bg4')

  // ---------- Helpers ----------
  const BAY = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16))
  const bay = (x, y) => BAY[((y & 3) << 2) | (x & 3)]
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const rnd = (a, b) => a + Math.random() * (b - a)
  const pick = (arr) => arr[(Math.random() * arr.length) | 0]

  // Tileable value noise (128 x 128), sampled with bilinear filtering.
  const NT = new Float32Array(128 * 128)
  ;(function () {
    for (const [n, w] of [[8, 0.5], [16, 0.3], [32, 0.2]]) {
      const lat = new Float32Array(n * n).map(() => Math.random())
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
          const gx = (x * n) / 128, gy = (y * n) / 128
          const ix = gx | 0, iy = gy | 0
          let fx = gx - ix, fy = gy - iy
          fx = fx * fx * (3 - 2 * fx)
          fy = fy * fy * (3 - 2 * fy)
          const a = lat[iy * n + ix], b = lat[iy * n + ((ix + 1) % n)], c = lat[((iy + 1) % n) * n + ix], d = lat[((iy + 1) % n) * n + ((ix + 1) % n)]
          NT[y * 128 + x] += w * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy)
        }
    }
    let lo = 1, hi = 0
    for (let i = 0; i < NT.length; i++) (lo = Math.min(lo, NT[i])), (hi = Math.max(hi, NT[i]))
    for (let i = 0; i < NT.length; i++) NT[i] = (NT[i] - lo) / (hi - lo)
  })()
  function noise(u, v) {
    const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv
    const x0 = iu & 127, y0 = (iv & 127) << 7, x1 = (x0 + 1) & 127, y1 = ((iv + 1) & 127) << 7
    const a = NT[y0 + x0], b = NT[y0 + x1], c = NT[y1 + x0], d = NT[y1 + x1]
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv
  }

  // ---------- Pixel buffer ----------
  let W = 0, H = 0, S = 3, F = 1, CX = 0, CY = 0
  let img = null, buf = null, bgBuf = null
  let FADE = 1 // dithered fade-in for objects appearing in the distance

  function put(x, y, c) {
    x |= 0
    y |= 0
    if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = c
  }
  function addAt(i, r, gg, b) {
    const d = buf[i]
    let R = (d & 255) + r, G = ((d >>> 8) & 255) + gg, B = ((d >>> 16) & 255) + b
    if (R > 255) R = 255
    if (G > 255) G = 255
    if (B > 255) B = 255
    buf[i] = (0xff000000 | (B << 16) | (G << 8) | R) >>> 0
  }
  function add(x, y, r, gg, b) {
    x |= 0
    y |= 0
    if (x >= 0 && y >= 0 && x < W && y < H) addAt(y * W + x, r, gg, b)
  }
  function blendAt(i, c, a) {
    const d = buf[i]
    const dr = d & 255, dg = (d >>> 8) & 255, db = (d >>> 16) & 255
    buf[i] = (0xff000000 | ((db + ((c >>> 16) & 255) * a - db * a) << 16) | ((dg + ((c >>> 8) & 255) * a - dg * a) << 8) | (dr + (c & 255) * a - dr * a)) >>> 0
  }
  // A soft additive glow with stepped (retro) falloff.
  function glow(cx, cy, rad, c, gain) {
    if (rad <= 0) return
    const R = cr(c), G = cg(c), B = cb(c)
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad))
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad))
    const inv = 1 / rad
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) * inv
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const dx = (x + 0.5 - cx) * inv
        const d2 = dx * dx + dy * dy
        if (d2 >= 1) continue
        const k = Math.floor((1 - Math.sqrt(d2)) * (1 - Math.sqrt(d2)) * gain * 4 + BAY[((y & 3) << 2) | (x & 3)]) * 0.25
        if (k > 0) addAt(i, R * k, G * k, B * k)
      }
    }
  }

  // ---------- Pixel font (3 x 5) for the HUD ----------
  const GLYPHS = {
    0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001011001111', 4: '101101111001001', 5: '111100111001111',
    6: '111100111101111', 7: '111001001010010', 8: '111101111101111', 9: '111101111001111', '.': '000000000000010', ' ': '000000000000000',
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
    G: '011100101101011', H: '101101111101101', I: '111010010010111', K: '101101110101101', L: '100100100100111', M: '101111111101101',
    N: '110101101101101', O: '010101101101010', P: '110101110100100', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101101111101', X: '101101010101101', Y: '101101010010010', '-': '000000111000000', '!': '010010010000010'
  }
  function text(str, x, y, c, shadow) {
    for (let n = 0; n < str.length; n++) {
      const gl = GLYPHS[str[n]] || GLYPHS[' ']
      for (let k = 0; k < 15; k++)
        if (gl.charCodeAt(k) === 49) {
          if (shadow) put(x + n * 4 + (k % 3) + 1, y + ((k / 3) | 0) + 1, shadow)
          put(x + n * 4 + (k % 3), y + ((k / 3) | 0), c)
        }
    }
  }

  // ---------- Layout ----------
  function layout() {
    const aw = frameEl.clientWidth - 2
    const ah = frameEl.clientHeight - 2
    if (aw < 24 || ah < 24) return
    let s = clamp(Math.round(Math.sqrt((aw * ah) / 14000)), 2, 6)
    while (s > 2 && Math.min(aw, ah) / s < 64) s--
    const w = Math.floor(aw / s)
    const h = Math.floor(ah / s)
    if (w === W && h === H && s === S && buf) return
    W = w
    H = h
    S = s
    cv.width = W
    cv.height = H
    cv.style.width = W * S + 'px'
    cv.style.height = H * S + 'px'
    img = g.createImageData(W, H)
    buf = new Uint32Array(img.data.buffer)
    bgBuf = new Uint32Array(W * H)
    F = Math.sqrt(W * H) * 0.8
    CX = W / 2
    CY = H * 0.42
    makeBackground()
    initStars()
    hudDirty = true
    if (!running) render()
  }

  // Distant sky: a dithered gradient, a faint band of the galaxy and still, far-away stars.
  function makeBackground() {
    const ang = Math.random() * 0.8 - 0.4
    const ca = Math.cos(ang), sa = Math.sin(ang)
    const off = rnd(-0.15, 0.15)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const u = (x - W / 2) / Math.max(W, H), v = (y - H / 2) / Math.max(W, H)
        const across = -u * sa + v * ca - off
        const band = Math.exp(-(across * across) / 0.018) * (0.55 + 0.9 * noise(x * 0.9, y * 0.9) * noise(x * 0.25 + 40, y * 0.25))
        const lvl = 1.05 + 0.45 * (y / H) + band * 2.6 + (bay(x, y) - 0.5) * 0.8
        bgBuf[y * W + x] = BG[clamp(lvl | 0, 0, BG.length - 1)]
      }
    const n = Math.round((W * H) / 45)
    for (let k = 0; k < n; k++) {
      const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0
      const r = Math.random()
      bgBuf[y * W + x] = r < 0.55 ? K.blue : r < 0.8 ? K.lav : r < 0.93 ? K.grey : r < 0.98 ? K.silver : K.peach
    }
  }

  // ---------- Flight state ----------
  let t = 0
  let pending = 0 // characters typed since the last frame
  let rate = 0 // smoothed typing rate, characters per second
  let throttle = 0 // 0 = cruise, 1 = full warp
  let warp = 0 // 0..1, how much of the warp look to show
  let speed = 0.6 // world units per second
  let flash = 0
  let typedEver = false
  let sessionAU = 0
  let savedAU = 0
  let loaded = false
  let boostSpark = 0

  OpenTex.onActivity(({ chars }) => {
    pending += Math.min(Math.abs(Number(chars) || 0), 25) // a big paste shouldn't jump straight to warp
    typedEver = true
  })

  function speedC() {
    if (throttle < 0.55) return 0.1 + (throttle / 0.55) * 0.89
    return Math.pow(warpFactor(), 10 / 3) // warp factor -> multiples of light speed
  }
  const warpFactor = () => 1 + ((throttle - 0.55) / 0.45) * 8.9

  // ---------- Stars flying past ----------
  const ZS = 3
  const MAXS = 900
  const SX = new Float32Array(MAXS), SY = new Float32Array(MAXS), SZ = new Float32Array(MAXS)
  const SC = new Uint8Array(MAXS)
  const STAR_RGB = [[255, 241, 232], [194, 205, 255], [243, 239, 125], [255, 157, 129], [255, 241, 232]]
  let NS = 0
  function spawnStar(i, z) {
    SZ[i] = z
    SX[i] = (Math.random() - 0.5) * W * 1.15 * (z / F)
    SY[i] = (Math.random() - 0.42) * H * 1.15 * (z / F)
    const r = Math.random()
    SC[i] = r < 0.6 ? 0 : r < 0.82 ? 1 : r < 0.93 ? 2 : 3
  }
  function initStars() {
    NS = clamp(Math.round((W * H) / 48), 90, MAXS)
    for (let i = 0; i < NS; i++) spawnStar(i, rnd(0.08, ZS))
  }

  // Black hole lensing: stars behind the hole are pushed out into a ring and swirled.
  let bhOn = false, bhX = 0, bhY = 0, bhR = 0, bhZ = 0
  let LX = 0, LY = 0
  function lens(px, py) {
    const dx = px - bhX, dy = py - bhY
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01
    if (d > bhR * 10) {
      LX = px
      LY = py
      return
    }
    const push = d + (bhR * bhR * 2.4) / d
    const a = Math.atan2(dy, dx) + (1.4 * bhR) / d
    LX = bhX + Math.cos(a) * push
    LY = bhY + Math.sin(a) * push
  }

  function updateStars(dt) {
    const dz = speed * dt
    for (let i = 0; i < NS; i++) {
      const z = (SZ[i] -= dz)
      if (z < 0.04) {
        spawnStar(i, ZS - Math.random() * 0.3)
        continue
      }
      const hx = CX + (SX[i] * F) / z, hy = CY + (SY[i] * F) / z
      if (hx < -4 || hx > W + 4 || hy < -4 || hy > H + 4) spawnStar(i, ZS - Math.random() * 0.3)
    }
  }

  function drawStars(near) {
    const streak = 0.008 + speed * speed * 0.009
    const wb = warp
    for (let i = 0; i < NS; i++) {
      const z = SZ[i]
      if (near ? z >= 0.7 : z < 0.7) continue
      let hx = CX + (SX[i] * F) / z, hy = CY + (SY[i] * F) / z
      const z2 = Math.min(ZS * 1.2, z + streak)
      let tx = CX + (SX[i] * F) / z2, ty = CY + (SY[i] * F) / z2
      if (bhOn && z > bhZ) {
        lens(hx, hy)
        hx = LX
        hy = LY
        lens(tx, ty)
        tx = LX
        ty = LY
        const ex = hx - bhX, ey = hy - bhY
        if (ex * ex + ey * ey < bhR * bhR * 1.3) continue
      }
      let b = 1 - z / ZS
      b = b * b * 1.15 + 0.08
      const c = STAR_RGB[SC[i]]
      // At warp the light shifts toward blue-white.
      const R = (c[0] + (170 - c[0]) * wb * 0.6) * b, G = (c[1] + (215 - c[1]) * wb * 0.6) * b, B = (c[2] + (255 - c[2]) * wb * 0.6) * b
      const dx = hx - tx, dy = hy - ty
      const len = Math.max(Math.abs(dx), Math.abs(dy))
      if (len < 1) {
        add(hx, hy, R, G, B)
        if (z < 0.3) {
          add(hx + 1, hy, R * 0.45, G * 0.45, B * 0.45)
          add(hx - 1, hy, R * 0.45, G * 0.45, B * 0.45)
          add(hx, hy + 1, R * 0.45, G * 0.45, B * 0.45)
          add(hx, hy - 1, R * 0.45, G * 0.45, B * 0.45)
        }
        continue
      }
      if ((hx < 0 && tx < 0) || (hx >= W && tx >= W) || (hy < 0 && ty < 0) || (hy >= H && ty >= H)) continue
      const n = Math.min(160, Math.ceil(len))
      const sx = dx / n, sy = dy / n
      for (let s = 0; s <= n; s++) {
        const f = s / n
        const k = 0.12 + 0.88 * f * f
        add(tx + sx * s, ty + sy * s, R * k, G * k, B * k)
      }
    }
  }

  // ---------- Objects ----------
  const AST = 1, PLANET = 2, SUN = 3, HOLE = 4, NEB = 5, COMET = 6, STATION = 7
  const NAMES = { asteroid: AST, planet: PLANET, ringed: PLANET, sun: SUN, hole: HOLE, nebula: NEB, comet: COMET, station: STATION }
  const POOL = []
  for (let i = 0; i < 40; i++)
    POOL.push({ on: false, type: 0, x: 0, y: 0, z: 0, z0: 1, R: 0, ext: 1, rot: 0, spin: 0, a: 0, b: 0, c: 0, kind: 0, ramps: null, ramp: null, tilt: 0, bf: 6, spot: false, ring: false, rflat: 0.3, rpal: null, rpat: new Uint8Array(18), crat: new Float32Array(12), big: false, moon: false, mph: 0 })
  const ORDER = new Array(40)
  let distSmall = 0, distBig = 0, gapSmall = 1, gapBig = 6, lastBig = 0

  function grab() {
    for (const o of POOL) if (!o.on) return o
    return null
  }
  // Place a new object far away at a small offset from the vanishing point; it then flies out past the ship.
  function place(o, z0, d0, k) {
    let th = Math.random() * Math.PI * 2
    if (Math.sin(th) > 0.55 && Math.abs(Math.cos(th)) < 0.6) th = -th // keep traffic out from behind the ship
    const ax = clamp(Math.sqrt(W / H), 1, 2.4) // wide panels: favour sideways paths, which stay on screen longer
    const ox = Math.cos(th) * d0 * ax, oy = Math.sin(th) * d0 / ax
    o.on = true
    o.z = o.z0 = z0
    o.x = (ox * z0) / F
    o.y = (oy * z0) / F
    o.R = k * Math.sqrt(o.x * o.x + o.y * o.y)
    o.rot = Math.random() * 6.28
    o.a = Math.random() * 6.28
    o.b = Math.random() * 6.28
    o.c = Math.random() * 6.28
    o.big = false
    return o
  }

  function spawn(type, zOverride) {
    const o = grab()
    if (!o) return null
    o.type = type
    if (type === AST) {
      place(o, zOverride || rnd(5.5, 7), rnd(1.5, 11), rnd(0.1, 0.38))
      o.ext = 1.3
      o.spin = rnd(-1.2, 1.2)
      o.ramp = pick([RAMPS.rockGrey, RAMPS.rockGrey, RAMPS.rockBrown, RAMPS.rockRed])
      for (let c = 0; c < 4; c++) {
        const a = Math.random() * 6.28, d = Math.random() * 0.55
        o.crat[c * 3] = Math.cos(a) * d
        o.crat[c * 3 + 1] = Math.sin(a) * d
        o.crat[c * 3 + 2] = rnd(0.14, 0.3)
      }
    } else if (type === PLANET) {
      o.ring = Math.random() < 0.45
      place(o, zOverride || 14, rnd(2.5, 5), o.ring ? rnd(0.28, 0.34) : rnd(0.42, 0.56))
      o.big = true
      const r = Math.random()
      o.kind = o.ring ? (r < 0.8 ? 0 : 4) : r < 0.38 ? 0 : r < 0.64 ? 1 : r < 0.78 ? 2 : r < 0.9 ? 3 : 4
      o.ramps = o.kind === 0 ? pick(GAS) : null
      o.bf = rnd(4, 8)
      o.spot = o.kind === 0 && o.ramps === GAS[0] ? true : Math.random() < 0.25
      o.tilt = rnd(-0.45, 0.45)
      o.spin = rnd(0.04, 0.09)
      o.rflat = rnd(0.2, 0.36)
      o.rpal = pick(RINGS)
      for (let k = 0; k < 18; k++) o.rpat[k] = Math.random() < 0.13 ? 0 : 1 + ((Math.random() * 4) | 0)
      o.rpat[0] = 1
      o.rpat[1] = 2
      o.moon = !o.ring && Math.random() < 0.5
      o.mph = Math.random() * 6.28
      o.ext = o.ring ? 2.3 : o.moon ? 2.1 : 1.1
    } else if (type === SUN) {
      place(o, zOverride || 16, rnd(2.5, 5), rnd(0.24, 0.3))
      o.big = true
      o.kind = Math.random() < 0.55 ? 0 : Math.random() < 0.6 ? 1 : 2
      o.ext = 3.4
    } else if (type === HOLE) {
      place(o, zOverride || 15, rnd(2.5, 4.5), rnd(0.68, 0.78))
      o.big = true
      o.tilt = rnd(-0.35, 0.35)
      o.rflat = rnd(0.2, 0.3)
      o.ext = 1.05
    } else if (type === NEB) {
      place(o, zOverride || 18, rnd(1, 4), rnd(0.8, 1.1))
      o.big = true
      o.ramp = pick(NEBULAE)
      o.ext = 1
    } else if (type === COMET) {
      place(o, zOverride || rnd(6, 8), rnd(2, 5), rnd(0.05, 0.07))
      o.ext = 14
      o.tilt = Math.atan2(o.y, o.x) + Math.PI + rnd(-0.6, 0.6) // tail points back toward the distance
    } else if (type === STATION) {
      place(o, zOverride || 14, rnd(3, 5), rnd(0.42, 0.5))
      o.big = true
      o.tilt = rnd(-0.3, 0.3)
      o.rflat = rnd(0.45, 0.7)
      o.spin = rnd(0.25, 0.45)
      o.ext = 1.1
    }
    return o
  }

  const BIG_TABLE = [[PLANET, 40], [NEB, 13], [SUN, 12], [HOLE, 9], [STATION, 7], [0, 11]] // 0 = asteroid field
  function spawnBig() {
    let total = 0
    for (const [, w] of BIG_TABLE) total += w
    let type = 0
    for (let tries = 0; tries < 4; tries++) {
      let r = Math.random() * total
      for (const [ty, w] of BIG_TABLE) if ((r -= w) < 0) {
        type = ty
        break
      }
      if (type !== lastBig || type === PLANET) break
    }
    lastBig = type
    if (type === 0) {
      const n = 7 + ((Math.random() * 8) | 0)
      for (let k = 0; k < n; k++) spawn(AST, rnd(5.5, 9.5))
    } else spawn(type)
  }

  function updateObjects(dt) {
    const dz = speed * dt
    distSmall += dz
    distBig += dz
    if (distSmall > gapSmall) {
      distSmall = 0
      gapSmall = rnd(0.7, 1.9) * (1 + throttle * 2)
      spawn(Math.random() < 0.07 ? COMET : AST)
    }
    let bigNear = false
    for (const o of POOL) if (o.on && o.big && o.z > 3) bigNear = true
    if (distBig > gapBig && !bigNear) {
      distBig = 0
      gapBig = rnd(5, 12) * (1 + throttle)
      spawnBig()
    }
    for (const o of POOL) {
      if (!o.on) continue
      o.z -= dz
      o.rot += o.spin * dt
      if (o.z < 0.1) {
        o.on = false
        continue
      }
      const sx = CX + (o.x * F) / o.z, sy = CY + (o.y * F) / o.z, e = ((o.R * F) / o.z) * o.ext + 2
      if (sx + e < 0 || sx - e > W || sy + e < 0 || sy - e > H) o.on = false
    }
  }

  // Asteroid: a lumpy, spinning rock with craters, lit from the upper left.
  const LXd = -0.55, LYd = -0.5, LZd = 0.67
  function drawAsteroid(o, sx, sy, r) {
    const rp = o.ramp
    if (r < 1.2) {
      if (bay(sx | 0, sy | 0) < FADE) put(sx, sy, rp[r < 0.6 ? 1 : 2])
      return
    }
    const e = r * 1.3
    const co = Math.cos(o.rot), si = Math.sin(o.rot)
    const lx2 = LXd * co + LYd * si, ly2 = -LXd * si + LYd * co
    const x0 = Math.max(0, Math.floor(sx - e)), x1 = Math.min(W - 1, Math.ceil(sx + e))
    const y0 = Math.max(0, Math.floor(sy - e)), y1 = Math.min(H - 1, Math.ceil(sy + e))
    const ir = 1 / r
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - sy) * ir
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const dx = (x + 0.5 - sx) * ir
        const d2 = dx * dx + dy * dy
        if (d2 > 1.69) continue
        const b = BAY[((y & 3) << 2) | (x & 3)]
        if (FADE < 1 && b >= FADE) continue
        const lx = dx * co + dy * si, ly = -dx * si + dy * co
        const ang = Math.atan2(ly, lx)
        const rad = 1 + 0.17 * Math.sin(2 * ang + o.a) + 0.1 * Math.sin(3 * ang + o.b) + 0.06 * Math.sin(5 * ang + o.c)
        const dl = Math.sqrt(d2)
        if (dl > rad) continue
        const q = dl / rad
        const nz = Math.sqrt(Math.max(0, 1 - q * q))
        let lum = (dx / rad) * LXd + (dy / rad) * LYd + nz * LZd
        for (let c = 0; c < 12; c += 3) {
          const ex = lx - o.crat[c], ey = ly - o.crat[c + 1], cr2 = o.crat[c + 2]
          const e2 = ex * ex + ey * ey
          if (e2 < cr2 * cr2) lum += (-(ex * lx2 + ey * ly2) / cr2) * 0.55 - 0.12
        }
        let lvl = Math.floor((0.1 + lum * 0.95) * 4 + b - 0.25)
        if (q > 0.86 && lum < 0.45) lvl--
        buf[i] = rp[lvl < 0 ? 0 : lvl > 4 ? 4 : lvl]
      }
    }
  }

  // Planet surface colour at a point of the sphere (normal bx, by, nz in the planet's tilted frame).
  function surface(o, bx, by, nz, x, y, light, b) {
    const lon = Math.atan2(bx, nz) + t * o.spin
    const lvlOf = (rp, l) => rp[clamp(Math.floor(l * 4.6 + b - 0.4), 0, 4)]
    if (o.kind === 0) {
      // Banded gas giant with turbulent edges and maybe a big storm.
      const wob = (noise(lon * 9 + o.a * 20, by * 22 + 7) - 0.5) * 0.9
      const rps = o.ramps
      if (o.spot) {
        const sx2 = (lon - o.b - t * 0.01) * 2.4, sy2 = (by - 0.28) * 7
        const dd = sx2 * sx2 + sy2 * sy2
        if (dd < 1) return lvlOf(RAMPS.spot, light + (dd < 0.35 ? 0.12 : 0))
      }
      const band = Math.floor(by * o.bf + wob + 50) % rps.length
      return lvlOf(rps[band], light + (((Math.floor(by * o.bf * 2 + wob * 2) & 1) === 0) ? 0.05 : -0.05))
    }
    if (o.kind === 1) {
      // Ocean world with continents, clouds and ice caps.
      const h = noise(lon * 11 + o.a * 20, by * 12 + 30)
      const cloud = noise(lon * 14 - t * 0.6 + 60, by * 30 + 90)
      if (Math.abs(by) > 0.8 + h * 0.1) return lvlOf(RAMPS.snow, light)
      if (cloud > 0.7) return lvlOf(RAMPS.snow, light * 0.95)
      return h > 0.53 ? lvlOf(RAMPS.land, light) : lvlOf(RAMPS.ocean, light)
    }
    if (o.kind === 2) {
      // Desert world: dunes, dark plains, polar frost.
      const h = noise(lon * 10 + o.a * 20, by * 11)
      if (Math.abs(by) > 0.86) return lvlOf(RAMPS.snow, light)
      return h > 0.58 ? lvlOf(RAMPS.duneDark, light) : lvlOf(RAMPS.dune, light)
    }
    if (o.kind === 3) {
      // Lava world: dark rock cracked with glowing seams that shine even on the night side.
      const h = noise(lon * 12 + o.a * 20, by * 14 + 50)
      const seam = Math.abs(h - 0.5)
      if (seam < 0.035) return seam < 0.015 ? K.yellow : K.tangerine
      if (seam < 0.06 && light < 0.5) return K.crimson
      return lvlOf(RAMPS.basalt, light)
    }
    // Icy world: pale, streaked.
    const h = noise(lon * 6 + o.a * 20, by * 40)
    return lvlOf(RAMPS.frost, light + (h - 0.5) * 0.3)
  }

  function drawRing(o, sx, sy, r, front) {
    const co = Math.cos(o.tilt), si = Math.sin(o.tilt), fl = o.rflat
    const ro = 2.2 * r
    const ey = ro * (Math.abs(si) + fl * Math.abs(co)) + 1
    const x0 = Math.max(0, Math.floor(sx - ro)), x1 = Math.min(W - 1, Math.ceil(sx + ro))
    const y0 = Math.max(0, Math.floor(sy - ey)), y1 = Math.min(H - 1, Math.ceil(sy + ey))
    const ir = 1 / r, ifl = 1 / fl
    const pal = o.rpal
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - sy) * ir
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const dx = (x + 0.5 - sx) * ir
        const w = (-dx * si + dy * co) * ifl
        if (front ? w < 0 : w >= 0) continue
        const u = dx * co + dy * si
        const rr2 = u * u + w * w
        if (rr2 < 1.69 || rr2 > 4.84) continue
        const b = BAY[((y & 3) << 2) | (x & 3)]
        if (FADE < 1 && b >= FADE) continue
        const band = ((Math.sqrt(rr2) - 1.3) * 20) | 0
        const p = o.rpat[band > 17 ? 17 : band]
        if (p === 0) continue
        // The back of the ring sits partly in the planet's shadow; the front catches more light.
        let lvl = p - 1 + (front ? 0 : -1)
        if (!front && u > 0.2 && Math.abs(u) < 1.15) lvl -= 1
        if (lvl < 0) {
          if (b > 0.5) continue
          lvl = 0
        }
        buf[i] = pal[lvl > 3 ? 3 : lvl]
      }
    }
  }

  function drawSphere(o, sx, sy, r) {
    const co = Math.cos(o.tilt), si = Math.sin(o.tilt)
    const x0 = Math.max(0, Math.floor(sx - r)), x1 = Math.min(W - 1, Math.ceil(sx + r))
    const y0 = Math.max(0, Math.floor(sy - r)), y1 = Math.min(H - 1, Math.ceil(sy + r))
    const ir = 1 / r
    const atm = o.kind === 1 ? K.sky : o.kind === 0 && o.ramps === GAS[1] ? K.sky : 0
    for (let y = y0; y <= y1; y++) {
      const ny = (y + 0.5 - sy) * ir
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const nx = (x + 0.5 - sx) * ir
        const d2 = nx * nx + ny * ny
        if (d2 > 1) continue
        const b = BAY[((y & 3) << 2) | (x & 3)]
        if (FADE < 1 && b >= FADE) continue
        const nz = Math.sqrt(1 - d2)
        const lam = nx * LXd + ny * LYd + nz * LZd
        const light = lam > 0 ? 0.04 + lam * 0.98 : 0.04 + lam * 0.04
        const bx = nx * co + ny * si, by = -nx * si + ny * co
        let c = surface(o, bx, by, nz, x, y, light, b)
        if (atm && d2 > 0.84 && lam > -0.15 && b < 0.6) c = atm
        buf[i] = c
      }
    }
  }

  function drawPlanet(o, sx, sy, r) {
    if (r < 1.2) {
      if (bay(sx | 0, sy | 0) < FADE) put(sx, sy, o.kind === 0 ? o.ramps[0][3] : o.kind === 1 ? K.sky : o.kind === 2 ? K.tangerine : o.kind === 3 ? K.crimson : K.silver)
      return
    }
    // A small moon on a slow orbit; behind the planet for half of it.
    const ma = o.mph + t * 0.15
    const mx = sx + Math.cos(ma) * r * 1.75, my = sy + Math.sin(ma) * r * 0.45
    const mr = Math.max(1, r * 0.2)
    const moonBehind = Math.sin(ma) < 0
    if (o.moon && moonBehind) drawMoon(mx, my, mr)
    if (o.ring) drawRing(o, sx, sy, r, false)
    drawSphere(o, sx, sy, r)
    if (o.ring) drawRing(o, sx, sy, r, true)
    if (o.moon && !moonBehind) drawMoon(mx, my, mr)
  }
  function drawMoon(cx, cy, r) {
    const rp = RAMPS.rockGrey
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r
        const d2 = nx * nx + ny * ny
        if (d2 > 1) continue
        const b = bay(x, y)
        if (FADE < 1 && b >= FADE) continue
        const lam = nx * LXd + ny * LYd + Math.sqrt(1 - d2) * LZd
        buf[y * W + x] = rp[clamp(Math.floor((0.1 + Math.max(0, lam)) * 4 + b - 0.3), 0, 4)]
      }
  }

  // Sun: granulated photosphere, flickering corona rays, a glow and a retro lens flare.
  function drawSun(o, sx, sy, r) {
    const pal = SUNS[o.kind]
    const fl = 0.85 + 0.15 * Math.sin(t * 6 + o.a)
    if (r < 1) {
      glow(sx, sy, 2.5 + r * 3, pal.corona[3], 1.4 * FADE)
      put(sx, sy, pal.body[4])
      return
    }
    const rh = r * 3.3
    const x0 = Math.max(0, Math.floor(sx - rh)), x1 = Math.min(W - 1, Math.ceil(sx + rh))
    const y0 = Math.max(0, Math.floor(sy - rh)), y1 = Math.min(H - 1, Math.ceil(sy + rh))
    const ir = 1 / r
    const body = pal.body, cor = pal.corona
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - sy) * ir
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const dx = (x + 0.5 - sx) * ir
        const d2 = dx * dx + dy * dy
        if (d2 > 10.9) continue
        const b = BAY[((y & 3) << 2) | (x & 3)]
        if (FADE < 1 && b >= FADE) continue
        if (d2 <= 1) {
          const gran = noise(dx * 9 + t * 0.7 + o.a * 20, dy * 9 + t * 0.3)
          const lum = 1 - 0.5 * d2 + (gran - 0.5) * 0.55
          buf[i] = body[clamp(Math.floor(lum * 4.4 + b - 0.6), 0, 4)]
        } else {
          const d = Math.sqrt(d2)
          const ray = noise(Math.atan2(dy, dx) * (64 / Math.PI), t * 2.2 + o.a * 30)
          let I = ((0.35 + 1.3 * ray * ray) / (d2 * d)) * fl * (1 - (d - 1) / 2.4)
          I = I * 4 + b - 0.5
          if (I < 1) continue
          const c = cor[I > 4 ? 3 : (I | 0) - 1]
          addAt(i, cr(c) * 0.75, cg(c) * 0.75, cb(c) * 0.75)
        }
      }
    }
    // Lens flare: a horizontal streak and a few ghosts mirrored through the centre of view.
    const fc = pal.flare, R = cr(fc), G = cg(fc), B = cb(fc)
    const len = Math.min(W * 0.9, r * 10)
    if (len > 6) {
      const yy = Math.round(sy - 0.5)
      for (let x = Math.max(0, Math.floor(sx - len)); x <= Math.min(W - 1, sx + len); x++) {
        const k = (1 - Math.abs(x - sx) / len) * 0.75 * FADE
        if (k <= 0) continue
        add(x, yy, R * k, G * k, B * k)
        if (bay(x, yy) < k) add(x, yy + (x & 1 ? 1 : -1), R * k * 0.4, G * k * 0.4, B * k * 0.4)
      }
      const vx = CX - sx, vy = CY - sy
      const ghosts = [[1.4, 0.45, K.sky], [1.8, 0.25, K.lime], [2.3, 0.7, K.pink]]
      for (const [f, s, c] of ghosts) glow(sx + vx * f, sy + vy * f, Math.max(1.5, r * s), c, 0.5 * FADE)
    }
  }

  // Black hole: a black shadow, a thin photon ring, the far side of the disc lensed over the top,
  // and a swirling, Doppler-brightened accretion disc in front.
  function diskColor(rr, ang, b) {
    const heat = 1 - (rr - 1.25) / 2.25
    const swirl = 0.5 + 0.5 * Math.sin(ang * 3 + 9 / rr - t * 2.4)
    const dop = 0.72 + 0.4 * Math.cos(ang)
    const l = heat * dop * (0.85 + 0.35 * swirl)
    const lvl = Math.floor(l * 7.2 + b - 0.7)
    return lvl < 0 ? 0 : DISK[lvl > 6 ? 6 : lvl]
  }
  function drawHole(o, sx, sy, r) {
    const rs = r / 3.4 // shadow radius
    if (r < 2) {
      if (bay(sx | 0, sy | 0) < FADE) put(sx, sy, K.orange)
      return
    }
    const co = Math.cos(o.tilt), si = Math.sin(o.tilt), ifl = 1 / o.rflat
    const e = r * 1.02
    const x0 = Math.max(0, Math.floor(sx - e)), x1 = Math.min(W - 1, Math.ceil(sx + e))
    const y0 = Math.max(0, Math.floor(sy - e)), y1 = Math.min(H - 1, Math.ceil(sy + e))
    const ir = 1 / rs
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - sy) * ir
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const dx = (x + 0.5 - sx) * ir
        const b = BAY[((y & 3) << 2) | (x & 3)]
        if (FADE < 1 && b >= FADE) continue
        const d2 = dx * dx + dy * dy
        const u = dx * co + dy * si
        const ws = -dx * si + dy * co // screen-space height above/below the disc plane
        const w = ws * ifl
        const rr = Math.sqrt(u * u + w * w)
        const inDisk = rr > 1.25 && rr < 3.5
        let c = 0
        // Far half of the disc, behind everything.
        if (inDisk && w < 0) c = diskColor(rr, Math.atan2(w, u), b)
        // Lensed image of the far disc: an arc hugging the shadow, thick on top and thin below.
        if (d2 < 3.4 && d2 >= 1) {
          const d = Math.sqrt(d2)
          const up = -ws / d
          const th = 0.12 + (up > 0 ? 0.62 * up * up : 0.18 * up * up)
          const f = (d - 1) / th
          if (f < 1) {
            const ang = Math.atan2(dy, dx)
            const l = (1 - f) * (0.8 + 0.2 * Math.sin(ang * 3 - t * 2)) * (0.8 + (0.3 * u) / d)
            const lvl = Math.floor(l * 7 + b - 0.4)
            if (lvl > 0) c = DISK[lvl > 6 ? 6 : lvl]
          }
        }
        if (d2 < 1) c = d2 > 0.86 ? K.wine : K.black
        if (d2 >= 1 && d2 < 1.12) c = b < 0.6 ? K.white : K.yellow // photon ring
        // Near half of the disc crosses in front of the shadow.
        if (inDisk && w >= 0) {
          const dc = diskColor(rr, Math.atan2(w, u), b)
          if (dc) c = dc
        }
        if (c) buf[i] = c
        else if (d2 < 9) blendAt(i, K.void, 0.5 * (1 - d2 / 9)) // the space nearby looks darker
      }
    }
  }

  // Nebula: a dithered cloud of glowing gas with a dark dust lane and a few young stars inside.
  function drawNebula(o, sx, sy, r) {
    if (r < 2) return
    const big = Math.max(W, H)
    const A = clamp((2.6 * big) / r - 0.6, 0, 1) * 0.8 * FADE // fades as we fly into it
    if (A <= 0.02) return
    const x0 = Math.max(0, Math.floor(sx - r)), x1 = Math.min(W - 1, Math.ceil(sx + r))
    const y0 = Math.max(0, Math.floor(sy - r)), y1 = Math.min(H - 1, Math.ceil(sy + r))
    const ir = 1 / r, pal = o.ramp
    const ou = o.a * 15, ov = o.b * 15
    for (let y = y0; y <= y1; y++) {
      const ny = (y + 0.5 - sy) * ir
      for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
        const nx = (x + 0.5 - sx) * ir
        const d2 = nx * nx + ny * ny
        if (d2 > 1) continue
        const n1 = noise(nx * 24 + ou, ny * 24 + ov)
        const n2 = noise(nx * 55 + ov, ny * 55 + ou)
        let dens = (n1 * 0.7 + n2 * 0.3) * (1 - d2) * 2.1 - 0.35
        const dust = noise(nx * 18 + 70, ny * 40 + 20)
        if (dust < 0.32) dens -= 0.5
        if (dens <= 0) continue
        const b = BAY[((y & 3) << 2) | (x & 3)]
        const lvl = Math.floor(dens * 3.2 + b - 0.5)
        if (lvl < 0) continue
        blendAt(i, pal[lvl > 2 ? 2 : lvl], A * (0.42 + 0.22 * (lvl > 2 ? 2 : lvl)))
      }
    }
    for (let k = 0; k < 5; k++) {
      const a = o.c + k * 2.1, d = 0.15 + ((k * 37) % 10) / 20
      const px = sx + Math.cos(a) * d * r, py = sy + Math.sin(a) * d * r * 0.8
      add(px, py, 255 * A, 241 * A, 232 * A)
      if (r > 30) glow(px, py, 2.5, pal[2], A)
    }
  }

  // Comet: an icy head in a bright coma, with a blue ion tail and a broader, curving dust tail.
  function drawComet(o, sx, sy, r) {
    const hr = Math.max(0.6, r)
    const L = Math.max(10, hr * 30)
    const ca = Math.cos(o.tilt), sa = Math.sin(o.tilt)
    for (let s = 1; s < L; s++) {
      const f = s / L
      const wid = 0.6 + s * 0.06
      for (let j = -Math.ceil(wid); j <= Math.ceil(wid); j++) {
        const fall = 1 - Math.abs(j) / (wid + 0.5)
        if (fall <= 0) continue
        // ion tail (straight)
        let k = (1 - f) * fall * 0.9 * FADE
        let px = sx + ca * s - sa * j, py = sy + sa * s + ca * j
        if (bay(px | 0, py | 0) < k * 1.4) add(px, py, 41 * k * 2, 173 * k * 2, 255 * k * 2)
        // dust tail (curves away)
        const bend = f * f * L * 0.35
        k = (1 - f) * fall * 0.55 * FADE
        px = sx + ca * s - sa * (j * 1.6 + bend)
        py = sy + sa * s + ca * (j * 1.6 + bend)
        if (bay(px | 0, py | 0) < k * 1.2) add(px, py, 255 * k, 204 * k, 170 * k)
      }
    }
    glow(sx, sy, hr * 3 + 1.5, K.sky, 1.1 * FADE)
    put(sx, sy, K.white)
    if (hr > 1.5) glow(sx, sy, hr, K.white, 1.6 * FADE)
  }

  // Space station: a spinning wheel with lit windows, spokes, a hub, a mast and blinking lights.
  const HULL = ramp('blue grey lav silver white')
  function drawStation(o, sx, sy, r) {
    if (r < 2) {
      if (bay(sx | 0, sy | 0) < FADE) put(sx, sy, (t * 2) % 1 < 0.5 ? K.white : K.red)
      return
    }
    const co = Math.cos(o.tilt), si = Math.sin(o.tilt), fl = o.rflat, ifl = 1 / fl
    const spin = o.rot
    const e = r * 1.08
    const x0 = Math.max(0, Math.floor(sx - e)), x1 = Math.min(W - 1, Math.ceil(sx + e))
    const y0 = Math.max(0, Math.floor(sy - e)), y1 = Math.min(H - 1, Math.ceil(sy + e))
    const hull = HULL
    const ring = (front) => {
      for (let y = y0; y <= y1; y++) {
        const dy = (y + 0.5 - sy) / r
        for (let x = x0, i = y * W + x0; x <= x1; x++, i++) {
          const dx = (x + 0.5 - sx) / r
          const u = dx * co + dy * si, w = (-dx * si + dy * co) * ifl
          if (front ? w < 0 : w >= 0) continue
          const rr = Math.sqrt(u * u + w * w)
          if (rr < 0.8 || rr > 1.02) continue
          const b = BAY[((y & 3) << 2) | (x & 3)]
          if (FADE < 1 && b >= FADE) continue
          const tube = (rr - 0.91) / 0.11 // -1 inner edge .. 1 outer edge
          const ang = Math.atan2(w, u) + spin
          const lum = 0.5 + (0.35 * (u * LXd + w * LYd)) / rr - tube * tube * 0.3 - tube * 0.15 + (front ? 0.12 : -0.12)
          let c = hull[clamp(Math.floor(lum * 4 + b - 0.4), 0, 4)]
          const seg = ((ang / 6.283) * 48 + 480) | 0
          if (Math.abs(tube) < 0.3 && r > 6 && seg % 3 === 1) c = (seg * 7) % 5 === 0 ? K.sky : front ? K.yellow : K.orange
          if (seg % 12 === 0 && r > 5) c = hull[1] // section joints
          buf[i] = c
        }
      }
    }
    const spokes = () => {
      for (let k = 0; k < 4; k++) {
        const a = spin + (k * Math.PI) / 2
        for (let s = 0.2; s < 0.82; s += 0.5 / r) {
          const u = Math.cos(a) * s, w = Math.sin(a) * s * fl
          const px = sx + u * co - w * si, py = sy + u * si + w * co
          if (bay(px | 0, py | 0) < FADE) put(px, py, k & 1 ? K.grey : K.lav)
        }
      }
    }
    ring(false)
    spokes()
    // mast through the hub, with solar panels on either side
    const mast = r * 0.7
    for (let s = -mast; s <= mast; s += 1) {
      const px = sx + si * s, py = sy - co * s
      put(px, py, s < 0 ? K.silver : K.grey)
      if (r > 8 && Math.abs(Math.abs(s) - mast * 0.6) < mast * 0.2) {
        for (let j = 1; j < r * 0.28; j++) {
          put(px + co * j, py + si * j, (j & 1) ? K.cobalt : K.blue)
          put(px - co * j, py - si * j, (j & 1) ? K.cobalt : K.blue)
        }
      }
    }
    const hr = Math.max(1, r * 0.15)
    for (let y = Math.floor(sy - hr); y <= sy + hr; y++)
      for (let x = Math.floor(sx - hr); x <= sx + hr; x++) {
        const nx = (x + 0.5 - sx) / hr, ny = (y + 0.5 - sy) / hr
        const d2 = nx * nx + ny * ny
        if (d2 > 1) continue
        const lam = nx * LXd + ny * LYd + Math.sqrt(1 - d2) * LZd
        put(x, y, hull[clamp(Math.floor((0.15 + lam) * 4 + bay(x, y) - 0.3), 0, 4)])
      }
    ring(true)
    const blink = (t * 1.5) % 1 < 0.3
    if (blink) {
      add(sx + si * mast, sy - co * mast, 255, 0, 77)
      glow(sx + si * mast, sy - co * mast, 2.5, K.red, 1)
      glow(sx - si * mast, sy + co * mast, 2.5, K.lime, 1)
    }
  }

  // ---------- Ship (seen from behind) ----------
  // Left half of each row, centre column last; the right half is mirrored with darker shading.
  const SHIP_HALF = [
    '..............k',
    '.............kC',
    '............kCc',
    '............kCc',
    '...........kmcc',
    '..........kllmm',
    '.r........kllmm',
    '.k.......kllmmm',
    '.kk....kkllllmm',
    '.klkkkklllllmmm',
    '.kllooolllkkkkm',
    '..kddddddkeeekm',
    '...kkkkkkkeeekd',
    '.........kkkkkk'
  ]
  const SHIP_W = 29, SHIP_H = SHIP_HALF.length, SHIP_C = 14
  const MIRROR = { l: 'd', d: 'l', r: 'g', C: 'c' }
  const SHIP = SHIP_HALF.map((row) => row + row.slice(0, SHIP_C).split('').reverse().map((ch) => MIRROR[ch] || ch).join(''))
  const SHIP_COL = { o: K.tangerine, k: K.black, d: K.lav, m: K.silver, l: K.white, c: K.cobalt, C: K.sky, r: K.red, g: K.lime, e: K.void }
  let shipX = 0, shipY = 0

  function drawShip() {
    const ph = t * 0.31 + 0.5
    const shake = warp > 0.6 ? (Math.random() - 0.5) * warp * 0.9 : 0
    const cx = W / 2 + Math.sin(ph) * W * 0.035 + shake
    const bob = Math.sin(t * 2.1) * 0.7 + Math.sin(t * 0.9) * 0.5
    const bank = Math.cos(ph) * 0.9
    const x0 = Math.round(cx - SHIP_C)
    const y0 = Math.round(H - SHIP_H - Math.max(2, H * 0.06) + bob)
    shipX = x0
    shipY = y0
    // Engine light spills on the hull from below at speed.
    for (let row = 0; row < SHIP_H; row++) {
      const line = SHIP[row]
      for (let col = 0; col < SHIP_W; col++) {
        const ch = line[col]
        if (ch === '.') continue
        const off = Math.round(((bank * (col - SHIP_C)) / SHIP_C) * 1.6)
        put(x0 + col, y0 + row + off, SHIP_COL[ch])
      }
    }
    // Blinking nav lights on the wing tips.
    if ((t * 1.2) % 1 < 0.5) {
      glow(x0 + 1.5, y0 + 6.5 + Math.round(-bank * 1.5), 2.4, K.red, 1.2)
      glow(x0 + 27.5, y0 + 6.5 + Math.round(bank * 1.5), 2.4, K.lime, 1.2)
    }
    // Engines: flicker and grow with speed; at warp they burn white-hot with a long plume.
    const flick = 0.75 + 0.25 * Math.sin(t * 37) * Math.sin(t * 23 + 1)
    const s = throttle
    for (const ex of [11.5, 17.5]) {
      const exs = x0 + ex
      const eys = y0 + 12 + Math.round(((bank * (ex - SHIP_C - 0.5)) / SHIP_C) * 1.6)
      glow(exs, eys, (2.2 + s * 4.5 + warp * 3) * flick, warp > 0.5 ? K.lav : K.cobalt, 1.3 + s)
      glow(exs, eys, (1.4 + s * 2.2) * flick, K.sky, 1.6 + s)
      const plume = Math.round((1 + s * 5 + warp * 5) * flick)
      for (let j = 0; j < plume; j++) {
        const k = 1 - j / (plume + 1)
        add(exs - 1, eys + j, 41 * k, 173 * k, 255 * k)
        add(exs, eys + j, 120 * k, 220 * k, 255 * k)
      }
      put(exs - 1, eys - 0.5, K.white)
      put(exs, eys - 0.5, K.white)
      if (s > 0.35) {
        put(exs - 1, eys + 0.5, K.white)
        put(exs, eys + 0.5, K.white)
      }
    }
    if (boostSpark > 0) glow(x0 + SHIP_C + 0.5, y0 + 6, 6 + (1 - boostSpark) * 10, K.yellow, boostSpark * 1.5)
  }

  // ---------- HUD ----------
  let hudSpeed = '', hudDist = '', hudDirty = true, hudTimer = 0
  let hudCol = K.sky
  const HUD_SHADOW = K.void
  function fmtDist(au) {
    if (au >= 63241) return (au / 63241).toFixed(au >= 632410 ? 1 : 3) + ' LY'
    if (au >= 1000) return Math.round(au) + ' AU'
    return au.toFixed(au >= 100 ? 1 : 2) + ' AU'
  }
  function refreshHud() {
    hudSpeed = throttle < 0.55 ? 'SPEED ' + speedC().toFixed(2) + 'C' : 'WARP ' + Math.min(9.9, warpFactor()).toFixed(1)
    hudDist = fmtDist(savedAU + sessionAU)
  }
  function drawHud() {
    const warpOn = throttle >= 0.55
    const label = warpOn && throttle > 0.97 && (t * 3) % 1 < 0.35 ? K.white : warpOn ? K.yellow : hudCol
    text(hudSpeed, 2, 2, label, HUD_SHADOW)
    // Throttle bar: ten segments, cool to hot.
    const segs = Math.round(throttle * 10)
    const SEG = [K.cobalt, K.cobalt, K.sky, K.sky, K.sky, K.lime, K.lime, K.yellow, K.orange, K.red]
    for (let k = 0; k < 10; k++) {
      const c = k < segs ? SEG[k] : K.bg3
      for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) put(2 + k * 3 + x, 8 + y, c)
    }
    const dw = hudDist.length * 4 - 1
    const sw = hudSpeed.length * 4 - 1
    if (W >= sw + dw + 10) text(hudDist, W - 2 - dw, 2, hudCol, HUD_SHADOW)
    else text(hudDist, 2, 12, hudCol, HUD_SHADOW)
    if (!typedEver && t < 10 && throttle < 0.05) {
      const msg = W >= 80 ? 'TYPE TO GO FASTER' : 'TYPE TO FLY'
      const a = clamp((10 - t) / 2, 0, 1) * clamp(t - 1, 0, 1)
      if (a > 0) {
        const mw = msg.length * 4 - 1
        const y = Math.round(shipY - 9)
        if (y > 14) text(msg, Math.round((W - mw) / 2), y, a > 0.5 ? K.lav : K.blue, HUD_SHADOW)
      }
    }
  }

  // ---------- Frame ----------
  function update(dt) {
    t += dt
    const inst = pending / dt
    pending = 0
    rate += (inst - rate) * (1 - Math.exp(-dt / 1.6))
    const target = Math.min(1, Math.pow(rate / 7, 0.85))
    // Climb toward the target over a few seconds, coast back down over ~15-20 seconds.
    throttle += (target - throttle) * (1 - Math.exp(-dt / (target > throttle ? 4.5 : 6.5)))
    if (throttle < 0.0005) throttle = 0
    const before = warp
    warp = clamp((throttle - 0.5) / 0.4, 0, 1)
    if (before < 0.12 && warp >= 0.12) flash = 1
    flash = Math.max(0, flash - dt * 2.2)
    boostSpark = Math.max(0, boostSpark - dt * 2.5)
    speed = 0.6 + 9.4 * Math.pow(throttle, 2.2)
    sessionAU += (speedC() * dt) / 499
    CX = W / 2 + Math.sin(t * 0.31) * W * 0.02
    CY = H * 0.42 + Math.sin(t * 0.23) * H * 0.012
    updateStars(dt)
    updateObjects(dt)
    hudTimer -= dt
    if (hudTimer <= 0 || hudDirty) {
      hudTimer = 0.25
      hudDirty = false
      refreshHud()
    }
  }

  function render() {
    if (!buf) return
    buf.set(bgBuf)
    // Find a black hole (for lensing) and sort the objects far to near.
    let n = 0
    bhOn = false
    for (const o of POOL) {
      if (!o.on) continue
      ORDER[n++] = o
      if (o.type === HOLE) {
        const r = (o.R * F) / o.z
        if (r > 3) {
          bhOn = true
          bhX = CX + (o.x * F) / o.z
          bhY = CY + (o.y * F) / o.z
          bhR = r / 3.4
          bhZ = o.z
        }
      }
    }
    for (let i = 1; i < n; i++) {
      const o = ORDER[i]
      let j = i - 1
      while (j >= 0 && ORDER[j].z < o.z) {
        ORDER[j + 1] = ORDER[j]
        j--
      }
      ORDER[j + 1] = o
    }
    drawStars(false)
    for (let i = 0; i < n; i++) {
      const o = ORDER[i]
      const sx = CX + (o.x * F) / o.z, sy = CY + (o.y * F) / o.z, r = (o.R * F) / o.z
      FADE = clamp((o.z0 - o.z) / (o.z0 * 0.18), 0, 1)
      if (o.type === AST) drawAsteroid(o, sx, sy, r)
      else if (o.type === PLANET) drawPlanet(o, sx, sy, r)
      else if (o.type === SUN) drawSun(o, sx, sy, r)
      else if (o.type === HOLE) drawHole(o, sx, sy, r)
      else if (o.type === NEB) drawNebula(o, sx, sy, r)
      else if (o.type === COMET) drawComet(o, sx, sy, r)
      else if (o.type === STATION) drawStation(o, sx, sy, r)
    }
    FADE = 1
    drawStars(true)
    // Jumping to warp: a ring of light bursts out from the vanishing point.
    if (flash > 0) {
      const rad = (1 - flash) * Math.max(W, H) * 0.9
      for (let a = 0; a < 6.283; a += 1 / Math.max(8, rad)) {
        const k = flash * 0.9
        add(CX + Math.cos(a) * rad, CY + Math.sin(a) * rad * 0.8, 200 * k, 230 * k, 255 * k)
      }
    }
    drawShip()
    drawHud()
    g.putImageData(img, 0, 0)
  }

  // ~22 frames a second; nothing runs while the panel is hidden.
  let running = false, raf = 0, lastT = 0, lastDraw = 0
  function frame(now) {
    raf = requestAnimationFrame(frame)
    if (now - lastDraw < 44) return
    lastDraw = now
    const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000))
    lastT = now
    update(dt)
    render()
  }
  function startLoop() {
    if (running || document.hidden) return
    running = true
    lastT = lastDraw = performance.now()
    raf = requestAnimationFrame(frame)
  }
  function stopLoop() {
    running = false
    cancelAnimationFrame(raf)
  }

  // ---------- Saved distance ----------
  function save() {
    if (loaded) OpenTex.storage.set('distanceAU', savedAU + sessionAU)
  }
  OpenTex.storage.get('distanceAU').then((v) => {
    if (typeof v === 'number' && isFinite(v) && v > 0) savedAU = v
    loaded = true
    hudDirty = true
  })
  setInterval(() => {
    if (!document.hidden) save()
  }, 5000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      save()
      stopLoop()
    } else startLoop()
  })
  window.addEventListener('pagehide', save)

  // ---------- Theme ----------
  OpenTex.onTheme((theme) => {
    const a = theme && theme.colors && theme.colors.accent
    if (typeof a === 'string' && /^#[0-9a-f]{6}$/i.test(a)) {
      // A light tint of the accent so the HUD reads on dark space in both themes.
      const n = parseInt(a.slice(1), 16)
      const mixw = (v) => Math.round(v + (255 - v) * 0.45)
      hudCol = (0xff000000 | (mixw(n & 255) << 16) | (mixw((n >> 8) & 255) << 8) | mixw(n >> 16)) >>> 0
    }
  })

  // ---------- Easter egg: click the ship for a boost ----------
  cv.addEventListener('click', (e) => {
    const r = cv.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H
    if (x >= shipX - 3 && x <= shipX + SHIP_W + 3 && y >= shipY - 3 && y <= shipY + SHIP_H + 4) {
      pending += 22
      throttle = Math.min(1, throttle + 0.06)
      boostSpark = 1
    }
  })

  // ---------- Start ----------
  new ResizeObserver(layout).observe(frameEl)
  layout()
  // Something to look at straight away: a few rocks and a big object on its way.
  // `#demo=<kind>` puts that object close by, for trying things out.
  const demo = /demo=(\w+)(?:,([\d.]+))?/.exec(location.hash)
  if (!demo) for (let k = 0; k < 6; k++) spawn(AST, rnd(1.5, 6.5))
  if (demo && NAMES[demo[1]]) {
    distSmall = -4
    const o = spawn(NAMES[demo[1]])
    if (o) o.z = Number(demo[2]) || 1.5 // skip most of the approach
    if (o && demo[1] === 'ringed' && o.type === PLANET) {
      o.ring = true
      o.kind = 0
      o.ramps = GAS[3]
      o.ext = 2.3
    }
    if (o && demo[1] === 'planet') o.ring = false
    distBig = -8
  } else {
    spawn(Math.random() < 0.6 ? PLANET : pick([SUN, NEB, STATION, HOLE]), 9)
  }
  startLoop()
})()
