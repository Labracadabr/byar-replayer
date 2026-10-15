// Engine resolution: BAR's engine folder, then our engine cache, then the Recoil GitHub release.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { path7za as packed7za } from '7zip-bin'
import { unpacked } from '../unpacked'
import { downloadFile, type Progress } from './download'

const path7za = unpacked(packed7za) // the real exe is outside app.asar when packaged

const run = promisify(execFile)

export const HEADLESS_EXE = process.platform === 'win32' ? 'spring-headless.exe' : 'spring-headless'

/** Recoil release versions look like 2025.04.08 (optionally with a suffix); older Spring-era BAR engines don't. */
export function isRecoilVersion(v: string): boolean {
  return /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(v)
}

export function engineFolderName(version: string): string {
  return `recoil_${version}`
}

export function engineDownloadUrl(version: string): string {
  const platform = process.platform === 'win32' ? 'amd64-windows' : 'amd64-linux'
  return `https://github.com/beyond-all-reason/RecoilEngine/releases/download/${version}/recoil_${version}_${platform}.7z`
}

/** Engine dir containing spring-headless for this version, or null. */
export function findEngine(version: string, barDataDir: string, engineCacheDir: string): string | null {
  for (const root of [join(barDataDir, 'engine'), engineCacheDir]) {
    const dir = join(root, engineFolderName(version))
    if (existsSync(join(dir, HEADLESS_EXE))) return dir
  }
  return null
}

/** True if BAR has this engine but without the headless binary (then we need our own copy). */
export function barEngineLacksHeadless(version: string, barDataDir: string): boolean {
  const dir = join(barDataDir, 'engine', engineFolderName(version))
  return existsSync(dir) && !existsSync(join(dir, HEADLESS_EXE))
}

export async function downloadEngine(
  version: string,
  engineCacheDir: string,
  opts: { signal?: AbortSignal; onProgress?(p: Progress): void } = {}
): Promise<string> {
  if (!isRecoilVersion(version))
    throw new Error(`Engine ${version} is not a Recoil release; automatic download is only supported for Recoil engines.`)
  const target = join(engineCacheDir, engineFolderName(version))
  const archive = join(engineCacheDir, `${engineFolderName(version)}.7z`)
  const tmp = target + '.extracting'
  try {
    await downloadFile(engineDownloadUrl(version), archive, opts)
  } catch (e) {
    const status = (e as { status?: number }).status
    if (status === 404) throw new Error(`No Recoil release ${version} on GitHub (${engineDownloadUrl(version)}).`)
    throw e
  }
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  await run(path7za, ['x', '-y', `-o${tmp}`, archive], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  // archives normally have the files at the root; tolerate a single wrapping folder
  let root = tmp
  const entries = readdirSync(tmp)
  if (entries.length === 1 && statSync(join(tmp, entries[0])).isDirectory()) root = join(tmp, entries[0])
  if (!existsSync(join(root, HEADLESS_EXE)))
    throw new Error(`Engine ${version} was downloaded but contains no ${HEADLESS_EXE}.`)
  rmSync(target, { recursive: true, force: true })
  renameSync(root, target)
  rmSync(tmp, { recursive: true, force: true })
  rmSync(archive, { force: true })
  return target
}
