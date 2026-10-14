// Real downloads against GitHub / BAR CDNs. Run with:  BRV_E2E=1 npx vitest run tests/deps.e2e.test.ts
// Uses D:\Dmitrii\bar-replay-viewer\_e2e (same volume as BAR, so pool files hardlink); BAR itself is only read.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/types'
import { downloadEngine, HEADLESS_EXE } from '../src/main/deps/engine'
import { downloadMap, lookupMapBarCdn } from '../src/main/deps/maps'
import { downloadGame, parseSdp, poolPath } from '../src/main/deps/rapid'
import { DepsResolver } from '../src/main/deps/resolver'

const BAR = 'D:\\Dmitrii\\Beyond-All-Reason\\data'
const E2E = 'D:\\Dmitrii\\bar-replay-viewer\\_e2e'
const GAME = 'Beyond All Reason test-29265-bf6d4d0' // not installed; close to installed test-29253
const MAP = 'Red Comet Remake 1.8'
const ENGINE = '2025.04.08'

describe.skipIf(!process.env.BRV_E2E || !existsSync(BAR))('dependency downloads (network)', () => {
  it('downloads and extracts a Recoil engine with spring-headless', { timeout: 600_000 }, async () => {
    rmSync(join(E2E, 'engines'), { recursive: true, force: true })
    const dir = await downloadEngine(ENGINE, join(E2E, 'engines'))
    expect(existsSync(join(dir, HEADLESS_EXE))).toBe(true)
  })

  it('downloads a missing game version, hardlinking files BAR already has', { timeout: 1_800_000 }, async () => {
    rmSync(join(E2E, 'data'), { recursive: true, force: true })
    const stats = await downloadGame(GAME, join(E2E, 'data'), [BAR])
    console.log('game stats', stats)
    expect(stats.linked).toBeGreaterThan(stats.files / 2)
    const sdps = join(E2E, 'data', 'packages')
    const sdp = readFileSync(join(sdps, readdirSync(sdps)[0]))
    for (const f of parseSdp(sdp)) expect(existsSync(poolPath(join(E2E, 'data'), f.md5))).toBe(true)
    // a hardlinked file shares the donor's inode-equivalent: same size, link count > 1
    const shared = parseSdp(sdp).find((f) => existsSync(poolPath(BAR, f.md5)))!
    expect(statSync(poolPath(join(E2E, 'data'), shared.md5)).nlink).toBeGreaterThan(1)
  })

  it('looks up and downloads a map with md5 verification', { timeout: 600_000 }, async () => {
    rmSync(join(E2E, 'maps'), { recursive: true, force: true })
    const remote = await lookupMapBarCdn(MAP)
    expect(remote?.fileName).toBe('red_comet_remake_1.8.sd7')
    const file = await downloadMap(remote!, join(E2E, 'maps'))
    expect(statSync(file).size).toBe(remote!.size)
  })

  it('resolver sees everything as installed afterwards', () => {
    const settings: Settings = {
      barDataDir: join(E2E, 'no-bar'), // force engine lookup into the cache
      demoDirs: [],
      mapDirs: [join(E2E, 'maps')],
      workDir: E2E,
      engineCacheDir: join(E2E, 'engines'),
      concurrency: 0,
      sampleInterval: 15,
      googleApiKey: ''
    }
    const r = new DepsResolver(() => settings).check({ engineVersion: ENGINE, gameVersion: GAME, mapName: MAP })
    expect([r.engine.status, r.game.status, r.map.status]).toEqual(['ok', 'ok', 'ok'])
    expect(r.game.path).toBe(join(E2E, 'data'))
  })
})
