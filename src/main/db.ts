// node:sqlite instead of better-sqlite3: same synchronous API, ships inside
// Electron's Node, and needs no native rebuild. Experimental-but-stable enough
// for a single-user local app.
import { DatabaseSync } from 'node:sqlite'
import type { Meeting, MeetingStatus, Speaker, TranscriptSegment } from '../shared/types'

const MIGRATIONS = [
  `CREATE TABLE meetings (
     id                    TEXT PRIMARY KEY,
     title                 TEXT NOT NULL,
     status                TEXT NOT NULL,
     created_at            INTEGER NOT NULL,
     recording_started_at  INTEGER,
     recording_ended_at    INTEGER,
     raw_notes             TEXT NOT NULL DEFAULT '',
     enhanced_notes        TEXT,
     error_message         TEXT,
     audio_dir             TEXT
   );
   CREATE TABLE transcript_segments (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     speaker    TEXT NOT NULL,
     start_ms   INTEGER NOT NULL,
     end_ms     INTEGER NOT NULL,
     text       TEXT NOT NULL
   );
   CREATE INDEX idx_segments_meeting ON transcript_segments(meeting_id, start_ms);`
]

let db: DatabaseSync

export function initDb(path: string): void {
  db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i])
    db.exec(`PRAGMA user_version = ${i + 1}`)
  }
}

interface MeetingRow {
  id: string
  title: string
  status: string
  created_at: number
  recording_started_at: number | null
  recording_ended_at: number | null
  raw_notes: string
  enhanced_notes: string | null
  error_message: string | null
  audio_dir: string | null
}

function toMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    title: row.title,
    status: row.status as MeetingStatus,
    createdAt: row.created_at,
    recordingStartedAt: row.recording_started_at,
    recordingEndedAt: row.recording_ended_at,
    rawNotes: row.raw_notes,
    enhancedNotes: row.enhanced_notes,
    errorMessage: row.error_message,
    audioDir: row.audio_dir
  }
}

export function createMeeting(meeting: {
  id: string
  title: string
  audioDir: string
  startedAt: number
}): Meeting {
  db.prepare(
    `INSERT INTO meetings (id, title, status, created_at, recording_started_at, audio_dir)
     VALUES (?, ?, 'recording', ?, ?, ?)`
  ).run(meeting.id, meeting.title, meeting.startedAt, meeting.startedAt, meeting.audioDir)
  return getMeeting(meeting.id)!
}

export function getMeeting(id: string): Meeting | null {
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined
  return row ? toMeeting(row) : null
}

export function listMeetings(): Meeting[] {
  const rows = db
    .prepare('SELECT * FROM meetings ORDER BY created_at DESC')
    .all() as unknown as MeetingRow[]
  return rows.map(toMeeting)
}

// Recording/processing state lives only in main-process memory, so any row
// still in those states at startup is an orphan from a crashed or restarted
// run. Marking it 'error' surfaces the Retry button, which re-runs the
// pipeline from the WAVs on disk.
export function markInterruptedMeetings(): number {
  const result = db
    .prepare(
      `UPDATE meetings
       SET status = 'error',
           error_message = CASE status
             WHEN 'recording' THEN 'Recording was interrupted by an app restart. The audio captured so far is safe on disk.'
             ELSE 'Processing was interrupted by an app restart.'
           END
       WHERE status IN ('recording', 'processing')`
    )
    .run()
  return Number(result.changes)
}

export function setMeetingStatus(id: string, status: MeetingStatus, errorMessage?: string): void {
  db.prepare('UPDATE meetings SET status = ?, error_message = ? WHERE id = ?').run(
    status,
    errorMessage ?? null,
    id
  )
}

export function setRecordingEnded(id: string, endedAt: number): void {
  db.prepare('UPDATE meetings SET recording_ended_at = ? WHERE id = ?').run(endedAt, id)
}

export function setMeetingTitle(id: string, title: string): void {
  db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(title, id)
}

export function setEnhancedNotes(id: string, notes: string): void {
  db.prepare('UPDATE meetings SET enhanced_notes = ? WHERE id = ?').run(notes, id)
}

export function deleteMeeting(id: string): void {
  db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
}

export function saveTranscript(meetingId: string, segments: TranscriptSegment[]): void {
  db.prepare('DELETE FROM transcript_segments WHERE meeting_id = ?').run(meetingId)
  const insert = db.prepare(
    'INSERT INTO transcript_segments (meeting_id, speaker, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
  )
  for (const s of segments) {
    insert.run(meetingId, s.speaker, s.startMs, s.endMs, s.text)
  }
}

export function getTranscript(meetingId: string): TranscriptSegment[] {
  const rows = db
    .prepare(
      'SELECT speaker, start_ms, end_ms, text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms'
    )
    .all(meetingId) as Array<{ speaker: string; start_ms: number; end_ms: number; text: string }>
  return rows.map((r) => ({
    speaker: r.speaker as Speaker,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text
  }))
}
