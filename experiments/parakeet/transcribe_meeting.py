"""Transcribe both streams of a recording with parakeet v2, sentence JSON out.

Usage: uv run transcribe_meeting.py <recording-dir> <out-dir>
"""

import json
import sys
import time
from pathlib import Path

from parakeet_mlx import from_pretrained

rec_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v2")
for stream in ("mic", "system"):
    wav = rec_dir / f"{stream}-16k.wav"
    t0 = time.time()
    result = model.transcribe(str(wav), chunk_duration=120, overlap_duration=15)
    sentences = [
        {"start": s.start, "end": s.end, "text": s.text.strip()}
        for s in result.sentences
    ]
    out = out_dir / f"parakeet-{stream}.json"
    out.write_text(json.dumps(sentences, indent=1))
    print(f"{stream}: {len(sentences)} sentences in {time.time() - t0:.1f}s -> {out}")
