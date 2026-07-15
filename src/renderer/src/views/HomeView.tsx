import type { Meeting, PipelineStage } from '../../../shared/types'
import { DocIcon, PlusIcon } from '../components/icons'
import { dayLabel, durationLabel, stageLabel, timeLabel } from '../lib/format'

interface Props {
  meetings: Meeting[]
  progress: Record<string, PipelineStage>
  searching: boolean
  onOpen: (id: string) => void
  onNew: () => void
}

export function HomeView({ meetings, progress, searching, onOpen, onNew }: Props) {
  const groups: { label: string; items: Meeting[] }[] = []
  for (const m of meetings) {
    const label = dayLabel(m.createdAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(m)
    else groups.push({ label, items: [m] })
  }

  return (
    <div className="home">
      <button className="new-note" onClick={onNew}>
        <PlusIcon /> New note
      </button>
      <h1 className="page-title">Notes</h1>
      {groups.length === 0 && (
        <p className="empty-state">
          {searching
            ? 'No notes match your search.'
            : 'No notes yet. Start your first meeting with New note.'}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.label} className="day-group">
          <h2 className="day-label">{g.label}</h2>
          {g.items.map((m) => (
            <NoteRow key={m.id} meeting={m} stage={progress[m.id]} onOpen={() => onOpen(m.id)} />
          ))}
        </section>
      ))}
    </div>
  )
}

function NoteRow({
  meeting,
  stage,
  onOpen
}: {
  meeting: Meeting
  stage?: PipelineStage
  onOpen: () => void
}) {
  return (
    <button className="note-row" onClick={onOpen}>
      <span className="note-icon">
        <DocIcon />
      </span>
      <span className="note-info">
        <span className="note-row-title">{meeting.title}</span>
        <NoteSub meeting={meeting} stage={stage} />
      </span>
      <span className="note-time">{timeLabel(meeting.createdAt)}</span>
    </button>
  )
}

function NoteSub({ meeting, stage }: { meeting: Meeting; stage?: PipelineStage }) {
  if (meeting.status === 'recording')
    return (
      <span className="sub live">
        <span className="live-dot" />
        Recording
      </span>
    )
  if (meeting.status === 'processing')
    return (
      <span className="sub live">
        <span className="live-dot" />
        {stageLabel(stage)}
      </span>
    )
  if (meeting.status === 'error') return <span className="sub err">Failed — open to retry</span>
  return <span className="sub">{durationLabel(meeting) ?? 'Me'}</span>
}
