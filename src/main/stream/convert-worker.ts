// Worker thread entry: parse the demo's chat and convert a raw recording without blocking the main process.
import { parentPort, workerData } from 'node:worker_threads'
import { readDemoChat } from '../demo-meta'
import { convertRaw, type ConvertResult } from './convert'

export interface ConvertJob {
  demoPath: string
  rawPath: string
  unitDefsPath: string
  outPath: string
  gameId: string
}

export type ConvertMessage = { ok: true; result: ConvertResult } | { ok: false; error: string }

const job = workerData as ConvertJob
void (async () => {
  try {
    const chat = await readDemoChat(job.demoPath).catch(() => [])
    const result = await convertRaw({ ...job, chat })
    parentPort!.postMessage({ ok: true, result } satisfies ConvertMessage)
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ConvertMessage)
  }
})()
