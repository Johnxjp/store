export const IPC = {
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  pipelineProgress: 'pipeline:progress',
  pipelineRetry: 'pipeline:retry',
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  meetingsDelete: 'meetings:delete',
  meetingsRename: 'meetings:rename',
  meetingsSetNotes: 'meetings:set-notes',
  meetingsSetSummary: 'meetings:set-summary',
  meetingUpdated: 'meeting:updated'
} as const
