import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ReplayPlayer } from '@shared/types'
import { classifyPreset, readDemoMeta } from '../src/main/demo-meta'

const p = (allyTeamId: number, isAI = false): ReplayPlayer => ({
  name: 'x',
  teamId: 0,
  allyTeamId,
  color: '#000000',
  isAI
})

describe('classifyPreset', () => {
  it('classifies common layouts', () => {
    expect(classifyPreset([p(0), p(1)])).toBe('duel')
    expect(classifyPreset([p(0), p(0), p(1), p(1)])).toBe('team')
    expect(classifyPreset([p(0), p(1), p(2)])).toBe('ffa')
    expect(classifyPreset([p(0), p(0), p(1), p(1), p(2), p(2)])).toBe('teamffa')
    expect(classifyPreset([p(0), p(1, true), p(1, true)])).toBe('pve')
    expect(classifyPreset([p(0), p(0, true), p(1), p(1, true)])).toBe('team')
    expect(classifyPreset([])).toBe('unknown')
  })
})

// Integration tests against real demos on the dev machine; skipped elsewhere.
const DEMOS = 'D:/Dmitrii/Beyond-All-Reason/data/demos/'
const finished = DEMOS + '2025-11-03_16-19-19-030_Project SD-129 v1_2025.04.08.sdfz'
const aborted = DEMOS + '2026-01-10_08-02-42-177_Death Valley v1.0.1_2025.06.12.sdfz'

describe.skipIf(!existsSync(finished))('readDemoMeta (local demos)', () => {
  it('reads a finished 8v8', async () => {
    const m = await readDemoMeta(finished)
    expect(m.engineVersion).toBe('2025.04.08')
    expect(m.gameVersion).toBe('Beyond All Reason test-28768-e91bda2')
    expect(m.mapName).toBe('Project SD-129 v1.0')
    expect(m.players).toHaveLength(16)
    expect(m.preset).toBe('team')
    expect(m.winners).toEqual([0])
    expect(m.lastFrame).toBe(30592)
  })

  it('gets the real length of an aborted demo (header gameTime = 0)', async () => {
    const m = await readDemoMeta(aborted)
    expect(m.lastFrame).toBe(3968)
    expect(m.durationMs).toBe(Math.round((3968 / 30) * 1000))
    expect(m.preset).toBe('pve')
  })
})

describe.skipIf(!existsSync(DEMOS))('team colors', () => {
  it('gives AI teams real colors', async () => {
    const m = await readDemoMeta(DEMOS + '2026-01-10_08-06-29-983_Death Valley v1.0.1_2025.06.12.sdfz')
    const ais = m.players.filter((p) => p.isAI)
    expect(ais.length).toBeGreaterThan(0)
    for (const a of ais) expect(a.color).not.toBe('#888888')
  })
})

describe.skipIf(!existsSync(DEMOS))('saved-game detection', () => {
  it('flags demos that continue a saved game', async () => {
    const resumed = await readDemoMeta(DEMOS + '2026-01-11_16-01-47-002_FolsomDamR 1.17_2025.06.12.sdfz')
    expect(resumed.firstFrame).toBe(47472)
    const normal = await readDemoMeta(finished)
    expect(normal.firstFrame).toBe(0)
  })
})
