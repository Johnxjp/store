import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc-channels'
import type { Meeting, MeetingDetail, PipelineStage } from '../shared/types'
import * as db from './db'
import { audioCaptureBin, recordingsDir } from './paths'
import { runPipeline, writeSessionFile } from './pipeline'
import { Recorder } from './recorder'

interface Session {
  recorder: Recorder
  meetingId: string
}

let session: Session | null = null

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.recordingStart, async (): Promise<Meeting> => {
    if (session) throw new Error('already recording')
    const id = randomUUID()
    const dir = join(recordingsDir, id)
    await mkdir(dir, { recursive: true })

    const recorder = new Recorder(audioCaptureBin)
    const anchors = await recorder.start(dir)
    await writeSessionFile(dir, anchors)

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
      startedAt: now
    })
    session = { recorder, meetingId: id }
    return meeting
  })

  ipcMain.handle(IPC.recordingStop, async (event): Promise<Meeting> => {
    if (!session) throw new Error('not recording')
    const { recorder, meetingId } = session
    session = null

    await recorder.stop()
    db.setRecordingEnded(meetingId, Date.now())

    // Pipeline runs in the background; the renderer follows progress events.
    void runPipelineNotifying(meetingId, event.sender).catch(() => {})
    return db.getMeeting(meetingId)!
  })

  ipcMain.handle(IPC.pipelineRetry, async (event, meetingId: string): Promise<void> => {
    void runPipelineNotifying(meetingId, event.sender).catch(() => {})
  })

  ipcMain.handle(IPC.meetingsList, (): Meeting[] => db.listMeetings())

  ipcMain.handle(IPC.meetingsGet, (_event, id: string): MeetingDetail | null => {
    const meeting = db.getMeeting(id)
    if (!meeting) return null
    return { meeting, transcript: db.getTranscript(id) }
  })

  ipcMain.handle(IPC.meetingsRename, (_event, id: string, title: string): void => {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('title cannot be empty')
    db.setMeetingTitle(id, trimmed)
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

async function runPipelineNotifying(meetingId: string, sender: WebContents): Promise<void> {
  const progress = (stage: PipelineStage) => {
    if (!sender.isDestroyed()) sender.send(IPC.pipelineProgress, { meetingId, stage })
  }
  const notifyUpdated = () => {
    if (!sender.isDestroyed()) sender.send(IPC.meetingUpdated, meetingId)
  }
  try {
    await runPipeline(meetingId, progress)
  } finally {
    notifyUpdated()
  }
}
