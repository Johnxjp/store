# Transcription experiments

Working notes for two experiments run against the meeting recorded in
`data/recordings/ba784f46-7a20-470c-9af5-5a3d96d9cd8c` (~83 min, a
two-person call), using the transcripts in
`data/examples/reference-meeting` (local only, not committed).

## 1. Granola vs our app (word error rate)

Run: `npx tsx experiments/compare-granola.ts` → `results/granola-vs-app.json`

Method: Granola's export is one unlabeled prose blob after a `Transcript:`
header; ours is repeating `MM:SS / Me|Them / text` blocks. Both are flattened
to plain text, normalized (lowercase, punctuation stripped), and compared with
word-level Levenshtein distance. WER = edit distance / reference word count,
so the same distance yields a different WER depending on which side is
declared canonical.

| Metric                    | Value  |
| ------------------------- | ------ |
| Granola words             | 5,345  |
| Our app words (Me + Them) | 17,838 |
| Word edit distance        | 12,690 |
| WER, Granola canonical    | 237.4% |
| WER, our app canonical    | 71.1%  |
| WER, Granola vs Them only | 14.1%  |
| WER, Granola vs Me only   | 139.9% |

### Reading these numbers

The headline WERs are dominated by a **length mismatch**, not by
mis-recognition: our transcript has 3.3× more words than Granola's.
Two causes, both visible in the data:

1. **Granola dropped most of the near-side (mic) speech.** Whole passages
   that only "Me" spoke — a several-minute story told in the first
   minutes — do not appear in Granola's transcript at all (`grep` for its
   distinctive phrases: zero hits). Granola's 5,345 words are
   essentially one side of the call: our Them-only stream matches it at
   **14.1% WER**, which is ordinary ASR-level disagreement.
2. **Mic bleed duplicates the far side in our transcript.** The meeting was
   run on speakers, so our mic stream contains both sides' speech; the same
   sentences appear under both Me and Them ~30 s apart. Granola has each
   sentence once, so every duplicated run counts as insertions against it.

So: where the two products transcribe the _same audio_ (the system stream),
they agree to within ~14%. The 237%/71% headline numbers mostly measure
coverage differences — our app captures more real speech (good), but also
duplicates far-side speech through the mic (bleed, worth deduplicating at
merge time) and includes some silence-hallucination text.

## 2. Streaming (chunked) transcription vs full-file

Goal: transcription of the whole file after the meeting is slow; instead,
transcribe ~30 s chunks as the audio arrives so the transcript is ready
moments after Stop.

### Design (`streaming/streaming-transcriber.ts`)

`StreamingTranscriber` accepts 16 kHz mono s16le PCM pushed in arbitrary-size
buffers, exactly as a live capture callback would deliver it:

- **Chunking:** audio accumulates until ~30 s is buffered (Whisper's native
  window, per the chosen latency target). The cut point is not the hard 30 s
  boundary but the quietest 200 ms frame in the last 5 s of the window, so
  cuts land in pauses instead of mid-word; the remainder carries into the
  next chunk.
- **Cross-chunk context:** the tail (32 words) of the previous chunk's text
  is passed to `whisper-cli --prompt`, recovering the context a full-file run
  gets for free.
- **Silence gate per chunk:** chunks whose peak never exceeds the app's
  existing `SILENCE_MAX_DB` (−40 dB) are skipped without invoking Whisper —
  Whisper hallucinates on silence, and each stream is silent roughly half the
  meeting.
- **Sequential queue:** chunks transcribe one at a time in arrival order
  while audio keeps accumulating, matching how a live meeting would run.
- Same model (`large-v3-turbo`) and `whisper-cli` flags as the app's
  full-file path, so the comparison isolates the effect of chunking.

Prototype cost note: each chunk currently spawns a fresh `whisper-cli`, which
reloads the 1.6 GB model every ~30 s. For app integration the model should
stay resident (whisper.cpp `server` mode or persistent bindings); the accuracy
results are unaffected by this.

### Test harness

Run: `npx tsx experiments/run-streaming.ts [recording-dir]` →
`results/streaming-vs-full.json`, plus per-stream chunk logs and transcripts
under `results/streaming/`.

The harness feeds each of `mic-16k.wav` / `system-16k.wav` to the transcriber
in 1 s pushes, then scores the concatenated streaming text against the app's
existing full-file whisper output for the same stream (`mic-16k.json` /
`system-16k.json`), treated as ground truth.

### Results

Full-file output for each stream is the declared ground truth.

| Stream | Audio  | Chunks | Skipped silent | Streaming words | Full words | WER vs full |
| ------ | ------ | ------ | -------------- | --------------- | ---------- | ----------- |
| mic    | 83.1 m | 183    | 5              | 12,032          | 12,290     | **9.1%**    |
| system | 83.1 m | 182    | 14             | 5,877           | 6,459      | **24.7%**   |

Throughput: ~4,985 s of audio transcribed in 220 s (mic) / 206 s (system) —
about 23× realtime _including_ a model reload per chunk, so each 30 s chunk
finishes in ~1.2 s. Streamed live, the transcript trails the meeting by one
chunk (~30 s) and is complete seconds after Stop, versus minutes of batch
transcription today.

### Where the disagreement actually comes from

Inspecting the largest diff hunks (word-level alignment of the two texts)
shows the WER numbers overstate real transcription divergence:

- **Degenerate repetition loops dominate.** The top hunks on both streams are
  Whisper melting down on low-signal audio — "I don't know what it is" × 30,
  "all right" × 15 — in _both_ outputs, just melting down differently. These
  loops contribute hundreds of edit-distance words each.
- **Ground truth contains hallucinations that streaming suppressed.** The
  full-file system output has 31 "Thank you" occurrences (the classic
  silence hallucination); streaming has 9, because gated chunks never reach
  Whisper. Each suppressed hallucination counts as a deletion _against_
  streaming even though streaming is the more correct output.
- **Streaming recovered real speech the full-file run dropped.** E.g. the
  full-file mic output renders an early passage as just "thank you" where
  streaming has 79 words of real conversation, matching what was actually
  said (it also appears in our exported transcript).
- The system stream's higher WER (24.7% vs 9.1%) follows directly: it is
  silent roughly half the meeting, so hallucination/loop deltas are a much
  larger fraction of its 6.5k words than of the mic's 12.3k.

### Conclusions

1. 30 s chunked streaming with pause-seeking cuts and `--prompt` carry-over
   is accuracy-equivalent to full-file transcription on real speech; the
   measured gap is mostly noise-floor behavior, where streaming is as good or
   better (fewer hallucinations, recovered dropped speech).
2. The per-chunk silence gate should ship with any streaming integration —
   it cheaply removes most silence hallucinations before Whisper sees them.
3. For app integration the remaining work is engineering, not accuracy:
   keep the model resident (whisper.cpp server / bindings) instead of
   spawning `whisper-cli` per chunk, and feed chunks from the Swift helper's
   live buffers instead of a WAV file.

## 3. The bleed effect

(Corrected after listening to the raw audio and measuring levels — an earlier
version of this section wrongly claimed far-end echo on the system stream.)

Bleed is **one-way**: everything the speakers play (the far side) is also
captured by the mic, so far-side speech appears twice — once on the system
stream (correctly, as "Them") and once on the mic stream, mislabeled "Me",
a couple of seconds later as a garbled partial duplicate.

The system stream itself is clean. Measured during a near-side-only passage
(3791–3800 s, mic max −19 dB), the system stream sits at −63.6 dB mean /
−38.9 dB max — silence floor, no echo of the near side coming back from the
far end.

Two facts make the mic-side bleed as bad as it is:

1. **No echo cancellation in our capture path.** `MicRecorder.swift` taps the
   raw `AVAudioEngine.inputNode` with voice processing off. Meeting apps
   capture the mic through Apple's voice-processing unit (AEC), which
   subtracts exactly what the machine is playing; we record the unprocessed
   device, so every word the speakers play lands in the mic WAV.
2. **Bleed is as loud as the primary voice.** On this quiet mic, the
   note-taker's own speech peaks at −19…−25 dB and far-side bleed at −25 dB —
   comparable levels. Whisper therefore transcribes the bleed fluently
   (disfluencies and all), and no energy threshold can separate bleed from
   primary speech.

Consequences: far-side sentences appear twice in the merged transcript (the
bulk of the 3.3× length vs Granola), each bleed copy is attributed to the
wrong speaker, and the overlapped low-SNR passages are where Whisper's
repetition loops concentrate.

Fixes: enable `setVoiceProcessingEnabled(true)` on the input node (kills the
bleed at the source for future recordings — the same AEC meeting apps use);
cross-stream text dedup in `merge.ts` for existing recordings (drop mic
segments whose normalized text near-matches a system segment within a few
seconds — text, not energy, since levels are indistinguishable); offline AEC
(speexdsp / WebRTC AEC3) using `system.wav` as the far-end reference is also
possible since we record exactly what the speakers played.

## 4. Echo cancellation results

### Live: Apple voice processing in the helper

`MicRecorder.swift` now enables `setVoiceProcessingEnabled(true)` on the
input node (with other-audio ducking set to minimum, since the system
recorder captures that same audio). A/B test — same sentence spoken through
the speakers via `say` while both helpers record:

| Helper      | Mic during playback                         | Whisper on the mic WAV  |
| ----------- | ------------------------------------------- | ----------------------- |
| without AEC | −43.5 dB mean (= the meeting's bleed level) | both sentences verbatim |
| with AEC    | −55.4 dB mean                               | one stray "this"        |

The bleed is functionally gone at capture time. Needs a real-meeting sanity
check for voice quality/ducking side effects, but startup, epoch anchors,
and stop all behave.

### Offline: `experiments/offline-aec.ts` (existing recordings)

For already-recorded meetings we have the exact far-end reference —
`system.wav` is what the speakers played. The script estimates the echo with
ffmpeg's `anlms` adaptive filter (2048 taps, reference delayed by the epoch
offset from `session.json`) and subtracts the phase-inverted estimate from
the mic. Output: `mic-16k-aec.wav` beside the originals; nothing existing is
modified. (ffmpeg quirks discovered: `out_mode=e` emits the echo _estimate_,
`out_mode=n` emits the reference, and `amix` ignores negative weights —
hence the explicit `aeval` inversion.)

Probe windows on the ba784… recording:

| Window                        | Before (mean/max) | After (mean/max) |
| ----------------------------- | ----------------- | ---------------- |
| bleed only (far side talking) | −43.9 / −25.0 dB  | −55.8 / −28.4 dB |
| own voice (near side talking) | −42.8 / −19.0 dB  | −42.8 / −19.0 dB |

−12 dB of bleed suppression with the near-side voice untouched — the same residual
level Apple's live AEC leaves. Functionally it is a partial win: Whisper
previously transcribed the bleed verbatim; on the cleaned file loud bleed
passages come out garbled/fragmented rather than silent, so some bleed text
would still reach a transcript. A linear NLMS can't fully model speaker
distortion and clock drift over 83 min; speexdsp/WebRTC AEC3 would do
better if offline cleanup ever matters. For pipeline purposes the
merge-time text dedup remains the right backstop for old recordings —
the real fix is the live AEC for future ones.

## 5. Parakeet vs Whisper (speed + WER)

Run: `cd experiments/parakeet && uv run run_parakeet.py <wav> <out.txt>`, then
`npx tsx experiments/compare-parakeet.ts` → `results/parakeet-vs-whisper.json`

Candidate: `nvidia/parakeet-tdt-0.6b-v3` (600M params, 25 languages), two
runtimes: the HuggingFace `transformers` pipeline (native `parakeet_tdt`
support since ≥4.57; tested on 5.14.1, torch 2.13, MPS; naive 300 s chunks,
no overlap) and `parakeet-mlx` 0.5.2 (`mlx-community/parakeet-tdt-0.6b-v3`,
120 s chunks with 15 s merged overlap). Benchmarked on the 83-min system
("Them") stream of the ba784… meeting, M4 Pro, against `whisper-cli`
large-v3-turbo (Metal) and the Granola transcript as the pseudo-reference
(Granola is itself ASR output, so these are agreement rates, not true WER —
but the reference is the same for all runs).

| Metric (83-min file)         | whisper large-v3-turbo | parakeet (transformers) | parakeet v3 (mlx) | parakeet v2 (mlx) |
| ---------------------------- | ---------------------- | ----------------------- | ----------------- | ----------------- |
| Transcription time           | 216.7 s (23× RT)       | 103.5 s (48× RT)        | 74.8 s (67× RT)   | 65.3 s (76× RT)   |
| WER vs Granola               | 14.1%                  | 18.0%                   | 14.7%             | —                 |
| WER vs Granola (fillers cut) | 13.1%                  | 16.6%                   | 13.1%             | **10.3%**         |
| Words produced               | 5,572                  | 5,298                   | 5,542             | 5,465             |

Notes:

- **The mlx run matches whisper's accuracy exactly** (13.1% with fillers
  stripped) and is ~3× faster. The transformers run's worse WER was mostly
  my naive chunking — no overlap, so words at every 300 s boundary were
  lost or garbled (the two parakeet runs disagree 10.6% with each other,
  and mlx recovered ~250 words). Chunking strategy matters as much as the
  model.
- **Speed**: NVIDIA's "6000 s of audio per second" figure is
  A100-with-batching; irrelevant on a Mac. All three are far faster than
  realtime, so batch-on-stop stays fine and streaming remains unnecessary.
- **Residual WER gap is style, not mis-hearing**: parakeet writes verbatim
  ("um", "gonna") and spells numbers out ("thirty eight" vs "38"); Granola's
  cleaned-up style matches whisper's more closely. Verbatim is arguably
  _better_ raw material for LLM summarization.
- **Hallucination**: parakeet did _not_ hallucinate on the silent intro,
  where a fresh whisper run produced "you you you you…" — the failure mode
  merge.ts's filters exist for. It also caught real speech whisper missed
  in the opening minute.
- **Chunking is mandatory, not optional**: passing the full 83-min file
  with no chunking dies instantly — the encoder's full attention tries to
  allocate 248 GB (Metal buffer cap ~30 GB on a 48 GB M4 Pro). Quadratic
  scaling puts the single-shot ceiling around ~25 min, matching NVIDIA's
  stated limit. The 120 s + 15 s-overlap chunking above is the config that
  produced the whisper-equal WER, and parakeet-mlx does the overlap
  merging internally.
- **Chunk size doesn't affect accuracy, only speed — smaller is faster.**
  With 15 s overlap, WER (fillers cut) is flat across sizes while quadratic
  attention makes big chunks pay per audio-second: 120 s → 74.8 s / 13.1%,
  300 s → 84.6 s / 12.9%, 900 s → 148.0 s / 13.3%. Peak RSS ~1 GB in all
  cases. Use 2–5 min chunks; there is no reason to go larger.
- **Timestamps**: `parakeet-mlx` returns `AlignedSentence` objects with
  start/end times (globally correct across chunks — first speech at 107 s
  matched the silent intro), and ships a CLI (`parakeet-mlx <wav>
--output-format json`) — the same child-process shape as whisper-cli.
- **Integration cost of switching**: a Python runtime (uv-managed) instead
  of a Homebrew binary, a 2.3 GB HF-cache model, and merge.ts adaptations
  (sentence-level segments instead of whisper's; the hallucination filters
  likely become mostly dead weight).

- **v2 (English-only) beats v3 and whisper on our audio**: 10.3% vs 13.1%
  (fillers cut) — a ~3-point real improvement at the same size (600M, same
  2.3 GB download) and slightly faster. Matches FluidAudio's LibriSpeech
  numbers (v2 2.1% vs v3 2.6%) and NVIDIA's own "v2 is a bit better on
  English" guidance. Trade-off: English only — fine for this app today.
- **FluidAudio CoreML/ANE (tested): 280× realtime, best accuracy, no
  Python.** `experiments/fluidaudio/` compiles a minimal transcribe helper
  from FluidAudio's ASR sources with plain `swiftc` (SwiftPM is still
  broken on this machine; only the Parakeet ASR + Shared subset compiles,
  plus three files for type definitions — no Diarizer/VAD/TTS code runs).
  Library defaults: int8 encoder on the ANE, disk-backed streaming for
  files >30 s (constant memory, no length ceiling), seam-gap repair. The
  83-min file: **v3 17.8 s (280× RT) / 13.2% WER; v2 18.0 s (278× RT) /
  9.9% WER** (fillers cut) — accuracy identical to MLX fp32, so int8/ANE
  costs nothing. Per-token timestamps (~9.5k tokens; first token 107.4 s,
  agreeing with MLX within 40 ms). Model load is 0.2 s warm (~2 GB
  download + ANE compile once). A non-fatal `E5RT … zero shape error`
  warning prints at load. GPU stays free for Ollama.

### Deepgram cross-check (nova-3 as reference)

`experiments/deepgram/transcribe.ts` sends recordings to Deepgram nova-3
(cloud — the one deliberate exception to local-only; key in gitignored
`.env`, outputs in gitignored `results/`). Ran the 5 most recent meetings,
both streams. Scoring the same ba784 system stream against Deepgram
instead of Granola (fillers stripped in all cases):

| Engine                 | WER vs Deepgram | WER vs Granola |
| ---------------------- | --------------- | -------------- |
| parakeet v2 mlx        | **9.2%**        | 10.3%          |
| parakeet v3 coreml     | 9.4%            | 13.2%          |
| parakeet v2 coreml     | 9.8%            | 9.9%           |
| parakeet v3 mlx        | 10.2%           | 13.1%          |
| Granola's own export   | 11.9%           | —              |
| whisper large-v3-turbo | 12.8%           | 13.1%          |

Two conclusions the Granola reference couldn't give: **every parakeet
variant beats whisper — and Granola itself — against the SOTA reference**,
and the v2-vs-v3 gap mostly evaporates (9.2–9.8% vs 9.4–10.2%): much of
v2's apparent lead against Granola was shared transcription style. Runtime
choice (CoreML for speed) matters more than v2-vs-v3; v2 still edges it on
English and never does worse.

Verdict: parakeet is now the better model for this app, not just a faster
one, and **FluidAudio CoreML v2 is the best configuration tested**: 9.9%
WER (vs whisper's 13.1%), 278× realtime (12× faster than whisper-cli),
hallucination-free on silence, token-level timestamps, Swift like our
existing helpers, no Python runtime. Migration paths, best first:
(a) FluidAudio in a Swift transcribe helper (the experiments/fluidaudio
build proves it works despite broken SwiftPM), (b) `parakeet-mlx` CLI as a
whisper-cli drop-in (simplest). Not switching mid-V3, but the evidence now
clearly favors switching.

## 6. Summary prompt optimisation (Granola-quality notes)

Full write-up: `prompt_optimisation/ANALYSIS.md`.

Our enhanced notes for a real job-interview meeting were far worse
than Granola's for the same meeting: bare topic labels with no detail, a
"no decisions were made" filler section, and the closing action item
attributed to the wrong person. Two root causes: the production Ollama
call set no `num_ctx`, so the 16k-token transcript was silently truncated
to the 4096-token default — and the prompt literally asked for "a list of
key topics covered", which is what it got.

Two rounds of iteration against real transcripts (harness:
`prompt_optimisation/run.ts`, scored on a 16-fact checklist verified
against the transcript) landed on v11, now in `src/main/enhance.ts`: an
"Overview" section stating the meeting's core purpose first, with
relevance to that purpose deciding what belongs (which drops rapport
chit-chat without enumerating banned topics), topic sections carrying the
concrete facts/numbers/examples, participant names resolved from the
conversation — never guessed, commitments owned by whoever spoke them, and
a "Next steps" section omitted entirely when no one committed to anything.
Shipped alongside `num_ctx: 32768`, `temperature: 0`, and a
`MAX_TRANSCRIPT_CHARS` cap that matches the real context window.

Sharpest lesson: at 14B, one-sentence prompt changes cause non-local
regressions — a "skip the goodbyes" instruction deleted the action item
that was spoken during the goodbyes. Never reword the production prompt
without re-running this harness.
