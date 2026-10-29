#!/usr/bin/env python3
"""Run a Qwen3-TTS VoiceDesign job on the configured Tailscale GPU host."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time


def is_wave(path: Path) -> bool:
    try:
        import soundfile as sf

        info = sf.info(path)
        return info.frames > 0 and info.samplerate > 0 and info.channels > 0
    except Exception:
        return False


def save_manifest(path: Path, manifest: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--force", choices=("0", "1"), default="0")
    parser.add_argument("--retries", type=int, default=0)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    rows = manifest.get("items", [])
    unique = [row for row in rows if not row.get("duplicateOf")]
    model = None
    generated = cached = failed = 0
    for index, row in enumerate(unique, start=1):
        target = args.out_dir / (row["id"] + ".wav")
        if args.force == "0" and is_wave(target):
            row["status"] = "cached"
            cached += 1
            save_manifest(args.manifest, manifest)
            print(f"[{index}/{len(unique)}] cached {row.get('speaker') or row['kind']} {row['nodeId']}:{row['lineIndex']}", flush=True)
            continue

        try:
            if model is None:
                import torch
                from qwen_tts import Qwen3TTSModel

                if not torch.cuda.is_available():
                    raise RuntimeError("CUDA is unavailable on the configured host.")
                model = Qwen3TTSModel.from_pretrained(
                    args.model,
                    device_map="cuda:0",
                    dtype=torch.bfloat16,
                    local_files_only=True,
                )
            error = None
            for attempt in range(args.retries + 1):
                try:
                    started = time.monotonic()
                    waves, sample_rate = model.generate_voice_design(
                        text=row["text"],
                        instruct=row["voicePrompt"],
                        language="Chinese",
                        do_sample=True,
                        temperature=0.7,
                        max_new_tokens=512,
                    )
                    if not waves or sample_rate <= 0:
                        raise RuntimeError("Qwen returned an empty audio result.")
                    import soundfile as sf

                    temp = target.with_suffix(".tmp.wav")
                    sf.write(temp, waves[0], sample_rate, subtype="PCM_16")
                    if not is_wave(temp):
                        raise RuntimeError("Generated output is not a readable WAV file.")
                    temp.replace(target)
                    row["status"] = "generated"
                    row.pop("error", None)
                    generated += 1
                    print(f"[{index}/{len(unique)}] generated {row.get('speaker') or row['kind']} {row['nodeId']}:{row['lineIndex']} ({time.monotonic() - started:.1f}s)", flush=True)
                    error = None
                    break
                except Exception as exc:  # noqa: BLE001
                    error = str(exc)[:500]
            if error is not None:
                row["status"] = "failed"
                row["error"] = error
                failed += 1
                print(f"[{index}/{len(unique)}] failed {row.get('speaker') or row['kind']} {row['nodeId']}:{row['lineIndex']}", flush=True)
        except Exception as exc:  # noqa: BLE001
            row["status"] = "failed"
            row["error"] = str(exc)[:500]
            failed += 1
            print(f"[{index}/{len(unique)}] model error {type(exc).__name__}", flush=True)
            for remaining in unique[index:]:
                remaining["status"] = "failed"
                remaining["error"] = "Model initialization failed; see remote runner output."
                failed += 1
            save_manifest(args.manifest, manifest)
            break
        save_manifest(args.manifest, manifest)

    for row in rows:
        if row.get("duplicateOf"):
            row["status"] = "duplicate"
    manifest.setdefault("counts", {}).update({"generated": generated, "cached": cached, "failed": failed})
    save_manifest(args.manifest, manifest)
    print(f"Qwen job finished: generated={generated}, cached={cached}, failed={failed}.", flush=True)
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
