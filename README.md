# Store: A local meeting note taker

An AI-powered meeting note taker that is fully local. Like Granola, the AI does not join a meeting but instead records the microphone and system audio in the background, transcribes them and then summarises into notes. All processing is done locally using open-source models (**no audio or text ever leaves the laptop**).

## Installation

Requirements:

- macOS 14.2+ on Apple Silicon (the system-audio capture uses CoreAudio process taps, which only exist from 14.2. The helpers are arm64-only and transcription runs on the Neural Engine)
- 16 GB RAM minimum. The 14B summary model is ~9 GB on disk and needs roughly 13–15 GB of memory with the 32k context the app requests. On a 16 GB Mac, set a smaller model in `data/config.json`
- ~10 GB free disk for models, plus ~330 MB per hour of recorded meetings (audio is kept so failed runs can be retried)
- Xcode Command Line Tools (`xcode-select --install`) — the Swift helpers compile with `swiftc`
- Node.js 22+
- [ffmpeg](https://formulae.brew.sh/formula/ffmpeg) (`brew install ffmpeg`)
- [Ollama](https://ollama.com) with the summary model pulled:

  ```sh
  ollama pull qwen2.5:14b
  ```

Then:

```sh
git clone <this repo> && cd ai-meeting-notes
npm install
npm run build:native   # compiles the two Swift helpers into resources/bin/
npm run dev            # builds and launches the app
```

## Recording your first call

1. Join your meeting in any app (Zoom, Meet, Teams, a phone call routed through the Mac)
2. Click **New note**. The note opens instantly and shows "Starting audio capture…" for the second or two the audio hardware takes to spin up;
3. Type your own notes during the call if you like; they autosave as you go.
4. Click **Stop** when the meeting ends. Transcription and summarisation run automatically. This usually takes a couple of minutes for an hour-long call. Note, it will take a few minutes to download the transcription model the first time (parakeet v2, ~450 MB).
5. Edit the generated notes. Edit the title. If a step fails (e.g. Ollama isn't running), the note shows a Retry button that resumes from where it got to.

> **Caution:** there is no pause. The stop button ends the recording for good and transcription and summarisation will start immediately.

#### Permissions

- macOS will prompt for **Microphone** access on first use.
- System audio does **not** prompt. Instead, you must grant it manually, once: attempt a recording (this registers the app with macOS, but the capture will fail), then enable the app under **System Settings → Privacy & Security → Screen & System Audio Recording → System Audio Recording Only**, and record again. (In dev, the permission may already be satisfied without any new entry appearing: helpers are attributed up the process chain, so if your terminal already has the broader Screen Recording permission, which includes system audio, recording just works.)

Everything the app produces (database, recordings, models, config) lives in the gitignored `./data/` folder.

## Features

### Start a new note

The 'New note' button starts a note and automatically begins recording. Nothing is visible to other participants so make sure to inform them.

![Image](/assets/home.png)

### Take your own notes during the call

Every note has a free-form notepad you can type into while recording. Notes autosave.

### Automatic summary, editable in place

When you stop, the app writes structured meeting notes: an overview of what the meeting was about, topic sections with the concrete facts and numbers that were said, and next steps with owners. Click anywhere in the summary to edit it directly.

![Image](/assets/summary.png)

### Transcript toggle

A **Transcript** chip switches the note to the full timestamped transcript, with each line labelled "Me" or "Them".

![Image](/assets/transcript.png)

### Chat with your notes (not yet implemented)

Asking questions across all your meetings is planned but not built yet; the tab is a placeholder.

## How it works

![Image](/assets/how-it-works.png)

This is written as an Electron app with a Node main process that owns all I/O. It spawns two small Swift helpers, ffmpeg, and talking to Ollama over HTTP.

Recording writes two WAV files to disk; when you hit 'Stop', a batch pipeline transcribes each stream, merges them into one speaker-labelled timeline, stores it in SQLite, and asks the LLM for a summary. WAVs are kept forever (~330 MB/hour); they make every pipeline step re-runnable from disk.

### Key technical decisions

**Two audio streams instead of diarization.** The mic and system audio are recorded as separate WAVs. Speaker attribution then comes free from the hardware path i.e. mic = "Me", system = "Them". The trade-off is all other participants are collapsed into "Them". The two streams are aligned at merge time using wall-clock epoch anchors captured at record start.

**How the audio is recorded.** A single Swift helper captures both streams. The mic comes from `AVAudioEngine`; system audio comes from a **CoreAudio process tap** (`CATapDescription` on an aggregate device, macOS 14.2+) rather than ScreenCaptureKit. SCK counts as _screen recording_ and macOS shows the purple "your screen is being recorded" indicator, while the process tap delivers the same PCM under the milder "System Audio Recording Only" permission with no indicator. This is also why the app doesn't use Electron/Chromium's built-in loopback capture: it's lossy (Opus) and its mic and system clocks are unsynchronised, which is fatal when merging two streams into one timeline.

**Noise cancellation: why and how the mic audio is cleaned.** The first recordings had a serious _bleed_ problem: everything the speakers play is also picked up by the microphone, so the far side of the call appeared twice in the transcript: once correctly as "Them" and once mislabelled as "Me". Measurements showed the bleed is as loud as the user's own voice, so no volume threshold can separate them. The fix is Apple's voice-processing unit (`setVoiceProcessingEnabled(true)`) on the mic input, which subtracts exactly what the machine is playing. An A/B test (same sentence played through the speakers with both capture paths) showed the bleed go from transcribed verbatim to a single stray word. 

An offline AEC approach (ffmpeg adaptive filtering using the system WAV as the echo reference) was also prototyped for old recordings, but only achieved −12 dB suppression. This was enough to garble the bleed, not remove it. Details and measurements: `experiments/README.md` §3–4.

**Transcription model: parakeet v2 via CoreML, chosen by measurement.** The app originally used whisper large-v3-turbo. Candidates were benchmarked on a real 83-minute meeting against two references: Granola's transcript of the same call and Deepgram nova-3 (used only for evaluation). NVIDIA's parakeet-tdt-0.6b (v2, English-only) running on the Apple Neural Engine via [FluidAudio](https://github.com/FluidInference/FluidAudio) CoreML won decisively: **9.9% WER vs whisper's 13.1%**, ~280× realtime (12× faster than whisper), and, unlike whisper, no hallucinations on silence (whisper famously invents "Thank you." during quiet passages, and each stream is silent about half of any meeting). Running on the ANE also leaves the GPU free for the LLM. A thin Swift helper wraps the model and emits word-level timings; sentence segments are assembled in TypeScript. Whisper-era hallucination filters are kept in the merge step as cheap insurance. Full benchmarks: `experiments/README.md` §5.

**The note-taker LLM.** Summaries come from a local model via Ollama (currently `qwen2.5:14b`), set in `data/config.json` along with the context window and transcript cap (config is re-read on every summarise, so you can switch models and hit Retry without restarting). Its input is the meeting title, date, and the full merged transcript with "Me"/"Them" speaker labels. However, **it does not currently take your own typed notes into account**.

One hard-won detail: Ollama silently truncates input to a 4,096-token context unless `num_ctx` is set explicitly. An hour-long meeting is ~16k tokens, so early summaries were being generated from a fraction of the transcript. The app requests a 32k context and caps the transcript to match.

> **Known limitation:** very long calls don't fit yet. The 32k context covers roughly two hours of meeting; beyond that the transcript is middle-truncated before summarisation, so facts from the middle of the call are lost. Handling longer calls properly needs a different algorithm — compressing the transcript before summarising, or summarising in chunks and merging the outputs.

**How middle truncation works.** The speaker-labelled transcript is capped at `maxTranscriptChars` (default 110,000 characters, ~27k tokens — sized so that the transcript plus the system prompt and the model's output fit inside the 32k `num_ctx`; the two values live together in `data/config.json` and must be scaled together when changing models). If the transcript is over the cap, the first and last halves of the budget are kept verbatim and everything between them is replaced with a `[... transcript truncated ...]` marker, so the model can see the gap rather than silently missing it. The middle is the part sacrificed because meetings are front- and back-loaded for a summary's purposes: the opening establishes who is present and what the meeting is for, and the close carries the decisions, commitments and next steps. It's a heuristic, not a guarantee: a decision made at minute 70 of a three-hour call is simply gone, which is why this is listed as a limitation rather than a solution.

**How the prompt was created.** The summary prompt was iterated against real meeting transcripts in a scoring harness (`experiments/prompt_optimisation/`), where each candidate's output was checked against a 16-fact checklist verified from the transcript. The winning version (v11) is overview-first. Write-up at `experiments/prompt_optimisation/ANALYSIS.md`.

## Development

| Task                   | Command                                            |
| ---------------------- | -------------------------------------------------- |
| Run the app (dev)      | `npm run dev`                                      |
| Tests                  | `npm test`                                         |
| Typecheck              | `npm run typecheck`                                |
| Lint / format          | `npm run lint` / `npm run format`                  |
| Rebuild Swift helpers  | `npm run build:native`                             |
| Headless pipeline test | `npx tsx scripts/test-pipeline.ts <recording-dir>` |
| Headless summary test  | `npx tsx scripts/test-enhance.ts [model]`          |

Architecture notes and conventions live in `CLAUDE.md`; experiment write-ups (transcription benchmarks, echo cancellation, prompt optimisation) in `experiments/README.md`.
