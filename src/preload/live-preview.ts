import { ipcRenderer } from 'electron'
import type { LiveBox, LiveRequest, LiveResult } from '../shared/live-preview'

// Live preview (src/main/live-preview.ts): background builds into a private folder.
export const livePreviewApi = {
  build: (req: LiveRequest): Promise<LiveResult> => ipcRenderer.invoke('live:build', req),
  cancel: (): Promise<void> => ipcRenderer.invoke('live:cancel'),
  forward: (file: string, line: number): Promise<LiveBox | null> => ipcRenderer.invoke('live:forward', file, line),
  inverse: (page: number, x: number, y: number): Promise<{ file: string; line: number } | null> => ipcRenderer.invoke('live:inverse', page, x, y),
  onBattery: (): Promise<boolean> => ipcRenderer.invoke('live:onBattery'),
  onPower: (fn: (onBattery: boolean) => void): void => {
    ipcRenderer.on('live:power', (_e, onBattery: boolean) => fn(onBattery))
  }
}
