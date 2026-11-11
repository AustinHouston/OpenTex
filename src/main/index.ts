import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { Engine, ProjectConfig, Settings } from '../shared/types'
import { Project } from './project'
import { cancelCompile, compile, detectTex } from './tex'
import { gitStatus, synctexForward, synctexInverse } from './extras'
import { builtinPluginsDir, listPlugins, pluginStorageGet, pluginStorageSet, registerPluginScheme, servePlugins, userPluginsDir } from './plugins'
import { installMissing, installTinyTex, isTinyTex } from './tinytex'
import { loadSettings, loadUserThemes, saveSettings, settingsPath, themesDir } from './settings'

registerPluginScheme()

let win: BrowserWindow | null = null
let project: Project | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 400,
    title: 'OpenTex',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Spelling suggestions and the right-click position go to the page, which draws its own menu.
  win.webContents.on('context-menu', (_e, p) => {
    win?.webContents.send('context-menu', { misspelled: p.misspelledWord, suggestions: p.dictionarySuggestions.slice(0, 6) })
  })
  win.on('close', (e) => {
    // Ask the renderer whether there are unsaved changes.
    if (!forceClose) {
      e.preventDefault()
      win?.webContents.send('app:before-close')
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

let forceClose = false
ipcMain.on('app:close-ok', () => {
  forceClose = true
  win?.close()
})

const send = (action: string): void => win?.webContents.send('menu', action)

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('open-folder') },
        { label: 'New File…', accelerator: 'CmdOrCtrl+N', click: () => send('new-file') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Focus Mode', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('focus') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
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
        { label: 'Stop Compile', click: () => cancelCompile() },
        { label: 'Show Log', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('show-log') },
        { type: 'separator' },
        { label: 'Install TinyTeX…', click: () => send('install-tinytex') }
      ]
    },
    {
      role: 'help',
      submenu: [{ label: 'OpenTex on GitHub', click: () => shell.openExternal('https://github.com/AustinHouston/OpenTex') }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function openProject(root: string) {
  project?.close()
  project = new Project(root)
  project.watch((paths) => win?.webContents.send('project:changed', paths))
  await saveSettings({ lastProject: root })
  app.addRecentDocument(root)
  win?.setTitle(`${project.root.split(/[\\/]/).pop()} — OpenTex`)
  return project.info()
}

function need(): Project {
  if (!project) throw new Error('No project folder is open')
  return project
}

function registerIpc(): void {
  ipcMain.handle('project:choose', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : openProject(r.filePaths[0])
  })
  ipcMain.handle('project:open', async (_e, root: string) => {
    try {
      await fs.access(root)
      return await openProject(root)
    } catch {
      return null
    }
  })
  ipcMain.handle('project:info', () => need().info())
  ipcMain.handle('project:setConfig', (_e, patch: ProjectConfig) => need().writeConfig(patch))
  ipcMain.handle('project:reveal', (_e, rel: string) => shell.showItemInFolder(need().abs(rel)))

  ipcMain.handle('file:read', (_e, rel: string) => fs.readFile(need().abs(rel), 'utf8'))
  ipcMain.handle('file:readBinary', async (_e, rel: string) => new Uint8Array(await fs.readFile(need().abs(rel))))
  ipcMain.handle('file:write', async (_e, rel: string, text: string) => {
    const p = need().abs(rel)
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, text, 'utf8')
  })
  ipcMain.handle('file:create', async (_e, rel: string) => {
    const p = need().abs(rel)
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, '', { flag: 'wx' })
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => saveSettings(patch))
  ipcMain.handle('settings:openFile', async () => {
    await loadSettings().then(() => saveSettings({}))
    shell.openPath(settingsPath())
  })
  ipcMain.handle('themes:user', () => loadUserThemes())
  ipcMain.handle('themes:openFolder', async () => {
    await loadUserThemes()
    shell.openPath(themesDir())
  })
  ipcMain.handle('window:fullscreen', (_e, on: boolean) => win?.setFullScreen(on))

  ipcMain.handle('tex:detect', async () => detectTex((await loadSettings()).texPath))
  ipcMain.handle('tex:compile', async (_e, mainFile: string, engine: Engine) => {
    const s = await loadSettings()
    const tex = detectTex(s.texPath)
    if (!tex.found) throw new Error('No TeX installation found. Set the TeX folder in Settings.')
    return compile(need().root, mainFile, engine, tex, s.useLatexmk)
  })
  ipcMain.handle('tex:cancel', () => cancelCompile())
  const binDir = async (): Promise<string | null> => detectTex((await loadSettings()).texPath).binDir
  ipcMain.handle('synctex:forward', async (_e, file: string, line: number, pdf: string) => synctexForward(await binDir(), need().root, file, line, pdf))
  ipcMain.handle('synctex:inverse', async (_e, pdf: string, page: number, x: number, y: number) => synctexInverse(await binDir(), need().root, pdf, page, x, y))
  ipcMain.handle('git:status', () => (project ? gitStatus(project.root) : null))
  ipcMain.handle('edit:command', (_e, cmd: 'cut' | 'copy' | 'paste' | 'selectAll') => win?.webContents[cmd]())
  ipcMain.handle('spell:add', (_e, word: string) => win?.webContents.session.addWordToSpellCheckerDictionary(word))
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:openFolder', async () => {
    await listPlugins()
    shell.openPath(userPluginsDir())
  })
  ipcMain.handle('plugins:storageGet', (_e, id: string) => pluginStorageGet(id))
  ipcMain.handle('plugins:storageSet', (_e, id: string, key: string, value: unknown) => pluginStorageSet(id, key, value))

  const progress = (line: string): void => win?.webContents.send('tex:progress', line)
  ipcMain.handle('tinytex:install', () => installTinyTex(progress))
  ipcMain.handle('tex:canInstallPackages', async () => isTinyTex(detectTex((await loadSettings()).texPath).binDir))
  ipcMain.handle('tex:installMissing', async (_e, files: string[]) => {
    const tex = detectTex((await loadSettings()).texPath)
    return tex.binDir ? installMissing(tex.binDir, files, progress) : false
  })
}

app.whenReady().then(async () => {
  await listPlugins()
  servePlugins(join(builtinPluginsDir(), 'opentex-sdk.js'))
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  project?.close()
  if (process.platform !== 'darwin') app.quit()
})
