export type Speaker = 'me' | 'them'

export interface TranscriptSegment {
  speaker: Speaker
  startMs: number
  endMs: number
  text: string
}

export type MeetingStatus = 'recording' | 'processing' | 'ready' | 'error'

export interface Meeting {
  id: string
  title: string
  status: MeetingStatus
  createdAt: number
  recordingStartedAt: number | null
  recordingEndedAt: number | null
  rawNotes: string
  enhancedNotes: string | null
  errorMessage: string | null
  audioDir: string | null
  /** Total paused time. Recorded length is recordingEndedAt - recordingStartedAt - pausedMs. */
  pausedMs: number
}

export type PipelineStage = 'converting' | 'transcribing' | 'merging' | 'summarizing'

export interface PipelineProgress {
  meetingId: string
  stage: PipelineStage
}

/** Cumulative summary text streamed while the summarize stage runs. */
export interface SummaryDelta {
  meetingId: string
  text: string
}

export interface MeetingDetail {
  meeting: Meeting
  transcript: TranscriptSegment[]
  /** True when the recorded WAVs (and session.json) still exist on disk, so the pipeline can re-run. */
  hasAudio: boolean
  /** Wall-clock ms when the current pause began; null unless this meeting is the live session and paused. */
  pausedAt: number | null
  /** Paused time so far in the live session, falling back to the stored total once stopped. */
  pausedMs: number
}
