import { beforeEach, describe, expect, it } from 'vitest'
import * as db from '../src/main/db'

beforeEach(() => {
  db.initDb(':memory:')
})

const create = (id = 'm1') =>
  db.createMeeting({ id, title: 'Standup', audioDir: `/tmp/${id}`, startedAt: 1000 })

describe('meetings', () => {
  it('creates and fetches a meeting in recording state', () => {
    const m = create()
    expect(m).toMatchObject({
      id: 'm1',
      title: 'Standup',
      status: 'recording',
      createdAt: 1000,
      rawNotes: '',
      enhancedNotes: null
    })
    expect(db.getMeeting('m1')).toEqual(m)
  })

  it('lists meetings newest first', () => {
    db.createMeeting({ id: 'a', title: 'Old', audioDir: '/tmp/a', startedAt: 1 })
    db.createMeeting({ id: 'b', title: 'New', audioDir: '/tmp/b', startedAt: 2 })
    expect(db.listMeetings().map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('updates status with and without error message', () => {
    create()
    db.setMeetingStatus('m1', 'error', 'whisper exploded')
    expect(db.getMeeting('m1')).toMatchObject({ status: 'error', errorMessage: 'whisper exploded' })
    db.setMeetingStatus('m1', 'ready')
    expect(db.getMeeting('m1')).toMatchObject({ status: 'ready', errorMessage: null })
  })

  it('renames a meeting', () => {
    create()
    db.setMeetingTitle('m1', 'Quarterly planning')
    expect(db.getMeeting('m1')).toMatchObject({ title: 'Quarterly planning' })
  })

  it('stores enhanced notes and recording end', () => {
    create()
    db.setRecordingEnded('m1', 5000)
    db.setEnhancedNotes('m1', '## Summary\nGood meeting.')
    expect(db.getMeeting('m1')).toMatchObject({
      recordingEndedAt: 5000,
      enhancedNotes: '## Summary\nGood meeting.'
    })
  })

  it('marks stale recording and processing meetings as error, leaving others alone', () => {
    create('rec')
    create('proc')
    db.setMeetingStatus('proc', 'processing')
    create('done')
    db.setMeetingStatus('done', 'ready')

    expect(db.markInterruptedMeetings()).toBe(2)
    expect(db.getMeeting('rec')).toMatchObject({
      status: 'error',
      errorMessage:
        'Recording was interrupted by an app restart. Retry to process the audio captured so far.'
    })
    expect(db.getMeeting('proc')).toMatchObject({
      status: 'error',
      errorMessage: 'Processing was interrupted by an app restart. Retry to run it again.'
    })
    expect(db.getMeeting('done')).toMatchObject({ status: 'ready', errorMessage: null })
    expect(db.markInterruptedMeetings()).toBe(0)
  })

  it('deletes a meeting and cascades its transcript', () => {
    create()
    db.saveTranscript('m1', [{ speaker: 'me', startMs: 0, endMs: 100, text: 'hi' }])
    db.deleteMeeting('m1')
    expect(db.getMeeting('m1')).toBeNull()
    expect(db.getTranscript('m1')).toEqual([])
  })
})

describe('transcripts', () => {
  it('round-trips segments in chronological order', () => {
    create()
    db.saveTranscript('m1', [
      { speaker: 'them', startMs: 500, endMs: 900, text: 'second' },
      { speaker: 'me', startMs: 0, endMs: 400, text: 'first' }
    ])
    expect(db.getTranscript('m1').map((s) => s.text)).toEqual(['first', 'second'])
  })

  it('replaces the transcript on re-save (retry case)', () => {
    create()
    db.saveTranscript('m1', [{ speaker: 'me', startMs: 0, endMs: 1, text: 'v1' }])
    db.saveTranscript('m1', [{ speaker: 'me', startMs: 0, endMs: 1, text: 'v2' }])
    expect(db.getTranscript('m1').map((s) => s.text)).toEqual(['v2'])
  })
})
