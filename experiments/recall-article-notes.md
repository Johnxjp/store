# Notes: Recall.ai "How to get access to system audio" vs this project

Source: https://www.recall.ai/blog/how-to-get-access-to-system-audio
(read 2026-07-27). The article surveys macOS system-audio capture approaches
and the surrounding problems. Cross-reference against our architecture.

## Components we have considered (and where we landed)

| Article component                                | Our status                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ScreenCaptureKit**                             | Considered, rejected (CLAUDE.md): requires attaching to a display, so macOS classifies it as screen recording — purple indicator naming the app. Article's caveat that audio is "tied to a window or capture session" matches.                                                                                                          |
| **Electron desktopCapturer / Chromium loopback** | Considered, rejected: lossy Opus and two unsynchronized clocks, fatal for our two-stream merge. (Granola uses this path.)                                                                                                                                                                                                               |
| **Core Audio taps**                              | **Chosen** for system audio: `CATapDescription` mono global tap on an aggregate device, macOS 14.2+, "System Audio Recording Only" permission, no indicator. Article's warning about sparse documentation matched our experience.                                                                                                       |
| **AVAudioEngine**                                | **Chosen** for mic. Article's point that it does no system audio is exactly why we pair it with the tap — one API per stream, one Swift helper.                                                                                                                                                                                         |
| **Echo cancellation**                            | The article calls this the critical issue, and it was: see experiments/README.md §3–4. Live: `setVoiceProcessingEnabled(true)` (Apple AEC) now in MicRecorder. Offline: NLMS repair gets −12 dB (partial). Backstop: merge-time text dedup (planned). Article's "test AEC with your actual pipeline" advice is effectively what §4 did. |
| **Stream synchronization**                       | Considered from V1: wall-clock epoch anchors captured at first buffer of each stream, merge aligns on them (`session.json`, `merge.ts`).                                                                                                                                                                                                |
| **Speaker attribution**                          | Considered from V1: hardware-path attribution (mic = Me, system = Them) instead of a diarization model. Known trade-off: all remote participants are one "Them".                                                                                                                                                                        |
| **Volume consistency**                           | Considered: peak-based silence gate + gain boost to −3 dB peak before Whisper (`transcribe.ts`). Apple AEC's AGC now also helps the quiet-mic problem.                                                                                                                                                                                  |
| **Real-time storage / crash safety**             | Considered: WAVs stream to disk during the meeting and are kept forever; any pipeline failure is re-runnable from disk. Streaming transcription (experiments §2) extends this to incremental transcripts.                                                                                                                               |
| **Automatic meeting detection**                  | Considered, deferred: roadmap V4 (EventKit calendar + meeting-start notifications).                                                                                                                                                                                                                                                     |
| **Resource optimization**                        | Partially considered: batch post-meeting transcription was the V1 choice; the streaming prototype spreads the cost across the meeting but needs a resident model before app integration.                                                                                                                                                |
| **Windows (WASAPI)**                             | Out of scope — single user, single machine, macOS only.                                                                                                                                                                                                                                                                                 |

## Gaps the article flags that we have NOT addressed

- **Mic switching mid-meeting.** The helper binds the default input at start;
  if the user switches mics (or AirPods hand off) mid-recording, we likely
  lose audio silently. No route-change handling exists.
- **Non-isolated system audio.** Our global tap records everything the Mac
  plays — notifications, music, other apps — not just the meeting. That
  audio reaches Whisper and can pollute the transcript/summary.
- **Mute-state awareness.** We record the mic continuously regardless of the
  meeting app's mute state. The article's point: users expect muted = not
  recorded. We have no mute detection.
- **Headphones vs speakers detection.** Article suggests toggling AEC by
  output device. Likely a non-issue for us — Apple's voice processing adapts
  (with headphones there is simply no echo path) — but untested.
