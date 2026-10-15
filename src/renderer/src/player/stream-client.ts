// Main-thread side of the stream worker: opens a stream, keeps a small cache of decoded chunks, prefetches.
import type { DecodedChunk, StreamHeader, StreamMeta } from '@shared/stream/format'
import type { WorkerRequest, WorkerResponse } from './stream-worker'

const CACHE_SIZE = 8

export class StreamClient {
  private worker = new Worker(new URL('./stream-worker.ts', import.meta.url), { type: 'module' })
  private cache = new Map<number, DecodedChunk>() // insertion order = LRU order
  private pending = new Map<number, { resolve(c: DecodedChunk): void; reject(e: Error): void; promise: Promise<DecodedChunk> }>()
  private opened: ((v: { header: StreamHeader; meta: StreamMeta }) => void) | null = null
  private openFailed: ((e: Error) => void) | null = null
  header!: StreamHeader
  meta!: StreamMeta

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data)
  }

  open(url: string): Promise<{ header: StreamHeader; meta: StreamMeta }> {
    return new Promise((resolve, reject) => {
      this.opened = resolve
      this.openFailed = reject
      this.send({ type: 'open', url })
    })
  }

  dispose(): void {
    this.worker.terminate()
    this.cache.clear()
  }

  chunkIndexFor(frame: number): number {
    const chunks = this.header.chunks
    let lo = 0
    let hi = chunks.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (chunks[mid].frameStart <= frame) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Decoded chunk if cached (marks it recently used). */
  get(index: number): DecodedChunk | undefined {
    const c = this.cache.get(index)
    if (c) {
      this.cache.delete(index)
      this.cache.set(index, c)
    }
    return c
  }

  load(index: number): Promise<DecodedChunk> {
    const cached = this.get(index)
    if (cached) return Promise.resolve(cached)
    const p = this.pending.get(index)
    if (p) return p.promise
    let resolve!: (c: DecodedChunk) => void
    let reject!: (e: Error) => void
    const promise = new Promise<DecodedChunk>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.pending.set(index, { resolve, reject, promise })
    this.send({ type: 'chunk', index })
    return promise
  }

  /** Requests a chunk without waiting (ignored if out of range). */
  prefetch(index: number): void {
    if (index >= 0 && index < this.header.chunks.length && !this.cache.has(index)) void this.load(index).catch(() => {})
  }

  private send(msg: WorkerRequest): void {
    this.worker.postMessage(msg)
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'opened') {
      this.header = msg.header
      this.meta = msg.meta
      this.opened?.({ header: msg.header, meta: msg.meta })
    } else if (msg.type === 'chunk') {
      this.cache.set(msg.index, msg.chunk)
      while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!)
      this.pending.get(msg.index)?.resolve(msg.chunk)
      this.pending.delete(msg.index)
    } else if (msg.type === 'error') {
      if (msg.index !== undefined) {
        this.pending.get(msg.index)?.reject(new Error(msg.message))
        this.pending.delete(msg.index)
      } else this.openFailed?.(new Error(msg.message))
    }
  }
}
