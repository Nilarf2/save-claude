#!/usr/bin/env python3
"""Build the bundled Chinese font subset after changing story/UI text.

Optional development dependency: pip install 'fonttools[woff]'
The game itself needs no Python packages.
"""
import argparse
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, required=True, help="Original Noto Serif CJK SC font (OTF/TTF/TTC)")
    parser.add_argument("--font-number", type=int, default=0, help="SC index if input is a TTC collection")
    args = parser.parse_args()
    text = "".join(chr(n) for n in range(32, 127)) + "年月日时分秒…—·↗←→✓✕"
    for rel in ["story/03-story.md", "web/story.json", "web/character-portraits.json", "web/index.html", "web/game.js"]:
        text += (ROOT / rel).read_text(encoding="utf-8")
    font = TTFont(args.font, fontNumber=args.font_number, recalcTimestamp=False)
    options = subset.Options()
    options.flavor = "woff2"
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    options.name_legacy = True
    options.name_languages = [0x409]
    options.recalc_timestamp = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    # Give the modified font its own family name, retaining upstream copyright/license.
    family = "Save Claude Serif"
    for record in font["name"].names:
        replacements = {1: family, 4: family + " Regular", 6: "SaveClaudeSerif-Regular", 16: family, 17: "Regular", 3: "SaveClaudeSerif-Regular-2026"}
        if record.nameID in replacements:
            record.string = replacements[record.nameID].encode(record.getEncoding())
    font.flavor = "woff2"
    out = ROOT / "web/assets/fonts/story-serif.woff2"
    out.parent.mkdir(parents=True, exist_ok=True)
    font.save(out)
    print(f"Wrote {out.relative_to(ROOT)}: {out.stat().st_size} bytes, {len(set(text))} requested characters")


if __name__ == "__main__":
    main()
