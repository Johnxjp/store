import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import type { MeetingDetail, PipelineStage } from '../../../shared/types'
import { stageLabel } from '../App'
import { formatElapsed } from './RecordingView'

type Tab = 'notes' | 'transcript'

interface Props {
  meetingId: string
  refreshKey: number
  stage?: PipelineStage
  onDelete: () => void
  onRetry: () => void
}

export function MeetingDetailView({ meetingId, refreshKey, stage, onDelete, onRetry }: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null)
  const [tab, setTab] = useState<Tab>('notes')

  useEffect(() => {
    let cancelled = false
    void window.api.getMeeting(meetingId).then((d) => {
      if (!cancelled) setDetail(d)
    })
    return () => {
      cancelled = true
    }
  }, [meetingId, refreshKey])

  if (!detail) return null
  const { meeting, transcript } = detail

  return (
    <div className="detail">
      <header className="detail-header">
        <div>
          <h2>{meeting.title}</h2>
          <p className="meta">{new Date(meeting.createdAt).toLocaleString()}</p>
        </div>
        <button className="ghost" onClick={onDelete}>
          Delete
        </button>
      </header>

      {meeting.status === 'processing' && (
        <div className="processing-banner">{stageLabel(stage)}</div>
      )}

      {meeting.status === 'error' && (
        <div className="error">
          <p>{meeting.errorMessage ?? 'Something went wrong.'}</p>
          <button onClick={onRetry}>Retry</button>
        </div>
      )}

      {(meeting.status === 'ready' || transcript.length > 0) && (
        <>
          <nav className="tabs">
            <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
              Notes
            </button>
            <button
              className={tab === 'transcript' ? 'active' : ''}
              onClick={() => setTab('transcript')}
            >
              Transcript
            </button>
          </nav>

          {tab === 'notes' && (
            <article className="notes">
              {meeting.enhancedNotes ? (
                <Markdown>{meeting.enhancedNotes}</Markdown>
              ) : (
                <p className="empty">No notes yet.</p>
              )}
            </article>
          )}

          {tab === 'transcript' && (
            <section className="transcript">
              {transcript.length === 0 && <p className="empty">No speech detected.</p>}
              {transcript.map((s, i) => (
                <div key={i} className={`segment ${s.speaker}`}>
                  <span className="ts">{formatElapsed(s.startMs)}</span>
                  <span className="speaker">{s.speaker === 'me' ? 'Me' : 'Them'}</span>
                  <span className="text">{s.text}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
