// In-game artwork taken from the exact game version a replay used: strategic icons (+ icontypes.lua) and the
// rank chevrons of the in-game player list. Extracted from the rapid package once per game version.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { findInstalledGame, parseSdp, poolPath } from './deps/rapid'

export interface IconType {
  /** path inside the game, e.g. icons/bot_amph_t2_aa.png */
  bitmap: string
  /** relative icon size (1 = default) */
  size: number
}

export type IconTypes = Record<string, IconType>

export const ICONTYPES_JSON = 'icontypes.json'
const COMPLETE = '.complete'

function wanted(name: string): boolean {
  const n = name.toLowerCase()
  return n.startsWith('icons/') || n === 'gamedata/icontypes.lua' || n.startsWith('luaui/images/advplayerslist/ranks/')
}

/**
 * Parses BAR's gamedata/icontypes.lua: a static table of `name = { bitmap = "...", size = n }` entries, followed by a
 * loop that adds `<name>_scav` variants using the icons in an `inverted/` subfolder.
 */
export function parseIconTypes(lua: string): IconTypes {
  const out: IconTypes = {}
  for (const m of lua.matchAll(/([A-Za-z_][\w]*)\s*=\s*\{([^{}]*)\}/g)) {
    const body = m[2]
    const bitmap = body.match(/bitmap\s*=\s*"([^"]+)"/)?.[1]
    const size = Number(body.match(/size\s*=\s*([\d.]+)/)?.[1] ?? 1)
    if (!bitmap && m[1] !== 'default') continue
    out[m[1]] = { bitmap: bitmap ?? '', size: size || 1 }
  }
  if (/_scav/.test(lua)) {
    for (const [name, t] of Object.entries({ ...out })) {
      if (name.endsWith('_scav')) continue
      out[`${name}_scav`] = { bitmap: t.bitmap ? t.bitmap.replace('/', '/inverted/') : '', size: t.size }
    }
  }
  return out
}

export function gameAssetsDir(cacheRoot: string, gameVersion: string): string {
  return join(cacheRoot, gameVersion.replace(/[^\w.-]+/g, '_'))
}

/** Extracts the assets for a game version (no-op when done before); returns the cache dir. */
export function ensureGameAssets(gameVersion: string, dataDirs: string[], cacheRoot: string): string {
  const dir = gameAssetsDir(cacheRoot, gameVersion)
  if (existsSync(join(dir, COMPLETE))) return dir
  const game = findInstalledGame(gameVersion, dataDirs)
  if (!game) throw new Error(`Game version "${gameVersion}" is not installed`)
  const files = parseSdp(readFileSync(join(game.dataDir, 'packages', game.entry.md5 + '.sdp'))).filter((f) => wanted(f.name))
  for (const f of files) {
    const dest = join(dir, f.name.toLowerCase())
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, gunzipSync(readFileSync(poolPath(game.dataDir, f.md5))))
  }
  const luaPath = join(dir, 'gamedata', 'icontypes.lua')
  const icons = existsSync(luaPath) ? parseIconTypes(readFileSync(luaPath, 'utf8')) : {}
  writeFileSync(join(dir, ICONTYPES_JSON + '.tmp'), JSON.stringify(icons))
  renameSync(join(dir, ICONTYPES_JSON + '.tmp'), join(dir, ICONTYPES_JSON))
  writeFileSync(join(dir, COMPLETE), String(files.length))
  return dir
}
