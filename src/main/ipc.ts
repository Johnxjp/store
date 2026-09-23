import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc-channels'
import type { Meeting, MeetingDetail, PipelineStage } from '../shared/types'
import { readConfig } from './config'
import * as db from './db'
import { buildSummaryPrompt, type ChatPrompt } from './enhance'
import { LiveTranscriber, type LiveSegments } from './live'
import { formatTranscript, mergeTranscripts, type PauseInterval } from './merge'
import { audioCaptureBin, recordingsDir } from './paths'
import {
  runPipeline,
  writeSessionFile,
  type PipelineOptions,
  type SessionAnchors
} from './pipeline'
import { Recorder } from './recorder'
import { SummaryWarmer } from './warm'

interface Session {
  recorder: Recorder
  meetingId: string
  /** Where the WAVs and session.json live. */
  dir: string
  /** Resolves true once capture is live (anchors written), false if it failed to start. */
  starting: Promise<boolean>
  /** Transcribes during the meeting; null until capture is live (or when disabled by config). */
  live: LiveTranscriber | null
  /** Keeps Ollama's prefix cache warm as the live transcript grows. */
  warmer: SummaryWarmer | null
  /** Title at recording start; every warm and the final summary prompt use it (renames would void the cache). */
  promptTitle: string | null
  /** Epoch anchors once capture is live; null while it spins up. */
  anchors: SessionAnchors | null
  /** Closed pause spans, in press order. */
  pauses: PauseInterval[]
  /** When the current pause began, or null while capture is running. */
  pausedAt: number | null
}

function totalPausedMs(pauses: PauseInterval[]): number {
  return pauses.reduce((sum, p) => sum + (p.toEpochMs - p.fromEpochMs), 0)
}

/**
 * Freezes the session's pause spans to disk and to the meeting row, closing
 * an open pause at the current instant. The pipeline collapses the transcript
 * using session.json and the duration label reads the DB total, so both have
 * to land before either runs.
 */
async function persistPauses(sess: Session): Promise<void> {
  const pauses = [...sess.pauses]
  if (sess.pausedAt !== null) pauses.push({ fromEpochMs: sess.pausedAt, toEpochMs: Date.now() })
  if (sess.anchors) await writeSessionFile(sess.dir, { ...sess.anchors, pauses })
  db.setPausedMs(sess.meetingId, totalPausedMs(pauses))
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
  const { recorder, meetingId, live, warmer } = session
  const active = session
  session = null
  warmer?.stop()
  live?.cancel()
  return recorder
    .stop()
    .catch(() => {})
    .then(async () => {
      await persistPauses(active)
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
        if (session?.meetingId === id) session.anchors = anchors
        // A fast Stop (or quit) during capture spin-up already tore the
        // session down — starting the live loop then would leak it.
        if (session?.meetingId === id && readConfig().liveTranscription) {
          const sess = session
          const promptTitle = db.getMeeting(id)?.title ?? meeting.title
          const live = new LiveTranscriber(dir, {
            onChunk: () => sess.warmer?.poke()
          })
          sess.live = live
          sess.warmer = new SummaryWarmer(() =>
            buildWarmPrompt(live.snapshot(), anchors, sess.pauses, promptTitle, meeting.createdAt)
          )
          sess.promptTitle = promptTitle
          live.start()
          // Warm immediately: loads the model and prefills the static
          // instruction prefix before the first chunk even lands.
          sess.warmer.poke()
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
    session = {
      recorder,
      meetingId: id,
      dir,
      starting,
      live: null,
      warmer: null,
      promptTitle: null,
      anchors: null,
      pauses: [],
      pausedAt: null
    }
    return meeting
  })

  ipcMain.handle(IPC.recordingStop, async (event): Promise<Meeting> => {
    if (!session) throw new Error('not recording')
    const active = session
    session = null

    // Capture may still be spinning up; wait for it to go live (or fail)
    // before stopping. On failure the meeting is already marked 'error'.
    if (await active.starting) {
      const { live, warmer } = active
      // Stop warming first: an unaborted warm would queue the final summary
      // request behind it on Ollama's single runner.
      warmer?.stop()
      try {
        await active.recorder.stop()
      } catch (err) {
        live?.cancel()
        throw err
      }
      db.setRecordingEnded(active.meetingId, Date.now())
      await persistPauses(active)

      // finish() is not awaited here — that would hold the meeting in
      // 'recording' while the tail chunks transcribe. The pipeline awaits it
      // inside its transcribing stage instead.
      void runPipelineNotifying(active.meetingId, event.sender, {
        liveResult: live?.finish(),
        promptTitle: active.promptTitle ?? undefined
      }).catch(() => {})
    }
    return db.getMeeting(active.meetingId)!
  })

  ipcMain.handle(IPC.recordingPause, (): void => {
    if (!session) throw new Error('not recording')
    if (session.pausedAt !== null) return
    session.recorder.pause()
    session.pausedAt = Date.now()
  })

  // Persisting on resume rather than only at Stop means a crash mid-meeting
  // still collapses every pause that had already finished.
  ipcMain.handle(IPC.recordingResume, async (): Promise<void> => {
    if (!session) throw new Error('not recording')
    if (session.pausedAt === null) return
    session.recorder.resume()
    session.pauses.push({ fromEpochMs: session.pausedAt, toEpochMs: Date.now() })
    session.pausedAt = null
    await persistPauses(session)
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
    const live = session?.meetingId === id ? session : null
    return {
      meeting,
      transcript: db.getTranscript(id),
      hasAudio,
      pausedAt: live?.pausedAt ?? null,
      // Excludes any pause still open, which is what lets the record bar
      // freeze its timer at pausedAt without polling for updates.
      pausedMs: live ? totalPausedMs(live.pauses) : meeting.pausedMs
    }
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

/**
 * The warmer's prompt builder: merge the live segments with the session
 * anchors and build the production prompt byte-identically to the pipeline's
 * summarize stage. Returns null once the transcript exceeds the truncation
 * cap — truncation rewrites the prompt middle, which defeats the cache.
 */
function buildWarmPrompt(
  segments: LiveSegments,
  anchors: SessionAnchors,
  pauses: PauseInterval[],
  title: string,
  createdAt: number
): ChatPrompt | null {
  const merged = mergeTranscripts(
    { segments: segments.mic, epochMs: anchors.micEpochMs },
    { segments: segments.system, epochMs: anchors.systemEpochMs },
    pauses
  )
  const config = readConfig()
  if (formatTranscript(merged).length > config.maxTranscriptChars) return null
  return buildSummaryPrompt(
    { title, dateLabel: new Date(createdAt).toLocaleString(), transcript: merged },
    config.maxTranscriptChars
  )
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
