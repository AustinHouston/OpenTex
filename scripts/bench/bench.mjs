// OpenTex speed benchmark: how the app feels to a real user, measured in the real app.
//
//   npm run build && node scripts/bench/bench.mjs [options]
//     --app <dir>        the OpenTex checkout to run (default: this one; run `npm run build` first)
//     --port <n>         remote-debugging port (default 9350)
//     --label <text>     name for this run in the report
//     --settings <json>  settings to start with, e.g. '{"livePreview":true}'
//     --panels <list>    panels to show besides Files/PDF/Comments, e.g. plugin:writing-garden,outline
//     --runs <n>         repeat the whole measurement and report the median of each number (default 1)
//     --json <file>      also append the results to this file (one JSON object per line)
//     --live             also measure Live preview (turn it on with --settings '{"livePreview":true}'):
//                        typing in bursts while PDFs rebuild and swap, last keystroke -> new PDF on
//                        screen, the background TeX processes' CPU, and CPU 10-20 s after typing
//
// It makes a ~3,000-line test paper (scripts/bench/make-project.mjs), starts OpenTex with a fresh
// profile, opens the paper and measures:
//   startup        launch -> start page ready
//   open           click a recent project -> text on screen
//   typing         keypress -> painted, while typing 150 characters at ~12/s (median, 95th percentile, worst)
//   long tasks     main-thread stalls over 50 ms while typing (they feel like stutter)
//   CPU            all OpenTex processes: idle (10 s, project open) and while typing (incl. 5 s after)
//   scrolling      frame times while scrolling the long file (frames over 33 ms feel janky)
//   memory         resident memory of all OpenTex processes, and the page's JavaScript heap
//   compile        Compile button -> finished, for the test paper
//   texCpu         (always) CPU of TeX and other helper processes the app starts while typing,
//                  sampled every 100 ms (ps can't see a process after it exits)
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const app = path.resolve(arg('app', path.join(here, '../..')))
const port = Number(arg('port', '9350'))
const label = arg('label', path.basename(app))
const extraSettings = JSON.parse(arg('settings', '{}'))
const panels = (arg('panels', '') || '').split(',').filter(Boolean)
const runs = Number(arg('runs', '1'))
const jsonOut = arg('json', null)
const liveMode = process.argv.includes('--live')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0)
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0)

/** CPU seconds and resident memory of every process started with this profile folder. */
function procStats(profile) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,rss=,time=,command='], { encoding: 'utf8', maxBuffer: 1 << 24 })
  let cpu = 0
  let rss = 0
  let n = 0
  for (const line of out.split('\n')) {
    if (!line.includes(profile)) continue
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)\s/)
    if (!m) continue
    const t = m[3].split(':').map(Number)
    cpu += t.reduce((s, v) => s * 60 + v, 0)
    rss += Number(m[2]) * 1024
    n++
  }
  return { cpu, rss, n }
}

/** CPU seconds of the app's helper processes (TeX, SyncTeX…): same process group, not the app itself. */
function helperCpu(group, profile) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,time=,command='], { encoding: 'utf8', maxBuffer: 1 << 24 })
  const seen = new Map()
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/)
    if (!m || Number(m[2]) !== group || m[4].includes(profile) || /node_modules\/\.bin\/electron/.test(m[4])) continue
    seen.set(m[1], m[3].split(':').map(Number).reduce((s, v) => s * 60 + v, 0))
  }
  return seen
}
/** Polls helper processes every 100 ms and adds up the CPU each one used before it exited. */
function helperSampler(group, profile) {
  const best = new Map()
  const tick = () => {
    try {
      for (const [pid, cpu] of helperCpu(group, profile)) best.set(pid, Math.max(cpu, best.get(pid) ?? 0))
    } catch {
      /* ps busy */
    }
  }
  tick()
  const timer = setInterval(tick, 100)
  const base = new Map(best)
  return {
    total: () => [...best].reduce((s, [pid, cpu]) => s + cpu - (base.get(pid) ?? 0), 0),
    count: () => [...best.keys()].filter((p) => !base.has(p)).length,
    stop: () => (tick(), clearInterval(timer))
  }
}

async function once() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `opentex-bench-${port}-`))
  const paper = path.join(tmp, 'paper')
  const profile = path.join(tmp, 'profile')
  execFileSync(process.execPath, [path.join(here, 'make-project.mjs'), paper], { stdio: 'ignore' })
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ recentProjects: [paper], checkForUpdates: false, ...extraSettings }))

  const t0 = Date.now()
  const proc = spawn(path.join(app, 'node_modules/.bin/electron'), [app, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], { detached: true, stdio: 'ignore' })
  const r = { label }
  let ws
  try {
    let target
    for (let i = 0; i < 300 && !target; i++) {
      await wait(100)
      target = await fetch(`http://127.0.0.1:${port}/json`).then((x) => x.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null)
    }
    if (!target) throw new Error('OpenTex did not start')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      pending.get(d.id)?.(d)
      pending.delete(d.id)
    }
    await new Promise((res) => (ws.onopen = res))
    const call = (method, params = {}) => new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
    const ev = async (expr) => {
      const x = await call('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, returnByValue: true, awaitPromise: true })
      if (x.result.exceptionDetails) throw new Error(x.result.exceptionDetails.exception?.description ?? 'page error')
      return x.result.result.value
    }
    const until = async (expr, ms = 30000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await ev(expr).catch(() => false)) return true
        await wait(25)
      }
      return false
    }
    await call('Performance.enable')
    const heap = async () => (await call('Performance.getMetrics')).result.metrics.find((m) => m.name === 'JSHeapUsedSize').value

    // Startup and opening the paper.
    await until(`return !!document.querySelector('#wl-recent li .open')`)
    r.startupMs = Date.now() - t0
    const t1 = Date.now()
    await ev(`document.querySelector('#wl-recent li .open').click(); return 1`)
    await until(`return !document.body.classList.contains('no-project') && document.querySelectorAll('.cm-line').length > 5`)
    r.openMs = Date.now() - t1
    for (const p of panels) await ev(`document.querySelector('#btn-panels').click(); await new Promise(r=>setTimeout(r,150)); const b=[...document.querySelectorAll('#ctx-menu button')].find(b=>b.textContent.toLowerCase().includes(${JSON.stringify(p.replace(/^plugin:/, '').replace(/-/g, ' '))})); b ? b.click() : document.body.click(); return 1`)
    r.panels = await ev(`return [...document.querySelectorAll('[data-panel]')].filter(p=>p.offsetParent && !p.classList.contains('collapsed')).map(p=>p.dataset.panel).join(',')`)
    await wait(4000) // let the PDF, plugins and indexes settle

    // Idle.
    const a = procStats(profile)
    await wait(10000)
    const b = procStats(profile)
    r.idleCpuPct = +(((b.cpu - a.cpu) / 10) * 100).toFixed(1)
    r.memoryMB = Math.round(b.rss / 2 ** 20)
    r.processes = b.n
    r.heapMB = +((await heap()) / 2 ** 20).toFixed(1)

    // Typing in the middle of a long section.
    await ev(`[...document.querySelectorAll('.tree .row')].find(r=>r.title==='sections/results.tex').click(); return 1`)
    await wait(800)
    await ev(`const s=document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight/2; return 1`)
    await wait(400)
    const pt = await ev(`const ls=[...document.querySelectorAll('.cm-line')].filter(l=>l.textContent.length>40); const l=ls[Math.floor(ls.length/2)]; const b=l.getBoundingClientRect(); const v=document.querySelector('.cm-content').getBoundingClientRect(); const sr=document.querySelector('.cm-scroller').getBoundingClientRect(); return {x:Math.min(b.left+b.width-4, sr.right-24, v.right-4), y:b.top+8}`)
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await ev(`window.__lat=[]; window.__long=[];
      document.addEventListener('keydown', () => { const t0 = performance.now(); requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => window.__lat.push(performance.now() - t0); c.port2.postMessage(0) }) }, true);
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask' }); return 1`)
    const text = ' the measured signal shows a clear decay within four nanoseconds and we fit it with a damped model that matches every run in this study'
    const c0 = procStats(profile)
    const helpers = helperSampler(proc.pid, profile)
    const typeStart = Date.now()
    for (const ch of text.slice(0, 150)) {
      const key = ch === ' ' ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 } : { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }
      await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...key })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      await wait(80)
    }
    await wait(5000) // background work after typing (saving, live preview, plugins)
    const c1 = procStats(profile)
    const lat = await ev(`return window.__lat`)
    const longs = await ev(`return window.__long`)
    r.typingMedianMs = +median(lat).toFixed(1)
    r.typingP95Ms = +pct(lat, 0.95).toFixed(1)
    r.typingWorstMs = +Math.max(...lat).toFixed(1)
    r.longTasks = longs.length
    r.longTaskTotalMs = Math.round(longs.reduce((s, x) => s + x, 0))
    r.typingCpuPct = +(((c1.cpu - c0.cpu) / ((Date.now() - typeStart) / 1000)) * 100).toFixed(1)
    helpers.stop()
    // The keystrokes must land in the text (a click beside the editor once left them going nowhere).
    r.typedIntoEditor = await ev(`return document.querySelector('.cm-content').textContent.includes('decay within four nanoseconds')`)
    r.typingTexCpuPct = +((helpers.total() / ((Date.now() - typeStart) / 1000)) * 100).toFixed(1)
    r.typingTexProcesses = helpers.count()

    if (liveMode) {
      // Typing in bursts with pauses of different lengths, so new PDFs arrive and get drawn while typing goes on.
      await ev(`window.__lat=[]; window.__long=[]; document.addEventListener('keydown', () => (window.__lastKeyAt = Date.now()), true); return 1`)
      const shown = async () => Number((await ev(`return document.querySelector('#pdf').dataset.liveShownAt || 0`)) || 0)
      let lastKeyAt = 0
      const typeWord = async (w) => {
        for (const ch of w) {
          lastKeyAt = Date.now()
          const key = ch === ' ' ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 } : { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }
          await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...key })
          await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
          await wait(80)
        }
      }
      const h0 = procStats(profile)
      const hs = helperSampler(proc.pid, profile)
      const liveStart = Date.now()
      const builds0 = Number((await ev(`return document.querySelector('#pdf').dataset.liveBuilds || 0`)) || 0)
      for (const pause of [1000, 1900, 1300, 2600, 1600, 2200]) {
        await typeWord(' and more words')
        await wait(pause)
      }
      const burstLat = await ev(`return window.__lat`)
      const burstLong = await ev(`return window.__long`)
      r.liveTypingP95Ms = +pct(burstLat, 0.95).toFixed(1)
      r.liveTypingWorstMs = +Math.max(...burstLat).toFixed(1)
      r.liveLongTasks = burstLong.length
      r.liveLongTaskWorstMs = Math.round(Math.max(0, ...burstLong))
      // Last keystroke -> new PDF on screen, in clean rounds.
      const upd = []
      const builds = []
      for (let i = 0; i < 3; i++) {
        const before = await shown()
        await typeWord(' word')
        const lastKey = await ev(`return window.__lastKeyAt`)
        await until(`return Number(document.querySelector('#pdf').dataset.liveShownAt || 0) > ${before} && Number(document.querySelector('#pdf').dataset.liveShownAt) > ${lastKey}`, 10000)
        const at = await shown()
        if (at > lastKey) upd.push(at - lastKey)
        builds.push(Number(await ev(`return document.querySelector('#pdf').dataset.liveMs || 0`)))
        await wait(1500)
      }
      r.liveUpdateMs = Math.round(median(upd))
      r.liveBuildMs = Math.round(median(builds))
      r.livePasses = Number(await ev(`return document.querySelector('#pdf').dataset.livePasses || 0`))
      r.liveBuilds = Number((await ev(`return document.querySelector('#pdf').dataset.liveBuilds || 0`)) || 0) - builds0
      r.liveErrors = Number((await ev(`return document.querySelector('#pdf').dataset.liveErrors || 0`)) || 0)
      const h1 = procStats(profile)
      r.liveCpuPct = +(((h1.cpu - h0.cpu + hs.total()) / ((Date.now() - liveStart) / 1000)) * 100).toFixed(1)
      hs.stop()
      // Quiet again: CPU (app + TeX) from 10 to 20 s after the last keystroke (the editor keeps focus, so its
      // blinking caret, about 2% here, is included with Live preview on and off alike).
      await wait(Math.max(0, lastKeyAt + 10000 - Date.now()))
      const q0 = procStats(profile)
      const qs = helperSampler(proc.pid, profile)
      await wait(10000)
      qs.stop()
      const q1 = procStats(profile)
      r.cpuAfterTypingPct = +(((q1.cpu - q0.cpu + qs.total()) / 10) * 100).toFixed(1)
    }

    // Scrolling.
    const frames = await ev(`const s=document.querySelector('.cm-scroller'); s.scrollTop=0; const f=[]; let last=performance.now();
      await new Promise((done)=>{ let n=0; const step=(t)=>{ f.push(t-last); last=t; s.scrollTop+=60; if(++n<180) requestAnimationFrame(step); else done() }; requestAnimationFrame(step) }); return f.slice(2)`)
    r.scrollP95Ms = +pct(frames, 0.95).toFixed(1)
    r.scrollJankyFrames = frames.filter((x) => x > 33).length

    // Compile.
    const t2 = Date.now()
    await ev(`document.querySelector('#btn-compile').click(); return 1`)
    await wait(300)
    await until(`return !document.querySelector('#btn-compile').classList.contains('busy')`, 120000)
    r.compileMs = Date.now() - t2
    r.compileStatus = await ev(`return document.querySelector('#st-compile').textContent`)
    r.memoryEndMB = Math.round(procStats(profile).rss / 2 ** 20)
    r.heapEndMB = +((await heap()) / 2 ** 20).toFixed(1)
  } finally {
    ws?.close()
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await wait(500)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return r
}

const results = []
for (let i = 0; i < runs; i++) results.push(await once())
const out = { ...results[0] }
if (runs > 1) for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] = median(results.map((x) => x[k]))
out.runs = runs
out.date = new Date().toISOString()
console.log(JSON.stringify(out, null, 2))
if (jsonOut) fs.appendFileSync(jsonOut, JSON.stringify(out) + '\n')
