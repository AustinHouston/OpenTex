// "A new version is available" notice. Once a day at most, OpenTex asks GitHub for the latest
// release and, if it is newer, tells the user with a Download link. Nothing is downloaded or
// installed automatically: that suits computers where only IT installs software.
import { app, BrowserWindow, ipcMain, net, shell } from 'electron'
import { loadSettings, saveSettings } from './settings'

const LATEST = 'https://api.github.com/repos/AustinHouston/OpenTex/releases/latest'
const DAY = 24 * 60 * 60 * 1000

export interface UpdateInfo {
  version: string // e.g. '0.4.0'
  url: string // the release page
}

export type UpdateCheck = { status: 'newer'; current: string; info: UpdateInfo } | { status: 'latest'; current: string } | { status: 'offline'; current: string }

/** The running version. OPENTEX_FAKE_VERSION is for testing the notice only. */
const currentVersion = (): string => process.env.OPENTEX_FAKE_VERSION || app.getVersion()

/** Compare two versions like 1.2.3 or v1.2.3-beta.1 (semver rules). Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string[] } | null => {
    const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/)
    return m ? { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split('.') : [] } : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  // A release is newer than its pre-releases (1.0.0 > 1.0.0-beta).
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** Ask GitHub for the latest release. Never throws; gives up after 5 seconds. */
async function fetchLatest(): Promise<UpdateInfo | null> {
  const timeout = new Promise<null>((done) => setTimeout(() => done(null), 5000))
  try {
    const get = async (): Promise<unknown> => {
      const res = await net.fetch(LATEST, {
        headers: { 'User-Agent': 'OpenTex-update-check', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok ? res.json() : null
    }
    const j = (await Promise.race([get(), timeout])) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
    if (!j || typeof j.tag_name !== 'string' || j.draft || j.prerelease) return null
    const url = typeof j.html_url === 'string' && j.html_url.startsWith('https://github.com/') ? j.html_url : 'https://github.com/AustinHouston/OpenTex/releases/latest'
    return { version: j.tag_name.replace(/^v/i, ''), url }
  } catch {
    return null
  }
}

let found: UpdateInfo | null = null // a newer release found this session

async function check(): Promise<UpdateCheck> {
  const current = currentVersion()
  const latest = await fetchLatest()
  if (!latest) return { status: 'offline', current }
  await saveSettings({ lastUpdateCheck: Date.now() }).catch(() => {})
  if (compareVersions(latest.version, current) > 0) {
    found = latest
    return { status: 'newer', current, info: latest }
  }
  found = null
  return { status: 'latest', current }
}

/** The notice to show, unless the user skipped that version or turned checking off. */
async function pending(): Promise<UpdateInfo | null> {
  const s = await loadSettings()
  return found && s.checkForUpdates && s.skippedVersion !== found.version ? found : null
}

const broadcast = (channel: string, ...args: unknown[]): void => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

/** On startup: check in the background, at most once a day. Failures are ignored. */
export async function checkForUpdatesInBackground(): Promise<void> {
  try {
    const s = await loadSettings()
    if (!s.checkForUpdates || Date.now() - (s.lastUpdateCheck || 0) < DAY) return
    const r = await check()
    const show = r.status === 'newer' ? await pending() : null
    if (show) broadcast('update:available', show)
  } catch {
    /* never bother the user about a failed check */
  }
}

export function registerUpdateIpc(): void {
  // A window that opens later asks whether there's a notice to show.
  ipcMain.handle('update:pending', () => pending())
  // Help → Check for Updates…: always check now, and report the result.
  ipcMain.handle('update:check', async () => {
    const r = await check()
    if (r.status === 'latest') broadcast('update:available', null)
    return r
  })
  ipcMain.handle('update:skip', async (_e, version: string) => {
    await saveSettings({ skippedVersion: String(version) })
    broadcast('update:available', null)
  })
  ipcMain.handle('update:download', async () => {
    const url = found?.url ?? 'https://github.com/AustinHouston/OpenTex/releases/latest'
    await shell.openExternal(url)
  })
}
