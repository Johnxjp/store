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
          onStop={stopRecording}
          onBack={() => setSelectedId(null)}
          onDelete={() => deleteMeeting(selectedId)}
          onRetry={() => window.api.retryPipeline(selectedId)}
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
