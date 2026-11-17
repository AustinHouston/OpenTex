// Small dialog helpers (Electron has no window.prompt).

const modal = (): HTMLDialogElement => document.getElementById('modal') as HTMLDialogElement

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Show a message with buttons; resolves to the chosen button's index, or -1 on Escape. */
export function ask(message: string, buttons: string[], primary = 0): Promise<number> {
  const d = modal()
  d.innerHTML = `<div class="modal-body"><p>${esc(message)}</p></div><div class="modal-actions">${buttons
    .map((b, i) => `<button data-i="${i}" class="${i === primary ? 'primary' : ''}">${esc(b)}</button>`)
    .join('')}</div>`
  return new Promise((resolve) => {
    let result = -1
    d.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        result = Number(b.dataset.i)
        d.close()
      })
    )
    d.addEventListener('close', () => resolve(result), { once: true })
    d.showModal()
    ;(d.querySelector('button.primary') as HTMLButtonElement)?.focus()
  })
}

export function promptText(message: string, initial = ''): Promise<string | null> {
  const d = modal()
  d.innerHTML = `<form method="dialog"><div class="modal-body"><p>${esc(message)}</p><input type="text" value="${esc(initial)}" /></div>
    <div class="modal-actions"><button value="cancel" type="button" data-cancel>Cancel</button><button class="primary" value="ok">OK</button></div></form>`
  const input = d.querySelector('input')!
  return new Promise((resolve) => {
    d.querySelector('[data-cancel]')!.addEventListener('click', () => d.close('cancel'))
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null), { once: true })
    d.returnValue = ''
    d.showModal()
    input.focus()
    input.select()
  })
}

/** A menu row: label, action and an optional tooltip; null draws a separator. */
export type MenuItem = [string, () => void, string?] | null

/** Who opened a menu: it gets aria-expanded while the menu shows, and the keyboard focus back on Escape. */
export interface MenuOpener {
  opener?: HTMLElement
}

let closeMenu: (() => void) | null = null

/** Close the open menu, if any (a menu button clicked again closes its menu). */
export function closeContextMenu(): void {
  closeMenu?.()
}

export function contextMenu(x: number, y: number, items: MenuItem[], opts: MenuOpener = {}): void {
  const m = document.getElementById('ctx-menu')!
  // A menu opened from another menu's item replaces it: the first one's closing click must not close this one.
  closeMenu?.()
  const opener = opts.opener
  m.setAttribute('role', 'menu')
  m.replaceChildren(
    ...items.map((item) => {
      // A separator line: null, or the label '-'.
      if (!item || item[0] === '-') return Object.assign(document.createElement('div'), { className: 'ctx-sep', role: 'separator' })
      const [label, fn, tip] = item
      const b = document.createElement('button')
      b.textContent = label
      b.setAttribute('role', 'menuitem')
      b.tabIndex = -1
      if (tip) b.title = tip
      b.onclick = () => {
        // Back to the opener first, so a dialog the item opens can still take the focus from there.
        const hadFocus = m.contains(document.activeElement)
        close()
        if (hadFocus) opener?.focus()
        fn()
      }
      return b
    })
  )
  m.style.left = `${x}px`
  m.style.top = `${y}px`
  m.classList.remove('hidden')
  // Keep it on screen.
  const r = m.getBoundingClientRect()
  if (r.right > window.innerWidth - 4) m.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`
  if (r.bottom > window.innerHeight - 4) m.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`
  const rows = (): HTMLButtonElement[] => [...m.querySelectorAll<HTMLButtonElement>('button')]
  // Arrow keys walk the rows, Escape closes and hands the focus back to the opener, Tab just closes.
  const onKey = (e: KeyboardEvent): void => {
    const list = rows()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number): void => {
      e.preventDefault()
      list[(n + list.length) % list.length]?.focus()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const back = m.contains(document.activeElement) || document.activeElement === opener
      close()
      if (back) opener?.focus()
    } else if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
    else if (e.key === 'Tab') close()
  }
  const close = (): void => {
    m.classList.add('hidden')
    document.removeEventListener('click', close)
    document.removeEventListener('keydown', onKey, true)
    opener?.setAttribute('aria-expanded', 'false')
    if (closeMenu === close) closeMenu = null
  }
  closeMenu = close
  opener?.setAttribute('aria-expanded', 'true')
  document.addEventListener('keydown', onKey, true)
  // Opened from the keyboard: the first row takes the focus, like a native menu.
  if (opener?.matches(':focus-visible')) rows()[0]?.focus()
  setTimeout(() => closeMenu === close && document.addEventListener('click', close, { once: true }))
}
