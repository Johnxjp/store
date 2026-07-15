import { useEffect, useState } from 'react'
import { formatElapsed } from '../lib/format'

export function RecordBar({ startedAt, onStop }: { startedAt: number; onStop: () => void }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt)

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(t)
  }, [startedAt])

  return (
    <div className="record-bar">
      <div className="level-bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span className="record-timer">{formatElapsed(elapsed)}</span>
      <button className="stop-btn" onClick={onStop} aria-label="Stop recording">
        <span className="stop-square" />
      </button>
    </div>
  )
}
