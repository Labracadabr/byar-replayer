import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { engineDownloadUrl, isRecoilVersion } from '../src/main/deps/engine'
import { findLocalMap, mapFileStem } from '../src/main/deps/maps'
import { findEntryLocally, findInstalledGame, parseSdp, parseVersions } from '../src/main/deps/rapid'

function sdpEntry(name: string, md5: string, size: number): Buffer {
  const n = Buffer.from(name)
  const tail = Buffer.alloc(8)
  tail.writeUInt32BE(0, 0) // crc
  tail.writeUInt32BE(size, 4)
  return Buffer.concat([Buffer.from([n.length]), n, Buffer.from(md5, 'hex'), tail])
}

const tmp = mkdtempSync(join(tmpdir(), 'brv-deps-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('rapid', () => {
  it('parses .sdp packages', () => {
    const gz = gzipSync(
      Buffer.concat([sdpEntry('modinfo.lua', '0e1fdd12b278d691a9ed5097bc88ae22', 252), sdpEntry('units/a.lua', 'ff'.repeat(16), 70000)])
    )
    expect(parseSdp(gz)).toEqual([
      { name: 'modinfo.lua', md5: '0e1fdd12b278d691a9ed5097bc88ae22', size: 252 },
      { name: 'units/a.lua', md5: 'ff'.repeat(16), size: 70000 }
    ])
  })

  it('parses versions.gz and finds installed games', () => {
    const versions = gzipSync(
      'byar:test,aaaa,,Beyond All Reason test-2-bbb\nbyar:git:123,cccc,,Beyond All Reason test-1-aaa\n'
    )
    expect(parseVersions(versions, 'https://x/byar')[1]).toEqual({
      tag: 'byar:git:123',
      md5: 'cccc',
      name: 'Beyond All Reason test-1-aaa',
      repoUrl: 'https://x/byar'
    })
    const data = join(tmp, 'data')
    mkdirSync(join(data, 'rapid', 'repos-cdn.example', 'byar'), { recursive: true })
    writeFileSync(join(data, 'rapid', 'repos-cdn.example', 'byar', 'versions.gz'), versions)
    expect(findEntryLocally('Beyond All Reason test-1-aaa', [data])?.repoUrl).toBe('https://repos-cdn.example/byar')
    expect(findInstalledGame('Beyond All Reason test-1-aaa', [data])).toBeNull() // no .sdp yet
    mkdirSync(join(data, 'packages'))
    writeFileSync(join(data, 'packages', 'cccc.sdp'), '')
    expect(findInstalledGame('Beyond All Reason test-1-aaa', [data])?.dataDir).toBe(data)
  })
})

describe('engine', () => {
  it('recognises Recoil versions and builds the release URL', () => {
    expect(isRecoilVersion('2025.04.08')).toBe(true)
    expect(isRecoilVersion('105.1.1-2511-g747f18b BAR105')).toBe(false)
    expect(engineDownloadUrl('2025.04.08')).toMatch(
      /RecoilEngine\/releases\/download\/2025\.04\.08\/recoil_2025\.04\.08_amd64-(windows|linux)\.7z$/
    )
  })
})

describe('maps', () => {
  it('derives BAR archive names and finds maps case-insensitively', () => {
    expect(mapFileStem('Death Valley v1.0.1')).toBe('death_valley_v1.0.1')
    expect(mapFileStem('Project SD-129 v1.0')).toBe('project_sd-129_v1.0')
    const maps = join(tmp, 'maps')
    mkdirSync(maps)
    writeFileSync(join(maps, 'FolsomDamR_1.17.SD7'), '')
    writeFileSync(join(maps, 'odd-name.sdz'), '')
    expect(findLocalMap('FolsomDamR 1.17', [join(tmp, 'nope'), maps])).toBe(join(maps, 'FolsomDamR_1.17.SD7'))
    expect(findLocalMap('Odd Map 1', [maps])).toBeNull()
    expect(findLocalMap('Odd Map 1', [maps], 'odd-name.sdz')).toBe(join(maps, 'odd-name.sdz'))
  })
})

describe('game assets', () => {
  it('parses icontypes.lua including scav variants', async () => {
    const { parseIconTypes } = await import('../src/main/game-assets')
    const lua = `local icontypes = {
	armaak = {
		bitmap = "icons/bot_amph_t2_aa.png",
		size = 1.41999996
	},
	legjam ={
		bitmap ="icons/jammer.png",
	},
	default = {
		size = 1,
		radiusadjust = 1,
	},
}
local newIcontypes = {}
for name, params in pairs(icontypes) do
	newIcontypes[name..'_scav'] = { size = params.size or 1 }
end
return newIcontypes`
    const t = parseIconTypes(lua)
    expect(t.armaak).toEqual({ bitmap: 'icons/bot_amph_t2_aa.png', size: 1.41999996 })
    expect(t.legjam).toEqual({ bitmap: 'icons/jammer.png', size: 1 })
    expect(t.armaak_scav.bitmap).toBe('icons/inverted/bot_amph_t2_aa.png')
    expect(t.default.bitmap).toBe('')
  })
})
