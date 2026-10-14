import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { Library } from '../src/main/library'
import { isAscii, validateSettings } from '../src/main/paths'
import type { Settings } from '@shared/types'

describe('settings validation', () => {
  const base: Settings = {
    barDataDir: 'Z:\\nope\\data',
    demoDirs: [],
    mapDirs: [],
    workDir: 'C:\\Users\\Пользователь\\brv',
    engineCacheDir: '',
    concurrency: 0,
    sampleInterval: 15,
    googleApiKey: ''
  }

  it('flags a bad BAR dir, missing replay folder and non-ASCII work dir', () => {
    const fields = validateSettings(base).map((p) => p.field)
    expect(fields).toContain('barDataDir')
    expect(fields).toContain('demoDirs')
    expect(fields).toContain('workDir')
  })

  it('rejects drive-relative work dirs', () => {
    const p = validateSettings({ ...base, workDir: 'D:Dmitrii\\bar-replay-viewer' })
    expect(p.find((x) => x.field === 'workDir')?.message).toMatch(/absolute/)
  })

  it('detects non-ASCII paths', () => {
    expect(isAscii('D:\\Dmitrii\\bar-replay-viewer')).toBe(true)
    expect(isAscii('C:\\Users\\Пользователь')).toBe(false)
  })
})

const DEMOS = 'D:/Dmitrii/Beyond-All-Reason/data/demos/'
const A = '2026-01-10_08-02-42-177_Death Valley v1.0.1_2025.06.12.sdfz'
const B = '2026-01-10_07-48-15-416_Death Valley v1.0.1_2025.06.12.sdfz'

describe.skipIf(!existsSync(DEMOS + A))('library scan + watcher', () => {
  let dir = ''
  let lib: Library | null = null
  afterEach(() => {
    lib?.stopWatching()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('indexes, keeps favorites/notes, picks up new files and marks removed ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'brv-lib-'))
    copyFileSync(DEMOS + A, join(dir, A))
    const db = openDb(':memory:')
    lib = new Library(db, [dir])
    await lib.scan()
    let list = lib.list()
    expect(list).toHaveLength(1)
    expect(list[0].mapName).toBe('Death Valley v1.0.1')

    lib.setFavorite(list[0].id, true)
    lib.setNote(list[0].id, 'hello')
    await lib.scan() // unchanged file: no re-parse, user data kept
    expect(lib.list()[0]).toMatchObject({ favorite: true, note: 'hello' })

    lib.startWatching()
    const changed = new Promise<void>((r) => lib!.once('changed', r))
    copyFileSync(DEMOS + B, join(dir, B))
    await changed
    expect(lib.list()).toHaveLength(2)

    unlinkSync(join(dir, B))
    await lib.scan()
    list = lib.list()
    expect(list).toHaveLength(1)
    expect(list[0].note).toBe('hello')
  })
})
