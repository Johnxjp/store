import { useEffect, useRef, useState } from 'react'
import type { PipelineStage, RecordingState, TranscriptSegment } from '../../shared/types'

const STAGE_LABELS: Record<PipelineStage, string> = {
  converting: 'Preparing audio…',
  'transcribing-mic': 'Transcribing your audio…',
  'transcribing-system': 'Transcribing meeting audio…',
  merging: 'Merging transcript…'
}

export default function App() {
  const [state, setState] = useState<RecordingState>('idle')
  const [stage, setStage] = useState<PipelineStage | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => window.api.onPipelineProgress(setStage), [])

  useEffect(() => {
    if (state === 'recording') {
      const startedAt = Date.now()
      timerRef.current = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [state])

  async function start() {
    setError(null)
    setSegments(null)
    setElapsed(0)
    try {
      await window.api.startRecording()
      setState('recording')
    } catch (e) {
      setError(String(e))
      setState('idle')
    }
  }

  async function stop() {
    setState('processing')
    setStage(null)
    try {
      const result = await window.api.stopRecording()
      setSegments(result.segments)
    } catch (e) {
      setError(String(e))
    } finally {
      setState('idle')
      setStage(null)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>AI Meeting Notes</h1>
        {state === 'idle' && (
          <button className="record" onClick={start}>
            ● Record
          </button>
        )}
        {state === 'recording' && (
          <button className="stop" onClick={stop}>
            ■ Stop {formatElapsed(elapsed)}
          </button>
        )}
        {state === 'processing' && (
          <span className="processing">{stage ? STAGE_LABELS[stage] : 'Processing…'}</span>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      {segments && (
        <section className="transcript">
          <h2>Transcript</h2>
          {segments.length === 0 && <p className="empty">No speech detected.</p>}
          {segments.map((s, i) => (
            <div key={i} className={`segment ${s.speaker}`}>
              <span className="ts">{formatElapsed(s.startMs)}</span>
              <span className="speaker">{s.speaker === 'me' ? 'Me' : 'Them'}</span>
              <span className="text">{s.text}</span>
            </div>
          ))}
        </section>
      )}

      {!segments && state === 'idle' && !error && (
        <p className="empty">Press Record, have a conversation, then Stop to see the transcript.</p>
      )}
    </div>
  )
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
