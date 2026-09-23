export const IPC = {
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingPause: 'recording:pause',
  recordingResume: 'recording:resume',
  pipelineProgress: 'pipeline:progress',
  pipelineSummaryDelta: 'pipeline:summary-delta',
  pipelineRetry: 'pipeline:retry',
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  meetingsDelete: 'meetings:delete',
  meetingsRename: 'meetings:rename',
  meetingsSetNotes: 'meetings:set-notes',
  meetingsSetSummary: 'meetings:set-summary',
  meetingUpdated: 'meeting:updated'
} as const
