import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PipelineStage } from '../shared/types'
import { readConfig } from './config'
import * as db from './db'
import { buildSummaryPrompt, generateNotes } from './enhance'
import { mergeTranscripts, type WhisperSegment } from './merge'
import { modelPath } from './paths'
import { convertTo16k, isSilent, measureMeanVolumeDb, transcribeWav } from './transcribe'

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
  if (!meeting?.audioDir) throw new Error(`meeting ${meetingId} has no recording`)
  const dir = meeting.audioDir

  db.setMeetingStatus(meetingId, 'processing')
  try {
    const anchors = await readSessionFile(dir)

    onProgress('converting')
    const mic16k = join(dir, 'mic-16k.wav')
    const system16k = join(dir, 'system-16k.wav')
    await convertTo16k(join(dir, 'mic.wav'), mic16k)
    await convertTo16k(join(dir, 'system.wav'), system16k)

    // Silence gate: Whisper invents text for silent audio, so silent streams
    // are never transcribed at all.
    const micDb = await measureMeanVolumeDb(mic16k)
    const systemDb = await measureMeanVolumeDb(system16k)

    let micSegments: WhisperSegment[] = []
    if (!isSilent(micDb)) {
      onProgress('transcribing-mic')
      micSegments = await transcribeWav(mic16k, modelPath)
    }
    let systemSegments: WhisperSegment[] = []
    if (!isSilent(systemDb)) {
      onProgress('transcribing-system')
      systemSegments = await transcribeWav(system16k, modelPath)
    }

    onProgress('merging')
    const segments = mergeTranscripts(
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

    onProgress('summarizing')
    const notes = await generateNotes(
      buildSummaryPrompt({
        title: meeting.title,
        dateLabel: new Date(meeting.createdAt).toLocaleString(),
        transcript: segments
      }),
      readConfig().ollamaModel
    )
    db.setEnhancedNotes(meetingId, notes)
    db.setMeetingStatus(meetingId, 'ready')
  } catch (err) {
    db.setMeetingStatus(meetingId, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}
