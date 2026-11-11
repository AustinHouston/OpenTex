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
  /** The open file's text, for plugins with the 'document' permission. */
  document: () => Promise<{ file: string; text: string; version: number; files: { file: string; text: string }[] } | null>
  highlight: (file: string, version: number, marks: unknown[]) => void
  /** Remove every plugin highlight from the editor (the plugin's panel was closed or turned off). */
  clearHighlights: () => void
  goTo: (file: string, from: number, to: number) => void
}

export class PluginPanels {
  private frames = new Map<string, HTMLIFrameElement>()
  private plugins: PluginInfo[] = []
  private docSubs = new Set<string>()
  private docVisible = new Set<string>() // document plugins whose panel is open

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
    this.syncVisibility()
  }

  private visible(id: string): boolean {
    return this.frames.has(id) && this.plugins.some((p) => p.id === id) && this.layout.isVisible(`plugin:${id}`)
  }

  /**
   * Call after any layout change. A plugin that reads the paper only works, and only shows its
   * highlights, while its panel is open: closing, collapsing or turning it off clears them, and
   * opening it again sends it the text afresh.
   */
  syncVisibility(): void {
    let hidden = false
    for (const id of this.docSubs) {
      const now = this.visible(id)
      if (now === this.docVisible.has(id)) continue
      if (now) {
        this.docVisible.add(id)
        this.host.document().then((doc) => this.post(id, { type: 'document', document: doc }))
      } else {
        this.docVisible.delete(id)
        hidden = true
      }
    }
    if (hidden) this.host.clearHighlights()
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

  /** Typing activity: characters changed since the last message (sent at most every 250 ms). */
  broadcastActivity(chars: number): void {
    for (const id of this.frames.keys()) this.post(id, { type: 'activity', chars, at: Date.now() })
  }

  broadcastContext(): void {
    for (const id of this.frames.keys()) this.post(id, { type: 'context', context: this.host.context() })
  }

  private canReadDocument(id: string): boolean {
    return Boolean(this.plugins.find((p) => p.id === id)?.permissions?.includes('document'))
  }

  /** Send the open file's text to plugins that asked for it (call debounced after edits and on tab switch). */
  async broadcastDocument(): Promise<void> {
    if (!this.docVisible.size) return
    const doc = await this.host.document()
    for (const id of this.docVisible) this.post(id, { type: 'document', document: doc })
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
    } else if (m.type === 'document:subscribe') {
      if (!this.canReadDocument(id)) return
      this.docSubs.add(id)
      if (!this.visible(id)) return
      this.docVisible.add(id)
      this.post(id, { type: 'document', document: await this.host.document() })
    } else if (m.type === 'highlight') {
      if (this.canReadDocument(id) && this.docVisible.has(id) && Array.isArray(m.marks)) this.host.highlight(String(m.file), Number(m.version), m.marks)
    } else if (m.type === 'goto') {
      if (this.canReadDocument(id)) this.host.goTo(String(m.file), Number(m.from) || 0, Number(m.to) || 0)
    } else if (m.type === 'notify') {
      try {
        new Notification(String(m.title ?? 'OpenTex'), { body: String(m.body ?? '') })
      } catch {
        /* notifications not available */
      }
    }
  }
}
