# AI Meeting Notes

A local-only Granola clone for macOS: records meetings (system audio + microphone), transcribes with local parakeet (CoreML), and generates notes with a local LLM via Ollama. Single user, single machine. **No audio or text ever leaves the laptop.**

## Commands

| Task                   | Command                                                    |
| ---------------------- | ---------------------------------------------------------- |
| Run the app (dev)      | `npm run dev` (watch mode: main-process edits hot-restart) |
| Tests                  | `npm test` (Vitest — logic only: merge, prompts, db)       |
| Typecheck              | `npm run typecheck`                                        |
| Lint / format          | `npm run lint` / `npm run format`                          |
| Rebuild Swift helpers  | `npm run build:native`                                     |
| Headless pipeline test | `npx tsx scripts/test-pipeline.ts <recording-dir>`         |
| Headless summary test  | `npx tsx scripts/test-enhance.ts [model]`                  |

## Architecture

```
Renderer (React, pure UI) ←window.api (preload)→ Main (Node, all I/O)
                                                   ├─ spawn→ resources/bin/audio-capture (Swift)
                                                   ├─ spawn→ resources/bin/fluid-transcribe (Swift)
                                                   ├─ spawn→ ffmpeg (Homebrew)
                                                   ├─ HTTP → Ollama localhost:11434
                                                   └─ node:sqlite → data/db.sqlite
```

- `src/main/` — services: `recorder` (Swift helper lifecycle), `transcribe` (ffmpeg + fluid-transcribe), `merge` (pure timeline logic), `enhance` (prompt + Ollama), `pipeline` (orchestration + status), `db`, `config`, `paths`.
- `src/renderer/` — React UI. No Node access; everything goes through the typed `window.api` bridge in `src/preload/`.
- `native/AudioCapture/` — Swift helper. Captures mic (AVAudioEngine) + system audio (CoreAudio process tap) into two WAVs. Speaks NDJSON on stdout; stops on `stop\n` via stdin or EOF.
- `native/FluidTranscribe/` — Swift helper. Transcribes one WAV with parakeet v2 via FluidAudio CoreML, writes word-level timings as JSON, exits. Compiled against a pinned FluidAudio checkout auto-cloned into `native/vendor/FluidAudio` (gitignored) by `build-native.sh`.
- All runtime data lives in `./data/` (gitignored): `db.sqlite`, `models/`, `recordings/<meetingId>/`, `config.json`.

### The pipeline (stop → notes)

Two WAVs → ffmpeg to 16 kHz mono → fluid-transcribe (word-timing JSON, per stream) → sentence assembly (`wordsToSegments`) → merge → SQLite → Ollama summary. The merge (`src/main/merge.ts`, the most-tested code here) aligns the two streams via wall-clock epoch anchors captured at record start, labels mic segments "Me" and system segments "Them", filters ASR hallucinations, and coalesces same-speaker runs.

## Key decisions (and why)

- **Two audio streams, not one.** Mic = "Me", system audio = "Them". Speaker attribution comes free from the hardware path instead of a diarization model. Trade-off: all other participants are one "Them".
- **Post-meeting batch transcription, no live streaming.** Massively simpler pipeline; V1 tracer-bullet decision. Audio is recorded to disk, transcription runs on Stop (at ~280× realtime the wait is seconds even for hour-long meetings).
- **Swift helper over Chromium's loopback capture.** Electron's `getDisplayMedia` loopback on macOS is lossy (Opus) and has two unsynchronized clocks — fatal for merging. The helper gives clean PCM and one process to reason about permissions. (Granola itself uses Chromium's loopback, whose native layer also ends up on CoreAudio taps.)
- **CoreAudio process tap over ScreenCaptureKit for system audio** (macOS 14.2+). SCK requires attaching to a display, so macOS classifies it as _screen recording_ and shows the purple indicator naming the responsible app (iTerm in dev). A `CATapDescription` mono global tap on an aggregate device delivers the same PCM under the "System Audio Recording Only" permission instead — no indicator.
- **Apple voice processing (AEC) on the mic.** `setVoiceProcessingEnabled(true)` in `MicRecorder` — the raw input node records everything the speakers play, so without AEC the far side appears twice in the transcript (once per stream, mislabeled "Me"). Other-audio ducking is set to minimum because the system recorder captures that same audio. Analysis and A/B verification: `experiments/README.md` §3–4.
- **`node:sqlite` over better-sqlite3.** Same synchronous API, ships inside Electron's Node (22.22+), zero native-module rebuild pain. Experimental flag warning is cosmetic.
- **Ollama settings are config, not code.** `data/config.json` → `ollamaModel`, `ollamaUrl`, `numCtx`, `maxTranscriptChars`, re-read on every summarize so you can edit + hit Retry without restarting.
- **Parakeet v2 (CoreML/ANE via FluidAudio) over whisper large-v3-turbo.** Better accuracy on our audio (9.9% vs 13.1% WER, fillers cut), ~12× faster (~280× realtime), no hallucination on silence, and the GPU stays free for Ollama; benchmarks in `experiments/README.md` §5. The `fluid-transcribe` helper emits word timings; sentence segments are assembled in `transcribe.ts` (v2 punctuates, so sentence ends are detectable). Models auto-download to `data/models/fluidaudio/` (~450 MB, never committed) on first run. English-only — acceptable for now. Residual quirk: occasional duplicated-word artifacts at chunk seams ("not not b badad"), part of the measured WER.
- **WAVs are kept forever** (≈330 MB/hour). They're the retry safety net: any pipeline failure is re-runnable from disk (`session.json` beside the WAVs holds the epoch anchors).
- **Stale-session recovery over persisted recording state.** The active recording session lives only in main-process memory (`session` in `ipc.ts`), so any crash/restart — including dev watch-mode hot-restarts — orphans DB rows stuck in `recording`/`processing`, which the UI renders as a fake live recording that can't be stopped or deleted. Two layers handle it: a `before-quit` hook stops the helper (WAVs finalize) and marks the meeting `error` (the pipeline is too slow to run during quit), and `markInterruptedMeetings()` at startup sweeps any leftover `recording`/`processing` rows to `error` → Retry. Stale meetings are marked, never auto-deleted — their WAVs may hold real audio. Retry resumes rather than restarts: a stored transcript is always complete (written only after merge), so the pipeline skips straight to summarization when one exists. The error card's button says what will happen ("Generate summary" / "Generate transcript and summary"); with no transcript and no WAVs on disk it shows a capture-failed message instead. _Might revisit:_ auto-running the pipeline at next launch instead of requiring a manual Retry, or persisting session state so an in-flight recording could survive a main-process restart.

## Lessons learned (read before touching related code)

- **SwiftPM is broken on this machine** (Command Line Tools manifest-lib/compiler mismatch → `PackageDescription` link errors). Helpers compile with plain `swiftc` in `scripts/build-native.sh`. SourceKit IDE diagnostics for the Swift files are false positives for the same reason.
- **ESM preload needs `sandbox: false`.** This package is `"type": "module"`, so the preload builds as `.mjs`; Electron's sandboxed renderers can't load ESM preloads. Symptom: black screen, `window.api` undefined.
- **`app.getAppPath()` is unreliable** — it changes with how Electron is launched. `paths.ts` derives the project root from the bundle location (`out/main/../..`) instead.
- **macOS TCC (permissions):** helpers spawned by Electron are attributed to the dev `Electron.app` (`com.github.Electron`). Mic prompt works out of the box; the system-audio tap needs a one-time grant under Screen & System Audio Recording → "System Audio Recording Only". From a sandboxed/CI shell there is no prompt — mic capture just fails (no first buffers).
- **Bluetooth mics are slow to start.** AirPods-class devices take seconds to switch into their hands-free input profile before AVAudioEngine delivers any buffers. The helper waits up to 15 s for first buffers (was 5 s → caused `timed out waiting for first audio buffers (mic: false)`).
- **Whisper hallucinates on silence** — famously "Thank you." / "Thanks for watching." (web-video training data). Each stream is silent ~half the meeting, so under whisper this was constant. Parakeet doesn't do this, but the defenses in `merge.ts` (bracket-filler filter, exact-phrase blocklist, repeated-run filter) are kept as cheap insurance, and the audio-level silence gate still skips dead streams entirely.
- **Ollama model blobs can rot.** The original gpt-oss:20b blob was corrupt ("llama-server process has terminated: … failed to load model"); the fix is a full re-pull. `ollama pull` resumes partial downloads, so a retry loop survives flaky connections.
- **`timeout` does not exist in macOS shells** — use background-process + `kill` patterns in scripts.

## Roadmap state

Tracer-bullet versions, each fully working before the next: **V1** record→transcript ✅ · **V2** LLM summary + SQLite persistence ✅ · **V3** typed-notes-during-meeting + AI enhance (Granola's signature) + menu bar tray · **V4** calendar (EventKit) + meeting-start notifications · **V5** packaged .app. Full plan: `~/.claude/plans/we-re-going-to-try-hazy-nest.md`.

## Conventions

- TypeScript strict everywhere; Prettier (no semicolons, single quotes) + ESLint flat config.
- Tests only where there's logic (merge, prompts, db, config) — no UI/E2E harness.
- Swift helpers are dumb pipes: all state and orchestration stays in TypeScript.
- IPC channel names live in `src/shared/ipc-channels.ts`; payload types in `src/shared/types.ts`.
