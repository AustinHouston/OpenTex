import { app, BrowserWindow, dialog, ipcMain, IpcMainEvent, IpcMainInvokeEvent, Menu, MenuItemConstructorOptions, shell } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { Engine, ProjectConfig, Settings } from '../shared/types'
import { Project } from './project'
import { cancelCompile, compile, detectTex } from './tex'
import { gitStatus, synctexForward, synctexInverse } from './extras'
import { builtinPluginsDir, listPlugins, pluginStorageGet, pluginStorageSet, registerPluginScheme, servePlugins, userPluginsDir } from './plugins'
import { findPandoc, importWord, installPandoc, pandocVersion } from './pandoc'
import { installMissing, installTinyTex, isTinyTex } from './tinytex'
import { loadSettings, loadUserThemes, saveSettings, settingsPath, themesDir } from './settings'

registerPluginScheme()

// Each window works in its own folder, like VS Code.
interface WindowCtx {
  win: BrowserWindow
  project: Project | null
  forceClose: boolean
}
const windows = new Map<number, WindowCtx>() // keyed by webContents id

type Ev = IpcMainInvokeEvent | IpcMainEvent
const ctxOf = (e: Ev): WindowCtx | undefined => windows.get(e.sender.id)
const winOf = (e: Ev): BrowserWindow => ctxOf(e)!.win
function need(e: Ev): Project {
  const p = ctxOf(e)?.project
  if (!p) throw new Error('No project folder is open')
  return p
}

export const templatesDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'templates') : join(app.getAppPath(), 'templates'))

function createWindow(openFolder?: string): BrowserWindow {
  const focused = BrowserWindow.getFocusedWindow()
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 400,
    title: 'OpenTex',
    show: false,
    // Cascade new windows a little so they don't stack exactly.
    ...(focused ? { x: focused.getBounds().x + 30, y: focused.getBounds().y + 30 } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const ctx: WindowCtx = { win, project: null, forceClose: false }
  const id = win.webContents.id
  windows.set(id, ctx)
  win.once('ready-to-show', () => win.show())
  // Keep the folder name in the title bar instead of the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault())
  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Spelling suggestions and the right-click position go to the page, which draws its own menu.
  win.webContents.on('context-menu', (_e, p) => {
    win.webContents.send('context-menu', { misspelled: p.misspelledWord, suggestions: p.dictionarySuggestions.slice(0, 6) })
  })
  win.on('close', (e) => {
    // Ask the page whether there are unsaved changes first.
    if (!ctx.forceClose) {
      e.preventDefault()
      win.webContents.send('app:before-close')
    }
  })
  win.on('closed', () => {
    ctx.project?.close()
    windows.delete(id)
  })
  const query = openFolder ? { open: openFolder } : undefined
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (openFolder) url.searchParams.set('open', openFolder)
    win.loadURL(url.toString())
  } else win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  return win
}

ipcMain.on('app:close-ok', (e) => {
  const ctx = ctxOf(e)
  if (!ctx) return
  ctx.forceClose = true
  ctx.win.close()
})

/** Send a menu action to the focused window (creating one if none is open). */
function send(action: string, ...args: unknown[]): void {
  const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
  const go = (): void => w.webContents.send('menu', action, ...args)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go)
  else go()
}

async function recentProjects(): Promise<string[]> {
  return ((await loadSettings()).recentProjects ?? []).filter((p) => existsSync(p))
}

async function buildMenu(): Promise<void> {
  const isMac = process.platform === 'darwin'
  const recent = await recentProjects()
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
        { label: 'New Project…', click: () => send('new-project') },
        { label: 'New File…', accelerator: 'CmdOrCtrl+N', click: () => send('new-file') },
        { type: 'separator' },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('open-folder') },
        { label: 'Open Folder in New Window…', click: () => openFolderInNewWindow() },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? [
                ...recent.map((p): MenuItemConstructorOptions => ({ label: p.replace(app.getPath('home'), '~'), click: () => send('open-path', p) })),
                { type: 'separator' },
                { label: 'Clear Recent', click: async () => (await saveSettings({ recentProjects: [] }), buildMenu()) }
              ]
            : [{ label: 'No recent folders', enabled: false }]
        },
        { label: 'Open the Example Paper', click: () => send('open-example') },
        { type: 'separator' },
        { label: 'Import Word Document…', click: () => send('import-word') },
        { label: 'Import References (EndNote, Zotero, Mendeley)…', click: () => send('import-refs') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { label: 'Close Folder', click: () => send('close-folder') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => BrowserWindow.getFocusedWindow()?.close() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('focus') },
        { label: 'Toggle Files', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { label: 'Toggle PDF', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('toggle-pdf') },
        { type: 'separator' },
        // Zoom keys are handled in the page so both Ctrl and Cmd work on macOS.
        { label: 'Bigger Interface', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => send('zoom-in') },
        { label: 'Smaller Interface', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => send('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => send('zoom-reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Review',
      submenu: [
        { label: 'Add Comment', accelerator: 'CmdOrCtrl+Shift+M', click: () => send('add-comment') },
        { label: 'Show Comments', click: () => send('show-comments') },
        { type: 'separator' },
        { label: 'Show Source Line in PDF', accelerator: 'CmdOrCtrl+J', click: () => send('sync-forward') }
      ]
    },
    {
      label: 'Build',
      submenu: [
        { label: 'Compile', accelerator: 'CmdOrCtrl+Return', click: () => send('compile') },
        { label: 'Stop Compile', click: () => send('stop-compile') },
        { label: 'Show Log', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('show-log') },
        { type: 'separator' },
        { label: 'Install TinyTeX…', click: () => send('install-tinytex') }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open the Example Paper', click: () => send('open-example') },
        { label: 'OpenTex on GitHub', click: () => shell.openExternal('https://github.com/AustinHouston/OpenTex') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function openFolderInNewWindow(): Promise<void> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (!r.canceled && r.filePaths[0]) focusOrOpen(r.filePaths[0])
}

/** Bring forward the window that already has this folder, or open it in a new window. */
function focusOrOpen(root: string): void {
  const existing = [...windows.values()].find((c) => c.project?.root === root)
  if (existing) existing.win.focus()
  else createWindow(root)
}

async function openProject(ctx: WindowCtx, root: string) {
  // A folder is open in at most one window: if another window has it, switch to that one.
  const other = [...windows.values()].find((c) => c !== ctx && c.project?.root === root)
  if (other) {
    other.win.focus()
    return null
  }
  ctx.project?.close()
  const project = new Project(root)
  ctx.project = project
  project.watch((paths) => ctx.win.webContents.send('project:changed', paths))
  const recent = [root, ...(await recentProjects()).filter((p) => p !== root)].slice(0, 12)
  await saveSettings({ lastProject: root, recentProjects: recent })
  app.addRecentDocument(root)
  ctx.win.setTitle(`${basename(root)} — OpenTex`)
  ctx.win.setRepresentedFilename?.(root)
  buildMenu()
  return project.info()
}

function registerIpc(): void {
  ipcMain.handle('project:choose', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : openProject(ctxOf(e)!, r.filePaths[0])
  })
  ipcMain.handle('project:open', async (e, root: string) => {
    try {
      await fs.access(root)
      return await openProject(ctxOf(e)!, root)
    } catch {
      return null
    }
  })
  ipcMain.handle('project:close', (e) => {
    const ctx = ctxOf(e)!
    ctx.project?.close()
    ctx.project = null
    ctx.win.setTitle('OpenTex')
  })
  ipcMain.handle('project:recent', async () => (await recentProjects()).map((p) => ({ path: p, name: basename(p), parent: dirname(p).replace(app.getPath('home'), '~') })))
  ipcMain.handle('project:forgetRecent', async (_e, p: string) => {
    await saveSettings({ recentProjects: (await recentProjects()).filter((x) => x !== p) })
    buildMenu()
  })
  ipcMain.handle('window:new', (_e, folder?: string) => {
    if (folder) focusOrOpen(folder)
    else createWindow()
  })
  ipcMain.handle('project:defaultParent', () => app.getPath('documents'))
  ipcMain.handle('project:create', async (_e, parent: string, name: string, template: 'blank' | 'example-paper') => {
    const clean = name.replace(/[\\/:*?"<>|]+/g, '-').trim()
    if (!clean) throw new Error('Please give the project a name.')
    const folder = join(parent, clean)
    if (existsSync(folder) && (await fs.readdir(folder)).length) throw new Error(`A folder named “${clean}” already exists there and isn't empty.`)
    await fs.cp(join(templatesDir(), template), folder, { recursive: true })
    return folder
  })
  ipcMain.handle('project:example', async () => {
    // A fresh copy in Documents, so the reader can edit it freely; reused if it already exists.
    const folder = join(app.getPath('documents'), 'OpenTex Example Paper')
    if (!existsSync(folder)) await fs.cp(join(templatesDir(), 'example-paper'), folder, { recursive: true })
    return folder
  })
  ipcMain.handle('project:info', (e) => need(e).info())
  ipcMain.handle('project:setConfig', (e, patch: ProjectConfig) => need(e).writeConfig(patch))
  ipcMain.handle('project:reveal', (e, rel: string) => shell.showItemInFolder(need(e).abs(rel)))

  ipcMain.handle('file:read', (e, rel: string) => fs.readFile(need(e).abs(rel), 'utf8'))
  ipcMain.handle('file:readBinary', async (e, rel: string) => new Uint8Array(await fs.readFile(need(e).abs(rel))))
  ipcMain.handle('file:write', async (e, rel: string, text: string) => {
    const p = need(e).abs(rel)
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, text, 'utf8')
  })
  ipcMain.handle('file:create', async (e, rel: string) => {
    const p = need(e).abs(rel)
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, '', { flag: 'wx' })
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', async (e, patch: Partial<Settings>) => {
    const s = await saveSettings(patch)
    // Keep every window's look in sync (themes, fonts, zoom…); layout stays per window until reload.
    if (!('layout' in patch && Object.keys(patch).length === 1)) {
      for (const c of windows.values()) if (c.win.webContents.id !== e.sender.id) c.win.webContents.send('settings:changed', s)
    }
    return s
  })
  ipcMain.handle('settings:openFile', async () => {
    await loadSettings().then(() => saveSettings({}))
    shell.openPath(settingsPath())
  })
  ipcMain.handle('themes:user', () => loadUserThemes())
  ipcMain.handle('themes:openFolder', async () => {
    await loadUserThemes()
    shell.openPath(themesDir())
  })
  ipcMain.handle('window:fullscreen', (e, on: boolean) => winOf(e).setFullScreen(on))

  ipcMain.handle('tex:detect', async () => detectTex((await loadSettings()).texPath))
  ipcMain.handle('tex:compile', async (e, mainFile: string, engine: Engine) => {
    const s = await loadSettings()
    const tex = detectTex(s.texPath)
    if (!tex.found) throw new Error('No TeX installation found. Set the TeX folder in Settings.')
    return compile(need(e).root, mainFile, engine, tex, s.useLatexmk)
  })
  ipcMain.handle('tex:cancel', (e) => {
    const p = ctxOf(e)?.project
    if (p) cancelCompile(p.root)
  })
  const binDir = async (): Promise<string | null> => detectTex((await loadSettings()).texPath).binDir
  ipcMain.handle('synctex:forward', async (e, file: string, line: number, pdf: string) => synctexForward(await binDir(), need(e).root, file, line, pdf))
  ipcMain.handle('synctex:inverse', async (e, pdf: string, page: number, x: number, y: number) => synctexInverse(await binDir(), need(e).root, pdf, page, x, y))
  ipcMain.handle('git:status', (e) => {
    const p = ctxOf(e)?.project
    return p ? gitStatus(p.root) : null
  })
  ipcMain.handle('edit:command', (e, cmd: 'cut' | 'copy' | 'paste' | 'selectAll') => e.sender[cmd]())
  ipcMain.handle('spell:add', (e, word: string) => e.sender.session.addWordToSpellCheckerDictionary(word))

  // ---------- Importing ----------
  ipcMain.handle('word:choose', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), { title: 'Import a Word document', properties: ['openFile'], filters: [{ name: 'Word documents', extensions: ['docx'] }] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('folder:choose', async (e, title: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(winOf(e), { title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('pandoc:find', async () => {
    const p = await findPandoc()
    const v = p && (await pandocVersion(p))
    return v ? { path: p, version: v } : null
  })
  ipcMain.handle('pandoc:install', (e) => installPandoc((line) => e.sender.send('tex:progress', line)))
  ipcMain.handle('word:import', async (_e, docx: string, parent: string, keepComments: boolean) => {
    const p = await findPandoc()
    if (!p) throw new Error('Pandoc is not installed')
    if (!/\.docx$/i.test(docx)) throw new Error('Only .docx files can be imported (in Word, use File → Save As → Word Document).')
    return importWord(p, docx, parent, keepComments)
  })
  ipcMain.handle('refs:choose', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), {
      title: 'Choose an exported reference library',
      properties: ['openFile'],
      filters: [{ name: 'Reference libraries', extensions: ['xml', 'ris', 'txt', 'bib', 'json', 'nbib', 'enw'] }, { name: 'All files', extensions: ['*'] }]
    })
    const file = r.canceled ? null : r.filePaths[0]
    if (!file) return null
    const stat = await fs.stat(file)
    if (stat.size > 80 * 1024 * 1024) throw new Error('That file is too large to be a reference library.')
    return { name: basename(file), text: await fs.readFile(file, 'utf8') }
  })
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:openFolder', async () => {
    await listPlugins()
    shell.openPath(userPluginsDir())
  })
  ipcMain.handle('plugins:storageGet', (_e, id: string) => pluginStorageGet(id))
  ipcMain.handle('plugins:storageSet', (_e, id: string, key: string, value: unknown) => pluginStorageSet(id, key, value))

  ipcMain.handle('tinytex:install', (e) => installTinyTex((line) => e.sender.send('tex:progress', line)))
  ipcMain.handle('tex:canInstallPackages', async () => isTinyTex(detectTex((await loadSettings()).texPath).binDir))
  ipcMain.handle('tex:installMissing', async (e, files: string[]) => {
    const tex = detectTex((await loadSettings()).texPath)
    return tex.binDir ? installMissing(tex.binDir, files, (line) => e.sender.send('tex:progress', line)) : false
  })
}

app.whenReady().then(async () => {
  await listPlugins()
  servePlugins(join(builtinPluginsDir(), 'opentex-sdk.js'))
  registerIpc()
  await buildMenu()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
