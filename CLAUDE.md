# AI Meeting Notes

A local-only Granola clone for macOS: records meetings (system audio + microphone), transcribes with local Whisper, and generates notes with a local LLM via Ollama. Single user, single machine. **No audio or text ever leaves the laptop.**

## Commands

| Task                   | Command                                                    |
| ---------------------- | ---------------------------------------------------------- |
| Run the app (dev)      | `npm run dev` (watch mode: main-process edits hot-restart) |
| Tests                  | `npm test` (Vitest — logic only: merge, prompts, db)       |
| Typecheck              | `npm run typecheck`                                        |
| Lint / format          | `npm run lint` / `npm run format`                          |
| Rebuild Swift helpers  | `npm run build:native`                                     |
| Download whisper model | `npm run download-model`                                   |
| Headless pipeline test | `npx tsx scripts/test-pipeline.ts <recording-dir>`         |
| Headless summary test  | `npx tsx scripts/test-enhance.ts [model]`                  |

## Architecture

```
Renderer (React, pure UI) ←window.api (preload)→ Main (Node, all I/O)
                                                   ├─ spawn→ resources/bin/audio-capture (Swift)
                                                   ├─ spawn→ ffmpeg, whisper-cli (Homebrew)
                                                   ├─ HTTP → Ollama localhost:11434
                                                   └─ node:sqlite → data/db.sqlite
```

- `src/main/` — services: `recorder` (Swift helper lifecycle), `transcribe` (ffmpeg + whisper-cli), `merge` (pure timeline logic), `enhance` (prompt + Ollama), `pipeline` (orchestration + status), `db`, `config`, `paths`.
- `src/renderer/` — React UI. No Node access; everything goes through the typed `window.api` bridge in `src/preload/`.
- `native/AudioCapture/` — Swift helper. Captures mic (AVAudioEngine) + system audio (CoreAudio process tap) into two WAVs. Speaks NDJSON on stdout; stops on `stop\n` via stdin or EOF.
- All runtime data lives in `./data/` (gitignored): `db.sqlite`, `models/`, `recordings/<meetingId>/`, `config.json`.

### The pipeline (stop → notes)

Two WAVs → ffmpeg to 16 kHz mono → whisper-cli (JSON out, per stream) → merge → SQLite → Ollama summary. The merge (`src/main/merge.ts`, the most-tested code here) aligns the two streams via wall-clock epoch anchors captured at record start, labels mic segments "Me" and system segments "Them", filters Whisper hallucinations, and coalesces same-speaker runs.

## Key decisions (and why)

- **Two audio streams, not one.** Mic = "Me", system audio = "Them". Speaker attribution comes free from the hardware path instead of a diarization model. Trade-off: all other participants are one "Them".
- **Post-meeting batch transcription, no live streaming.** Massively simpler pipeline; V1 tracer-bullet decision. Audio is recorded to disk, whisper runs on Stop.
- **Swift helper over Chromium's loopback capture.** Electron's `getDisplayMedia` loopback on macOS is lossy (Opus) and has two unsynchronized clocks — fatal for merging. The helper gives clean PCM and one process to reason about permissions. (Granola itself uses Chromium's loopback, whose native layer also ends up on CoreAudio taps.)
- **CoreAudio process tap over ScreenCaptureKit for system audio** (macOS 14.2+). SCK requires attaching to a display, so macOS classifies it as *screen recording* and shows the purple indicator naming the responsible app (iTerm in dev). A `CATapDescription` mono global tap on an aggregate device delivers the same PCM under the "System Audio Recording Only" permission instead — no indicator.
- **`node:sqlite` over better-sqlite3.** Same synchronous API, ships inside Electron's Node (22.22+), zero native-module rebuild pain. Experimental flag warning is cosmetic.
- **Ollama model is config, not code.** `data/config.json` → `ollamaModel`, re-read on every summarize so you can edit + hit Retry without restarting.
- **Whisper large-v3-turbo via `whisper-cli`** (Homebrew) as a child process — no bindings, easy to swap. Model file in `data/models/` (1.6 GB, never committed).
- **WAVs are kept forever** (≈330 MB/hour). They're the retry safety net: any pipeline failure is re-runnable from disk (`session.json` beside the WAVs holds the epoch anchors).

## Lessons learned (read before touching related code)

- **SwiftPM is broken on this machine** (Command Line Tools manifest-lib/compiler mismatch → `PackageDescription` link errors). Helpers compile with plain `swiftc` in `scripts/build-native.sh`. SourceKit IDE diagnostics for the Swift files are false positives for the same reason.
- **ESM preload needs `sandbox: false`.** This package is `"type": "module"`, so the preload builds as `.mjs`; Electron's sandboxed renderers can't load ESM preloads. Symptom: black screen, `window.api` undefined.
- **`app.getAppPath()` is unreliable** — it changes with how Electron is launched. `paths.ts` derives the project root from the bundle location (`out/main/../..`) instead.
- **macOS TCC (permissions):** helpers spawned by Electron are attributed to the dev `Electron.app` (`com.github.Electron`). Mic prompt works out of the box; the system-audio tap needs a one-time grant under Screen & System Audio Recording → "System Audio Recording Only". From a sandboxed/CI shell there is no prompt — mic capture just fails (no first buffers).
- **Bluetooth mics are slow to start.** AirPods-class devices take seconds to switch into their hands-free input profile before AVAudioEngine delivers any buffers. The helper waits up to 15 s for first buffers (was 5 s → caused `timed out waiting for first audio buffers (mic: false)`).
- **Whisper hallucinates on silence** — famously "Thank you." / "Thanks for watching." (web-video training data). Each stream is silent ~half the meeting, so this is constant. Defenses in `merge.ts`: bracket-filler filter, exact-phrase blocklist, repeated-run filter. A recording with _no_ speech at all can still produce a fake transcript-and-summary — the audio-level silence gate exists for that.
- **Ollama model blobs can rot.** The original gpt-oss:20b blob was corrupt ("llama-server process has terminated: … failed to load model"); the fix is a full re-pull. `ollama pull` resumes partial downloads, so a retry loop survives flaky connections.
- **`timeout` does not exist in macOS shells** — use background-process + `kill` patterns in scripts.

## Roadmap state

Tracer-bullet versions, each fully working before the next: **V1** record→transcript ✅ · **V2** LLM summary + SQLite persistence ✅ · **V3** typed-notes-during-meeting + AI enhance (Granola's signature) + menu bar tray · **V4** calendar (EventKit) + meeting-start notifications · **V5** packaged .app. Full plan: `~/.claude/plans/we-re-going-to-try-hazy-nest.md`.

## Conventions

- TypeScript strict everywhere; Prettier (no semicolons, single quotes) + ESLint flat config.
- Tests only where there's logic (merge, prompts, db, config) — no UI/E2E harness.
- Swift helpers are dumb pipes: all state and orchestration stays in TypeScript.
- IPC channel names live in `src/shared/ipc-channels.ts`; payload types in `src/shared/types.ts`.
