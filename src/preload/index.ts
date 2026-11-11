import { contextBridge, ipcRenderer } from 'electron'

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
  closeOk: () => ipcRenderer.send('app:close-ok'),
  on: (channel: 'menu' | 'project:changed' | 'app:before-close', fn: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_e, ...args) => fn(...args))
  }
}

contextBridge.exposeInMainWorld('opentex', api)
export type OpenTexApi = typeof api
