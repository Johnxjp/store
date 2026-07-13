export type Speaker = 'me' | 'them'

export interface TranscriptSegment {
  speaker: Speaker
  startMs: number
  endMs: number
  text: string
}

export type RecordingState = 'idle' | 'recording' | 'processing'

export type PipelineStage = 'converting' | 'transcribing-mic' | 'transcribing-system' | 'merging'

export interface RecordingResult {
  segments: TranscriptSegment[]
  durationMs: number
}
