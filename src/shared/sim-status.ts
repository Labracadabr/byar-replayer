import type { JobInfo, SimStatus } from './types'

/** Library-level sim status from the replay's latest job. */
export function simStatusOf(job: Pick<JobInfo, 'status' | 'frame' | 'totalFrames'> | null): { status: SimStatus; progress: number } {
  switch (job?.status) {
    case 'queued':
      return { status: 'queued', progress: 0 }
    case 'running':
      return { status: 'running', progress: job.totalFrames ? Math.min(1, job.frame / job.totalFrames) : 0 }
    case 'done':
      return { status: 'ready', progress: 1 }
    case 'failed':
      return { status: 'failed', progress: 0 }
    default:
      return { status: 'none', progress: 0 }
  }
}

/** Demos of games loaded from a save start at the save's frame, not 0; they can't be re-simulated. */
export function isResumedGame(r: { firstFrame: number }): boolean {
  return r.firstFrame > 300
}
