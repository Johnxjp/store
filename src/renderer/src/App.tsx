import { useCallback, useEffect, useState } from 'react'
import type { Meeting, PipelineStage } from '../../shared/types'
import { ChatIcon, HomeIcon, SearchIcon } from './components/icons'
import { ChatView } from './views/ChatView'
import { HomeView } from './views/HomeView'
import { MeetingDetailView } from './views/MeetingDetail'

type Nav = 'home' | 'chat'

export default function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [nav, setNav] = useState<Nav>('home')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, PipelineStage>>({})
  const [summaryStream, setSummaryStream] = useState<Record<string, string>>({})
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setMeetings(await window.api.listMeetings())
    setRefreshKey((k) => k + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const offProgress = window.api.onPipelineProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.meetingId]: p.stage }))
    })
    const offSummary = window.api.onSummaryDelta((d) => {
      setSummaryStream((prev) => ({ ...prev, [d.meetingId]: d.text }))
    })
    const offUpdated = window.api.onMeetingUpdated((meetingId) => {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[meetingId]
        return next
      })
      // The stream entry outlives the refresh so the summary never flashes
      // back to "No summary yet." between the DB write landing and the refetch.
      void refresh().then(() => {
        setSummaryStream((prev) => {
          const next = { ...prev }
          delete next[meetingId]
          return next
        })
      })
    })
    return () => {
      offProgress()
      offSummary()
      offUpdated()
    }
  }, [refresh])

  async function startRecording() {
    setError(null)
    try {
      const meeting = await window.api.startRecording()
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
    await refresh()
  }

  async function pauseRecording() {
    setError(null)
    try {
      await window.api.pauseRecording()
    } catch (e) {
      setError(String(e))
    }
    await refresh()
  }

  async function resumeRecording() {
    setError(null)
    try {
      await window.api.resumeRecording()
    } catch (e) {
      setError(String(e))
    }
    await refresh()
  }

  async function retryPipeline(id: string) {
    // The handler kicks off the pipeline and returns once the meeting is
    // 'processing'; refreshing here swaps the error card for the status line.
    await window.api.retryPipeline(id)
    await refresh()
  }

  async function renameMeeting(id: string, title: string) {
    await window.api.renameMeeting(id, title)
    await refresh()
  }

  async function deleteMeeting(id: string) {
    await window.api.deleteMeeting(id)
    if (selectedId === id) setSelectedId(null)
    await refresh()
  }

  const errorBanner = error && (
    <div className="error-banner">
      <span>{error}</span>
      <button onClick={() => setError(null)}>Dismiss</button>
    </div>
  )

  if (selectedId) {
    return (
      <>
        {errorBanner}
        <MeetingDetailView
          meetingId={selectedId}
          refreshKey={refreshKey}
          stage={progress[selectedId]}
          streamText={summaryStream[selectedId]}
          onStop={stopRecording}
          onPause={pauseRecording}
          onResume={resumeRecording}
          onBack={() => setSelectedId(null)}
          onDelete={() => deleteMeeting(selectedId)}
          onRetry={() => void retryPipeline(selectedId)}
          onRename={(title) => renameMeeting(selectedId, title)}
        />
      </>
    )
  }

  const trimmed = query.trim().toLowerCase()
  const visible = trimmed
    ? meetings.filter((m) => m.title.toLowerCase().includes(trimmed))
    : meetings

  return (
    <div className="layout">
      <div className="drag-strip" />
      {errorBanner}
      <aside className="sidebar">
        <label className="search">
          <SearchIcon />
          <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav className="side-nav">
          <button className={nav === 'home' ? 'active' : ''} onClick={() => setNav('home')}>
            <HomeIcon /> Home
          </button>
          <button className={nav === 'chat' ? 'active' : ''} onClick={() => setNav('chat')}>
            <ChatIcon /> Chat
          </button>
        </nav>
      </aside>
      <main className="main">
        {nav === 'chat' ? (
          <ChatView />
        ) : (
          <HomeView
            meetings={visible}
            progress={progress}
            searching={trimmed.length > 0}
            onOpen={setSelectedId}
            onNew={startRecording}
          />
        )}
      </main>
    </div>
  )
}
