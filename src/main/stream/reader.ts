// Node-side reader for BRVS stream files (tests, main process). The player decodes in a Web Worker instead.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { decodeChunk, decodeMeta, type DecodedChunk, readHeader, type StreamHeader, type StreamMeta } from '@shared/stream/format'

export interface StreamFile {
  header: StreamHeader
  meta: StreamMeta
  chunk(i: number): DecodedChunk
}

export function openStream(path: string): StreamFile {
  const buf = new Uint8Array(readFileSync(path))
  const { header, dataStart } = readHeader(buf)
  const blob = (offset: number, length: number): Uint8Array =>
    new Uint8Array(zstdDecompressSync(buf.subarray(dataStart + offset, dataStart + offset + length)))
  return {
    header,
    meta: decodeMeta(blob(header.meta.offset, header.meta.length)),
    chunk: (i) => decodeChunk(blob(header.chunks[i].offset, header.chunks[i].length), header.formatVersion)
  }
}
