// Pasting and dropping into the editor: reading the clipboard, saving pasted pictures,
// copying dropped pictures into the project, and choosing a CSV file for a table.
import { BrowserWindow, clipboard, dialog, ipcMain, IpcMainInvokeEvent } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { basename, dirname } from 'path'
import type { Project } from './project'

const IMAGE = /\.(png|jpe?g|pdf|eps)$/i

export function registerPasteIpc(need: (e: IpcMainInvokeEvent) => Project): void {
  ipcMain.handle('paste:clipboard', async () => {
    const text = await clipboard.readText().catch(() => '')
    let html = ''
    try {
      const item = (await clipboard.read()).find((i) => i.types.includes('text/html'))
      if (item) html = await (await item.getType('text/html')).text()
    } catch {
      html = ''
    }
    return { text, html }
  })
  ipcMain.handle('paste:exists', (e, rel: string) => existsSync(need(e).abs(rel)))
  ipcMain.handle('paste:writeBinary', async (e, rel: string, data: Uint8Array) => {
    if (!IMAGE.test(rel)) throw new Error('Only pictures can be saved this way.')
    const p = need(e).abs(rel)
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, data)
  })
  ipcMain.handle('paste:copyIn', async (e, src: string, rel: string) => {
    if (!IMAGE.test(src) || !IMAGE.test(rel)) throw new Error('Only pictures can be copied this way.')
    const p = need(e).abs(rel)
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.copyFile(src, p)
  })
  ipcMain.handle('paste:chooseTable', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Choose a CSV file',
      properties: ['openFile' as const],
      filters: [{ name: 'Spreadsheet data (CSV, TSV)', extensions: ['csv', 'tsv', 'txt'] }, { name: 'All files', extensions: ['*'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const file = r.canceled ? null : r.filePaths[0]
    if (!file) return null
    if ((await fs.stat(file)).size > 5 * 1024 * 1024) throw new Error('That file is too large to turn into a table (more than 5 MB).')
    return { name: basename(file), text: await fs.readFile(file, 'utf8') }
  })
}
