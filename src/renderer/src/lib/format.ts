import type { Meeting, PipelineStage } from '../../../shared/types'

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  converting: 'Preparing audio…',
  transcribing: 'Transcribing…',
  merging: 'Merging…',
  summarizing: 'Writing notes…'
}

export function stageLabel(stage: PipelineStage | undefined): string {
  return stage ? STAGE_LABELS[stage] : 'Processing…'
}

export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function durationLabel(meeting: Meeting): string | null {
  if (!meeting.recordingStartedAt || !meeting.recordingEndedAt) return null
  const mins = Math.round((meeting.recordingEndedAt - meeting.recordingStartedAt) / 60_000)
  return mins < 1 ? 'Under a minute' : `${mins} min`
}
