// Streaming HTTP download with progress, cancellation, md5 check and atomic rename.
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Progress {
  bytes: number
  totalBytes: number // 0 if unknown
}

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?(p: Progress): void
  /** hex md5 of the downloaded bytes; mismatch => error and no file */
  md5?: string
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export async function fetchOk(url: string, signal?: AbortSignal, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal, redirect: 'follow' })
  if (!res.ok) throw new DownloadError(`HTTP ${res.status} for ${url}`, res.status)
  return res
}

/** Downloads url to dest (via dest + '.part'); returns the md5 of the bytes. */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true })
  const part = dest + '.part'
  const res = await fetchOk(url, opts.signal)
  const total = Number(res.headers.get('content-length') ?? 0)
  const hash = createHash('md5')
  const out = createWriteStream(part)
  let bytes = 0
  let lastReport = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      bytes += chunk.length
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
      const now = Date.now()
      if (opts.onProgress && now - lastReport > 200) {
        lastReport = now
        opts.onProgress({ bytes, totalBytes: total })
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (e) {
    out.destroy()
    rmSync(part, { force: true })
    throw e
  }
  const md5 = hash.digest('hex')
  if (opts.md5 && opts.md5.toLowerCase() !== md5) {
    rmSync(part, { force: true })
    throw new DownloadError(`Checksum mismatch for ${url}: expected ${opts.md5}, got ${md5}`)
  }
  renameSync(part, dest)
  opts.onProgress?.({ bytes, totalBytes: total || bytes })
  return md5
}
