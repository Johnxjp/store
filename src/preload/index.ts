import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { Meeting, MeetingDetail, PipelineProgress } from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  startRecording: (): Promise<Meeting> => ipcRenderer.invoke(IPC.recordingStart),
  stopRecording: (): Promise<Meeting> => ipcRenderer.invoke(IPC.recordingStop),
  retryPipeline: (meetingId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.pipelineRetry, meetingId),
  listMeetings: (): Promise<Meeting[]> => ipcRenderer.invoke(IPC.meetingsList),
  getMeeting: (id: string): Promise<MeetingDetail | null> =>
    ipcRenderer.invoke(IPC.meetingsGet, id),
  deleteMeeting: (id: string): Promise<void> => ipcRenderer.invoke(IPC.meetingsDelete, id),
  renameMeeting: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke(IPC.meetingsRename, id, title),
  saveNotes: (id: string, notes: string): Promise<void> =>
    ipcRenderer.invoke(IPC.meetingsSetNotes, id, notes),
  saveSummary: (id: string, summary: string): Promise<void> =>
    ipcRenderer.invoke(IPC.meetingsSetSummary, id, summary),
  onPipelineProgress: (cb: (p: PipelineProgress) => void): (() => void) =>
    on(IPC.pipelineProgress, cb),
  onMeetingUpdated: (cb: (meetingId: string) => void): (() => void) => on(IPC.meetingUpdated, cb)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
