import { useEffect, useState } from 'react'

export function RecordingView({ onStop }: { onStop: () => void }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const startedAt = Date.now()
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="recording-view">
      <div className="pulse" />
      <h2>Recording</h2>
      <p className="timer">{formatElapsed(elapsed)}</p>
      <button className="stop" onClick={onStop}>
        ■ Stop recording
      </button>
    </div>
  )
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
