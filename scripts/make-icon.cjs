// Draws build/icon.png (1024x1024). electron-builder turns it into the macOS and Windows icons.
// Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')

const html = `<canvas id="c" width="1024" height="1024"></canvas><script>
const c = document.getElementById('c').getContext('2d')
const R = (x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r) }
// Body (Apple's grid: 824px square with ~185px corner radius, centered).
const g = c.createLinearGradient(100, 100, 924, 924)
g.addColorStop(0, '#2b7a78'); g.addColorStop(1, '#2c4f9e')
c.shadowColor = 'rgba(0,0,0,0.25)'; c.shadowBlur = 30; c.shadowOffsetY = 12
R(100, 100, 824, 824, 185); c.fillStyle = g; c.fill()
c.shadowColor = 'transparent'
// Page with a folded corner.
c.save(); c.translate(512, 520); c.rotate(-0.06)
c.shadowColor = 'rgba(0,0,0,0.25)'; c.shadowBlur = 24; c.shadowOffsetY = 10
c.beginPath(); c.moveTo(-230, -290); c.lineTo(150, -290); c.lineTo(230, -210); c.lineTo(230, 290); c.lineTo(-230, 290); c.closePath()
c.fillStyle = '#fbfaf6'; c.fill(); c.shadowColor = 'transparent'
c.beginPath(); c.moveTo(150, -290); c.lineTo(150, -210); c.lineTo(230, -210); c.closePath(); c.fillStyle = '#d9dee6'; c.fill()
// Braces and lines of "text".
c.fillStyle = '#2c4f9e'; c.font = '600 250px Menlo, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'
c.fillText('{', -105, -95); c.fillStyle = '#2b7a78'; c.fillText('}', 105, -95)
c.fillStyle = '#e07a3f'; c.beginPath(); c.arc(0, -90, 26, 0, Math.PI * 2); c.fill()
const line = (y, w, col) => { R(-160, y, w, 26, 13); c.fillStyle = col; c.fill() }
line(70, 320, '#3b4a5e'); line(120, 270, '#9aa6b5'); line(170, 300, '#9aa6b5'); line(220, 200, '#9aa6b5')
c.restore()
</script>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, useContentSize: true, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:transparent">' + html))
  const data = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')")
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), Buffer.from(data.split(',')[1], 'base64'))
  console.log('wrote build/icon.png')
  app.quit()
})
