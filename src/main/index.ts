import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { ReplayDeps, Settings, SettingsState } from '@shared/types'
import { openDb, type Db } from './db'
import { DepsResolver } from './deps/resolver'
import { readDemoTimeline } from './demo-meta'
import { Library } from './library'
import { handleProtocol, registerSchemePrivileges } from './protocol'
import { SettingsStore } from './settings'
import { SimQueue } from './sim/queue'

let win: BrowserWindow | null = null
let settings: SettingsStore
let db: Db | null = null
let dbPath = ''
let library: Library | null = null
let deps: DepsResolver
let queue: SimQueue | null = null

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
    queue?.stop()
    library?.stopWatching()
    db?.close()
    db = openDb(wantedDb)
    dbPath = wantedDb
    library = new Library(db, s.demoDirs)
    library.on('changed', () => send('library:changed'))
    library.on('progress', (p) => send('library:scanProgress', p))
    queue = new SimQueue(db, library, deps, () => settings.get())
    queue.on('job', (job) => send('sim:job', job))
    queue.on('changed', () => send('library:changed'))
    queue.on('log', (line: string) => console.log('[sim]', line))
    queue.start()
  }
  library!.setDemoDirs(s.demoDirs)
  void library!.scan()
}

function depsRequest(id: number): { engineVersion: string; gameVersion: string; mapName: string } {
  const r = requireLibrary().get(id)
  if (!r) throw new Error(`Unknown replay ${id}`)
  if (r.parseError) throw new Error(`Replay can't be read: ${r.parseError}`)
  return { engineVersion: r.engineVersion, gameVersion: r.gameVersion, mapName: r.mapName }
}

function requireQueue(): SimQueue {
  if (!queue) throw new Error('Simulation queue not available: fix the settings first')
  return queue
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
  ipcMain.handle('library:timeline', async (_e, id: number) => {
    const r = requireLibrary().get(id)
    if (!r) throw new Error(`Unknown replay ${id}`)
    return readDemoTimeline(r.path)
  })
  ipcMain.handle('library:setFavorite', (_e, id: number, fav: boolean) => requireLibrary().setFavorite(id, fav))
  ipcMain.handle('library:setNote', (_e, id: number, note: string) => requireLibrary().setNote(id, note))
  ipcMain.handle('library:rescan', () => requireLibrary().scan())
  ipcMain.handle('library:remove', (_e, id: number) => {
    requireQueue().deleteData(id) // recordings + job history; throws while a simulation runs
    requireLibrary().remove(id)
  })
  ipcMain.handle('library:import', (_e, paths: string[]) => requireLibrary().addManual(paths))
  ipcMain.handle('library:openReplays', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Add replays',
      defaultPath: settings.get().demoDirs[0],
      filters: [{ name: 'BAR replays', extensions: ['sdfz'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : requireLibrary().addManual(r.filePaths)
  })
  ipcMain.handle('deps:check', (_e, id: number): ReplayDeps => deps.check(depsRequest(id)))
  ipcMain.handle('deps:ensure', async (_e, id: number): Promise<ReplayDeps> => {
    const req = depsRequest(id)
    try {
      await deps.ensure(req)
    } catch {
      // failures are recorded per dependency and returned by check()
    }
    return deps.check(req)
  })
  ipcMain.handle('deps:addMapFolder', async (): Promise<SettingsState | null> => {
    const r = await dialog.showOpenDialog(win!, { title: 'Folder containing map archives', properties: ['openDirectory'] })
    if (r.canceled) return null
    const dir = r.filePaths[0]
    const current = settings.get().mapDirs
    return current.includes(dir) ? settings.state() : settings.update({ mapDirs: [...current, dir] })
  })
  ipcMain.handle('sim:simulate', (_e, id: number) => requireQueue().enqueue(id))
  ipcMain.handle('sim:cancel', (_e, id: number) => requireQueue().cancel(id))
  ipcMain.handle('sim:deleteData', (_e, id: number) => requireQueue().deleteData(id))
  ipcMain.handle('sim:getJob', (_e, id: number) => requireQueue().latestJob(id))
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

registerSchemePrivileges()

app.whenReady().then(() => {
  settings = new SettingsStore(app.getPath('userData'))
  deps = new DepsResolver(() => settings.get())
  deps.on('progress', (st) => send('deps:progress', st))
  deps.on('log', (line: string) => console.log('[deps]', line))
  registerIpc()
  handleProtocol({ library: () => library, queue: () => queue, settings: () => settings.get() })
  createWindow()
  startServices()
})

app.on('window-all-closed', () => {
  queue?.stop() // running sims are re-queued on next start
  library?.stopWatching()
  db?.close()
  app.quit()
})
