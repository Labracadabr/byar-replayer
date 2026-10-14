import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Settings, SettingsState } from '@shared/types'
import { openDb, type Db } from './db'
import { Library } from './library'
import { SettingsStore } from './settings'

let win: BrowserWindow | null = null
let settings: SettingsStore
let db: Db | null = null
let dbPath = ''
let library: Library | null = null

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

/** (Re)start the library when the settings are valid; called at startup and after every settings change. */
function startServices(): void {
  const state = settings.state()
  if (state.problems.length > 0) return
  const s = settings.get()
  mkdirSync(s.workDir, { recursive: true })
  const wantedDb = join(s.workDir, 'library.sqlite')
  if (wantedDb !== dbPath) {
    library?.stopWatching()
    db?.close()
    db = openDb(wantedDb)
    dbPath = wantedDb
    library = new Library(db, s.demoDirs)
    library.on('changed', () => send('library:changed'))
    library.on('progress', (p) => send('library:scanProgress', p))
  }
  library!.setDemoDirs(s.demoDirs)
  void library!.scan()
}

function requireLibrary(): Library {
  if (!library) throw new Error('Library not available: fix the settings first')
  return library
}

function registerIpc(): void {
  ipcMain.handle('settings:get', (): SettingsState => settings.state())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>): SettingsState => {
    const state = settings.update(patch)
    startServices()
    return state
  })
  ipcMain.handle('dialog:pickFolder', async (_e, title: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('library:list', () => (library ? library.list() : []))
  ipcMain.handle('library:get', (_e, id: number) => requireLibrary().get(id))
  ipcMain.handle('library:setFavorite', (_e, id: number, fav: boolean) => requireLibrary().setFavorite(id, fav))
  ipcMain.handle('library:setNote', (_e, id: number, note: string) => requireLibrary().setNote(id, note))
  ipcMain.handle('library:rescan', () => requireLibrary().scan())
  ipcMain.handle('shell:showInFolder', (_e, path: string) => shell.showItemInFolder(path))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'BAR Replay Viewer',
    backgroundColor: '#14171c',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.setMenuBarVisibility(false)
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  settings = new SettingsStore(app.getPath('userData'))
  registerIpc()
  createWindow()
  startServices()
})

app.on('window-all-closed', () => {
  library?.stopWatching()
  db?.close()
  app.quit()
})
