import { useLayoutEffect, useState } from 'react'
import { formatElapsed } from '../lib/format'
import { PauseIcon, PlayIcon } from './icons'

export function RecordBar({
  startedAt,
  paused,
  pausedAt,
  pausedMs,
  onStop,
  onPause,
  onResume
}: {
  startedAt: number
  paused: boolean
  pausedAt: number | null
  pausedMs: number
  onStop: () => void
  onPause: () => void
  onResume: () => void
}) {
  const [now, setNow] = useState(() => Date.now())

  // Layout effect, not effect: on resume React paints once with the stale `now`
  // and the already-grown pausedMs, which renders a negative timer ("-10:00"
  // after a ten-minute pause). Correcting before paint removes that frame.
  useLayoutEffect(() => {
    if (pausedAt !== null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pausedAt])

  // Recorded time, not wall clock: the transcript squishes paused time out, so
  // counting it here would drift ahead of the timestamps in the notes.
  const elapsed = (pausedAt ?? now) - startedAt - pausedMs

  return (
    <div className="record-bar">
      <div className={`level-bars ${paused ? 'paused' : ''}`} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <span className="record-timer">{formatElapsed(elapsed)}</span>
      <button
        className="pause-btn"
        onClick={paused ? onResume : onPause}
        aria-label={paused ? 'Resume recording' : 'Pause recording'}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>
      <button className="stop-btn" onClick={onStop} aria-label="Stop recording">
        <span className="stop-square" />
      </button>
    </div>
  )
}
