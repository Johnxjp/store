# Pause and resume recording

Design for a pause/resume control on the record bar, with Stop beside it.
Increments 1 to 3 have landed. Increments 4 to 6, which keep paused time out of
the timeline, are the remaining work.

## Context

A meeting is one continuous capture today: press record, the Swift helper opens
the mic and the system-audio tap, and both run until Stop. There is no way to
take a private aside, step out of a call, or keep a long silence out of the
notes without ending the meeting and starting a new one.

Pause means "temporarily stop recording". A paused span is time the user
deliberately put outside the meeting, so nothing the user sees afterwards counts
it: not the transcript timestamps, not the duration on the note, not the timer
on the record bar. Mute would be a different feature, where the meeting keeps
running and one input goes quiet.

Behaviour we want:

- Recording still starts automatically when the note is created.
- Pause and resume, as many times as needed, within one meeting.
- A separate Stop button, present while running and while paused, which ends
  the meeting and runs the usual transcribe-and-summarise pipeline.
- Once summarised, a meeting cannot be restarted.
- Every duration the user sees is recorded time, with paused spans squeezed out.

## What the investigation found

The constraint that decides this design is in `src/main/merge.ts`:

```ts
const offset = stream.epochMs - recordingStartMs
// ...
startMs: s.fromMs + offset
```

`s.fromMs` is a position inside a WAV file. `epochMs` is the wall-clock time of
that WAV's first audio buffer. Adding them produces a correct meeting timeline
only because **one second of WAV always equals one second of wall clock**. The
mic and system streams share no clock, no markers, no sync signal beyond their
two start epochs. Everything downstream inherits that assumption: the live
chunker's `startMs`, the timestamps in the summary prompt, retry-from-disk.

The design question is therefore what happens to that invariant when part of
the recording stops being meeting time.

Three other findings shaped the result:

- `live.ts` already skips silent chunks (`isSilent(peakDb(chunk.pcm))`, with the
  −40 dB threshold in `transcribe.ts`). `peakDb` of an all-zero buffer returns
  `-Infinity`. Silence therefore costs no ffmpeg run and no transcription.
- Recording state lives only in main-process memory (`session` in `ipc.ts`). Any
  row still marked `recording` at startup is an orphan by definition, which is
  what `markInterruptedMeetings` relies on. Pause state in the database would
  weaken that.
- The Swift helpers are dumb pipes by convention: state and orchestration stay
  in TypeScript.

### What the hardware actually delivers

Four real captures with no pauses at all were measured against the checks this
feature was going to rely on, and two of those checks turned out to be wrong
about healthy recordings.

- Cross-stream end skew, mic against system: −254, −32, −113, −145 ms.
- Each mic WAV runs short against its own start anchor by 123 to 242 ms. The
  system stream sits the other way, at +12 to +22 ms.
- The offset is a fixed bias rather than clock drift. It does not grow with run
  length: −242 ms over a 12 s run, −123 ms over a 40 s one.

Tracked as issue #1, out of scope here. The leading suspect is that both
recorders discard the hardware timestamp and use `Date()` at callback-dispatch
time: the tap closure in `MicRecorder` ignores its `AVAudioTime` parameter, and
the IO proc in `SystemAudioRecorder` ignores both its `AudioTimeStamp` ones. A
wall-clock reading taken at dispatch carries thread scheduling and driver
latency, which is the shape of the error measured. `AudioCaptureMain` calling
`mic.stop()` before `await system.stop()` adds a smaller tail contribution.

This bias already shifts every "Me" timestamp in every transcript the app has
ever produced, so it is a known issue on its own terms rather than a regression
this feature introduces. Fixing it means touching the same capture code pause
just landed on, which is why it is deliberately separate.

A fifth capture exercised the feature itself: 10 s of audio, 20 s paused, 10 s
more. Both WAVs hold exact digital silence across the paused window with audio
either side, and the cross-stream skew stays constant instead of growing. That
is the zero-fill frame count confirmed empirically, which is the one thing about
mute-in-place that unit tests cannot reach.

The consequence for this document is in Verification: a ±100 ms cross-stream
tolerance fails on runs that are perfectly healthy, so it has to be ~300 ms.

## Targets

1. Pause keeps captured audio off disk; resume continues the same meeting.
2. Timestamps after a pause stay correct, with no drift between the two streams.
3. The transcript, the duration on the note and the record bar timer all measure
   recorded time.
4. Stop behaves identically whether the meeting is running or paused.
5. A crash or quit while paused recovers exactly as it does today, from the WAVs.
6. Nothing already on disk changes meaning. A recording with no pauses merges
   byte-identically to how it merges now.

## Design overview

Two halves. The capture side mutes in place and keeps the WAVs on wall clock.
The timeline side subtracts the paused spans from a recorded log of them.

**Mute in place.** The helper keeps both devices open. While paused, each
capture callback throws away the incoming buffer and appends the same number of
_zero_ samples to the WAV instead.

The WAV keeps growing at exactly real time, so the merge invariant survives
intact and the two streams stay locked to each other. The consequences are the
whole argument for this approach:

- `chunker.ts` and the database schema's existing columns change in no way at
  all.
- `live.ts` changes in no way either. Paused audio arrives as silent chunks and
  hits the existing silence gate, so a pause costs no transcription work.
- Retry-from-disk works from the WAVs plus `session.json`, which already sits
  beside them and now carries the pause log as well.
- Every stream-relative offset (chunk starts, word timings, WAV positions)
  keeps meaning what it means today. Only the final merge into meeting time
  changes.

**Pause intervals are recorded, never detected.** When the pause IPC handler
fires, main stamps `Date.now()`; resume stamps it again. The pair is stored on
the session and written to `session.json` beside the anchors, so it survives a
crash and a retry. Inferring the spans from the audio instead would be wrong:
the WAVs hold silence for natural lulls too, and a lull in the conversation is
real meeting time. Only a button press marks a span as outside the meeting.

**The collapse happens in `mergeTranscripts`**, which gains a required
`pauses: PauseInterval[]` parameter. Required rather than optional, because the
cache warmer in `ipc.ts` builds the same prompt during the meeting: a caller
that silently skipped the collapse would shift every timestamp at Stop and burn
the prefix cache that warming exists to fill. A compile error is the cheap way
to find that. `PauseInterval` is `{ fromEpochMs, toEpochMs }`, absolute epochs,
so `session.json` is self-describing and needs no anchor to interpret.

The arithmetic is one function, applied to each segment's start and end
independently:

```ts
function pausedBefore(absMs: number, pauses: PauseInterval[]): number {
  let total = 0
  for (const p of pauses) {
    if (absMs <= p.fromEpochMs) break
    total += Math.min(absMs, p.toEpochMs) - p.fromEpochMs
  }
  return total
}
```

The `Math.min` clamps a timestamp that lands inside a pause to that pause's
start instant, so collapsed times stay monotonic and nothing goes negative. The
`break` assumes the intervals are sorted ascending, which the session guarantees
by appending them in order.

**This is alignment-preserving by construction.** The subtraction comes from one
stream-agnostic event log, so mic and system receive the identical adjustment
and the collapse structurally cannot pull "Me" out of step with "Them". The
logged boundary does lag the actual mute by up to one buffer, ~85 ms on the mic
and ~10 ms on the tap, but that shifts everything after a pause uniformly by
under 100 ms. Contrast the rejected option of writing no bytes at all while
paused, where the same boundary timing bakes separately into each stream's byte
count with no way to correct it afterwards.

**Coalescing does not cross a pause boundary.** `coalesce` glues adjacent
same-speaker segments that sit within 2 s of each other, and the collapse can
make two segments adjacent that were half an hour apart in the meeting. Each
timeline segment therefore carries its `pausedBefore` value internally, and two
segments with different values stay in separate blocks. The field never reaches
`TranscriptSegment` or the database.

**Recorded time everywhere a number is shown.** `durationLabel` becomes
`recordingEndedAt - recordingStartedAt - pausedMs`. It is used on the home list
(`HomeView.tsx:86`) as well as in the detail view, so the total has to live on
the meeting row: a migration adds `paused_ms INTEGER NOT NULL DEFAULT 0`, and
the default is the correct value for every meeting recorded before this feature
existed. The pipeline's too-short gate reads the same column. The record bar
timer freezes while paused, so the number on screen during the meeting matches
the transcript that comes out of it.

### Where "keep the gap" went

The first version of this design kept paused time in the timeline, on the
grounds that the transcript should describe what happened in wall clock. That
reversed once the button's meaning was pinned down. Pause stops the recording,
and a recording's timeline is made of the parts that were recorded, so the gap
goes. Keeping it also meant a 40-minute paused meeting reading as 40 minutes
everywhere in the UI, which is the thing a user pauses to avoid.

The reversal leaves one honest oddity on disk: the WAVs still hold wall-clock
silence across a pause, and the transcript timestamps no longer agree with WAV
positions. `session.json` is what reconciles them, and it is why the pause log
is written there rather than only into the database.

### The option not taken

Stopping the helper on pause and spawning a fresh one per segment releases the
devices, so the mic indicator goes out and no disk is burned. It was rejected
because:

- Resume costs 2 to 5 seconds of dead air on Bluetooth (the helper allows up to
  15 s for first buffers), and speech in that window is lost with no signal to
  the user. Recording hardware varies per meeting here, so the worst case has to
  be assumed. This is what rules the option out.
- Every resume rebuilds the VPIO chain and the CoreAudio tap, which makes the
  unimplemented fix in `fix-audio-capture-teardown.md` a prerequisite rather
  than a nice-to-have.
- `live.ts` binds a file handle, a cursor and a chunker to one file, so segments
  would mean one transcriber per segment, a merged `snapshot()` for the warmer,
  and a `finish()` that awaits all of them. `session.json` would gain a segment
  list, `hasAudio` would change, and the replay harness assumes one directory.

Per-segment drift was the original headline argument against it. The
measurements above weaken that one: the per-run alignment error is a fixed bias
of a couple hundred milliseconds and does not accumulate, which is smaller than
the baseline error the app already carries on every "Me" timestamp. Resume
latency is the reason this option stays rejected.

Stitching segments back together with ffmpeg padding was also considered. It
buys nothing over normalising timestamps at the seam, and it breaks the live
path.

### Two costs this accepts

**The macOS mic indicator stays lit while paused.** The devices are open even
though nothing reaches disk. There is no way around that short of releasing
them. It gets handled with copy in the note body, not with architecture.

**Silence still costs disk**, at the usual ~330 MB/hour, and WAVs are kept
forever by design. A meeting left paused and forgotten keeps writing zeros. No
auto-stop timer is included; if forgotten pauses turn out to happen, that is a
separate change.

## Details

### Where paused state lives

In main-process memory, on the `Recorder` and the session. The renderer reads it
through `MeetingDetail`, the same way it already reads `hasAudio`:

- `meetingsGet` in `ipc.ts` adds
  `paused: session?.meetingId === id && session.recorder.isPaused`, plus
  `pausedAt` and `pausedMs` from the same live session.
- `App.tsx` calls `refresh()` after pause and resume, exactly as it does after
  rename, delete and retry, so the bar gets fresh numbers at the moment they
  change.

One source of truth. A React state flag in `App` would duplicate it and go wrong
after a renderer reload. A `paused` column would need its own migration, a change
to `markInterruptedMeetings`, and it would break the orphan-row rule that crash
recovery depends on. The `paused_ms` column is a different thing: a finished
total written at Stop, not live state.

### Helper protocol

`pause` and `resume` lines on stdin, beside the existing `stop`. No
acknowledgement events: the gate is local to the helper, takes effect within one
buffer (~10 ms), and there is nothing the main process could usefully do about a
failure. `Recorder.pause()` throws when there is no child, which covers a dead
helper. The stdin loop needs a labelled break so `stop` still exits the loop
rather than just the `switch`.

### The gate itself

While paused the real samples are never mixed down, never buffered and never
written. The conversion is skipped outright and a zero array of the same frame
count is appended:

```swift
if isPaused {
    writer?.append([Int16](repeating: 0, count: frames))
    return
}
```

The frame count must match the incoming buffer exactly. That is what keeps the
WAV advancing at real time, which is what keeps the two streams locked together.

### The pause log

The session holds `pauses: PauseInterval[]` and the epoch of the pause currently
open, if any. `session.json` is rewritten whenever an interval closes, which
means on every resume and on a Stop that happens while paused. Writing closed
intervals only keeps the file's shape simple: every entry has both ends, and a
reader needs no rule for a half-written one.

`SessionAnchors` gains `pauses?: PauseInterval[]`. The field is optional in the
type and defaults to `[]` on read, which is what makes every `session.json`
written before this feature still replay correctly.

The same total reaches the database once, at Stop: `setRecordingEnded` is
followed by `setPausedMs` on both the normal Stop path and in
`abortActiveRecording`. Everything the renderer and the too-short gate need is
then on the row, and nothing has to re-read `session.json` to show a duration.

### Duration and the record bar timer

`durationLabel` subtracts `meeting.pausedMs`. The record bar computes
`now - startedAt - pausedMs` while running and `pausedAt - startedAt - pausedMs`
while paused. The paused expression is constant, so the effect can drop its
one-second interval entirely while paused and the display simply holds. No
polling, and no chance of the timer and the transcript disagreeing.

### UI

The record bar is: level bars · timer · pause/play · stop. While paused the
level bars freeze and grey out, the timer holds, and the line in the note body
reads "Paused. The mic is muted and nothing is being recorded. macOS keeps its
microphone indicator lit because the mic stays open." That last sentence earns
its place: the indicator is the one thing on screen contradicting the rest, and
leaving it unexplained reads as a bug.

## Increments

### 1. Pause gate in the Swift helper (done)

Teach the helper to mute itself on command. Standalone and verifiable on its own
before any TypeScript exists.

Components: `native/AudioCapture/Sources/AudioCapture/`

Changes:

- `MicRecorder` and `SystemAudioRecorder` each gain a `paused` flag behind the
  existing `anchorLock`, plus `setPaused(_:)`. Both capture callbacks read the
  flag once under the lock and, when paused, append `[Int16](repeating: 0,
count: frames)` without running the mixdown.
- `AudioCaptureMain` handles `pause` and `resume` stdin lines; the read loop gets
  a label so `stop` breaks the loop.

Criteria: `npm run build:native` succeeds. Running the helper by hand and typing
`pause`, then `resume`, then `stop` produces a WAV whose duration equals the
wall-clock time of the run, with silence exactly across the paused window.

### 2. Pause and resume through main (done)

Components: `src/main/recorder.ts`, `src/main/ipc.ts`, `src/shared/`,
`src/preload/`

Changes:

- `Recorder` gains `pause()`, `resume()` and `isPaused`. Both are no-ops when
  already in the requested state and throw when not recording.
- Two IPC channels, `recording:pause` and `recording:resume`, each guarded by
  `if (!session) throw new Error('not recording')`.
- `MeetingDetail` gains `paused`, set in `meetingsGet` from the live session.
- Preload exposes `pauseRecording()` and `resumeRecording()`.

Criteria: `npm test`, `npm run typecheck` and `npm run lint` pass, including a
new `test/recorder.test.ts` that drives a stub helper script (see Verification).

### 3. Record bar controls (done)

Components: `src/renderer/src/components/RecordBar.tsx`, `icons.tsx`,
`styles.css`, `views/MeetingDetail.tsx`, `App.tsx`

Changes:

- `PauseIcon` and `PlayIcon` in `icons.tsx`, following the existing stroke attrs.
- `RecordBar` takes `paused`, `onPause` and `onResume`; renders the pause/play
  button before the stop button and freezes the level bars when paused.
- `MeetingDetail` passes `detail.paused` through and swaps the recording
  placeholder line for the paused one.
- `App` gains `pauseRecording` and `resumeRecording`, each calling `refresh()`.

Criteria: pause, resume and stop all work from the bar in `npm run dev`, and the
transcript from a paused meeting has no text from the paused window.

### 4. Record the pause intervals (done)

Nothing visible changes here. This increment only makes the spans durable, so
the timeline work in 5 and 6 has something to read.

Components: `src/main/ipc.ts`, `src/main/pipeline.ts`, `src/main/db.ts`,
`src/main/merge.ts`, `src/shared/types.ts`

Changes:

- `PauseInterval` in `merge.ts`, where it is consumed. `SessionAnchors` in
  `pipeline.ts` gains `pauses?: PauseInterval[]`.
- The session tracks the open pause epoch and the closed intervals. The pause
  handler stamps `Date.now()`; the resume handler closes the interval and
  rewrites `session.json`. Stop closes an open interval before writing.
- A migration appending
  `ALTER TABLE meetings ADD COLUMN paused_ms INTEGER NOT NULL DEFAULT 0;`
  to `MIGRATIONS`, plus `db.setPausedMs`, `pausedMs` on `Meeting`, and
  `pausedAt` / `pausedMs` on `MeetingDetail`.
- Stop and `abortActiveRecording` write the total to the row.

Criteria: `npm test`, `npm run typecheck`, `npm run lint`. A DB test asserts the
migration leaves existing rows at 0 and that the round trip preserves the value.
A pause, resume, pause, resume, Stop recording leaves a `session.json` with two
closed intervals whose lengths match the button presses within a second, and a
`paused_ms` equal to their sum.

### 5. Collapse paused time in the merge (done)

Components: `src/main/merge.ts`, `src/main/pipeline.ts`, `src/main/ipc.ts`,
`test/merge.test.ts`

Changes:

- `pausedBefore` as above, applied to each segment's absolute start and end.
- `mergeTranscripts` takes `pauses` as a third required parameter. Both call
  sites pass it: the pipeline from `anchors.pauses ?? []`, `buildWarmPrompt`
  from the live session.
- Timeline segments carry their start-side `pausedBefore` value so `coalesce`
  can refuse to glue across a pause. The field is stripped on output.

Criteria: `npm test` with new merge cases covering a segment before, inside and
after a pause; two pauses; a segment that starts before a pause and ends inside
it; same-speaker segments either side of a pause staying separate; and an empty
`pauses` array reproducing today's output exactly.

### 6. Recorded time in the UI and the gates (done)

Components: `src/renderer/src/lib/format.ts`,
`src/renderer/src/components/RecordBar.tsx`,
`src/renderer/src/views/MeetingDetail.tsx`, `src/main/pipeline.ts`

Changes:

- `durationLabel` subtracts `meeting.pausedMs`.
- `RecordBar` takes `pausedAt` and `pausedMs` and freezes while paused.
- The too-short gate subtracts `meeting.pausedMs` from the wall-clock span. The
  row is already loaded at the top of `runPipeline`, so this is one line.

Criteria: `npm test`, `npm run typecheck`, `npm run lint`. A recording of 10 s of
speech, a two-minute pause, then Stop, gets "_Transcript too short to generate a
summary._" rather than an invented summary, shows "Under a minute" on the home
list, and showed a frozen timer throughout the pause.

## Verification

There are four ways this design can actually break. Every check below targets
one of them:

- **A. The WAV stops tracking wall clock**, because the zero-fill appends the
  wrong number of frames. Silent, cumulative, and it slides the two streams
  apart until speaker labels go wrong.
- **B. Audio reaches disk during a pause.** The whole promise of the feature.
- **C. The pause log is wrong or missing**, so the collapse removes the wrong
  span, or none.
- **D. The collapse itself is wrong**: times go backwards, the two streams get
  different adjustments, or blocks glue together across a pause.

### Level 0 — no hardware needed

`npm run build:native`, `npm run typecheck`, `npm run lint`, `npm test`, plus
three tests that carry real weight:

- `test/recorder.test.ts`. A stub helper script written to a temp dir emits a
  `started` event and appends every stdin line to a file. Asserts that `pause()`
  and `resume()` write the right lines, that `isPaused` tracks, that a repeated
  pause is a no-op, that pausing with no child throws, and that `stop()` still
  works after a pause. No microphone involved, so CI keeps it honest.
- `test/merge.test.ts` (extend). The cases listed in increment 5. This is D
  proven directly, and the two-stream case is the one that matters most: mic and
  system segments either side of the same pause must shift by the same amount.
- `test/live.test.ts` (extend). Push a tone chunk, then an all-zero chunk, then
  another tone chunk. Assert `transcribeWav` is called only for the tone chunks,
  **and that the third chunk's segment offsets still include the skipped chunk's
  duration.** Live offsets stay in WAV time; the collapse is the merge's job
  alone, and this pins that boundary.

### Level 1 — the helper alone, with real devices

Catches A and B, the two that unit tests cannot reach. Worth its own harness at
`scripts/test-pause-capture.ts`, matching the existing script conventions:
spawn `resources/bin/audio-capture` into a temp dir, wait, send `pause`, run
`afplay` on a loop through the paused window, send `resume`, wait, send `stop`.
Then assert:

1. Each WAV's `ffprobe` duration equals the wall-clock length of the run, within
   ~300 ms. This is the drift check. Measure the run from the moment `stop` is
   written rather than from helper exit: teardown adds a roughly constant
   145 ms that has nothing to do with the audio.
2. The two WAVs agree with each other within **~300 ms**, not the ±100 ms this
   document first specified. Measured cross-stream end skew on four clean
   captures was −254, −32, −113 and −145 ms, so a ±100 ms gate fails on healthy
   runs. The bias is fixed rather than accumulating, so the wide tolerance still
   catches a proportional zero-fill error, which is the failure the check exists
   for.
3. Peak level across the paused window sits at the 16-bit floor (~−91 dB, which
   `transcribe.ts` already treats as a dead stream) on both streams.
4. Peak level outside the paused window does not.

**Use a two-minute pause, not a five-second one.** A proportional frame-count
error is invisible at five seconds. The `afplay` loop makes the system-audio
gate fully automatic; the mic gate needs a person talking, so that half stays
manual.

This level has been run. A 10 s / 20 s paused / 10 s capture showed exact
digital silence across the paused window on both streams, audio either side, and
constant rather than growing skew.

### Level 2 — one real meeting through the app

Tests prove the code runs. Only a real recording proves it is right.

1. `npm run dev`, start a meeting, say a sentence.
2. Pause. Say something that must not appear, and play audio through the
   speakers that must not appear either. Watch the timer hold.
3. Resume, say a second sentence, Stop.
4. The transcript holds both sentences and nothing from the paused window, the
   two sentences sit close together in the timeline with the pause squeezed out,
   the last timestamp is close to the recorded length rather than the wall-clock
   one, the duration on the home list matches, and the Me/Them labels are right.

The two sentences must also stay in separate blocks even though both are "Me"
and the collapse put them seconds apart. That is the coalesce boundary, checked
on real output.

### Level 3 — both transcription paths, from that one recording

The live path and the batch path handle a pause differently enough to need
separate proof, and batch is what every Retry uses. Recording twice is
unnecessary: replay the Level 2 directory through both harnesses.

```
npx tsx scripts/test-pipeline.ts <recording-dir>       # batch path
npx tsx scripts/test-live-pipeline.ts <recording-dir>  # live path
```

Both transcripts should place the two sentences at the same collapsed times.
Both read the same `session.json`, so a disagreement means one path is not
passing the pauses through.

### Level 4 — state machine and recovery

Each case below is described in Failure modes; this is the list to actually
exercise:

- Pause, then Stop. Summarises normally, with `paused_ms` on the row.
- Pause, then quit the app. WAVs finalise, the row goes to `error`, and Retry
  reproduces the same collapsed transcript.
- Pause, then kill the main process, so `markInterruptedMeetings` sweeps it.
- Paused for the whole meeting. Lands on "No speech was detected".
- Double pause and double resume are no-ops, and neither logs an interval.
- After summarising there is no way back: the bar is gone and the IPC throws.

### Level 5 — confirming the accepted costs are real

Watch the recording directory grow during a long pause, which is the
~330 MB/hour bill in **Two costs this accepts** made visible. Confirm the mic
indicator does stay lit, so the copy in the note body is telling the truth.

### Who can run what

Level 1 runs from a normal terminal here: the shell holds the mic grant, and the
harness has been run against real devices. An earlier version of this document
claimed otherwise. A sandboxed shell is still the exception, where mic capture
fails under TCC with no prompt (see CLAUDE.md), so a Level 1 run from there
proves nothing. Level 2 needs the app and a person, being a UI flow with speech
in it.

## Failure modes

- **Quit while paused.** `abortActiveRecording` writes `stop` as it does today;
  the helper is sitting in the same read loop, finalises the WAVs, and the
  meeting goes to `error` for Retry. It closes the open interval first, so the
  pause log and `paused_ms` are both complete.
- **Crash while paused.** `markInterruptedMeetings` sweeps the row to `error`.
  The interval that was open is never closed, so it never reaches
  `session.json` and the trailing silence is not collapsed on Retry. Harmless in
  practice: an unclosed pause runs to the end of the recording, so no segments
  follow it and no timestamp moves. The row's `paused_ms` is also still 0 in this
  case, so the too-short gate measures wall clock for that one meeting. The
  transcript itself is correct either way.
- **Crash while running, after earlier pauses.** Those intervals are already
  closed in `session.json`, so Retry collapses them normally.
- **Paused for the whole meeting.** Both WAVs are entirely silent, live skips
  every chunk, merge yields nothing, and the existing second gate writes "_No
  speech was detected in this recording._" Already handled.
- **Pause during capture spin-up.** Unreachable from the UI: the bar only
  renders once `recordingStartedAt` is set. The IPC guard covers it anyway, and
  a line written early would simply sit in the pipe until the helper's read loop
  starts.
- **Pause longer than 15 minutes.** `warm.ts` sends `keep_alive: 15m`, so Ollama
  may unload the model during a long pause and the first warm after resume pays
  a reload. Accepted: holding the GPU for a meeting that may never resume is
  worse.
- **A warm sent mid-pause can shift one timestamp at Stop.** A chunk straddling
  the pause boundary transcribes during the pause, and the logged pause start
  lags the actual mute by up to one buffer, so a word can land just inside the
  pause. At warm time that pause is still open and absent from the log, so the
  word reads uncollapsed; at Stop the closed interval clamps it to the pause
  start. Timestamps render to the second, so an ~85 ms shift changes the prompt
  only when it crosses a second boundary, and only from that line onward. The
  cost is a partial prefill rather than a cold one, which is why this is
  recorded rather than engineered around.
- **Chunk straddling a pause boundary.** Contains real speech plus silence, so
  `peakDb` sees the speech and it transcribes normally. Words inside the paused
  part of that chunk are silence, so there are none; a word whose timing lands
  inside the pause clamps to the pause start and stays in order.
