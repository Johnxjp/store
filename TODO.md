# TODO — state as of 15 Jul 2026

Where we are: **V1** (record→transcript) and **V2** (SQLite persistence + Ollama summary) done and committed. Since then, two more things landed:

- **Granola-style UI redesign.** Warm paper theme, serif titles, hidden-inset title bar. Home = sidebar (search filter, Home, Chat placeholder) + date-grouped note list, "+ New note" starts recording. Note view = full-bleed centered column with date/duration chips, Notes/Transcript tabs, and a floating capsule (level bars + timer + stop) while recording. Old full-screen RecordingView deleted. Verified by driving the built app with Playwright (`playwright-core` `_electron`) and inspecting screenshots.
- **System audio now via CoreAudio process tap, not ScreenCaptureKit.** No more purple "screen recording" indicator. Same approach Granola effectively uses (their Chromium loopback lands on `CATapDescription` on macOS 14.2+ — verified by inspecting their app bundle). Helper protocol/WAV output unchanged; swiftc target bumped to 14.2. Permission now lives under Screen & System Audio Recording → "System Audio Recording Only".

## In flight — silence gate (committed, tests missing)

`transcribe.ts` + `pipeline.ts`: streams whose mean volume is below −50 dB (ffmpeg `volumedetect`) are never sent to Whisper, and an empty merged transcript skips the LLM entirely (notes become "_No speech was detected_"). This fixes: recording nothing → Whisper hallucinates a transcript → LLM summarizes the hallucination. Observed working on the 14 Jul recordings.

Remaining: unit tests for `parseMeanVolumeDb`/`isSilent`; headless run against a silent WAV (`ffmpeg -f lavfi -i anullsrc=r=16000 -t 10 silent.wav`).

## Bugs

1. **Bluetooth mic records nothing.** Recording `64f283a3` (14 Jul 09:00): system.wav grew to 1.2 MB, mic.wav stayed 44 bytes (WAV header, zero samples) — the BT mic connected but AVAudioEngine never delivered audio, even with the 15 s first-buffer timeout. Test with the built-in MacBook mic to confirm it's BT-specific. Candidate fixes: auto-fallback to built-in mic when the selected input delivers nothing; live input-level meter in the recording view so a dead mic is visible immediately.

2. **Orphaned helper on main-process restart.** `electron-vite dev --watch` restarting the main process mid-recording orphans the helper (seen as "system audio stream stopped" under the old SCK capture; the failure mode under the new tap capture is untested). Fix: kill the helper child when the main process exits/restarts. Also: many orphan dirs in `data/recordings/` with no DB row, from starts that failed before `createMeeting` — worth a sweep/cleanup on app start.

3. **Record start/stop feels slow.** Start blocks on first audio buffers from _both_ streams (BT mic = seconds; SCShareableContent ≈ 1 s). Fix: return from `recording:start` immediately after spawning the helper, resolve anchors in the background, surface capture failure via a `meeting:updated` event (meeting → error state). Stop is ~1–2 s (SCK teardown) — acceptable.

## Improvements queued

4. **Pipeline diagram** — add a step-by-step flowchart (including both silence gates) to the explainer artifact: https://claude.ai/code/artifact/95251d87-6ab7-4b5f-bad3-b596c06c1317
5. **Chat view is a placeholder** — "chat over all notes" page exists in the sidebar but is intentionally blank until it gets a backend.

## Housekeeping

- **At home:** `ollama pull qwen3.6:35b` (resumes partial download), then set `data/config.json` → `"ollamaModel": "qwen3.6:35b"`. Currently it's llama3.2 (weak but working). The 14 Jul 08:43 meeting errored while config briefly pointed at qwen — Retry will fix it once the model exists. gpt-oss:20b blob on disk is corrupt — re-pull if wanted.
- Stray helper cleanup: `pkill -f audio-capture`.

## Then: roadmap

- **V3** — typed notes during meeting + LLM enhance blending them with transcript (Granola's signature), menu-bar tray icon, hide-to-tray.
- **V4** — calendar via EventKit Swift helper (needs Electron Info.plist patch for `NSCalendarsFullAccessUsageDescription` + re-sign in dev), today sidebar, meeting-start notifications with dedupe.
- **V5** — electron-builder packaged .app, setup screen for missing whisper/model/Ollama.

Full architecture, decisions, and hard-won lessons: `CLAUDE.md`. Original plan: `~/.claude/plans/we-re-going-to-try-hazy-nest.md`.
