import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc-channels'
import type { Meeting, MeetingDetail, PipelineStage } from '../shared/types'
import { readConfig } from './config'
import * as db from './db'
import { LiveTranscriber } from './live'
import { audioCaptureBin, recordingsDir } from './paths'
import { runPipeline, writeSessionFile, type PipelineOptions } from './pipeline'
import { Recorder } from './recorder'

interface Session {
  recorder: Recorder
  meetingId: string
  /** Resolves true once capture is live (anchors written), false if it failed to start. */
  starting: Promise<boolean>
  /** Transcribes during the meeting; null until capture is live (or when disabled by config). */
  live: LiveTranscriber | null
}

let session: Session | null = null

/**
 * Stops an in-flight recording on app quit so the WAVs finalize and the
 * meeting doesn't stay stuck in 'recording'. The pipeline is too slow to run
 * during quit, so the meeting is marked 'error' and Retry picks it up later.
 * Returns null when nothing is recording.
 */
export function abortActiveRecording(): Promise<void> | null {
  if (!session) return null
  const { recorder, meetingId, live } = session
  session = null
  live?.cancel()
  return recorder
    .stop()
    .catch(() => {})
    .then(() => {
      db.setRecordingEnded(meetingId, Date.now())
      db.setMeetingStatus(
        meetingId,
        'error',
        'Recording stopped because the app quit. The captured audio is safe on disk.'
      )
    })
}

export function registerIpcHandlers(): void {
  // Returns as soon as the meeting row exists so the note opens instantly;
  // audio capture (AEC init, Bluetooth profile switch — seconds) spins up in
  // the background. recording_started_at is set once buffers actually flow,
  // and meetingUpdated tells the renderer to swap "starting" for the live bar.
  ipcMain.handle(IPC.recordingStart, async (event): Promise<Meeting> => {
    if (session) throw new Error('already recording')
    const id = randomUUID()
    const dir = join(recordingsDir, id)
    await mkdir(dir, { recursive: true })

    const now = Date.now()
    const meeting = db.createMeeting({
      id,
      title: `Meeting ${new Date(now).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })}`,
      audioDir: dir,
      createdAt: now
    })

    const recorder = new Recorder(audioCaptureBin)
    const sender = event.sender
    const starting = recorder.start(dir).then(
      async (anchors) => {
        await writeSessionFile(dir, anchors)
        db.setRecordingStarted(id, Math.min(anchors.micEpochMs, anchors.systemEpochMs))
        // A fast Stop (or quit) during capture spin-up already tore the
        // session down — starting the live loop then would leak it.
        if (session?.meetingId === id && readConfig().liveTranscription) {
          session.live = new LiveTranscriber(dir)
          session.live.start()
        }
        if (!sender.isDestroyed()) sender.send(IPC.meetingUpdated, id)
        return true
      },
      (err: unknown) => {
        if (session?.meetingId === id) session = null
        db.setMeetingStatus(id, 'error', err instanceof Error ? err.message : String(err))
        if (!sender.isDestroyed()) sender.send(IPC.meetingUpdated, id)
        return false
      }
    )
    session = { recorder, meetingId: id, starting, live: null }
    return meeting
  })

  ipcMain.handle(IPC.recordingStop, async (event): Promise<Meeting> => {
    if (!session) throw new Error('not recording')
    const active = session
    session = null

    // Capture may still be spinning up; wait for it to go live (or fail)
    // before stopping. On failure the meeting is already marked 'error'.
    if (await active.starting) {
      const { live } = active
      try {
        await active.recorder.stop()
      } catch (err) {
        live?.cancel()
        throw err
      }
      db.setRecordingEnded(active.meetingId, Date.now())

      // finish() is not awaited here — that would hold the meeting in
      // 'recording' while the tail chunks transcribe. The pipeline awaits it
      // inside its transcribing stage instead.
      void runPipelineNotifying(active.meetingId, event.sender, {
        liveResult: live?.finish()
      }).catch(() => {})
    }
    return db.getMeeting(active.meetingId)!
  })

  ipcMain.handle(IPC.pipelineRetry, async (event, meetingId: string): Promise<void> => {
    void runPipelineNotifying(meetingId, event.sender).catch(() => {})
  })

  ipcMain.handle(IPC.meetingsList, (): Meeting[] => db.listMeetings())

  ipcMain.handle(IPC.meetingsGet, (_event, id: string): MeetingDetail | null => {
    const meeting = db.getMeeting(id)
    if (!meeting) return null
    const hasAudio =
      meeting.audioDir !== null &&
      ['mic.wav', 'system.wav', 'session.json'].every((f) => existsSync(join(meeting.audioDir!, f)))
    return { meeting, transcript: db.getTranscript(id), hasAudio }
  })

  ipcMain.handle(IPC.meetingsRename, (_event, id: string, title: string): void => {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('title cannot be empty')
    db.setMeetingTitle(id, trimmed)
  })

  ipcMain.handle(IPC.meetingsSetNotes, (_event, id: string, notes: string): void => {
    db.setRawNotes(id, notes)
  })

  ipcMain.handle(IPC.meetingsSetSummary, (_event, id: string, summary: string): void => {
    db.setEnhancedNotes(id, summary)
  })

  ipcMain.handle(IPC.meetingsDelete, async (_event, id: string): Promise<void> => {
    const meeting = db.getMeeting(id)
    if (!meeting) return
    db.deleteMeeting(id)
    if (meeting.audioDir?.startsWith(recordingsDir)) {
      await rm(meeting.audioDir, { recursive: true, force: true })
    }
  })
}

async function runPipelineNotifying(
  meetingId: string,
  sender: WebContents,
  options: PipelineOptions = {}
): Promise<void> {
  const notifyUpdated = () => {
    if (!sender.isDestroyed()) sender.send(IPC.meetingUpdated, meetingId)
  }
  let summarizeAnnounced = false
  const progress = (stage: PipelineStage) => {
    // The transcript is already saved when summarizing starts; announcing the
    // update first (IPC is ordered) lets the renderer show it mid-processing.
    if (stage === 'summarizing' && !summarizeAnnounced) {
      summarizeAnnounced = true
      notifyUpdated()
    }
    if (!sender.isDestroyed()) sender.send(IPC.pipelineProgress, { meetingId, stage })
  }
  const onSummaryDelta = (text: string) => {
    if (!sender.isDestroyed()) sender.send(IPC.pipelineSummaryDelta, { meetingId, text })
  }
  try {
    await runPipeline(meetingId, progress, { ...options, onSummaryDelta })
  } finally {
    notifyUpdated()
  }
}
