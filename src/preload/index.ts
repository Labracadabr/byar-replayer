import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, DepState, JobInfo, ScanProgress } from '@shared/types'

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
  getTimeline: (id) => ipcRenderer.invoke('library:timeline', id),
  setFavorite: (id, favorite) => ipcRenderer.invoke('library:setFavorite', id, favorite),
  setNote: (id, note) => ipcRenderer.invoke('library:setNote', id, note),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  removeReplay: (id) => ipcRenderer.invoke('library:remove', id),
  importReplays: (paths) => ipcRenderer.invoke('library:import', paths),
  openReplays: () => ipcRenderer.invoke('library:openReplays'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),
  checkDeps: (id) => ipcRenderer.invoke('deps:check', id),
  ensureDeps: (id) => ipcRenderer.invoke('deps:ensure', id),
  addMapFolder: () => ipcRenderer.invoke('deps:addMapFolder'),
  onDepProgress: (cb) => subscribe<[DepState]>('deps:progress', cb),
  simulate: (id) => ipcRenderer.invoke('sim:simulate', id),
  cancelSim: (id) => ipcRenderer.invoke('sim:cancel', id),
  deleteSimData: (id) => ipcRenderer.invoke('sim:deleteData', id),
  getJob: (id) => ipcRenderer.invoke('sim:getJob', id),
  onJobUpdate: (cb) => subscribe<[JobInfo]>('sim:job', cb),
  onLibraryChanged: (cb) => subscribe('library:changed', cb),
  onScanProgress: (cb) => subscribe<[ScanProgress]>('library:scanProgress', cb)
}

contextBridge.exposeInMainWorld('api', api)
