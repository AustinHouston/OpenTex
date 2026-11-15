// File management in the file list: Rename, New Folder, Duplicate, Delete (to the Trash) and
// moving by drag and drop. Renames and moves keep everything attached: open tabs, comments, the
// main file setting, the PDF, and (if you agree) the \input / \includegraphics / \bibliography
// lines that name the file.
import './fileops.css'
import type { TreeNode } from '../../shared/types'
import { allFiles } from './filetree'
import { ask, contextMenu, promptText } from './ui'
import { AppHost, editOpenFile, editText, esc, liveText } from './apphost'
import { findReferences, mapPath, Move, RefEdit } from './references'

const DRAG_TYPE = 'text/x-opentex-file'
const isMac = navigator.platform.startsWith('Mac')
const BIN = navigator.platform.startsWith('Win') ? 'Recycle Bin' : 'Trash'

const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const nameOf = (p: string): string => p.split('/').pop()!
const joinName = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)
const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^.*Error: /, '')

export class FileOps {
  private dragging: TreeNode | null = null
  private dragEnded = 0
  private nodes = new WeakMap<HTMLElement, TreeNode>()
  private tree: HTMLElement

  constructor(private host: AppHost) {
    this.tree = document.getElementById('tree')!
    // Right-click in the empty part of the file list.
    this.tree.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.row') || !host.project()) return
      e.preventDefault()
      contextMenu(e.clientX, e.clientY, [
        ['New File…', () => host.newFile()],
        ['New Folder…', () => this.newFolder('')],
        [isMac ? 'Reveal Project in Finder' : 'Show Project Folder', () => host.api.reveal('.')]
      ])
    })
    this.wireDrop()
  }

  /** Items for the file list's right-click menu. */
  menuItems(n: TreeNode): [string, () => void][] {
    return [
      ['New Folder…', () => this.newFolder(n.dir ? n.path : parentOf(n.path))],
      ['Rename…', () => this.rename(n)],
      ['Duplicate', () => this.duplicate(n)],
      ['Delete', () => this.remove(n)]
    ]
  }

  // ---------- Names ----------
  private siblings(dir: string): TreeNode[] {
    const tree = this.host.project()?.tree ?? []
    if (!dir) return tree
    let level = tree
    for (const seg of dir.split('/')) level = level.find((x) => x.dir && x.name === seg)?.children ?? []
    return level
  }

  /** Why a name can't be used in `dir`, or null if it's fine. `self` is the item being renamed. */
  private nameProblem(name: string, dir: string, self?: string): string | null {
    if (!name) return 'Please type a name.'
    if (/[\\/:*?"<>|]/.test(name)) return 'Names can’t contain any of these characters:  / \\ : * ? " < > |'
    if (name.startsWith('.')) return 'Names can’t start with a dot (files like that are hidden).'
    if (name.endsWith('.')) return 'Names can’t end with a dot.'
    const clash = this.siblings(dir).find((s) => s.name.toLowerCase() === name.toLowerCase() && s.path !== self)
    if (clash) return `There is already a ${clash.dir ? 'folder' : 'file'} named “${clash.name}” here.`
    return null
  }

  /** Ask for a name until it's usable (or the user cancels). */
  private async askName(message: string, initial: string, dir: string, self?: string): Promise<string | null> {
    let value = initial
    for (;;) {
      const name = await promptText(message, value)
      if (name === null) return null
      const problem = this.nameProblem(name, dir, self)
      if (!problem) return name
      await ask(problem, ['OK'])
      value = name
    }
  }

  // ---------- Commands ----------
  async newFolder(dir: string): Promise<void> {
    if (!this.host.project()) return
    const name = await this.askName(dir ? `Name for the new folder inside “${dir}”:` : 'Name for the new folder:', 'New folder', dir)
    if (!name) return
    try {
      await this.host.api.makeFolder(joinName(dir, name))
    } catch (e) {
      await ask(`Could not make the folder: ${errText(e)}`, ['OK'])
      return
    }
    await this.host.reloadTree()
    this.host.status(`Made the folder ${joinName(dir, name)}`, 'ok')
  }

  async rename(n: TreeNode): Promise<void> {
    const dir = parentOf(n.path)
    const name = await this.askName(`New name for the ${n.dir ? 'folder' : 'file'} “${n.name}”:`, n.name, dir, n.path)
    if (!name || name === n.name) return
    if (!n.dir && /\.tex$/i.test(n.name) && !/\.tex$/i.test(name)) {
      const r = await ask(`“${name}” doesn’t end in .tex, so OpenTex won’t treat it as a LaTeX file any more. Rename it anyway?`, ['Rename', 'Cancel'], 1)
      if (r !== 0) return
    }
    await this.move(n, joinName(dir, name), 'rename')
  }

  async duplicate(n: TreeNode): Promise<void> {
    let copy: string
    try {
      copy = await this.host.api.duplicateItem(n.path)
    } catch (e) {
      await ask(`Could not copy “${n.name}”: ${errText(e)}`, ['OK'])
      return
    }
    await this.host.reloadTree()
    this.host.status(`Made a copy: ${copy}`, 'ok')
  }

  async remove(n: TreeNode): Promise<void> {
    const host = this.host
    const project = host.project()
    if (!project) return
    const inside = (p: string): boolean => p === n.path || (n.dir && p.startsWith(n.path + '/'))
    const count = n.dir ? allFiles(n.children ?? [], () => true).length : 0
    if (host.active() && host.files.has(host.active()!)) host.files.get(host.active()!)!.state = host.view.state
    const unsaved = [...host.files.values()].filter((f) => inside(f.path) && f.dirty).map((f) => nameOf(f.path))
    const what = n.dir
      ? `the folder “${n.name}”${count ? ` and the ${count === 1 ? 'file' : `${count} files`} in it` : ''}`
      : `“${n.name}”`
    let msg = `Move ${what} to the ${BIN}? You can get it back from the ${BIN} if you need it.`
    if (project.mainFile && inside(project.mainFile)) msg += ` ${n.dir ? 'It holds' : 'This is'} your main file.`
    if (unsaved.length) msg += ` Unsaved changes in ${unsaved.join(', ')} will be lost.`
    if ((await ask(msg, [`Move to ${BIN}`, 'Cancel'])) !== 0) return
    try {
      await host.api.trashItem(n.path)
    } catch (e) {
      await ask(`Could not move “${n.name}” to the ${BIN}: ${errText(e)}`, ['OK'])
      return
    }
    for (const p of [...host.tabOrder()].filter(inside)) {
      host.files.get(p)!.dirty = false // the user agreed to lose them
      await host.closeTab(p)
    }
    const pdf = host.lastPdf()
    if (pdf && inside(pdf)) host.forgetPdf()
    if (project.config.mainFile && inside(project.config.mainFile)) project.config = await host.api.setProjectConfig({ mainFile: undefined })
    await host.reloadTree()
    host.scheduleComments()
    host.refresh()
    host.status(`Moved ${n.dir ? 'folder ' : ''}${n.path} to the ${BIN}`, 'ok')
  }

  // ---------- Rename / move ----------
  /** Rename or move `n` to the project path `to`, keeping tabs, comments, the main file and the PDF attached. */
  async move(n: TreeNode, to: string, how: 'rename' | 'move'): Promise<void> {
    const host = this.host
    const project = host.project()
    if (!project || to === n.path) return
    const move: Move = { from: n.path, to, dir: n.dir }
    if (host.active() && host.files.has(host.active()!)) host.files.get(host.active()!)!.state = host.view.state

    // Look for references while the old paths still exist.
    const all = new Set(allFiles(project.tree, () => true))
    const texPaths = allFiles(project.tree, (p) => /\.tex$/i.test(p))
    const closed = texPaths.filter((p) => !host.files.has(p))
    const disk = new Map(closed.length ? await host.api.readMany(closed) : [])
    const texts = texPaths.map((p) => ({ path: p, text: liveText(host, p) ?? disk.get(p) ?? '' }))
    let refs: RefEdit[] = []
    try {
      refs = findReferences(move, texts, all, project.mainFile)
    } catch (e) {
      console.warn('Reference search failed', e)
    }

    const main = project.mainFile
    const pdf = host.lastPdf()
    const companions = !n.dir && (n.path === main || (pdf !== null && pdf === n.path.replace(/\.tex$/i, '.pdf')))
    let moved: [string, string][]
    try {
      moved = (await host.api.moveItem(n.path, to, companions)).companions
    } catch (e) {
      await ask(`Could not ${how} “${n.name}”: ${errText(e)}`, ['OK'])
      return
    }
    const map = (p: string): string | null => mapPath(move, p) ?? moved.find(([a]) => a === p)?.[1] ?? null

    // Open tabs (unsaved edits stay in the editor) and the active file.
    for (const [p, f] of [...host.files]) {
      const q = map(p)
      if (!q) continue
      host.files.delete(p)
      f.path = q
      host.files.set(q, f)
    }
    const order = host.tabOrder()
    order.forEach((p, i) => (order[i] = map(p) ?? p))
    const active = host.active()
    if (active && map(active)) host.setActive(map(active))

    // Comments.
    let changed = false
    for (const t of host.threads()) {
      const q = map(t.file)
      if (q) {
        t.file = q
        changed = true
      }
    }
    if (changed) await host.saveComments()

    // Main file setting, then the PDF.
    if (main && map(main)) await host.setMainFile(map(main)!)
    else if (project.config.mainFile && map(project.config.mainFile)) project.config = await host.api.setProjectConfig({ mainFile: map(project.config.mainFile)! })
    host.renderTabs()
    await host.reloadTree()
    if (pdf && map(pdf)) await host.showPdf(map(pdf)!)
    host.scheduleComments()

    const where = how === 'rename' ? `Renamed ${n.path} to ${nameOf(to)}` : `Moved ${n.path} to ${parentOf(to) || 'the top of the project'}`
    host.status(where, 'ok')
    if (refs.length) await this.offerReferences(n, move, refs, map)
    host.refresh()
  }

  /** Show the references that name the old path and offer to update them. */
  private async offerReferences(n: TreeNode, move: Move, refs: RefEdit[], map: (p: string) => string | null): Promise<void> {
    const host = this.host
    const files = new Set(refs.map((r) => r.file))
    const d = document.getElementById('modal') as HTMLDialogElement
    const shown = refs.slice(0, 60)
    d.innerHTML = `<div class="modal-body fo-refs">
      <p><b>${refs.length === 1 ? 'One place names' : `${refs.length} places name`} ${n.dir ? 'files in ' : ''}“${esc(nameOf(move.from))}” by ${n.dir ? 'their' : 'its'} old path</b>
      (in ${files.size === 1 ? esc(nameOf([...files][0])) : `${files.size} files`}). Update them so your paper still finds ${n.dir ? 'them' : 'it'}?</p>
      <ul class="fo-reflist">${shown
        .map(
          (r) => `<li><span class="fo-where">${esc(map(r.file) ?? r.file)}:${r.line}</span>
            <span class="fo-change"><del>${esc(r.expect)}</del> → <ins>${esc(r.insert)}</ins></span></li>`
        )
        .join('')}${refs.length > shown.length ? `<li class="fo-more">…and ${refs.length - shown.length} more</li>` : ''}</ul>
      <p class="hint">Open files change in the editor (Undo works there). Files that aren’t open are saved directly.</p>
    </div><div class="modal-actions"><button data-i="1">Leave them</button><button class="primary" data-i="0">Update references</button></div>`
    const choice = await new Promise<number>((resolve) => {
      let r = -1
      d.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => b.addEventListener('click', () => ((r = Number(b.dataset.i)), d.close())))
      d.addEventListener('close', () => resolve(r), { once: true })
      d.showModal()
      d.querySelector<HTMLButtonElement>('button.primary')?.focus()
    })
    if (choice !== 0) return

    let applied = 0
    let skipped = 0
    for (const file of files) {
      const now = map(file) ?? file
      const edits = refs.filter((r) => r.file === file)
      if (host.files.has(now)) {
        const k = editOpenFile(host, now, edits)
        applied += k
        skipped += edits.length - k
      } else {
        try {
          const r = editText(await host.api.readFile(now), edits)
          if (r.applied) await host.api.writeFile(now, r.text)
          applied += r.applied
          skipped += edits.length - r.applied
        } catch {
          skipped += edits.length
        }
      }
    }
    host.status(`Updated ${applied} reference${applied === 1 ? '' : 's'}${skipped ? `; ${skipped} had changed and were left alone` : ''}`, skipped ? 'warn' : 'ok')
  }

  // ---------- Drag and drop ----------
  /** Called by the file tree for each row it draws. */
  decorate(row: HTMLElement, n: TreeNode): void {
    this.nodes.set(row, n)
    row.dataset.ftPath = n.path
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      this.dragging = n
      e.dataTransfer!.setData(DRAG_TYPE, n.path)
      e.dataTransfer!.effectAllowed = 'move'
      row.classList.add('ft-dragging')
    })
    row.addEventListener('dragend', () => {
      this.dragEnded = Date.now()
      this.dragging = null
      row.classList.remove('ft-dragging')
      this.clearDrop()
    })
  }

  /** The folder a drop at this event would go into, or null when it can't go there. */
  private targetOf(e: DragEvent): string | null {
    const n = this.dragging
    if (!n) return null
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row')
    const over = row ? this.nodes.get(row) : undefined
    const dir = over ? (over.dir ? over.path : parentOf(over.path)) : ''
    if (dir === parentOf(n.path)) return null // already there
    if (n.dir && (dir === n.path || dir.startsWith(n.path + '/'))) return null // into itself
    return dir
  }

  private clearDrop(): void {
    this.tree.classList.remove('ft-drop-root')
    this.tree.querySelectorAll('.ft-drop').forEach((el) => el.classList.remove('ft-drop'))
  }

  private showDrop(dir: string): void {
    const li = dir ? this.tree.querySelector(`.row[data-ft-path="${CSS.escape(dir)}"]`)?.parentElement : null
    if (dir ? li?.classList.contains('ft-drop') : this.tree.classList.contains('ft-drop-root')) return
    this.clearDrop()
    if (li) li.classList.add('ft-drop')
    else this.tree.classList.add('ft-drop-root')
  }

  private wireDrop(): void {
    // A drag that ends where it started must not also count as a click (opening or folding a row).
    this.tree.addEventListener('click', (e) => Date.now() - this.dragEnded < 400 && e.stopPropagation(), true)
    this.tree.addEventListener('dragover', (e) => {
      if (!this.dragging || !e.dataTransfer?.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      const dir = this.targetOf(e)
      e.dataTransfer.dropEffect = dir === null ? 'none' : 'move'
      if (dir === null) this.clearDrop()
      else this.showDrop(dir)
    })
    this.tree.addEventListener('dragleave', (e) => {
      if (!this.tree.contains(e.relatedTarget as Node)) this.clearDrop()
    })
    this.tree.addEventListener('drop', async (e) => {
      const n = this.dragging
      if (!n || !e.dataTransfer?.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      const dir = this.targetOf(e)
      this.clearDrop()
      this.dragging = null
      if (dir === null) return
      const problem = this.nameProblem(n.name, dir)
      if (problem) return void ask(problem, ['OK'])
      const into = dir ? `the folder “${dir}”` : 'the top level of the project'
      if ((await ask(`Move ${n.dir ? 'the folder ' : ''}“${n.name}” into ${into}?`, ['Move', 'Cancel'])) !== 0) return
      await this.move(n, joinName(dir, n.name), 'move')
    })
  }
}
