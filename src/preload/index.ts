import { contextBridge, ipcRenderer, webFrame } from 'electron'

// The only bridge between the page and the system. Everything goes through IPC handlers in src/main/index.ts.
const api = {
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  openProject: (root: string) => ipcRenderer.invoke('project:open', root),
  projectInfo: () => ipcRenderer.invoke('project:info'),
  setProjectConfig: (patch: object) => ipcRenderer.invoke('project:setConfig', patch),
  reveal: (rel: string) => ipcRenderer.invoke('project:reveal', rel),
  readFile: (rel: string) => ipcRenderer.invoke('file:read', rel),
  readBinary: (rel: string) => ipcRenderer.invoke('file:readBinary', rel),
  writeFile: (rel: string, text: string) => ipcRenderer.invoke('file:write', rel, text),
  createFile: (rel: string) => ipcRenderer.invoke('file:create', rel),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: object) => ipcRenderer.invoke('settings:set', patch),
  openSettingsFile: () => ipcRenderer.invoke('settings:openFile'),
  userThemes: () => ipcRenderer.invoke('themes:user'),
  openThemesFolder: () => ipcRenderer.invoke('themes:openFolder'),
  setFullscreen: (on: boolean) => ipcRenderer.invoke('window:fullscreen', on),
  detectTex: () => ipcRenderer.invoke('tex:detect'),
  compile: (mainFile: string, engine: string) => ipcRenderer.invoke('tex:compile', mainFile, engine),
  cancelCompile: () => ipcRenderer.invoke('tex:cancel'),
  installTinyTex: () => ipcRenderer.invoke('tinytex:install'),
  canInstallPackages: () => ipcRenderer.invoke('tex:canInstallPackages'),
  installMissing: (files: string[]) => ipcRenderer.invoke('tex:installMissing', files),
  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
  synctexForward: (file: string, line: number, pdf: string) => ipcRenderer.invoke('synctex:forward', file, line, pdf),
  synctexInverse: (pdf: string, page: number, x: number, y: number) => ipcRenderer.invoke('synctex:inverse', pdf, page, x, y),
  gitStatus: () => ipcRenderer.invoke('git:status'),
  editCommand: (cmd: 'cut' | 'copy' | 'paste' | 'selectAll') => ipcRenderer.invoke('edit:command', cmd),
  addToDictionary: (word: string) => ipcRenderer.invoke('spell:add', word),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  openPluginsFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  pluginStorageGet: (id: string) => ipcRenderer.invoke('plugins:storageGet', id),
  pluginStorageSet: (id: string, key: string, value: unknown) => ipcRenderer.invoke('plugins:storageSet', id, key, value),
  closeOk: () => ipcRenderer.send('app:close-ok'),
  on: (channel: 'menu' | 'project:changed' | 'app:before-close' | 'tex:progress' | 'context-menu', fn: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_e, ...args) => fn(...args))
  }
}

contextBridge.exposeInMainWorld('opentex', api)
export type OpenTexApi = typeof api
