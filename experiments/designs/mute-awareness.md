# Mute-state awareness

Design for handling the mute problem flagged by the Recall.ai system-audio
article: our helper records the raw microphone for the whole meeting,
regardless of the meeting app's mute button. A user who mutes themselves in
Zoom to have a private side conversation is still being recorded by us — a
consent surprise that breaks the app's whole privacy stance. The system
stream is unaffected (it is the remote feed and keeps flowing when the local
mic is muted).

## Problem

Zoom/Meet/Teams mute is **app-internal**: the app keeps pulling mic samples
from CoreAudio and simply stops transmitting them (that's how "you're talking
while muted" hints work). So while the user believes their mic is off:

- the OS-level mic stream keeps flowing (orange menu-bar dot stays on),
- our `MicRecorder` tap keeps receiving real audio,
- every word of the "private" side conversation lands in `mic.wav`, gets
  transcribed, labeled "Me", and summarized by the LLM.

Two questions: can we _detect_ the meeting app's mute and follow it, and if
not, what do we build instead?

## What macOS can and cannot tell us

Researched July 2026 against Apple's CoreAudio/AVFAudio docs and developer
forums. Summary: **another process's software mute is not observable through
any public macOS API.** The honest options are our own mute button or
UI-scraping hacks. Details:

| Signal                                               | What it actually is                                                                                                                    | Usable?                                                                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kAudioDevicePropertyMute`                           | Device-level (hardware) mute on the input device                                                                                       | No — meeting apps never touch it; their mute is internal to the app                                                                                              |
| `kAudioHardwarePropertyProcessInputMute` (macOS 14+) | Lets a process mute **its own** input; coreaudiod then feeds it silence                                                                | No for detection — per-process, not readable across processes. (Interesting for _implementing_ mute, see below)                                                  |
| `kAudioProcessPropertyIsRunningInput` (macOS 14+)    | Whether another process currently has live input IO                                                                                    | No — Zoom keeps input IO _running_ while muted (that is the whole problem); also reported not to fire listeners                                                  |
| `AVAudioApplication` input-mute APIs (macOS 14+)     | `isInputMuted` / `setInputMuteStateChangeHandler` — the AirPods-stem-press mute integration, for the app doing the call's own audio IO | No — again scoped to our own process; Zoom hasn't even adopted it (open feature request on their dev forum)                                                      |
| Menu-bar mic indicator                               | Reflects "some process has input IO running", not mute                                                                                 | No — stays lit while Zoom is muted                                                                                                                               |
| AppleScript / Accessibility UI scraping              | Poll Zoom's menu items ("Mute audio" vs "Unmute audio") every second; several community menu-bar apps do this                          | Technically yes for Zoom only — but fragile (breaks on UI updates), needs Accessibility permission, ~1 s latency, and covers neither Meet-in-a-browser nor Teams |

Conclusion: **there is no reliable signal.** Any design that claims to
"follow Zoom's mute" would be a Zoom-only UI-scraping hack that silently
fails on Meet and Teams — worse than nothing, because it would make a privacy
promise it can't keep. The design must not pretend otherwise.

## Recommended design: our own mute, silence written to disk

One primary design: **a mute toggle in our app that zeroes mic samples inside
the Swift helper while keeping the system stream recording.** It is the only
option fully in our control, it works identically for every meeting app, and
its privacy promise is verifiable from the bytes on disk. The AppleScript
Zoom-follower is rejected outright (fragile, Zoom-only, false promise); it
could be revisited later as a _convenience_ that presses our own mute button,
never as the guarantee.

Mechanism, chosen for the epoch-anchor invariant:

- **Write silence, don't pause writing.** The merge maps WAV sample position
  to wall-clock time via one epoch anchor per stream; a gap in the file would
  shift everything after it. Zeroed samples keep the position→time mapping
  exact, and the pipeline already has defenses for silent audio.
- **Zero in the tap callback, not by stopping the engine.** `AVAudioEngine`
  stays running with voice processing (AEC) enabled; the tap callback checks
  a `muted` flag and appends `[Int16](repeating: 0, ...)` of the same frame
  count instead of the converted samples. Stopping/restarting the engine is
  ruled out: Bluetooth mics take up to 15 s to deliver first buffers, and a
  restart would need a fresh epoch anchor.
- Alternatives for the zeroing itself —
  `AVAudioInputNode.isVoiceProcessingInputMuted` (mutes at the VP unit) or
  `kAudioHardwarePropertyProcessInputMute` (coreaudiod feeds the process
  silence) — were considered and rejected: the process-wide property risks
  also silencing the system-audio tap's IO in the same process, and both make
  the guarantee depend on OS behavior we'd have to verify per macOS release.
  Our own zeroing is one deterministic line we can test by inspecting the
  WAV. The helper stays a dumb pipe: it holds exactly one boolean; all state,
  range bookkeeping, and UI live in TypeScript.

On top of the zeroed audio, TypeScript records the muted **time ranges** and
the merge drops any mic segment overlapping them. This is defense in depth:
Whisper hallucinates on silence, and a hallucinated "Thank you." timestamped
inside a muted window would look exactly like the app recording while muted —
a broken promise even though it's fake.

### Interaction with AEC and the existing silence defenses

- **AEC:** voice processing keeps running while muted (its output is
  discarded), so on unmute it is already converged — no warm-up gap and no
  bleed burst. The minimal-ducking configuration is untouched.
- **Silence gate (`transcribe.ts`):** a meeting muted throughout produces an
  all-zeros `mic.wav` → peak −∞ dB → `isSilent` → the stream never reaches
  Whisper. Partially-muted files pass the gate (real speech peaks elsewhere),
  which is correct. The gain boost keys off the file's true peak (unmuted
  speech), so zeros are never boosted into anything.
- **Hallucination filters (`merge.ts`):** the bracket/blocklist/repeat
  filters catch most silence hallucinations inside muted spans; the new
  muted-range filter is the hard guarantee that catches novel ones.

## Protocol / IPC changes

**Helper stdin** (newline commands, joining the existing `stop`):

```
mute
unmute
```

Idempotent; the helper acks every command. `--start-muted` is accepted as a
spawn flag so a pre-set mute applies from the first buffer (see edge cases).

**Helper stdout** (NDJSON events, joining `started`/`stopped`/`error`):

```
{"event":"muted","epochMs":...}
{"event":"unmuted","epochMs":...}
```

`epochMs` is the helper's clock at the moment the flag flipped — the same
clock as the epoch anchors, so range boundaries and anchors are directly
comparable.

**`recorder.ts`:** `setMuted(muted: boolean): Promise<number>` writes the
command and resolves with the ack's `epochMs` (2 s timeout, mirroring the
stop timeout). `start()` gains an optional `startMuted` flag.

**`session.json`** (`pipeline.ts`), backwards compatible — old files simply
lack the field:

```json
{
  "micEpochMs": ...,
  "systemEpochMs": ...,
  "mutedRanges": [{ "startEpochMs": ..., "endEpochMs": ... | null }]
}
```

The main process (`ipc.ts` session state) owns the ranges and rewrites
`session.json` on **every** transition, not just at stop — that makes the
file crash-safe. `endEpochMs: null` means "muted until end of stream".

**IPC** (`ipc-channels.ts` / `types.ts` / preload):

- `recording:set-muted` — invoke, renderer → main, `(muted: boolean)`.
- `recording:mute-changed` — push, main → renderer, `{ muted: boolean }`;
  keeps the window (and the V3 tray, when it exists) in sync from one source
  of truth in main.
- `merge.ts`: `mergeTranscripts(mic, system, mutedRanges = [])` — ranges are
  converted from epoch ms to mic-stream-relative ms and any mic segment that
  intersects one is dropped (system segments untouched).

**UI:** a mic-mute toggle in `RecordBar.tsx` next to the Stop button —
mic icon, flipping to a struck-through mic plus a "Muted" label while active,
so the state is unmissable. The button is also shown (disabled-until-armed)
before recording starts so mute can be pre-set. V3's menu-bar tray gets the
same toggle wired to the same channels; nothing here blocks on it.

## Privacy semantics

What the user is promised when the button shows muted:

- **Mic samples are discarded inside the helper the moment they arrive.**
  Real samples while muted are never written to disk, never leave the helper
  process, and are unrecoverable — the WAV physically contains zeros for the
  muted span. This holds even if the app crashes, because the guarantee is
  in the write path, not in post-processing.
- **No mic text can appear inside a muted window.** Enforced twice: the audio
  is zeros, and the merge hard-drops mic segments overlapping recorded
  ranges (so even a Whisper hallucination can't fake speech there).
- **The system stream keeps recording.** Mute is "my side", not "the
  meeting" — the remote participants are still captured, exactly like the
  meeting app's own mute. The UI copy says so: "Mic muted — your side is not
  being recorded."
- **Transcript rendering: muted periods show nothing.** No `[muted]` marker.
  Mute is the absence of data, and absence rendering as absence is the
  promise kept; a marker would mean persisting ranges into the DB and the
  renderer for no functional gain. Ranges stay in `session.json`, a pipeline
  concern. Revisit if "why is my side missing here?" turns out to confuse in
  practice.

## Edge cases

- **Mute pressed before recording starts.** The renderer holds the desired
  state; `recording:start` passes it through as `--start-muted`, so zeros are
  written from the very first buffer — no few-hundred-ms leak while waiting
  to send a `mute` command after `started`. Buffers still flow (they're
  zeroed, not stopped), so the first-buffer epoch anchors work unchanged.
  Main opens a muted range at the mic anchor.
- **Mute active at stop.** `recording:stop` closes the open range at the stop
  epoch and writes `session.json` before the pipeline runs. The helper's stop
  path is unchanged — it finalizes a WAV whose tail is zeros.
- **Crash while muted.** The WAV tail is zeros — nothing leaked, regardless
  of any bookkeeping. `session.json` was rewritten at the mute transition, so
  it holds an open range (`endEpochMs: null`); the retry pipeline treats an
  open range as extending to end of stream. Belt and braces: even with a
  pre-mute-era `session.json`, the zeros alone mean the muted span yields no
  real speech.
- **Retry-from-disk reruns.** `mutedRanges` is read from `session.json`, so
  reruns filter identically and deterministically. Old recordings without the
  field get `[]` — behavior unchanged.
- **Rapid toggling / lost acks.** The helper acks every command with the
  resulting state; TypeScript ignores no-op transitions. If an ack doesn't
  arrive within 2 s (helper died), `setMuted` rejects and the existing
  recorder-failure path surfaces it — the UI must not show "muted" without an
  ack, since that would be an unkept promise.

## Testing plan

Unit tests (Vitest, logic only per repo convention):

- `merge.test.ts`: muted-range filter — mic segment fully inside / straddling
  a boundary / outside a range; system segments never dropped; epoch→relative
  conversion; open-ended range; empty ranges = today's behavior.
- `pipeline.test.ts` (or extend existing): `session.json` round-trip with
  ranges, backwards compat (missing field → `[]`), open-range close at stop.
- Range bookkeeping (transition list → ranges) extracted as a pure function
  and tested: mute/unmute pairs, double-mute no-op, unclosed final range.

Headless helper integration (script beside `scripts/test-pipeline.ts`; the
helper _can_ capture mic from this dev environment, verified 2026-07-27;
remember macOS has no `timeout` — background process + `kill`):

1. Spawn `audio-capture --dir <scratch>`; after `started`, play phrase A via
   `say` (~2 s), send `mute` and await the ack, play phrase B (~3 s), send
   `unmute`, play phrase C, send `stop`.
2. Assert on the WAVs with ffmpeg `volumedetect` over `-ss/-t` windows cut at
   the ack epochs: the muted window of `mic.wav` peaks at the floor
   (< −60 dB), the A/C windows have signal, and `system.wav` has signal
   throughout — B lands in the system stream but not the mic stream, which is
   exactly the promised behavior (`say` plays through the speakers, and AEC
   keeps speaker audio out of the mic even when unmuted, so assert mic
   windows via the muted-floor check, not via B's absence alone).
3. Run the pipeline over the directory with the recorded ranges: transcript
   contains A and C as "Me", nothing attributed to "Me" inside the muted
   window.

Manual sanity check in the dev app: mute mid-recording, confirm the button
state round-trips through main, and read the resulting transcript.

## Implementation estimate

| File                                      | Change                                                   | ~LOC |
| ----------------------------------------- | -------------------------------------------------------- | ---- |
| `native/.../MicRecorder.swift`            | `muted` flag (lock-protected), zero-fill in tap callback | 12   |
| `native/.../AudioCaptureMain.swift`       | parse `mute`/`unmute` lines, `--start-muted`, ack events | 25   |
| `src/main/recorder.ts`                    | `setMuted()` + ack plumbing, `startMuted` option         | 35   |
| `src/main/ipc.ts`                         | mute handler, range bookkeeping, session rewrite, push   | 30   |
| `src/main/pipeline.ts`                    | session shape, pass ranges to merge, open-range handling | 15   |
| `src/main/merge.ts`                       | muted-range filter                                       | 25   |
| `src/shared/ipc-channels.ts` + `types.ts` | two channels, `MutedRange`, session type                 | 12   |
| `src/preload/index.ts`                    | `setMuted`, `onMuteChanged`                              | 8    |
| `src/renderer/.../RecordBar.tsx` (+ icon) | toggle button, muted state, copy                         | 40   |
| Tests + headless script                   | units above + integration script                         | 150  |

Roughly **200 LOC of app code plus 150 of tests**, no new dependencies, no
new permissions (the mic grant already exists). Swift changes rebuild with
`npm run build:native` (plain `swiftc` — SwiftPM stays out of it).
