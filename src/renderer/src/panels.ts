// Plugin panels. Each enabled plugin becomes a movable panel (see layout.ts) holding a sandboxed
// frame with no access to files or to OpenTex internals; it talks to OpenTex only through
// postMessage. See plugins/opentex-sdk.js for the plugin side.
import type { PluginInfo, Theme } from '../../shared/types'
import type { Layout } from './layout'

interface Host {
  storageGet: (id: string) => Promise<Record<string, unknown>>
  storageSet: (id: string, key: string, value: unknown) => Promise<void>
  theme: () => Theme
  context: () => Record<string, unknown>
}

export class PluginPanels {
  private frames = new Map<string, HTMLIFrameElement>()
  private plugins: PluginInfo[] = []

  constructor(private layout: Layout, private host: Host) {
    window.addEventListener('message', (e) => this.onMessage(e))
  }

  setPlugins(list: PluginInfo[], disabled: string[]): void {
    this.plugins = list.filter((p) => !disabled.includes(p.id))
    for (const id of this.layout.ids().filter((x) => x.startsWith('plugin:'))) {
      if (!this.plugins.some((p) => `plugin:${p.id}` === id)) {
        this.layout.remove(id)
        this.frames.delete(id.slice(7))
      }
    }
    for (const p of this.plugins) {
      const pid = `plugin:${p.id}`
      if (this.layout.has(pid)) continue
      const body = document.createElement('div')
      body.className = 'plugin-body'
      this.layout.add({ id: pid, title: `${p.icon ? p.icon + ' ' : ''}${p.name}`, body, defaultZone: 'side', onVisible: () => this.ensureFrame(p, body) })
    }
    this.layout.render()
  }

  /** Create the frame the first time the panel is shown (or again if moving the panel dropped it). */
  private ensureFrame(p: PluginInfo, body: HTMLElement): void {
    const existing = this.frames.get(p.id)
    if (existing && body.contains(existing)) return
    const f = document.createElement('iframe')
    f.sandbox.add('allow-scripts') // no allow-same-origin: the page can't reach OpenTex or your files
    f.src = `opentex-plugin://${p.id}/${p.panel}`
    f.title = p.name
    body.replaceChildren(f)
    this.frames.set(p.id, f)
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
