"""Transcribe a WAV with nvidia/parakeet-tdt-0.6b-v3 in fixed chunks.

Usage: uv run run_parakeet.py <wav> <out.txt>
"""

import sys
import time

import soundfile as sf
from transformers import pipeline

CHUNK_S = 300

wav_path, out_path = sys.argv[1], sys.argv[2]

audio, sr = sf.read(wav_path, dtype="float32")
assert sr == 16000, f"expected 16kHz, got {sr}"
duration = len(audio) / sr
print(f"audio: {duration:.0f}s")

t0 = time.time()
pipe = pipeline("automatic-speech-recognition", model="nvidia/parakeet-tdt-0.6b-v3")
print(f"load: {time.time() - t0:.1f}s, device: {pipe.model.device}")

texts = []
t0 = time.time()
for start in range(0, len(audio), CHUNK_S * sr):
    chunk = audio[start : start + CHUNK_S * sr]
    out = pipe({"raw": chunk, "sampling_rate": sr}, max_new_tokens=7000)
    texts.append(out["text"].strip())
    done_s = min((start + CHUNK_S * sr), len(audio)) / sr
    print(f"  {done_s:.0f}/{duration:.0f}s elapsed={time.time() - t0:.1f}s", flush=True)

elapsed = time.time() - t0
print(f"transcribe: {elapsed:.1f}s ({duration / elapsed:.1f}x realtime)")

with open(out_path, "w") as f:
    f.write("\n".join(texts) + "\n")
