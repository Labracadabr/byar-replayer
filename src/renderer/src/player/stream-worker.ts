// Web Worker: fetches a BRVS stream over brv:// and decodes the meta and chunks off the UI thread.
import { decompress } from 'fzstd'
import { decodeChunk, decodeMeta, type DecodedChunk, readHeader, type StreamHeader } from '@shared/stream/format'

export type WorkerRequest = { type: 'open'; url: string } | { type: 'chunk'; index: number }
export type WorkerResponse =
  | { type: 'opened'; header: StreamHeader; meta: ReturnType<typeof decodeMeta> }
  | { type: 'chunk'; index: number; chunk: DecodedChunk }
  | { type: 'error'; message: string; index?: number }

let file: Uint8Array | null = null
let header: StreamHeader | null = null
let dataStart = 0

const post = (msg: WorkerResponse, transfer: Transferable[] = []): void =>
  (self as unknown as Worker).postMessage(msg, transfer)

function blob(offset: number, length: number): Uint8Array {
  return decompress(file!.subarray(dataStart + offset, dataStart + offset + length))
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'open') {
      const res = await fetch(msg.url)
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      file = new Uint8Array(await res.arrayBuffer())
      ;({ header, dataStart } = readHeader(file))
      post({ type: 'opened', header, meta: decodeMeta(blob(header.meta.offset, header.meta.length)) })
    } else if (msg.type === 'chunk') {
      if (!header) throw new Error('stream not open')
      const ref = header.chunks[msg.index]
      const chunk = decodeChunk(blob(ref.offset, ref.length))
      const transfer: Transferable[] = []
      for (const s of chunk.samples) transfer.push(s.uid.buffer, s.def.buffer, s.team.buffer, s.x.buffer, s.z.buffer, s.heading.buffer, s.hp.buffer, s.build.buffer)
      for (const p of chunk.projectiles) transfer.push(p.weapon.buffer, p.team.buffer, p.x.buffer, p.z.buffer, p.vx.buffer, p.vz.buffer)
      post({ type: 'chunk', index: msg.index, chunk }, transfer)
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), index: msg.type === 'chunk' ? msg.index : undefined })
  }
}
