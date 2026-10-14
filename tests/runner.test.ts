import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { simStatusOf } from '@shared/sim-status'
import { recorderWidget, tailFile } from '../src/main/sim/runner'

describe('runner helpers', () => {
  it('injects the recorder config', () => {
    const lua = recorderWidget({ sampleInterval: 30, projectileInterval: 5, output: 'C:\\x\\raw.txt', unitDefsOutput: '' })
    expect(lua).toContain('local CONFIG = { sampleInterval = 30, projectileInterval = 5, output = "C:/x/raw.txt", unitDefsOutput = "" }')
    expect(lua).not.toContain('@@CONFIG@@')
    expect(lua).toContain('function widget:GameFrame')
  })

  it('reads the tail of a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brv-tail-'))
    const f = join(dir, 'log.txt')
    writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n')
    expect(tailFile(f, 3)).toBe('line 997\nline 998\nline 999')
    expect(tailFile(join(dir, 'missing.txt'), 3)).toBe('')
    rmSync(dir, { recursive: true })
  })

  it('maps jobs to library status', () => {
    expect(simStatusOf({ status: 'running', frame: 50, totalFrames: 200 })).toEqual({ status: 'running', progress: 0.25 })
    expect(simStatusOf({ status: 'cancelled', frame: 0, totalFrames: 1 }).status).toBe('none')
    expect(simStatusOf(null).status).toBe('none')
  })
})
