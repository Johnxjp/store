import { ipcMain, type WebContents } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../shared/ipc-channels'
import type { PipelineStage, RecordingResult } from '../shared/types'
import { mergeTranscripts } from './merge'
import { audioCaptureBin, modelPath, recordingsDir } from './paths'
import { Recorder, type RecorderAnchors } from './recorder'
import { convertTo16k, transcribeWav } from './transcribe'

interface Session {
  recorder: Recorder
  dir: string
  anchors: RecorderAnchors
}

let session: Session | null = null

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.recordingStart, async () => {
    if (session) throw new Error('already recording')
    const dir = join(recordingsDir, new Date().toISOString().replace(/[:.]/g, '-'))
    await mkdir(dir, { recursive: true })
    const recorder = new Recorder(audioCaptureBin)
    const anchors = await recorder.start(dir)
    session = { recorder, dir, anchors }
  })

  ipcMain.handle(IPC.recordingStop, async (event): Promise<RecordingResult> => {
    if (!session) throw new Error('not recording')
    const { recorder, dir, anchors } = session
    session = null

    const durationMs = await recorder.stop()
    const progress = (stage: PipelineStage) => sendProgress(event.sender, stage)

    progress('converting')
    const mic16k = join(dir, 'mic-16k.wav')
    const system16k = join(dir, 'system-16k.wav')
    await convertTo16k(join(dir, 'mic.wav'), mic16k)
    await convertTo16k(join(dir, 'system.wav'), system16k)

    progress('transcribing-mic')
    const micSegments = await transcribeWav(mic16k, modelPath)
    progress('transcribing-system')
    const systemSegments = await transcribeWav(system16k, modelPath)

    progress('merging')
    const segments = mergeTranscripts(
      { segments: micSegments, epochMs: anchors.micEpochMs },
      { segments: systemSegments, epochMs: anchors.systemEpochMs }
    )
    return { segments, durationMs }
  })
}

function sendProgress(sender: WebContents, stage: PipelineStage): void {
  if (!sender.isDestroyed()) sender.send(IPC.pipelineProgress, stage)
}
