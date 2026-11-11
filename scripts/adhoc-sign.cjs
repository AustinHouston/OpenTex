// electron-builder afterSign hook. Without an Apple Developer ID certificate the app would ship with
// Electron's original signature, which no longer matches once our files are added. macOS then calls
// the downloaded app "damaged". An ad-hoc signature keeps it valid, so users get the ordinary
// "unidentified developer" prompt instead. With a real certificate (CSC_LINK set) this does nothing.
const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${app}`)
}
