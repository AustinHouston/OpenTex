import type { TreeNode } from '../../shared/types'

export interface TreeHooks {
  open: (path: string) => void
  contextMenu: (node: TreeNode, x: number, y: number) => void
}

const collapsed = new Set<string>()
const TEXT_LIKE = /\.(tex|bib|sty|cls|bst|txt|md|cfg|def|ltx|dtx|bbx|cbx|lbx|csv|json|latexmkrc)$|^\.latexmkrc$/i

type Kind = 'main' | 'tex' | 'pdf' | 'refs' | 'img' | 'style' | 'other'
function kindOf(name: string): Kind {
  if (/\.tex$/i.test(name)) return 'tex'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.bib$/i.test(name)) return 'refs'
  if (/\.(png|jpe?g|gif|svg|eps|tiff?|bmp|webp)$/i.test(name)) return 'img'
  if (/\.(sty|cls|bst)$/i.test(name)) return 'style'
  return 'other'
}
const BADGE: Record<Kind, string> = { main: 'main', tex: 'tex', pdf: 'pdf', refs: 'refs', img: 'img', style: 'style', other: '' }

const ICON = {
  folder: '<path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.8h7.5a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>',
  folderOpen: '<path d="M2.5 15V5.5a1 1 0 0 1 1-1h4l1.5 1.8h6.5a1 1 0 0 1 1 1V8.5"/><path d="M2.5 15l2.2-6.5h13l-2.2 6.5z"/>',
  file: '<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M11.5 2.5v4h4"/>',
  img: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8.3" r="1.4"/><path d="M3.5 14.5l4-4 3 3 2-2 4 3.5"/>',
  refs: '<path d="M4 3.5h9.5a1.5 1.5 0 0 1 1.5 1.5v11.5H5.5A1.5 1.5 0 0 1 4 15z"/><path d="M4 15a1.5 1.5 0 0 1 1.5-1.5H15M7.5 6.5h4.5M7.5 9h3"/>',
  pdf: '<path d="M5 2.5h6.5L15.5 6.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z"/><path d="M7 13.5h6M7 11h6"/>'
}
const svg = (inner: string): string => `<svg viewBox="0 0 20 20">${inner}</svg>`

export function renderTree(host: HTMLElement, nodes: TreeNode[], active: string | null, main: string | null, hooks: TreeHooks): void {
  const build = (ns: TreeNode[], depth: number): HTMLUListElement => {
    const ul = document.createElement('ul')
    for (const n of ns) {
      const li = document.createElement('li')
      const row = document.createElement('div')
      row.className = 'row'
      row.title = n.path
      row.style.paddingLeft = `${8 + depth * 14}px`
      const isOpen = n.dir && !collapsed.has(n.path)
      const kind: Kind = n.dir ? 'other' : n.path === main ? 'main' : kindOf(n.name)
      const icon = n.dir ? (isOpen ? ICON.folderOpen : ICON.folder) : kind === 'img' ? ICON.img : kind === 'refs' ? ICON.refs : kind === 'pdf' ? ICON.pdf : ICON.file
      row.innerHTML = `<span class="caret">${n.dir ? (isOpen ? '▾' : '▸') : ''}</span><span class="ficon ${n.dir ? 'dir' : 'k-' + kind}">${svg(icon)}</span><span class="fname"></span>${
        BADGE[kind] && !n.dir ? `<span class="badge b-${kind}">${BADGE[kind]}</span>` : ''
      }`
      row.querySelector('.fname')!.textContent = n.name
      if (!n.dir && kind === 'other' && !TEXT_LIKE.test(n.name)) row.classList.add('dim')
      if (n.path === active) row.classList.add('active')
      row.addEventListener('click', () => {
        if (n.dir) {
          collapsed.has(n.path) ? collapsed.delete(n.path) : collapsed.add(n.path)
          renderTree(host, nodes, active, main, hooks)
        } else hooks.open(n.path)
      })
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        hooks.contextMenu(n, e.clientX, e.clientY)
      })
      li.appendChild(row)
      if (isOpen && n.children?.length) li.appendChild(build(n.children, depth + 1))
      ul.appendChild(li)
    }
    return ul
  }
  const scroll = host.scrollTop
  host.replaceChildren(build(nodes, 0))
  host.scrollTop = scroll
}

export function isTextFile(path: string): boolean {
  return TEXT_LIKE.test(path.split('/').pop() ?? '')
}

export function allFiles(nodes: TreeNode[], test: (p: string) => boolean): string[] {
  const out: string[] = []
  const walk = (ns: TreeNode[]): void => ns.forEach((n) => (n.dir ? walk(n.children ?? []) : test(n.path) && out.push(n.path)))
  walk(nodes)
  return out
}
