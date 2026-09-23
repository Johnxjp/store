import type { Speaker, TranscriptSegment } from '../shared/types'

export interface StreamSegment {
  fromMs: number
  toMs: number
  text: string
}

export interface StreamTranscript {
  segments: StreamSegment[]
  /** Wall-clock epoch ms of the start of this stream's WAV file. */
  epochMs: number
}

/**
 * A span the user paused the recording for, in wall-clock epoch ms. Recorded
 * from the pause/resume button presses, never inferred from the audio: the
 * WAVs hold silence for natural lulls too, and those are real meeting time.
 */
export interface PauseInterval {
  fromEpochMs: number
  toEpochMs: number
}

const COALESCE_GAP_MS = 2000
const REPEAT_RUN_THRESHOLD = 3

/**
 * Paused wall-clock ms accumulated before `absMs`. A timestamp that lands
 * inside a pause clamps to that pause's start, so collapsed times stay
 * monotonic and never go negative.
 */
export function pausedBefore(absMs: number, pauses: PauseInterval[]): number {
  let total = 0
  for (const p of pauses) {
    if (absMs <= p.fromEpochMs) break
    total += Math.min(absMs, p.toEpochMs) - p.fromEpochMs
  }
  return total
}

/** Carries the pause total at a segment's start so coalesce can tell a pause from a lull. */
interface Placed extends TranscriptSegment {
  pausedAtStart: number
}

/**
 * Merges the mic ("me") and system-audio ("them") transcripts into a single
 * chronological timeline. Timestamps become relative to the earliest stream
 * start, with paused spans subtracted so the result reads in recorded time.
 * ASR hallucination artifacts (silence fillers, repeated phrases) are dropped,
 * and consecutive same-speaker segments are coalesced.
 *
 * `pauses` is required rather than optional on purpose: the cache warmer
 * builds the same prompt during the meeting, and a caller that silently
 * skipped the collapse would shift every timestamp at Stop and void the
 * prefix cache that warming exists to fill.
 */
export function mergeTranscripts(
  mic: StreamTranscript,
  system: StreamTranscript,
  pauses: PauseInterval[]
): TranscriptSegment[] {
  const recordingStartMs = Math.min(mic.epochMs, system.epochMs)

  // One event log drives both streams, so mic and system get an identical
  // adjustment and collapsing cannot pull "Me" out of step with "Them".
  const toTimeline = (stream: StreamTranscript, speaker: Speaker): Placed[] =>
    dropHallucinations(stream.segments).map((s) => {
      const startAbs = stream.epochMs + s.fromMs
      const endAbs = stream.epochMs + s.toMs
      const pausedAtStart = pausedBefore(startAbs, pauses)
      return {
        speaker,
        startMs: startAbs - recordingStartMs - pausedAtStart,
        endMs: endAbs - recordingStartMs - pausedBefore(endAbs, pauses),
        text: s.text.trim(),
        pausedAtStart
      }
    })

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
export function dropHallucinations(segments: StreamSegment[]): StreamSegment[] {
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

function normalized(s: StreamSegment): string {
  return s.text.trim().toLowerCase()
}

function coalesce(segments: Placed[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  let prevPausedAtStart = -1
  for (const seg of segments) {
    const prev = out[out.length - 1]
    // Differing pause totals mean a pause fell between the two. Collapsing
    // made them adjacent in time; they were not adjacent in the meeting.
    const sameSpan = seg.pausedAtStart === prevPausedAtStart
    if (
      prev &&
      sameSpan &&
      prev.speaker === seg.speaker &&
      seg.startMs - prev.endMs < COALESCE_GAP_MS
    ) {
      prev.text = `${prev.text} ${seg.text}`
      prev.endMs = Math.max(prev.endMs, seg.endMs)
    } else {
      out.push({
        speaker: seg.speaker,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text
      })
    }
    prevPausedAtStart = seg.pausedAtStart
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
