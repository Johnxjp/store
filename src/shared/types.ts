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
}

export type PipelineStage =
  'converting' | 'transcribing-mic' | 'transcribing-system' | 'merging' | 'summarizing'

export interface PipelineProgress {
  meetingId: string
  stage: PipelineStage
}

export interface MeetingDetail {
  meeting: Meeting
  transcript: TranscriptSegment[]
}
