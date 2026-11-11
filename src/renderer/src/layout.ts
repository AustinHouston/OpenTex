// Movable panels. The editor stays in the middle; every other panel (Files, PDF, Comments,
// plugins) lives in one of four zones and can be dragged by its title bar to another zone or
// position, stacked, resized, collapsed to its title bar, or hidden.
//
//   ┌──────┬──────────────┬───────┬──────┐
//   │ left │    editor    │ right │ side │
//   ├──────┴──────────────┴───────┴──────┤
//   │               bottom               │
//   └────────────────────────────────────┘

export type Zone = 'left' | 'right' | 'side' | 'bottom'
export const ZONES: Zone[] = ['left', 'right', 'side', 'bottom']

export interface LayoutState {
  zones: Record<Zone, string[]>
  hidden: string[]
  collapsed: string[]
  sizes: Record<Zone, number> // px width (bottom: height); 0 means the default
  weights: Record<string, number> // share of the zone for each panel
}

export const DEFAULT_LAYOUT: LayoutState = {
  zones: { left: ['files'], right: ['pdf'], side: ['comments'], bottom: [] },
  hidden: [],
  collapsed: [],
  sizes: { left: 250, right: 0, side: 300, bottom: 220 },
  weights: {}
}

export interface PanelDef {
  id: string
  title: string
  body: HTMLElement
  extras?: HTMLElement // buttons shown in the title bar
  defaultZone?: Zone
  onVisible?: () => void // called when the panel becomes visible (e.g. to create a plugin frame)
}

const COLLAPSED_STRIP = 34

export class Layout {
  private panels = new Map<string, { def: PanelDef; el: HTMLElement }>()
  private dragging: string | null = null
  private indicator = document.createElement('div')

  constructor(private root: HTMLElement, public state: LayoutState, private persist: (s: LayoutState) => void) {
    this.state = normalize(state)
    this.indicator.className = 'drop-line'
    for (const z of ZONES) this.wireZone(this.zoneEl(z), z)
    root.querySelectorAll<HTMLElement>('.zsplit').forEach((s) => this.wireSplitter(s))
  }

  private zoneEl(z: Zone): HTMLElement {
    return this.root.querySelector<HTMLElement>(`.zone[data-zone="${z}"]`)!
  }

  add(def: PanelDef): void {
    const el = document.createElement('section')
    el.className = 'panel'
    el.dataset.panel = def.id
    el.innerHTML = `<header class="panel-head" draggable="true" title="Drag to move this panel">
      <button class="collapse" title="Collapse or expand"><svg viewBox="0 0 20 20"><path d="M6 8l4 4 4-4"/></svg></button>
      <span class="ptitle"></span><span class="spacer"></span><span class="pextras"></span>
      <button class="phide" title="Hide panel"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
    </header>`
    el.querySelector('.ptitle')!.textContent = def.title
    if (def.extras) el.querySelector('.pextras')!.appendChild(def.extras)
    const body = document.createElement('div')
    body.className = 'panel-body'
    body.appendChild(def.body)
    el.appendChild(body)
    const head = el.querySelector<HTMLElement>('.panel-head')!
    head.querySelector<HTMLElement>('.collapse')!.onclick = () => this.toggleCollapsed(def.id)
    head.querySelector<HTMLElement>('.phide')!.onclick = () => this.hide(def.id)
    head.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.toggleCollapsed(def.id)
    })
    // Clicking a collapsed strip expands it.
    head.addEventListener('click', (e) => {
      if (this.state.collapsed.includes(def.id) && !(e.target as HTMLElement).closest('button, select, input')) this.toggleCollapsed(def.id)
    })
    head.addEventListener('dragstart', (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return e.preventDefault()
      this.dragging = def.id
      e.dataTransfer!.setData('text/x-opentex-panel', def.id)
      e.dataTransfer!.effectAllowed = 'move'
      document.body.classList.add('dragging-panel')
      el.classList.add('being-dragged')
    })
    head.addEventListener('dragend', () => this.endDrag())
    this.panels.set(def.id, { def, el })
    if (!ZONES.some((z) => this.state.zones[z].includes(def.id))) this.state.zones[def.defaultZone ?? 'side'].push(def.id)
  }

  remove(id: string): void {
    this.panels.get(id)?.el.remove()
    this.panels.delete(id)
  }

  has(id: string): boolean {
    return this.panels.has(id)
  }

  setTitle(id: string, title: string): void {
    const t = this.panels.get(id)?.el.querySelector('.ptitle')
    if (t) t.textContent = title
  }

  ids(): string[] {
    return [...this.panels.keys()]
  }

  title(id: string): string {
    return this.panels.get(id)?.def.title ?? id
  }

  isShown(id: string): boolean {
    return this.panels.has(id) && !this.state.hidden.includes(id)
  }

  /** Shown and expanded. */
  isVisible(id: string): boolean {
    return this.isShown(id) && !this.state.collapsed.includes(id)
  }

  show(id: string): void {
    this.state.hidden = this.state.hidden.filter((x) => x !== id)
    this.state.collapsed = this.state.collapsed.filter((x) => x !== id)
    this.commit()
  }

  hide(id: string): void {
    if (!this.state.hidden.includes(id)) this.state.hidden.push(id)
    this.commit()
  }

  toggle(id: string): void {
    this.isVisible(id) ? this.hide(id) : this.show(id)
  }

  toggleCollapsed(id: string): void {
    const c = this.state.collapsed
    this.state.collapsed = c.includes(id) ? c.filter((x) => x !== id) : [...c, id]
    this.commit()
  }

  reset(): void {
    this.state = normalize(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)))
    for (const id of this.panels.keys()) {
      if (!ZONES.some((z) => this.state.zones[z].includes(id))) this.state.zones[this.panels.get(id)!.def.defaultZone ?? 'side'].push(id)
    }
    this.commit()
  }

  private commit(): void {
    this.render()
    this.persist(this.state)
  }

  render(): void {
    const workspace = this.root.getBoundingClientRect()
    for (const z of ZONES) {
      const zoneEl = this.zoneEl(z)
      const ids = this.state.zones[z].filter((id) => this.panels.has(id) && !this.state.hidden.includes(id))
      const allCollapsed = ids.length > 0 && ids.every((id) => this.state.collapsed.includes(id))
      zoneEl.classList.toggle('empty', ids.length === 0)
      zoneEl.classList.toggle('all-collapsed', allCollapsed)
      const split = this.root.querySelector<HTMLElement>(`.zsplit[data-zone="${z}"]`)
      split?.classList.toggle('hidden', ids.length === 0 || allCollapsed)

      // Re-insert panels only when the order changed: moving an <iframe> reloads it.
      const current = [...zoneEl.querySelectorAll<HTMLElement>(':scope > .panel')].map((p) => p.dataset.panel)
      if (current.join('|') !== ids.join('|')) {
        const nodes: HTMLElement[] = []
        ids.forEach((id, i) => {
          if (i > 0) nodes.push(this.divider(z))
          nodes.push(this.panels.get(id)!.el)
        })
        zoneEl.replaceChildren(...nodes)
      }
      for (const id of ids) {
        const p = this.panels.get(id)!
        const collapsed = this.state.collapsed.includes(id)
        p.el.classList.toggle('collapsed', collapsed)
        p.el.style.flex = collapsed ? '0 0 auto' : `${this.state.weights[id] ?? 1} 1 0`
        if (!collapsed) p.def.onVisible?.()
      }
      // Dividers next to a collapsed panel can't resize anything.
      zoneEl.querySelectorAll<HTMLElement>(':scope > .pdiv').forEach((d) => {
        const a = (d.previousElementSibling as HTMLElement)?.dataset.panel
        const b = (d.nextElementSibling as HTMLElement)?.dataset.panel
        d.classList.toggle('inert', [a, b].some((x) => x && this.state.collapsed.includes(x)))
      })

      const size = this.state.sizes[z]
      if (z === 'bottom') zoneEl.style.height = allCollapsed ? 'auto' : `${Math.min(size || 220, workspace.height * 0.7)}px`
      else zoneEl.style.width = allCollapsed ? `${COLLAPSED_STRIP}px` : size ? `${Math.min(size, workspace.width * 0.6)}px` : z === 'right' ? '38%' : '300px'
    }
    window.dispatchEvent(new Event('resize'))
  }

  private divider(z: Zone): HTMLElement {
    const d = document.createElement('div')
    d.className = `pdiv ${z === 'bottom' ? 'pdiv-v' : 'pdiv-h'}`
    d.addEventListener('pointerdown', (e) => {
      const a = d.previousElementSibling as HTMLElement
      const b = d.nextElementSibling as HTMLElement
      if (!a || !b || d.classList.contains('inert')) return
      const horizontal = z === 'bottom'
      const sizeOf = (el: HTMLElement): number => (horizontal ? el.getBoundingClientRect().width : el.getBoundingClientRect().height)
      const total = sizeOf(a) + sizeOf(b)
      const startA = sizeOf(a)
      const start = horizontal ? e.clientX : e.clientY
      const wa = this.state.weights[a.dataset.panel!] ?? 1
      const wb = this.state.weights[b.dataset.panel!] ?? 1
      d.setPointerCapture(e.pointerId)
      const move = (ev: PointerEvent): void => {
        const pa = Math.max(60, Math.min(total - 60, startA + (horizontal ? ev.clientX : ev.clientY) - start))
        const sum = wa + wb
        this.state.weights[a.dataset.panel!] = (sum * pa) / total
        this.state.weights[b.dataset.panel!] = (sum * (total - pa)) / total
        a.style.flex = `${this.state.weights[a.dataset.panel!]} 1 0`
        b.style.flex = `${this.state.weights[b.dataset.panel!]} 1 0`
      }
      const up = (): void => {
        d.removeEventListener('pointermove', move)
        this.persist(this.state)
        window.dispatchEvent(new Event('resize'))
      }
      d.addEventListener('pointermove', move)
      d.addEventListener('pointerup', up, { once: true })
    })
    return d
  }

  private wireSplitter(s: HTMLElement): void {
    const z = s.dataset.zone as Zone
    s.addEventListener('pointerdown', (e) => {
      const zoneEl = this.zoneEl(z)
      const rect = zoneEl.getBoundingClientRect()
      const startSize = z === 'bottom' ? rect.height : rect.width
      const start = z === 'bottom' ? e.clientY : e.clientX
      s.setPointerCapture(e.pointerId)
      s.classList.add('dragging')
      const move = (ev: PointerEvent): void => {
        const d = (z === 'bottom' ? ev.clientY : ev.clientX) - start
        const size = Math.max(140, startSize + (z === 'left' ? d : -d))
        this.state.sizes[z] = Math.round(size)
        if (z === 'bottom') zoneEl.style.height = `${size}px`
        else zoneEl.style.width = `${size}px`
      }
      const up = (): void => {
        s.classList.remove('dragging')
        s.removeEventListener('pointermove', move)
        this.persist(this.state)
        window.dispatchEvent(new Event('resize'))
      }
      s.addEventListener('pointermove', move)
      s.addEventListener('pointerup', up, { once: true })
    })
  }

  // ---------- Drag and drop ----------
  private dropIndex(zoneEl: HTMLElement, z: Zone, e: DragEvent): number {
    const panels = [...zoneEl.querySelectorAll<HTMLElement>(':scope > .panel')].filter((p) => p.dataset.panel !== this.dragging)
    const pos = z === 'bottom' ? e.clientX : e.clientY
    for (let i = 0; i < panels.length; i++) {
      const r = panels[i].getBoundingClientRect()
      if (pos < (z === 'bottom' ? r.left + r.width / 2 : r.top + r.height / 2)) return i
    }
    return panels.length
  }

  private wireZone(zoneEl: HTMLElement, z: Zone): void {
    zoneEl.addEventListener('dragover', (e) => {
      if (!this.dragging) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'move'
      zoneEl.classList.add('drop-target')
      const i = this.dropIndex(zoneEl, z, e)
      const panels = [...zoneEl.querySelectorAll<HTMLElement>(':scope > .panel')].filter((p) => p.dataset.panel !== this.dragging)
      const zr = zoneEl.getBoundingClientRect()
      let at: number
      if (!panels.length) at = z === 'bottom' ? zr.left + 6 : zr.top + 6
      else if (i < panels.length) at = z === 'bottom' ? panels[i].getBoundingClientRect().left : panels[i].getBoundingClientRect().top
      else at = z === 'bottom' ? panels[panels.length - 1].getBoundingClientRect().right : panels[panels.length - 1].getBoundingClientRect().bottom
      const s = this.indicator.style
      if (z === 'bottom') Object.assign(s, { left: `${at - 2}px`, top: `${zr.top}px`, width: '4px', height: `${zr.height}px` })
      else Object.assign(s, { left: `${zr.left}px`, top: `${at - 2}px`, width: `${zr.width}px`, height: '4px' })
      if (!this.indicator.isConnected) document.body.appendChild(this.indicator)
    })
    zoneEl.addEventListener('dragleave', (e) => {
      if (!zoneEl.contains(e.relatedTarget as Node)) zoneEl.classList.remove('drop-target')
    })
    zoneEl.addEventListener('drop', (e) => {
      if (!this.dragging) return
      e.preventDefault()
      const id = this.dragging
      const i = this.dropIndex(zoneEl, z, e)
      for (const k of ZONES) this.state.zones[k] = this.state.zones[k].filter((x) => x !== id)
      // dropIndex counts visible panels; map it onto the zone's full list (which includes hidden ones).
      const visible = this.state.zones[z].filter((x) => !this.state.hidden.includes(x))
      const before = visible[i]
      const list = this.state.zones[z]
      list.splice(before ? list.indexOf(before) : list.length, 0, id)
      this.state.collapsed = this.state.collapsed.filter((x) => x !== id)
      this.endDrag()
      this.commit()
    })
  }

  private endDrag(): void {
    this.dragging = null
    document.body.classList.remove('dragging-panel')
    this.root.querySelectorAll('.drop-target').forEach((z) => z.classList.remove('drop-target'))
    this.root.querySelectorAll('.being-dragged').forEach((p) => p.classList.remove('being-dragged'))
    this.indicator.remove()
  }
}

/** Fill in anything missing from a saved layout and drop duplicate panel ids. */
export function normalize(s: Partial<LayoutState> | undefined): LayoutState {
  const d = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as LayoutState
  if (!s || !s.zones) return d
  const empty: Record<Zone, string[]> = { left: [], right: [], side: [], bottom: [] }
  const zones = { ...empty, ...s.zones } as Record<Zone, string[]>
  const seen = new Set<string>()
  for (const z of ZONES) zones[z] = (zones[z] ?? []).filter((id) => !seen.has(id) && seen.add(id))
  return { zones, hidden: s.hidden ?? [], collapsed: s.collapsed ?? [], sizes: { ...d.sizes, ...(s.sizes ?? {}) }, weights: s.weights ?? {} }
}
