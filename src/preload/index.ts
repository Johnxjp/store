import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { PipelineStage, RecordingResult } from '../shared/types'

const api = {
  startRecording: (): Promise<void> => ipcRenderer.invoke(IPC.recordingStart),
  stopRecording: (): Promise<RecordingResult> => ipcRenderer.invoke(IPC.recordingStop),
  onPipelineProgress: (cb: (stage: PipelineStage) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, stage: PipelineStage) => cb(stage)
    ipcRenderer.on(IPC.pipelineProgress, listener)
    return () => ipcRenderer.removeListener(IPC.pipelineProgress, listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
