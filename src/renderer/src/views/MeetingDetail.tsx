import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import type { MeetingDetail, PipelineStage } from '../../../shared/types'
import { CalendarIcon, ChevronLeftIcon, HomeIcon } from '../components/icons'
import { RecordBar } from '../components/RecordBar'
import { dayLabel, durationLabel, formatElapsed, stageLabel } from '../lib/format'

type View = 'note' | 'transcript'

interface Props {
  meetingId: string
  refreshKey: number
  stage?: PipelineStage
  onStop: () => void
  onBack: () => void
  onDelete: () => void
  onRetry: () => void
  onRename: (title: string) => void
}

export function MeetingDetailView({
  meetingId,
  refreshKey,
  stage,
  onStop,
  onBack,
  onDelete,
  onRetry,
  onRename
}: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null)
  const [view, setView] = useState<View>('note')
  const [draftTitle, setDraftTitle] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [summaryDraft, setSummaryDraft] = useState<string | null>(null)

  // Refetches happen on every pipeline event; the notepad draft must survive
  // them, so it is initialized only once per meeting.
  const notesLoadedFor = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void window.api.getMeeting(meetingId).then((d) => {
      if (cancelled) return
      setDetail(d)
      if (d && notesLoadedFor.current !== meetingId) {
        notesLoadedFor.current = meetingId
        setNotes(d.meeting.rawNotes)
        setSummaryDraft(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [meetingId, refreshKey])

  useEffect(() => () => clearTimeout(saveTimer.current), [])

  if (!detail) return <div className="note-view" />
  const { meeting, transcript, hasAudio } = detail
  const isRecording = meeting.status === 'recording'
  const duration = durationLabel(meeting)

  function commitTitle() {
    if (draftTitle === null) return
    const trimmed = draftTitle.trim()
    setDraftTitle(null)
    if (trimmed && trimmed !== meeting.title) {
      setDetail({ ...detail!, meeting: { ...meeting, title: trimmed } })
      onRename(trimmed)
    }
  }

  function onNotesChange(value: string) {
    setNotes(value)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void window.api.saveNotes(meetingId, value)
    }, 600)
  }

  function flushNotes() {
    clearTimeout(saveTimer.current)
    void window.api.saveNotes(meetingId, notes)
  }

  function commitSummary() {
    if (summaryDraft === null) return
    const draft = summaryDraft
    setSummaryDraft(null)
    if (draft === (meeting.enhancedNotes ?? '')) return
    setDetail({ ...detail!, meeting: { ...meeting, enhancedNotes: draft } })
    void window.api.saveSummary(meetingId, draft)
  }

  const showResults = !isRecording && (meeting.status === 'ready' || transcript.length > 0)

  const notepad = (
    <section className="notepad">
      <h2 className="section-label">My notes</h2>
      <textarea
        className="notepad-input"
        placeholder="Type your notes here…"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        onBlur={flushNotes}
      />
    </section>
  )

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
          {draftTitle === null ? (
            <h1
              className="note-title"
              title="Click to rename"
              onClick={() => setDraftTitle(meeting.title)}
            >
              {meeting.title}
            </h1>
          ) : (
            <input
              className="note-title-input"
              value={draftTitle}
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setDraftTitle(null)
              }}
            />
          )}
          <div className="chips">
            <span className="chip">
              <CalendarIcon />
              {dayLabel(meeting.createdAt)}
            </span>
            {duration && <span className="chip">{duration}</span>}
            {showResults && (
              <button
                className={`chip chip-toggle ${view === 'transcript' ? 'active' : ''}`}
                onClick={() => setView(view === 'transcript' ? 'note' : 'transcript')}
              >
                Transcript
              </button>
            )}
          </div>

          {meeting.status === 'processing' && (
            <div className="status-line">
              <span className="live-dot" />
              {stageLabel(stage)}
            </div>
          )}

          {meeting.status === 'error' && (
            <div className="error-card">
              {transcript.length > 0 || hasAudio ? (
                <>
                  <p>{meeting.errorMessage ?? 'Something went wrong.'}</p>
                  <button className="ghost-btn" onClick={onRetry}>
                    {transcript.length > 0 ? 'Generate summary' : 'Generate transcript and summary'}
                  </button>
                </>
              ) : (
                <p>Failed to capture audio for this meeting, so there is nothing to process.</p>
              )}
            </div>
          )}

          {showResults && view === 'transcript' ? (
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
          ) : (
            <>
              {notepad}

              {isRecording && (
                <p className="placeholder">
                  Recording — the transcript and summary appear here when you stop.
                </p>
              )}

              {showResults && (
                <section className="summary">
                  <h2 className="section-label">Summary</h2>
                  {summaryDraft !== null ? (
                    <textarea
                      className="summary-input"
                      value={summaryDraft}
                      autoFocus
                      onChange={(e) => setSummaryDraft(e.target.value)}
                      onBlur={commitSummary}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setSummaryDraft(null)
                      }}
                    />
                  ) : meeting.enhancedNotes ? (
                    <div
                      className="notes"
                      title="Click to edit"
                      onClick={() => setSummaryDraft(meeting.enhancedNotes ?? '')}
                    >
                      <Markdown>{meeting.enhancedNotes}</Markdown>
                    </div>
                  ) : (
                    <p className="empty-state">No summary yet.</p>
                  )}
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
