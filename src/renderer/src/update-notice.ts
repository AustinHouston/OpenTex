// The "new version available" notice in the status bar, and Help → Check for Updates….
// The main process does the checking (src/main/updates.ts); nothing is installed automatically.
import './update-notice.css'

interface UpdateInfo {
  version: string
  url: string
}
type UpdateCheck = { status: 'newer'; current: string; info: UpdateInfo } | { status: 'latest'; current: string } | { status: 'offline'; current: string }

export interface UpdateApi {
  updatePending: () => Promise<UpdateInfo | null>
  checkUpdates: () => Promise<UpdateCheck>
  skipUpdate: (version: string) => Promise<void>
  downloadUpdate: () => Promise<void>
  onUpdateAvailable: (fn: (info: UpdateInfo | null) => void) => void
}

type Ask = (message: string, buttons: string[], primary?: number) => Promise<number>

/** Add the (hidden) notice to the status bar and start listening. Returns the Help-menu check. */
export function setupUpdateNotice(api: UpdateApi, ask: Ask): { checkNow: () => Promise<void> } {
  const el = document.createElement('span')
  el.id = 'st-update'
  el.className = 'hidden'
  el.innerHTML = `<span class="upd-text"></span> — <button class="link" data-upd="download">Download</button><button class="link" data-upd="skip">Skip this version</button><button class="link upd-x" data-upd="close" title="Hide until next time">×</button>`
  const bar = document.querySelector('.statusbar')
  const spacer = bar?.querySelector('.spacer')
  if (spacer) spacer.after(el)
  else bar?.append(el)

  let shown: UpdateInfo | null = null
  const show = (info: UpdateInfo | null): void => {
    shown = info
    el.classList.toggle('hidden', !info)
    if (info) {
      el.querySelector('.upd-text')!.textContent = `OpenTex ${info.version} is available`
      el.title = 'A newer version of OpenTex is out. Download opens the release page in your browser; install it the same way you installed OpenTex. Your projects and settings are kept.'
    }
  }
  el.querySelectorAll<HTMLButtonElement>('[data-upd]').forEach(
    (b) =>
      (b.onclick = async () => {
        const what = b.dataset.upd
        if (what === 'download') await api.downloadUpdate()
        if (what === 'skip' && shown) await api.skipUpdate(shown.version)
        show(null)
      })
  )
  api.onUpdateAvailable((info) => show(info))
  api.updatePending().then(show, () => {})

  const checkNow = async (): Promise<void> => {
    const r = await api.checkUpdates()
    if (r.status === 'offline') {
      await ask('Couldn’t reach GitHub to check for updates. Check your internet connection and try again later.', ['OK'])
    } else if (r.status === 'latest') {
      show(null)
      await ask(`You have the latest version of OpenTex (${r.current}).`, ['OK'])
    } else {
      const c = await ask(
        `OpenTex ${r.info.version} is available (you have ${r.current}). Download opens the release page in your browser. Install it the same way you installed OpenTex; your projects and settings are kept.`,
        ['Download', 'Skip This Version', 'Later']
      )
      if (c === 0) await api.downloadUpdate()
      if (c === 1) await api.skipUpdate(r.info.version)
      show(c === 2 ? r.info : null)
    }
  }
  return { checkNow }
}
