import { useCallback, useEffect, useState } from 'react'
import type { Meeting, PipelineStage } from '../../shared/types'
import { MeetingDetailView } from './views/MeetingDetail'
import { RecordingView } from './views/RecordingView'

export default function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [recording, setRecording] = useState<Meeting | null>(null)
  const [progress, setProgress] = useState<Record<string, PipelineStage>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setMeetings(await window.api.listMeetings())
    setRefreshKey((k) => k + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const offProgress = window.api.onPipelineProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.meetingId]: p.stage }))
    })
    const offUpdated = window.api.onMeetingUpdated(() => {
      setProgress({})
      void refresh()
    })
    return () => {
      offProgress()
      offUpdated()
    }
  }, [refresh])

  async function startRecording() {
    setError(null)
    try {
      const meeting = await window.api.startRecording()
      setRecording(meeting)
      setSelectedId(meeting.id)
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  async function stopRecording() {
    setError(null)
    try {
      await window.api.stopRecording()
    } catch (e) {
      setError(String(e))
    }
    setRecording(null)
    await refresh()
  }

  async function deleteMeeting(id: string) {
    await window.api.deleteMeeting(id)
    if (selectedId === id) setSelectedId(null)
    await refresh()
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Meetings</h1>
          {recording ? (
            <button className="stop" onClick={stopRecording}>
              ■ Stop
            </button>
          ) : (
            <button className="record" onClick={startRecording}>
              ● Record
            </button>
          )}
        </div>
        <ul className="meeting-list">
          {meetings.map((m) => (
            <li
              key={m.id}
              className={m.id === selectedId ? 'selected' : ''}
              onClick={() => setSelectedId(m.id)}
            >
              <span className="meeting-title">{m.title}</span>
              <StatusBadge meeting={m} stage={progress[m.id]} />
            </li>
          ))}
          {meetings.length === 0 && <li className="empty">No meetings yet</li>}
        </ul>
      </aside>

      <main className="main">
        {error && <div className="error">{error}</div>}
        {recording ? (
          <RecordingView onStop={stopRecording} />
        ) : selectedId ? (
          <MeetingDetailView
            meetingId={selectedId}
            refreshKey={refreshKey}
            stage={progress[selectedId]}
            onDelete={() => deleteMeeting(selectedId)}
            onRetry={() => window.api.retryPipeline(selectedId)}
          />
        ) : (
          <p className="empty">Select a meeting, or press Record to start a new one.</p>
        )}
      </main>
    </div>
  )
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  converting: 'Preparing audio…',
  'transcribing-mic': 'Transcribing you…',
  'transcribing-system': 'Transcribing others…',
  merging: 'Merging…',
  summarizing: 'Writing notes…'
}

export function stageLabel(stage: PipelineStage | undefined): string {
  return stage ? STAGE_LABELS[stage] : 'Processing…'
}

function StatusBadge({ meeting, stage }: { meeting: Meeting; stage?: PipelineStage }) {
  if (meeting.status === 'recording') return <span className="badge rec">rec</span>
  if (meeting.status === 'processing')
    return <span className="badge processing">{stageLabel(stage)}</span>
  if (meeting.status === 'error') return <span className="badge err">error</span>
  return null
}
