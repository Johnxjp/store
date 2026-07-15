import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import type { MeetingDetail, PipelineStage } from '../../../shared/types'
import { CalendarIcon, ChevronLeftIcon, HomeIcon } from '../components/icons'
import { RecordBar } from '../components/RecordBar'
import { dayLabel, durationLabel, formatElapsed, stageLabel } from '../lib/format'

type Tab = 'notes' | 'transcript'

interface Props {
  meetingId: string
  refreshKey: number
  stage?: PipelineStage
  onStop: () => void
  onBack: () => void
  onDelete: () => void
  onRetry: () => void
}

export function MeetingDetailView({
  meetingId,
  refreshKey,
  stage,
  onStop,
  onBack,
  onDelete,
  onRetry
}: Props) {
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

  if (!detail) return <div className="note-view" />
  const { meeting, transcript } = detail
  const isRecording = meeting.status === 'recording'
  const duration = durationLabel(meeting)

  return (
    <div className="note-view">
      <header className="note-topbar">
        <button className="pill-btn" onClick={onBack} aria-label="Back to home">
          <ChevronLeftIcon />
          <HomeIcon />
        </button>
        {!isRecording && (
          <button className="ghost-btn" onClick={onDelete}>
            Delete
          </button>
        )}
      </header>

      <div className="note-scroll">
        <article className="note">
          <h1 className="note-title">{meeting.title}</h1>
          <div className="chips">
            <span className="chip">
              <CalendarIcon />
              {dayLabel(meeting.createdAt)}
            </span>
            {duration && <span className="chip">{duration}</span>}
          </div>

          {meeting.status === 'processing' && (
            <div className="status-line">
              <span className="live-dot" />
              {stageLabel(stage)}
            </div>
          )}

          {meeting.status === 'error' && (
            <div className="error-card">
              <p>{meeting.errorMessage ?? 'Something went wrong.'}</p>
              <button className="ghost-btn" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}

          {isRecording && (
            <p className="placeholder">
              Recording — the transcript and notes appear here when you stop.
            </p>
          )}

          {!isRecording && (meeting.status === 'ready' || transcript.length > 0) && (
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
                    <p className="empty-state">No notes yet.</p>
                  )}
                </article>
              )}

              {tab === 'transcript' && (
                <section className="transcript">
                  {transcript.length === 0 && <p className="empty-state">No speech detected.</p>}
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
        </article>
      </div>

      {isRecording && (
        <RecordBar startedAt={meeting.recordingStartedAt ?? meeting.createdAt} onStop={onStop} />
      )}
    </div>
  )
}
