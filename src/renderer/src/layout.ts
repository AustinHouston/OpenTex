// Movable panels in a free split layout. Every panel (Project, file windows, PDF, Comments,
// plugins…) is a leaf of a tree of rows and columns:
//
//   row ─┬─ project
//        ├─ col ─┬─ files        (a file window)
//        │       └─ problems
//        └─ pdf
//
// Drag a panel by its title bar onto another one: the left/right/top/bottom bands split it there
// and the centre swaps the two. Dropping on the outer edge of the workspace makes a full-height
// or full-width split. Panels can also be collapsed to their title bar or hidden (taken out of the
// tree, and put back near where they were when shown again).
//
// Panels are absolutely positioned inside the workspace from rectangles computed here, so a
// panel's element never moves to another parent: moving an <iframe> would reload it, and moving
// the PDF or an editor is costly. Only their left/top/width/height change.

export type Dir = 'row' | 'col'
export interface Split {
  type: Dir
  children: LNode[]
  weights: number[]
}
export type LNode = Split | string
export type Side = 'left' | 'right' | 'top' | 'bottom'
/** Where a hidden panel was: next to these panels, on this side, taking this share. */
export interface Spot {
  near: string[]
  side: Side
  frac: number
}
export interface LayoutState {
  v: 2
  root: LNode | null
  hidden: Record<string, Spot | null>
  collapsed: string[]
}
/** Where a panel goes the first time it is shown (there is no saved place for it yet). */
export type Zone = 'left' | 'right' | 'side' | 'bottom'

export interface PanelDef {
  id: string
  title: string
  body: HTMLElement
  extras?: HTMLElement // buttons shown in the title bar
  defaultZone?: Zone
  onVisible?: () => void // called when the panel becomes visible (e.g. to create a plugin frame)
  startHidden?: boolean // the first time it's added, keep it hidden until the user opens it
  startCollapsed?: boolean // the first time it's added, show it collapsed to its title bar
  onClose?: () => void // the title bar's ✕ does this instead of hiding the panel
  closeTitle?: string
  className?: string
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface Hit {
  id: string | null // the panel under the pointer (null: the workspace edge)
  side: Side | 'center'
  rect: Rect // the region a drop here would fill, in workspace coordinates
}
export interface DragHooks {
  label: string
  /** Pointer moved (client coordinates): the region to preview, or null for "can't drop here". */
  move: (x: number, y: number) => Rect | null
  drop: (x: number, y: number) => void
  end?: () => void
}

const GAP = 1 // px between panels; the workspace background shows through as a line
const HEAD = 32 // title bar height (matches .panel-head in styles.css)
const STRIP = 34 // width of a panel collapsed inside a row
const EDGE = 18 // px at the workspace border that mean "split the whole workspace"
const MIN = 80 // smallest panel a splitter will make
const BAND = 0.3 // share of a panel, from each edge, that splits it on that side

// ---------- Tree helpers (pure) ----------
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const sum = (a: number[]): number => a.reduce((s, x) => s + x, 0)

export function leaves(n: LNode | null): string[] {
  if (n === null) return []
  return typeof n === 'string' ? [n] : n.children.flatMap(leaves)
}

/** The split holding `target` (a panel id, or a split by identity) and its index there. */
function parentOf(root: LNode | null, target: LNode): { parent: Split; index: number } | null {
  if (root === null || typeof root === 'string') return null
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i]
    if (c === target) return { parent: root, index: i }
    const r = parentOf(c, target)
    if (r) return r
  }
  return null
}

/** Take a panel out of the tree. Splits left with one child are replaced by it. */
function detach(n: LNode | null, id: string): LNode | null {
  if (n === null) return null
  if (typeof n === 'string') return n === id ? null : n
  const kids: LNode[] = []
  const ws: number[] = []
  n.children.forEach((c, i) => {
    const r = detach(c, id)
    if (r !== null) {
      kids.push(r)
      ws.push(n.weights[i])
    }
  })
  if (!kids.length) return null
  if (kids.length === 1) return kids[0]
  n.children = kids
  n.weights = ws
  return n
}

/** Flatten a row inside a row (or a column inside a column), drop bad weights and empty splits. */
function tidy(n: LNode | null, seen = new Set<string>()): LNode | null {
  if (n === null) return null
  if (typeof n === 'string') {
    if (seen.has(n)) return null
    seen.add(n)
    return n
  }
  if (!n || !Array.isArray(n.children) || (n.type !== 'row' && n.type !== 'col')) return null
  const kids: LNode[] = []
  const ws: number[] = []
  n.children.forEach((c, i) => {
    const w = Number(n.weights?.[i])
    const weight = w > 0 && isFinite(w) ? w : 1
    const t = tidy(c, seen)
    if (t === null) return
    if (typeof t !== 'string' && t.type === n.type) {
      const total = sum(t.weights)
      t.children.forEach((cc, j) => {
        kids.push(cc)
        ws.push((weight * t.weights[j]) / total)
      })
    } else {
      kids.push(t)
      ws.push(weight)
    }
  })
  if (!kids.length) return null
  if (kids.length === 1) return kids[0]
  const total = sum(ws)
  return { type: n.type, children: kids, weights: ws.map((w) => w / total) }
}

/** Put `leaf` next to `target` (a panel id or a split), on `side`, taking `frac` of the space. */
function insertNear(root: LNode | null, target: LNode | null, side: Side, leaf: string, frac: number): LNode {
  if (root === null || target === null) target = root
  if (root === null || target === null) return leaf
  const dir: Dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'
  frac = Math.min(0.9, Math.max(0.05, frac))
  const p = parentOf(root, target)
  if (p && p.parent.type === dir) {
    const w = p.parent.weights[p.index]
    p.parent.weights[p.index] = w * (1 - frac)
    const at = before ? p.index : p.index + 1
    p.parent.children.splice(at, 0, leaf)
    p.parent.weights.splice(at, 0, w * frac)
    return root
  }
  if (typeof target !== 'string' && target.type === dir) {
    const total = sum(target.weights)
    const w = (total * frac) / (1 - frac)
    if (before) {
      target.children.unshift(leaf)
      target.weights.unshift(w)
    } else {
      target.children.push(leaf)
      target.weights.push(w)
    }
    return root
  }
  const wrap: Split = { type: dir, children: before ? [leaf, target] : [target, leaf], weights: before ? [frac, 1 - frac] : [1 - frac, frac] }
  if (!p) return wrap
  p.parent.children[p.index] = wrap
  return root
}

/** The smallest node holding all of `ids` (which must be in the tree). */
function commonNode(root: LNode, ids: string[]): LNode {
  const pathTo = (n: LNode, id: string): LNode[] | null => {
    if (typeof n === 'string') return n === id ? [n] : null
    for (const c of n.children) {
      const p = pathTo(c, id)
      if (p) return [n, ...p]
    }
    return null
  }
  const paths = ids.map((id) => pathTo(root, id)).filter((p): p is LNode[] => !!p)
  if (!paths.length) return root
  let common: LNode = paths[0][0]
  for (let i = 0; i < paths[0].length; i++) {
    const n = paths[0][i]
    if (paths.every((p) => p[i] === n)) common = n
    else break
  }
  return common
}

/** Take a panel out of the tree, remembering where it was. */
function hideIn(s: LayoutState, id: string): void {
  const p = s.root === null ? null : parentOf(s.root, id)
  let spot: Spot | null = null
  if (p) {
    const sib = p.index > 0 ? p.index - 1 : p.index + 1
    const side: Side = p.parent.type === 'row' ? (p.index > 0 ? 'right' : 'left') : p.index > 0 ? 'bottom' : 'top'
    const w = p.parent.weights[p.index]
    spot = { near: leaves(p.parent.children[sib]), side, frac: w / (w + p.parent.weights[sib]) }
  } else if (s.root === id) spot = s.hidden[id] ?? null
  if (leaves(s.root).includes(id)) s.root = tidy(detach(s.root, id))
  s.hidden[id] = spot
}

function defaultState(width: number): LayoutState {
  const w = width || 1400
  const right = 0.38 * w
  const editor = Math.max(300, w - 250 - right - 300)
  return { v: 2, root: { type: 'row', children: ['project', 'files', 'pdf', 'comments'], weights: [250, editor, right, 300] }, hidden: {}, collapsed: [] }
}

interface OldLayout {
  zones: Record<Zone, string[]>
  hidden?: string[]
  collapsed?: string[]
  sizes?: Partial<Record<Zone, number>>
  weights?: Record<string, number>
}

/** A layout saved by OpenTex 0.4 and earlier (four zones around the editor) as the same arrangement. */
function migrate(old: OldLayout, size: { w: number; h: number }): LayoutState {
  const rn = (id: string): string => (id === 'files' ? 'project' : id) // the file tree is now "Project"
  const W = size.w || 1400
  const H = size.h || 800
  const seen = new Set<string>(['files'])
  const zone = (z: Zone): string[] => (old.zones?.[z] ?? []).map(rn).filter((id) => typeof id === 'string' && !seen.has(id) && seen.add(id))
  const left = zone('left')
  const right = zone('right')
  const side = zone('side')
  const bottom = zone('bottom')
  const wt = (id: string): number => Math.max(0.05, Number(old.weights?.[id === 'project' ? 'files' : id]) || 1)
  const group = (ids: string[], type: Dir): LNode => (ids.length === 1 ? ids[0] : { type, children: ids, weights: ids.map(wt) })
  const sizes = old.sizes ?? {}
  const kids: LNode[] = []
  const ws: number[] = []
  if (left.length) kids.push(group(left, 'col')), ws.push(Math.min(sizes.left || 250, W * 0.6))
  kids.push('files')
  ws.push(0)
  if (right.length) kids.push(group(right, 'col')), ws.push(Math.min(sizes.right || W * 0.38, W * 0.6))
  if (side.length) kids.push(group(side, 'col')), ws.push(Math.min(sizes.side || 300, W * 0.6))
  ws[kids.indexOf('files')] = Math.max(200, W - sum(ws))
  let root: LNode = kids.length === 1 ? 'files' : { type: 'row', children: kids, weights: ws }
  if (bottom.length) {
    const bh = Math.min(sizes.bottom || 220, H * 0.7)
    root = { type: 'col', children: [root, group(bottom, 'row')], weights: [Math.max(100, H - bh), bh] }
  }
  const s: LayoutState = { v: 2, root: tidy(root), hidden: {}, collapsed: (old.collapsed ?? []).map(rn) }
  for (const id of (old.hidden ?? []).map(rn)) {
    if (leaves(s.root).includes(id)) hideIn(s, id)
    else s.hidden[id] = null
  }
  return s
}

/** A saved layout, checked and completed, from this version or an older one. */
export function normalize(saved: unknown, size = { w: 0, h: 0 }): LayoutState {
  const s = saved as Partial<LayoutState> & Partial<OldLayout>
  if (!s || typeof s !== 'object') return defaultState(size.w)
  if (s.zones && !('root' in s)) return migrate(s as OldLayout, size)
  if (s.v !== 2) return defaultState(size.w)
  const st: LayoutState = { v: 2, root: tidy(clone(s.root ?? null)), hidden: {}, collapsed: Array.isArray(s.collapsed) ? s.collapsed.filter((x) => typeof x === 'string') : [] }
  const inTree = new Set(leaves(st.root))
  for (const [id, spot] of Object.entries(s.hidden ?? {})) {
    if (inTree.has(id)) continue
    st.hidden[id] = spot && Array.isArray(spot.near) && ['left', 'right', 'top', 'bottom'].includes(spot.side) ? { near: spot.near, side: spot.side, frac: Number(spot.frac) || 0.5 } : null
  }
  return st
}

// ---------- The layout ----------
interface Panel {
  def: PanelDef
  el: HTMLElement
  rect: string // last rectangle written, to skip unchanged ones
  visible: boolean // shown and expanded at the last layout
}
interface SplitterInfo {
  node: Split
  a: number // child indices on either side
  b: number
  sizeA: number
  sizeB: number
  dir: Dir
}

export class Layout {
  private panels = new Map<string, Panel>()
  private rects = new Map<string, Rect>()
  private size = { w: 0, h: 0 }
  private splitters: HTMLElement[] = []
  private splitInfo = new Map<HTMLElement, SplitterInfo>()
  private preview = document.createElement('div')
  private ghost = document.createElement('div')
  private frame = 0
  /** Right-click on a panel's title bar. */
  onHeaderMenu: ((id: string, x: number, y: number) => void) | null = null

  constructor(private root: HTMLElement, public state: LayoutState, private persist: (s: LayoutState) => void) {
    if (!state || state.v !== 2) this.state = { v: 2, root: null, hidden: {}, collapsed: [] }
    this.preview.className = 'drop-preview hidden'
    this.ghost.className = 'drag-ghost hidden'
    root.append(this.preview)
    document.body.append(this.ghost)
    new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect
      if (Math.round(r.width) === this.size.w && Math.round(r.height) === this.size.h) return
      this.size = { w: Math.round(r.width), h: Math.round(r.height) }
      this.layoutNow()
    }).observe(root)
  }

  /** The workspace size, read once (afterwards the ResizeObserver keeps it). */
  private measure(): void {
    if (this.size.w) return
    const r = this.root.getBoundingClientRect()
    this.size = { w: Math.round(r.width), h: Math.round(r.height) }
  }

  workspaceSize(): { w: number; h: number } {
    this.measure()
    return this.size
  }

  add(def: PanelDef): void {
    const el = document.createElement('section')
    el.className = `panel${def.className ? ' ' + def.className : ''}`
    el.dataset.panel = def.id
    el.innerHTML = `<header class="panel-head" title="Drag to move this panel">
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
    const close = head.querySelector<HTMLElement>('.phide')!
    if (def.closeTitle) close.title = def.closeTitle
    head.querySelector<HTMLElement>('.collapse')!.onclick = () => this.toggleCollapsed(def.id)
    close.onclick = () => (def.onClose ? def.onClose() : this.hide(def.id))
    head.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.toggleCollapsed(def.id)
    })
    // Clicking a collapsed strip expands it.
    head.addEventListener('click', (e) => {
      if (this.state.collapsed.includes(def.id) && !(e.target as HTMLElement).closest('button, select, input')) this.toggleCollapsed(def.id)
    })
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, select, input')) return
      this.dragPanel(e, def.id)
    })
    head.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('select, input')) return
      e.preventDefault()
      e.stopPropagation()
      this.onHeaderMenu?.(def.id, e.clientX, e.clientY)
    })
    this.panels.set(def.id, { def, el, rect: '', visible: false })
    if (!this.knows(def.id)) {
      if (def.startHidden) this.state.hidden[def.id] = null
      else {
        this.placeDefault(def.id)
        if (def.startCollapsed && !this.state.collapsed.includes(def.id)) this.state.collapsed.push(def.id)
      }
    }
  }

  /** Unregister a panel; it keeps its place in the saved layout (a plugin switched off and on again). */
  remove(id: string): void {
    this.panels.get(id)?.el.remove()
    this.panels.delete(id)
  }

  /** Unregister a panel and drop it from the layout for good (a file window that was closed). */
  forget(id: string): void {
    this.remove(id)
    this.state.root = tidy(detach(this.state.root, id))
    delete this.state.hidden[id]
    this.state.collapsed = this.state.collapsed.filter((x) => x !== id)
    this.commit()
  }

  has(id: string): boolean {
    return this.panels.has(id)
  }

  /** In the saved layout (shown or hidden), registered or not. */
  knows(id: string): boolean {
    return id in this.state.hidden || leaves(this.state.root).includes(id)
  }

  /** Panel ids in the layout tree, registered or not. */
  treeIds(): string[] {
    return leaves(this.state.root)
  }

  element(id: string): HTMLElement | null {
    return this.panels.get(id)?.el ?? null
  }

  setTitle(id: string, title: string): void {
    const t = this.panels.get(id)?.el.querySelector('.ptitle')
    if (t && t.textContent !== title) t.textContent = title
  }

  ids(): string[] {
    return [...this.panels.keys()]
  }

  title(id: string): string {
    return this.panels.get(id)?.def.title ?? id
  }

  isShown(id: string): boolean {
    return this.panels.has(id) && leaves(this.state.root).includes(id)
  }

  /** Shown and expanded. */
  isVisible(id: string): boolean {
    return this.isShown(id) && !this.state.collapsed.includes(id)
  }

  show(id: string): void {
    const wasCollapsed = this.state.collapsed.includes(id)
    this.state.collapsed = this.state.collapsed.filter((x) => x !== id)
    if (leaves(this.state.root).includes(id)) {
      if (wasCollapsed) this.commit()
      return
    }
    const spot = this.state.hidden[id]
    delete this.state.hidden[id]
    const near = spot?.near.filter((x) => this.panels.has(x) && leaves(this.state.root).includes(x)) ?? []
    if (spot && near.length && this.state.root !== null) this.state.root = tidy(insertNear(this.state.root, commonNode(this.state.root, near), spot.side, id, spot.frac))
    else this.placeDefault(id)
    this.commit()
  }

  hide(id: string): void {
    if (!this.knows(id) || leaves(this.state.root).includes(id)) {
      hideIn(this.state, id)
      this.commit()
    }
  }

  toggle(id: string): void {
    this.isVisible(id) ? this.hide(id) : this.show(id)
  }

  toggleCollapsed(id: string): void {
    const c = this.state.collapsed
    this.state.collapsed = c.includes(id) ? c.filter((x) => x !== id) : [...c, id]
    this.commit()
  }

  /** Move (or show) panel `id` next to panel `target` on `side`; with no target, along the workspace edge. */
  place(id: string, target: string | null, side: Side, frac = 0.5): void {
    if (id === target) return
    this.state.root = tidy(detach(this.state.root, id))
    delete this.state.hidden[id]
    this.state.collapsed = this.state.collapsed.filter((x) => x !== id)
    const t = target && leaves(this.state.root).includes(target) ? target : null
    this.state.root = tidy(insertNear(this.state.root, t, side, id, frac))
    this.commit()
  }

  /** Exchange two panels' places. */
  swap(a: string, b: string): void {
    const swapIn = (n: LNode | null): LNode | null => {
      if (n === null) return null
      if (typeof n === 'string') return n === a ? b : n === b ? a : n
      n.children = n.children.map((c) => swapIn(c)!)
      return n
    }
    if (a === b || !leaves(this.state.root).includes(a)) return
    if (!leaves(this.state.root).includes(b)) return this.place(b, a, 'right')
    this.state.root = swapIn(this.state.root)
    this.commit()
  }

  reset(): void {
    this.measure()
    this.state = defaultState(this.size.w)
    for (const [id, p] of this.panels) {
      if (this.knows(id)) continue
      if (p.def.startHidden) this.state.hidden[id] = null
      else this.placeDefault(id)
    }
    this.commit()
  }

  /** A panel's first place, from its defaultZone. */
  private placeDefault(id: string): void {
    const zone = this.panels.get(id)?.def.defaultZone ?? 'side'
    const tree = leaves(this.state.root).filter((x) => x !== id && this.panels.has(x))
    const first = (...ids: string[]): string | null => ids.find((x) => tree.includes(x)) ?? null
    const put = (target: string | null, side: Side, frac: number): void => void (this.state.root = tidy(insertNear(this.state.root, target, side, id, frac)))
    if (zone === 'left') {
      const t = first('project', 'outline', 'search')
      t ? put(t, 'bottom', 0.45) : put(null, 'left', 0.2)
    } else if (zone === 'right') {
      const t = first('pdf')
      t ? put(t, 'bottom', 0.5) : first('files') ? put('files', 'right', 0.4) : put(null, 'right', 0.3)
    } else if (zone === 'bottom') {
      first('files') ? put('files', 'bottom', 0.25) : put(null, 'bottom', 0.25)
    } else {
      const t = tree.filter((x) => this.panels.get(x)!.def.defaultZone === 'side').pop()
      t ? put(t, 'bottom', 0.5) : put(null, 'right', 0.22)
    }
  }

  private commit(): void {
    this.render()
    this.persist(this.state)
  }

  /** Lay the panels out now and tell everything that sizes itself to the window. */
  render(): void {
    this.layoutNow()
    window.dispatchEvent(new Event('resize'))
  }

  private scheduleLayout(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.layoutNow()
    })
  }

  // ---------- Computing the rectangles ----------
  private present(n: LNode): boolean {
    return typeof n === 'string' ? this.panels.has(n) : n.children.some((c) => this.present(c))
  }

  private allCollapsed(n: LNode): boolean {
    if (typeof n === 'string') return this.state.collapsed.includes(n)
    return n.children.filter((c) => this.present(c)).every((c) => this.allCollapsed(c))
  }

  /** Size along the parent's axis of a node whose panels are all collapsed. */
  private fixedSize(n: LNode, dir: Dir): number {
    if (dir === 'row') return STRIP
    if (typeof n === 'string' || n.type === 'row') return HEAD
    const kids = n.children.filter((c) => this.present(c))
    return sum(kids.map((c) => this.fixedSize(c, 'col'))) + GAP * (kids.length - 1)
  }

  private layoutNow(): void {
    this.measure()
    this.rects.clear()
    const strips = new Set<string>()
    const seps: { info: SplitterInfo; rect: Rect; inert: boolean }[] = []
    const walk = (n: LNode, r: Rect, strip: boolean): void => {
      if (typeof n === 'string') {
        this.rects.set(n, r)
        if (strip) strips.add(n)
        return
      }
      const idx = n.children.map((_, i) => i).filter((i) => this.present(n.children[i]))
      if (idx.length === 1) return walk(n.children[idx[0]], r, strip)
      const row = n.type === 'row'
      const main = (row ? r.w : r.h) - GAP * (idx.length - 1)
      const fixed = idx.map((i) => (!strip && this.allCollapsed(n.children[i]) ? this.fixedSize(n.children[i], n.type) : -1))
      const flexW = idx.map((i, k) => (fixed[k] >= 0 ? 0 : strip ? 1 : n.weights[i]))
      const free = Math.max(0, main - sum(fixed.filter((f) => f >= 0)))
      const totalW = sum(flexW) || 1
      const sizes = idx.map((_, k) => (fixed[k] >= 0 ? fixed[k] : (free * flexW[k]) / totalW))
      let pos = row ? r.x : r.y
      idx.forEach((i, k) => {
        const a = Math.round(pos)
        const b = Math.round(pos + sizes[k])
        const cr: Rect = row ? { x: a, y: r.y, w: b - a, h: r.h } : { x: r.x, y: a, w: r.w, h: b - a }
        if (k > 0) {
          const at = a - GAP / 2
          seps.push({
            info: { node: n, a: idx[k - 1], b: i, sizeA: sizes[k - 1], sizeB: sizes[k], dir: n.type },
            rect: row ? { x: at - 3, y: r.y, w: 7, h: r.h } : { x: r.x, y: at - 3, w: r.w, h: 7 },
            inert: strip || fixed[k] >= 0 || fixed[k - 1] >= 0
          })
        }
        walk(n.children[i], cr, strip || (row && fixed[k] >= 0))
        pos += sizes[k] + GAP
      })
    }
    if (this.state.root !== null && this.present(this.state.root)) walk(this.state.root, { x: 0, y: 0, w: this.size.w, h: this.size.h }, false)

    for (const [id, p] of this.panels) {
      const r = this.rects.get(id)
      if (!r) {
        if (p.el.isConnected) p.el.remove()
        p.rect = ''
        p.visible = false
        continue
      }
      const collapsed = this.state.collapsed.includes(id)
      p.el.classList.toggle('collapsed', collapsed)
      p.el.classList.toggle('vstrip', strips.has(id))
      const key = `${r.x},${r.y},${r.w},${r.h}`
      if (key !== p.rect) {
        p.rect = key
        const s = p.el.style
        s.left = `${r.x}px`
        s.top = `${r.y}px`
        s.width = `${r.w}px`
        s.height = `${r.h}px`
      }
      if (!p.el.isConnected) this.root.insertBefore(p.el, this.preview)
      // Only when it comes into view, not on every resize.
      if (!collapsed && !p.visible) p.def.onVisible?.()
      p.visible = !collapsed
    }

    // Splitters: reuse the elements, one per gap.
    while (this.splitters.length < seps.length) this.splitters.push(this.makeSplitter())
    this.splitInfo.clear()
    this.splitters.forEach((el, i) => {
      const s = seps[i]
      if (!s) {
        if (el.isConnected) el.remove()
        return
      }
      this.splitInfo.set(el, s.info)
      el.className = `lsplit ${s.info.dir === 'row' ? 'lsplit-v' : 'lsplit-h'}${s.inert ? ' inert' : ''}`
      Object.assign(el.style, { left: `${s.rect.x}px`, top: `${s.rect.y}px`, width: `${s.rect.w}px`, height: `${s.rect.h}px` })
      if (!el.isConnected) this.root.insertBefore(el, this.preview)
    })
  }

  private makeSplitter(): HTMLElement {
    const el = document.createElement('div')
    el.addEventListener('pointerdown', (e) => {
      const info = this.splitInfo.get(el)
      if (!info || el.classList.contains('inert') || e.button !== 0) return
      e.preventDefault()
      const row = info.dir === 'row'
      const start = row ? e.clientX : e.clientY
      const total = info.sizeA + info.sizeB
      const ws = info.node.weights
      const wsum = ws[info.a] + ws[info.b]
      el.setPointerCapture(e.pointerId)
      el.classList.add('dragging')
      document.body.classList.add(row ? 'resizing-col' : 'resizing-row')
      const move = (ev: PointerEvent): void => {
        const lo = Math.min(MIN, total / 2)
        const pa = Math.max(lo, Math.min(total - lo, info.sizeA + (row ? ev.clientX : ev.clientY) - start))
        ws[info.a] = (wsum * pa) / total
        ws[info.b] = wsum - ws[info.a]
        this.scheduleLayout()
      }
      const up = (): void => {
        el.classList.remove('dragging')
        document.body.classList.remove('resizing-col', 'resizing-row')
        el.removeEventListener('pointermove', move)
        el.removeEventListener('lostpointercapture', up)
        this.persist(this.state)
        window.dispatchEvent(new Event('resize'))
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('lostpointercapture', up)
    })
    return el
  }

  // ---------- Hit testing and drag and drop ----------
  /** The panel rectangle (workspace coordinates), if shown. */
  rectOf(id: string): Rect | null {
    return this.rects.get(id) ?? null
  }

  /** What a drop at this point (client coordinates) would do. `origin` is the workspace's client position. */
  hit(x: number, y: number, origin: { left: number; top: number }): Hit | null {
    const lx = x - origin.left
    const ly = y - origin.top
    const { w, h } = this.size
    if (lx < 0 || ly < 0 || lx > w || ly > h) return null
    const edgeW = Math.max(160, Math.round(w * 0.25))
    const edgeH = Math.max(120, Math.round(h * 0.3))
    if (lx < EDGE) return { id: null, side: 'left', rect: { x: 0, y: 0, w: edgeW, h } }
    if (lx > w - EDGE) return { id: null, side: 'right', rect: { x: w - edgeW, y: 0, w: edgeW, h } }
    if (ly < EDGE) return { id: null, side: 'top', rect: { x: 0, y: 0, w, h: edgeH } }
    if (ly > h - EDGE) return { id: null, side: 'bottom', rect: { x: 0, y: h - edgeH, w, h: edgeH } }
    for (const [id, r] of this.rects) {
      if (lx < r.x || lx >= r.x + r.w || ly < r.y || ly >= r.y + r.h) continue
      const fx = (lx - r.x) / r.w
      const fy = (ly - r.y) / r.h
      const d: [Side, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
      const [side, dist] = d.reduce((m, c) => (c[1] < m[1] ? c : m))
      if (dist >= BAND) return { id, side: 'center', rect: r }
      const half = side === 'left' ? { ...r, w: r.w / 2 } : side === 'right' ? { ...r, x: r.x + r.w / 2, w: r.w / 2 } : side === 'top' ? { ...r, h: r.h / 2 } : { ...r, y: r.y + r.h / 2, h: r.h / 2 }
      return { id, side, rect: half }
    }
    return null
  }

  /**
   * Follow a pointer drag that starts with this pointerdown: nothing happens until it moves a few
   * pixels (so clicks stay clicks); then a preview of the drop region follows the pointer (one
   * update per frame) until the button is released, or Escape cancels.
   */
  drag(e: PointerEvent, hooks: DragHooks): void {
    const x0 = e.clientX
    const y0 = e.clientY
    const id = e.pointerId
    let started = false
    let last: PointerEvent = e
    let frame = 0
    const ghost = this.ghost
    const update = (): void => {
      frame = 0
      ghost.style.transform = `translate(${last.clientX + 12}px, ${last.clientY + 10}px)`
      const r = hooks.move(last.clientX, last.clientY)
      const p = this.preview
      if (!r) return p.classList.add('hidden')
      p.classList.remove('hidden')
      Object.assign(p.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    }
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== id) return
      last = ev
      if (!started) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return
        started = true
        try {
          this.root.setPointerCapture(id)
        } catch {
          /* the pointer is gone */
        }
        document.body.classList.add('dragging-panel')
        ghost.textContent = hooks.label
        ghost.classList.remove('hidden')
        window.getSelection()?.removeAllRanges()
      }
      if (!frame) frame = requestAnimationFrame(update)
    }
    const finish = (drop: boolean, ev?: PointerEvent): void => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('keydown', key, true)
      this.root.removeEventListener('lostpointercapture', lost)
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      if (!started) return
      try {
        this.root.releasePointerCapture(id)
      } catch {
        /* already released */
      }
      document.body.classList.remove('dragging-panel')
      ghost.classList.add('hidden')
      this.preview.classList.add('hidden')
      // A click that follows the drag (it lands on the workspace) must not do anything.
      const eat = (c: MouseEvent): void => c.stopPropagation()
      window.addEventListener('click', eat, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', eat, true), 0)
      setTimeout(() => window.dispatchEvent(new Event('ot-drag-end')), 0)
      hooks.end?.()
      if (drop && ev) hooks.drop(ev.clientX, ev.clientY)
    }
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === id) finish(true, ev)
    }
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    const lost = (): void => {
      if (started) finish(true, last)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('keydown', key, true)
    this.root.addEventListener('lostpointercapture', lost)
  }

  /** Workspace position in the window, read once per drag. */
  origin(): { left: number; top: number } {
    const r = this.root.getBoundingClientRect()
    return { left: r.left, top: r.top }
  }

  private dragPanel(e: PointerEvent, id: string): void {
    let origin = { left: 0, top: 0 }
    let first = true
    const decide = (x: number, y: number): Hit | null => {
      const h = this.hit(x, y, origin)
      if (!h || h.id === id) return null
      return h
    }
    this.drag(e, {
      label: this.title(id),
      move: (x, y) => {
        if (first) {
          first = false
          origin = this.origin()
          this.panels.get(id)?.el.classList.add('being-dragged')
        }
        return decide(x, y)?.rect ?? null
      },
      drop: (x, y) => {
        const h = decide(x, y)
        if (!h) return
        if (h.side === 'center') this.swap(id, h.id!)
        else this.place(id, h.id, h.side, h.id ? 0.5 : 0.25)
      },
      end: () => {
        this.panels.get(id)?.el.classList.remove('being-dragged')
      }
    })
  }
}
