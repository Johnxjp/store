# Design: microphone switching mid-recording

## Problem

`MicRecorder.swift` binds the default input device once, at engine start. If
the user switches mics mid-meeting — picks a different device in Sound
settings, plugs in a USB mic, AirPods connect or disconnect — the running
engine does not follow. Depending on what changed, capture either continues
on the old device, stalls silently, or the engine stops entirely. Audio is
lost with no signal to the user, and nothing in the helper or the TS side
notices.

Two secondary problems make naive recovery wrong:

1. **Sample rate is baked into the WAV header at start.** A MacBook mic runs
   at 48 kHz; many USB mics and AirPods report 44.1 kHz (or 24/16 kHz in the
   hands-free profile). Appending new-device samples at a different rate to
   the old-rate WAV corrupts pitch and timing for everything after the
   switch.
2. **Merge alignment depends on continuous samples.** `merge.ts` maps a
   Whisper timestamp to wall-clock time as
   `epochAnchor + samplePosition / sampleRate`. Any capture gap during the
   switch shifts that mapping for the entire rest of the meeting — every
   "Me" segment after the switch lands early by the gap length, silently
   interleaving wrong against "Them".

## Current behavior (verified from the code)

- `MicRecorder.start()` reads `engine.inputNode.outputFormat(forBus: 0)`
  once, opens `WavWriter` with that sample rate, installs one tap, starts
  the engine. There is no `NotificationCenter` observer and no CoreAudio
  property listener anywhere in the helper (grep confirms zero hits for
  `NotificationCenter`, `PropertyListener`, `ConfigurationChange`).
- `stop()` is the only other code path. Nothing between start and stop can
  react to anything.
- The helper protocol has exactly three events: `started`, `stopped`,
  `error`. `recorder.ts` ignores `error` events after `started`, so even if
  the helper died mid-meeting the UI would show nothing.
- Live smoke test of `resources/bin/audio-capture` from this environment
  (2026-07-27): helper starts, emits `started` with `micSampleRate: 48000`
  (AEC enabled), both WAVs written and finalized on stdin EOF. Mic TCC works
  from a sandboxed shell here, contrary to the earlier lesson — useful for
  the testing plan below. Actual device-switch behavior was not exercised
  (would change machine audio state); expected behavior is derived from the
  API docs below.

## Detection: what macOS actually gives us

| Mechanism                                                                                                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.AVAudioEngineConfigurationChange` (NotificationCenter, per engine)                                                      | Posted when the engine's I/O unit observes a change to the input/output hardware's **channel count or sample rate**. Per Apple's docs, the engine **stops and uninitializes itself** before posting. The handler must not deallocate the engine synchronously; the standard pattern is: hop off the notification thread, re-read the (possibly changed) input format, reinstall taps with the new format, restart the engine.                                                                       |
| `kAudioHardwarePropertyDefaultInputDevice` listener (`AudioObjectAddPropertyListenerBlock` on `kAudioObjectSystemObject`) | Fires on **every** default-input change, including same-format switches that never trip the engine's format observer. Also fires when a device disappears and macOS falls back to another input (AirPods case), and when no input remains. This is plain CoreAudio, available regardless of AVFoundation state.                                                                                                                                                                                     |
| `inputNode` device binding                                                                                                | On macOS, `AVAudioInputNode` is fixed to the **system default input** (Apple binds it through a private aggregate device). It cannot be pointed at an arbitrary device without dropping to `kAudioOutputUnitProperty_CurrentDevice` on the underlying audio unit (TN2091). Crucially, it **rebinds to the current default on engine restart** — so "restart the engine" is also "follow the user's device choice".                                                                                  |
| Voice processing interaction                                                                                              | `setVoiceProcessingEnabled(true)` swaps the I/O unit for Apple's voice-processing unit and changes the node's I/O format (the code already reads the format after enabling it, per the comment in `MicRecorder.swift`). The setting lives on the node and survives an engine stop/start, but toggling it around configuration changes is a known crash area (Apple forums); the restart path should verify `isVoiceProcessingEnabled` and only call the setter if it is off, wrapped in `do/catch`. |

Neither mechanism alone is sufficient: a same-format device switch may not
post the configuration-change notification, and a sample-rate change on the
_same_ device (Audio MIDI Setup) never touches the default-device property.
Both feed the same recovery routine, so the union costs nothing extra.

Behavior while running is version-dependent and not worth relying on (the
engine may keep pulling the old device, or stall). The design below never
depends on it: any signal from either source triggers a full restart, which
deterministically rebinds to the current default input.

## Recovery design (recommended: restart + silence bridge, one WAV)

Keep **one mic WAV with the original header** for the whole meeting. On any
device/format signal, the helper runs one serialized recovery routine:

1. Remove the tap, stop the engine. (Note `samplesWritten` from `WavWriter` —
   it already tracks this.)
2. Re-read `inputNode.outputFormat(forBus: 0)` — the engine has rebound to
   the new default input. Verify voice processing is still enabled; try to
   re-enable if not; carry on without AEC if that throws (report it, don't
   die).
3. Install a new tap in the **new** format. If the new device rate differs
   from the WAV's rate, feed buffers through an `AVAudioConverter`
   (new format → 1ch float at the original WAV rate) before the existing
   `monoInt16` path. Same-rate switches skip the converter entirely.
4. Start the engine and wait for the first buffer (reuse the existing
   15 s first-buffer wait — AirPods hands-free profile takes seconds).
5. **Bridge the gap with silence.** Compute
   `expectedEpochMs = firstBufferEpochMs + samplesWritten / wavRate * 1000`
   and `gapMs = newFirstBufferEpochMs − expectedEpochMs`; prepend
   `gapMs × wavRate / 1000` zero samples before the first new-device buffer.
6. Emit a `micChanged` event (below) and resume normal appending.

Why this beats the alternative (rotate to `mic-2.wav` with a fresh epoch
anchor per segment): segment rotation is the "correct" general design but it
ripples everywhere — `session.json` becomes a segment list, `pipeline.ts`
transcribes N files, `merge.ts` takes N mic streams, `test-pipeline.ts` and
the retry path all change. The silence bridge confines the entire feature to
the helper plus event plumbing: the WAV that comes out is indistinguishable
from an uninterrupted recording with a quiet patch, so ffmpeg, whisper,
merge, session.json, and retry-from-disk all work **unchanged**. The gap is
also semantically honest — that audio genuinely does not exist — and the
pipeline already has defenses for silent stretches (silence gate, whisper
hallucination filters in `merge.ts`).

Cost of the silence bridge: gap accuracy is wall-clock based, the same
mechanism the epoch anchors already use, so error is a few tens of ms — well
under the 2 s coalescing granularity in `merge.ts`. Disk cost of a 15 s
AirPods gap is ~1.4 MB of zeros. Both are noise.

The sample-rate mismatch is fully absorbed by the converter in step 3;
`AVAudioConverter` streams, so an hour on the converted path is fine. The
WAV header never changes.

## Protocol changes

New NDJSON events from the helper (additions only; existing events
unchanged):

| Event        | Payload                                           | When                                                                                         |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `micChanged` | `deviceName`, `sampleRate`, `gapMs`, `aec` (bool) | Recovery completed and new-device audio is flowing. `gapMs` is the silence that was bridged. |
| `micLost`    | `message`                                         | No usable input device after a signal (none present, or first-buffer wait timed out).        |

`micLost` is not fatal: the helper keeps running — system audio capture is
untouched and the mic WAV simply stops growing (sample→time mapping stays
valid; there is just nothing after that point). The default-device listener
keeps firing, so when a device comes back the normal recovery routine runs
and emits `micChanged` with a correspondingly large `gapMs`.

## TS / UI handling

- `recorder.ts`: extend `HelperEvent`, and accept an
  `onStatus(event: MicStatusEvent)` callback in `start()` — today all events
  after `started` are dropped on the floor. Types go in `src/shared/types.ts`,
  channel name in `src/shared/ipc-channels.ts`, per convention.
- `pipeline.ts`/main: forward mic status over IPC to the renderer.
- Renderer: on `micChanged`, a transient status line on the recording screen
  ("Mic switched to _AirPods Pro_ — 3 s gap"); on `micLost`, a persistent
  warning ("Microphone lost — check your input device") that clears on the
  next `micChanged`. No new state machine — it is one nullable status field
  on the existing recording UI.
- Nothing is persisted: alignment survives by construction, so `session.json`
  and the DB schema are untouched.

## Edge cases

| Case                                     | Handling                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AirPods hands-free profile slow to start | Step 4's 15 s first-buffer wait (already sized for exactly this). The bridge in step 5 covers however long it took — gap length is measured, not assumed.                                               |
| Switch while voice processing enabled    | Full stop→reinstall→start cycle, never an in-place reconfigure (the known-crashy path). Verify/re-enable AEC in `do/catch`; on failure continue without AEC and set `aec: false` in `micChanged`.       |
| Device disappears, no replacement        | Recovery finds no valid input format (or times out) → `micLost`, keep recording system audio, wait for the next default-device event. No silence is written while lost; the bridge happens on recovery. |
| Multiple rapid switches                  | All signals funnel into one serial dispatch queue with a ~500 ms debounce; each recovery recomputes the gap from wall clock against `samplesWritten`, so consecutive restarts cannot accumulate error.  |
| Format change on the same device         | Caught by `.AVAudioEngineConfigurationChange` (the default-device listener never fires); same recovery routine.                                                                                         |
| Signal arrives during `stop()`           | The recovery queue checks a `stopping` flag before touching the engine; `stop()` sets it first.                                                                                                         |

## Testing plan

Headless (this environment — mic TCC verified working 2026-07-27):

- **WAV continuity invariant** — after any helper run, assert
  `dataBytes / (2 × wavRate) ≈ wall-clock elapsed` via ffprobe. This is the
  property the whole design exists to protect, and it is checkable on every
  run, switch or no switch. Add it to the helper smoke script.
- **Event protocol** — Vitest unit tests for `recorder.ts` parsing of
  `micChanged`/`micLost` lines using a stub script in place of the helper
  binary (pure logic; fits the "tests only where there's logic" convention).
- **Silence-bridge math** — the gap computation is a pure function of
  `(anchorEpoch, samplesWritten, wavRate, newEpoch)`; keep it in a small
  standalone Swift function so the smoke script can exercise it via a debug
  flag, or verify it indirectly through the continuity invariant.

Manual (real devices; scripted switches via `SwitchAudioSource` would work
but mutate machine audio state, so run attended):

| Scenario                                                    | Expect                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Speak → switch built-in ↔ USB (44.1 kHz) → speak            | Both passages transcribed, correct timestamps, `micChanged` with `gapMs` |
| AirPods connect mid-recording, then disconnect              | Two `micChanged` events, second recovery after hands-free delay          |
| Change device sample rate in Audio MIDI Setup mid-recording | Recovery via configuration-change path                                   |
| Unplug only mic (no fallback input)                         | `micLost`, system audio continues, recovery on replug                    |
| Toggle default input 5× in 3 s                              | One or two recoveries (debounced), continuity invariant holds            |
| Full meeting after a switch                                 | Merge alignment correct after the switch point; AEC still active         |

## Implementation estimate

| File                                               | Change                                                                  | ~LOC |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ---- |
| `native/AudioCapture/.../MicRecorder.swift`        | Listeners, serialized recovery, `AVAudioConverter` path, silence bridge | 150  |
| `native/AudioCapture/.../AudioCaptureMain.swift`   | Wire recovery callbacks → `Events.emit`                                 | 15   |
| `src/main/recorder.ts`                             | New event types, status callback                                        | 30   |
| `src/main/` (pipeline/index) + `src/shared/`       | IPC channel, payload types, forwarding                                  | 30   |
| `src/renderer/`                                    | Status line on recording screen                                         | 30   |
| Tests (Vitest stub-helper; smoke-script invariant) |                                                                         | 60   |

Roughly 300 LOC across 7–8 files, all additive; no pipeline, merge, or
storage changes. Builds with plain `swiftc` via `scripts/build-native.sh` as
today (no new frameworks beyond AVFoundation/CoreAudio already linked).

One honest tension with the "Swift helpers are dumb pipes" convention: the
recovery loop lives in the helper because the engine and the device events
only exist in-process. It stays a pipe in spirit — it makes no product
decisions, holds no meeting state, and only reports what happened; TS still
owns all orchestration and the user-facing response.
