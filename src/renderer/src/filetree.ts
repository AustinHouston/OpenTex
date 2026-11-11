import type { TreeNode } from '../../shared/types'

export interface TreeHooks {
  open: (path: string) => void
  contextMenu: (node: TreeNode, x: number, y: number) => void
}

const collapsed = new Set<string>()
const TEXT_LIKE = /\.(tex|bib|sty|cls|bst|txt|md|cfg|def|ltx|dtx|bbx|cbx|lbx|csv|json|latexmkrc)$|^\.latexmkrc$/i

export function renderTree(host: HTMLElement, nodes: TreeNode[], active: string | null, main: string | null, hooks: TreeHooks): void {
  const build = (ns: TreeNode[]): HTMLUListElement => {
    const ul = document.createElement('ul')
    for (const n of ns) {
      const li = document.createElement('li')
      const row = document.createElement('div')
      row.className = 'row'
      row.title = n.path
      const caret = document.createElement('span')
      caret.className = 'caret'
      caret.textContent = n.dir ? (collapsed.has(n.path) ? '▶' : '▼') : ''
      const label = document.createElement('span')
      label.textContent = n.name
      row.append(caret, label)
      if (!n.dir && !TEXT_LIKE.test(n.name) && !/\.pdf$/i.test(n.name)) row.classList.add('dim')
      if (n.path === active) row.classList.add('active')
      if (n.path === main) row.classList.add('main-file')
      row.addEventListener('click', () => {
        if (n.dir) {
          collapsed.has(n.path) ? collapsed.delete(n.path) : collapsed.add(n.path)
          renderTree(host, nodes, active, main, hooks)
        } else hooks.open(n.path)
      })
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        hooks.contextMenu(n, e.clientX, e.clientY)
      })
      li.appendChild(row)
      if (n.dir && !collapsed.has(n.path) && n.children?.length) li.appendChild(build(n.children))
      ul.appendChild(li)
    }
    return ul
  }
  const scroll = host.scrollTop
  host.replaceChildren(build(nodes))
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
