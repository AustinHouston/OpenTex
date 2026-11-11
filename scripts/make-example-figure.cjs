// Draws templates/example-paper/figures/example-plot.png, the figure in the example paper.
// Run with: npx electron scripts/make-example-figure.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')

const html = `<canvas id="c" width="1800" height="1100"></canvas><script>
const c = document.getElementById('c').getContext('2d')
const W = 1800, H = 1100, L = 220, R = 60, T = 60, B = 170
c.fillStyle = '#fff'; c.fillRect(0, 0, W, H)
const xmax = 20, ymin = -1.1, ymax = 1.1
const X = (t) => L + (t / xmax) * (W - L - R)
const Y = (v) => T + ((ymax - v) / (ymax - ymin)) * (H - T - B)
const model = (t) => Math.exp(-t / 6) * Math.cos(1.6 * t)
// Axes and ticks
c.strokeStyle = '#222'; c.lineWidth = 3
c.strokeRect(L, T, W - L - R, H - T - B)
c.font = '44px Helvetica, Arial'; c.fillStyle = '#222'; c.textAlign = 'center'
for (let t = 0; t <= xmax; t += 5) { c.beginPath(); c.moveTo(X(t), H - B); c.lineTo(X(t), H - B - 18); c.stroke(); c.fillText(String(t), X(t), H - B + 56) }
c.textAlign = 'right'
for (let v = -1; v <= 1.001; v += 0.5) { c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(L + 18, Y(v)); c.stroke(); c.fillText(v.toFixed(1), L - 18, Y(v) + 15) }
c.textAlign = 'center'; c.font = '50px Helvetica, Arial'
c.fillText('Time (ms)', L + (W - L - R) / 2, H - 40)
c.save(); c.translate(70, T + (H - T - B) / 2); c.rotate(-Math.PI / 2); c.fillText('Signal (a.u.)', 0, 0); c.restore()
// Zero line
c.strokeStyle = '#bbb'; c.lineWidth = 2; c.setLineDash([12, 10]); c.beginPath(); c.moveTo(L, Y(0)); c.lineTo(W - R, Y(0)); c.stroke(); c.setLineDash([])
// Model line
c.strokeStyle = '#2c4f9e'; c.lineWidth = 6; c.beginPath()
for (let i = 0; i <= 600; i++) { const t = (i / 600) * xmax; i ? c.lineTo(X(t), Y(model(t))) : c.moveTo(X(t), Y(model(t))) }
c.stroke()
// "Measured" points with error bars (fixed pseudo-random noise so the figure never changes)
let s = 3; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5)
c.fillStyle = '#e07a3f'; c.strokeStyle = '#e07a3f'; c.lineWidth = 3
for (let t = 0.4; t < xmax; t += 0.55) {
  const v = model(t) + rnd() * 0.16, err = 0.06 + Math.abs(rnd()) * 0.05
  c.beginPath(); c.moveTo(X(t), Y(v - err)); c.lineTo(X(t), Y(v + err)); c.stroke()
  c.beginPath(); c.arc(X(t), Y(v), 11, 0, Math.PI * 2); c.fill()
}
// Legend
c.font = '44px Helvetica, Arial'; c.textAlign = 'left'
const lx = W - R - 470, ly = T + 70
c.fillStyle = '#e07a3f'; c.beginPath(); c.arc(lx + 30, ly - 14, 11, 0, Math.PI * 2); c.fill()
c.fillStyle = '#222'; c.fillText('Measured', lx + 75, ly)
c.strokeStyle = '#2c4f9e'; c.lineWidth = 6; c.beginPath(); c.moveTo(lx, ly + 56); c.lineTo(lx + 60, ly + 56); c.stroke()
c.fillText('Model, Eq. (1)', lx + 75, ly + 70)
</script>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1800, height: 1100, show: false, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0">' + html))
  const data = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')")
  writeFileSync(join(__dirname, '..', 'templates', 'example-paper', 'figures', 'example-plot.png'), Buffer.from(data.split(',')[1], 'base64'))
  console.log('wrote templates/example-paper/figures/example-plot.png')
  app.quit()
})
