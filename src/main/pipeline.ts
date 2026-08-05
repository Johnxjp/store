import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineStage } from '../shared/types'
import { readConfig } from './config'
import * as db from './db'
import { buildSummaryPrompt, generateNotes } from './enhance'
import { mergeTranscripts, type StreamSegment } from './merge'
import {
  boostGainDb,
  convertTo16k,
  isSilent,
  measureMaxVolumeDb,
  transcribeWav
} from './transcribe'

export interface SessionAnchors {
  micEpochMs: number
  systemEpochMs: number
}

/** Persisted next to the WAVs so a failed pipeline can be retried later. */
export async function writeSessionFile(dir: string, anchors: SessionAnchors): Promise<void> {
  await writeFile(join(dir, 'session.json'), JSON.stringify(anchors))
}

export async function readSessionFile(dir: string): Promise<SessionAnchors> {
  return JSON.parse(await readFile(join(dir, 'session.json'), 'utf-8')) as SessionAnchors
}

/**
 * Convert to 16 kHz mono and decide whether the stream is worth transcribing.
 * Silent streams are skipped (transcribing silence yields only garbage); quiet
 * ones are re-converted with a gain boost so the ASR model sees healthy levels.
 */
async function prepare16k(srcWav: string, wav16k: string): Promise<boolean> {
  await convertTo16k(srcWav, wav16k)
  const maxDb = await measureMaxVolumeDb(wav16k)
  if (isSilent(maxDb)) return false
  const gain = boostGainDb(maxDb)
  if (gain > 0) await convertTo16k(srcWav, wav16k, gain)
  return true
}

/**
 * Runs the post-recording pipeline for a meeting: convert → transcribe both
 * streams → merge → persist transcript → summarize → ready. On failure the
 * meeting is marked 'error'; the WAVs and session.json stay on disk so the
 * whole pipeline can re-run from scratch.
 */
export async function runPipeline(
  meetingId: string,
  onProgress: (stage: PipelineStage) => void
): Promise<void> {
  const meeting = db.getMeeting(meetingId)
  if (!meeting) throw new Error(`meeting ${meetingId} not found`)

  db.setMeetingStatus(meetingId, 'processing')
  const timed = async <T>(stage: PipelineStage, fn: () => Promise<T>): Promise<T> => {
    onProgress(stage)
    const started = Date.now()
    const result = await fn()
    console.log(`[pipeline] ${stage} ${((Date.now() - started) / 1000).toFixed(1)}s`)
    return result
  }
  try {
    // A stored transcript is always complete (it's only written after merge),
    // so a retry with one on disk resumes at summarization instead of
    // re-transcribing the whole recording.
    let segments = db.getTranscript(meetingId)
    if (segments.length === 0) {
      const dir = meeting.audioDir
      if (!dir) throw new Error(`meeting ${meetingId} has no recording`)
      const anchors = await readSessionFile(dir)

      const mic16k = join(dir, 'mic-16k.wav')
      const system16k = join(dir, 'system-16k.wav')
      const [micAudible, systemAudible] = await timed('converting', () =>
        Promise.all([
          prepare16k(join(dir, 'mic.wav'), mic16k),
          prepare16k(join(dir, 'system.wav'), system16k)
        ])
      )

      const emptyStream = Promise.resolve<StreamSegment[]>([])
      const [micSegments, systemSegments] = await timed('transcribing', () =>
        Promise.all([
          micAudible ? transcribeWav(mic16k) : emptyStream,
          systemAudible ? transcribeWav(system16k) : emptyStream
        ])
      )

      onProgress('merging')
      segments = mergeTranscripts(
        { segments: micSegments, epochMs: anchors.micEpochMs },
        { segments: systemSegments, epochMs: anchors.systemEpochMs }
      )
      db.saveTranscript(meetingId, segments)

      // Second gate: nothing survived transcription+filtering → nothing to summarize.
      if (segments.length === 0) {
        db.setEnhancedNotes(meetingId, '_No speech was detected in this recording._')
        db.setMeetingStatus(meetingId, 'ready')
        return
      }
    }

    const config = readConfig()
    const notes = await timed('summarizing', () =>
      generateNotes(
        buildSummaryPrompt(
          {
            title: meeting.title,
            dateLabel: new Date(meeting.createdAt).toLocaleString(),
            transcript: segments
          },
          config.maxTranscriptChars
        ),
        config
      )
    )
    db.setEnhancedNotes(meetingId, notes)
    db.setMeetingStatus(meetingId, 'ready')
  } catch (err) {
    db.setMeetingStatus(meetingId, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}
