// The right-hand dock: the Comments panel plus one panel per enabled plugin.
// Plugin pages run in sandboxed frames (no access to files or to OpenTex internals) and talk to
// OpenTex only through postMessage; see plugins/opentex-sdk.js for the plugin side.
import type { PluginInfo, Theme } from '../../shared/types'

interface Host {
  storageGet: (id: string) => Promise<Record<string, unknown>>
  storageSet: (id: string, key: string, value: unknown) => Promise<void>
  theme: () => Theme
  context: () => Record<string, unknown>
  onShow: (panel: string) => void
}

export class Dock {
  private frames = new Map<string, HTMLIFrameElement>()
  private plugins: PluginInfo[] = []
  current = 'comments'

  constructor(private tabs: HTMLElement, private dock: HTMLElement, private host: Host) {
    window.addEventListener('message', (e) => this.onMessage(e))
    tabs.querySelector<HTMLElement>('[data-panel=comments]')!.onclick = () => this.show('comments')
  }

  setPlugins(list: PluginInfo[], disabled: string[]): void {
    this.plugins = list.filter((p) => !disabled.includes(p.id))
    this.tabs.querySelectorAll('[data-plugin]').forEach((t) => t.remove())
    for (const [id, f] of this.frames) {
      if (!this.plugins.some((p) => p.id === id)) {
        f.parentElement?.remove()
        this.frames.delete(id)
      }
    }
    const spacer = this.tabs.querySelector('.spacer')!
    for (const p of this.plugins) {
      const b = document.createElement('button')
      b.className = 'dock-tab'
      b.dataset.panel = `plugin:${p.id}`
      b.dataset.plugin = p.id
      b.title = p.description
      b.textContent = `${p.icon ? p.icon + ' ' : ''}${p.name}`
      b.onclick = () => this.show(`plugin:${p.id}`)
      this.tabs.insertBefore(b, spacer)
    }
    if (this.current.startsWith('plugin:') && !this.plugins.some((p) => `plugin:${p.id}` === this.current)) this.show('comments')
  }

  get pluginList(): PluginInfo[] {
    return this.plugins
  }

  isOpen(): boolean {
    return !document.body.classList.contains('no-dock')
  }

  show(panel: string): void {
    this.current = panel
    document.body.classList.remove('no-dock')
    if (panel.startsWith('plugin:')) this.ensureFrame(panel.slice(7))
    this.tabs.querySelectorAll<HTMLElement>('.dock-tab').forEach((t) => t.classList.toggle('on', t.dataset.panel === panel))
    this.dock.querySelectorAll<HTMLElement>('.dock-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== panel))
    this.host.onShow(panel)
  }

  toggle(panel = this.current): void {
    if (this.isOpen() && this.current === panel) document.body.classList.add('no-dock')
    else this.show(panel)
  }

  private ensureFrame(id: string): void {
    if (this.frames.has(id)) return
    const p = this.plugins.find((x) => x.id === id)
    if (!p) return
    const wrap = document.createElement('div')
    wrap.className = 'dock-panel'
    wrap.dataset.panel = `plugin:${id}`
    const f = document.createElement('iframe')
    f.sandbox.add('allow-scripts') // no allow-same-origin: the page can't reach OpenTex or your files
    f.src = `opentex-plugin://${id}/${p.panel}`
    f.title = p.name
    wrap.appendChild(f)
    this.dock.appendChild(wrap)
    this.frames.set(id, f)
  }

  private post(id: string, msg: Record<string, unknown>): void {
    this.frames.get(id)?.contentWindow?.postMessage({ __opentex: true, ...msg }, '*')
  }

  broadcastTheme(): void {
    for (const id of this.frames.keys()) this.post(id, { type: 'theme', theme: this.themePayload() })
  }

  broadcastContext(): void {
    for (const id of this.frames.keys()) this.post(id, { type: 'context', context: this.host.context() })
  }

  private themePayload(): Theme {
    return JSON.parse(JSON.stringify(this.host.theme()))
  }

  private async onMessage(e: MessageEvent): Promise<void> {
    const m = e.data
    if (!m || !m.__opentex) return
    const id = [...this.frames].find(([, f]) => f.contentWindow === e.source)?.[0]
    if (!id) return
    if (m.type === 'ready') {
      this.post(id, { type: 'theme', theme: this.themePayload() })
      this.post(id, { type: 'context', context: this.host.context() })
    } else if (m.type === 'storage:get') {
      const data = await this.host.storageGet(id)
      this.post(id, { type: 'reply', id: m.id, value: data[String(m.key)] ?? null })
    } else if (m.type === 'storage:set') {
      await this.host.storageSet(id, String(m.key), m.value)
    } else if (m.type === 'notify') {
      try {
        new Notification(String(m.title ?? 'OpenTex'), { body: String(m.body ?? '') })
      } catch {
        /* notifications not available */
      }
    }
  }
}
