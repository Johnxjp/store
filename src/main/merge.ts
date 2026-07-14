import type { Speaker, TranscriptSegment } from '../shared/types'

export interface WhisperSegment {
  fromMs: number
  toMs: number
  text: string
}

export interface StreamTranscript {
  segments: WhisperSegment[]
  /** Wall-clock epoch ms of the start of this stream's WAV file. */
  epochMs: number
}

const COALESCE_GAP_MS = 2000
const REPEAT_RUN_THRESHOLD = 3

/**
 * Merges the mic ("me") and system-audio ("them") whisper transcripts into a
 * single chronological timeline. Timestamps become relative to the earliest
 * stream start. Whisper hallucination artifacts (silence fillers, repeated
 * phrases) are dropped, and consecutive same-speaker segments are coalesced.
 */
export function mergeTranscripts(
  mic: StreamTranscript,
  system: StreamTranscript
): TranscriptSegment[] {
  const recordingStartMs = Math.min(mic.epochMs, system.epochMs)

  const toTimeline = (stream: StreamTranscript, speaker: Speaker): TranscriptSegment[] => {
    const offset = stream.epochMs - recordingStartMs
    return dropHallucinations(stream.segments).map((s) => ({
      speaker,
      startMs: s.fromMs + offset,
      endMs: s.toMs + offset,
      text: s.text.trim()
    }))
  }

  const merged = [...toTimeline(mic, 'me'), ...toTimeline(system, 'them')].sort(
    (a, b) => a.startMs - b.startMs
  )
  return coalesce(merged)
}

/**
 * Phrases Whisper's decoder invents on silence — learned from web-video
 * outros in its training data. Dropped when they are a segment's entire text.
 */
const PHRASE_BLOCKLIST = new Set([
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'please subscribe',
  'see you next time',
  'see you in the next video',
  'bye',
  'bye bye',
  'you'
])

/**
 * Whisper emits artifacts on (near-)silent audio: empty text, bracketed
 * fillers like [BLANK_AUDIO] or (music), known silence phrases like
 * "Thank you.", and short phrases repeated over and over. Each stream is
 * mostly silence while the other side talks, so these are common here.
 */
export function dropHallucinations(segments: WhisperSegment[]): WhisperSegment[] {
  const nonEmpty = segments.filter((s) => {
    const t = s.text.trim()
    if (t === '') return false
    if (/^[[(*♪].*[\])*♪]$/.test(t)) return false
    if (PHRASE_BLOCKLIST.has(t.toLowerCase().replace(/[.!,…]+$/, ''))) return false
    return true
  })

  const keep: boolean[] = nonEmpty.map(() => true)
  let runStart = 0
  for (let i = 1; i <= nonEmpty.length; i++) {
    const sameAsPrev =
      i < nonEmpty.length && normalized(nonEmpty[i]) === normalized(nonEmpty[runStart])
    if (!sameAsPrev) {
      const runLength = i - runStart
      if (runLength >= REPEAT_RUN_THRESHOLD) {
        for (let j = runStart; j < i; j++) keep[j] = false
      }
      runStart = i
    }
  }
  return nonEmpty.filter((_, i) => keep[i])
}

function normalized(s: WhisperSegment): string {
  return s.text.trim().toLowerCase()
}

function coalesce(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (prev && prev.speaker === seg.speaker && seg.startMs - prev.endMs < COALESCE_GAP_MS) {
      prev.text = `${prev.text} ${seg.text}`
      prev.endMs = Math.max(prev.endMs, seg.endMs)
    } else {
      out.push({ ...seg })
    }
  }
  return out
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${formatTimestamp(s.startMs)}] ${s.speaker === 'me' ? 'Me' : 'Them'}: ${s.text}`)
    .join('\n')
}
