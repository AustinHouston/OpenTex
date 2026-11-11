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

export function contextMenu(x: number, y: number, items: [string, () => void][]): void {
  const m = document.getElementById('ctx-menu')!
  m.replaceChildren(
    ...items.map(([label, fn]) => {
      const b = document.createElement('button')
      b.textContent = label
      b.onclick = () => {
        m.classList.add('hidden')
        fn()
      }
      return b
    })
  )
  m.style.left = `${x}px`
  m.style.top = `${y}px`
  m.classList.remove('hidden')
  setTimeout(() => document.addEventListener('click', () => m.classList.add('hidden'), { once: true }))
}
