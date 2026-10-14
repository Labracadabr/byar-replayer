import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ScanProgress } from '@shared/types'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  pickFolder: (title, defaultPath) => ipcRenderer.invoke('dialog:pickFolder', title, defaultPath),
  listReplays: () => ipcRenderer.invoke('library:list'),
  getReplay: (id) => ipcRenderer.invoke('library:get', id),
  setFavorite: (id, favorite) => ipcRenderer.invoke('library:setFavorite', id, favorite),
  setNote: (id, note) => ipcRenderer.invoke('library:setNote', id, note),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),
  onLibraryChanged: (cb) => subscribe('library:changed', cb),
  onScanProgress: (cb) => subscribe<[ScanProgress]>('library:scanProgress', cb)
}

contextBridge.exposeInMainWorld('api', api)
