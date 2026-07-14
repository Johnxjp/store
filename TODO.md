# TODO — state as of 14 Jul 2026

V1 (record→transcript) and V2 (SQLite persistence + Ollama summary) are done and committed. This file is the pick-up-here list.

## In flight — silence gate (code written, NOT verified)

Uncommitted-at-time-of-writing changes in `transcribe.ts` + `pipeline.ts`: streams whose mean volume is below −50 dB (ffmpeg `volumedetect`) are never sent to Whisper, and an empty merged transcript skips the LLM entirely (notes become "_No speech was detected_"). This fixes: recording nothing → Whisper hallucinates a transcript → LLM summarizes the hallucination.

Remaining: unit tests for `parseMeanVolumeDb`/`isSilent`; headless run against a silent WAV (`ffmpeg -f lavfi -i anullsrc=r=16000 -t 10 silent.wav`); then commit.

## Bugs

1. **Bluetooth mic records nothing.** Recording `64f283a3` (14 Jul 09:00): system.wav grew to 1.2 MB, mic.wav stayed 44 bytes (WAV header, zero samples) — the BT mic connected but AVAudioEngine never delivered audio, even with the 15 s first-buffer timeout. Test with the built-in MacBook mic to confirm it's BT-specific. Candidate fixes: auto-fallback to built-in mic when the selected input delivers nothing; live input-level meter in the recording view so a dead mic is visible immediately.

2. **`recording:start` → "system audio stream stopped: Failed during stream due to application connection being interrupted".** ScreenCaptureKit stream died at start. Probable cause: `electron-vite dev --watch` restarted the main process mid-recording and orphaned a helper whose SCK session went stale. Fixes: kill the helper child when the main process exits/restarts; retry SCStream start once on this error; re-check the Screen & System Audio Recording grant.

3. **Record start/stop feels slow.** Start blocks on first audio buffers from _both_ streams (BT mic = seconds; SCShareableContent ≈ 1 s). Fix: return from `recording:start` immediately after spawning the helper, resolve anchors in the background, surface capture failure via a `meeting:updated` event (meeting → error state). Stop is ~1–2 s (SCK teardown) — acceptable.

## Improvements queued

4. **UI redesign** — current dark theme is utilitarian; do a proper design pass (typography, palette, layout) on sidebar/detail/recording views.
5. **Pipeline diagram** — add a step-by-step flowchart (including both silence gates) to the explainer artifact: https://claude.ai/code/artifact/95251d87-6ab7-4b5f-bad3-b596c06c1317

## Housekeeping

- **At home:** `ollama pull qwen3.6:35b` (resumes partial download), then set `data/config.json` → `"ollamaModel": "qwen3.6:35b"`. Until then it's llama3.2 (weak but working). gpt-oss:20b blob on disk is corrupt — re-pull if wanted.
- FYI: the macOS purple "screen captured" indicator during recordings is ScreenCaptureKit (used for system audio) — expected. Stray helper cleanup: `pkill -f audio-capture`.

## Then: roadmap

- **V3** — typed notes during meeting + LLM enhance blending them with transcript (Granola's signature), menu-bar tray icon, hide-to-tray.
- **V4** — calendar via EventKit Swift helper (needs Electron Info.plist patch for `NSCalendarsFullAccessUsageDescription` + re-sign in dev), today sidebar, meeting-start notifications with dedupe.
- **V5** — electron-builder packaged .app, setup screen for missing whisper/model/Ollama.

Full architecture, decisions, and hard-won lessons: `CLAUDE.md`. Original plan: `~/.claude/plans/we-re-going-to-try-hazy-nest.md`.
