#!/usr/bin/env python3
"""Give every passage in a transcript its time in the recording, and who said it.

    python3 timecode.py --corpus <dir> [--plan] [--force]

The twin of paginate.py for recordings. A quotation is anchored in the transcript by
its characters; the transcript's timings (spec/05: application/vnd.upc.timings+json)
say which characters each segment holds and when it was said. This records, on each
passage, a secondary `timestamp_range` on the recording's web copy (the one a page
plays) and the speakers in `ext["upc-audio"]`.

  * **Nothing that verifies changes.** A time is a `secondary_locator`, outside the
    `ext-` id recipe (spec/03): navigation, never evidence.
  * **Word times where the words line up.** Inside a segment the passage's first and
    last words are matched to the engine's word times; when they can't be (a word the
    clean-up changed), the time is estimated from the character's place in the segment.
  * **Silenced stretches stay silent.** A passage that touches a left-out stretch gets no
    time, and is reported.

Idempotent: a passage that already has a time is left alone, unless --force.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

TIMINGS = "application/vnd.upc.timings+json"
_TOKEN = re.compile(r"\S+")


def _tok(w: str) -> str:
    return re.sub(r"[^\w]", "", w.lower().replace("’", "'").replace("-", ""))


def extraction_files(corpus: Path) -> list[Path]:
    return sorted(list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl")))


def maps(corpus: Path) -> dict[str, dict]:
    """transcript rep id -> {text, rows, audio rep id, source id}."""
    out = {}
    for sj in sorted(corpus.glob("sources/*/source.json")):
        d = C.load_json(sj, {})
        reps = d.get("representations") or []
        tm = next((r for r in reps if r.get("media_type") == TIMINGS), None)
        if not tm:
            continue
        tr = next((r for r in reps if r["representation_id"] == tm.get("parent_representation_ref")), None)
        audio = (next((r for r in reps if r["role"] == "audio" and r.get("produced_by") == "conversion"), None)
                 or next((r for r in reps if r["role"] in ("audio", "video")), None))
        if not tr or not audio or not (corpus / tm["path"]).exists() or not (corpus / tr["path"]).exists():
            continue
        out[tr["representation_id"]] = {
            "text": (corpus / tr["path"]).read_text(encoding="utf-8"),
            "rows": C.load_json(corpus / tm["path"], {}).get("segments") or [],
            "audio": audio["representation_id"], "duration": audio.get("duration_seconds"),
            "source_id": d["source_id"]}
    return out


def time_at(row: dict, text: str, c: int, edge: str) -> float:
    """The time of character `c` in a segment: its word's start (edge="start") or end,
    from the engine's word times when the words line up, else by its place in the segment."""
    a, b = row["c0"], row["c1"]
    words = row.get("words") or []
    span = text[a:b]
    toks = [(m.start() + a, m.end() + a, _tok(m.group(0))) for m in _TOKEN.finditer(span)]
    if words and toks:
        sm = difflib.SequenceMatcher(None, [t[2] for t in toks], [_tok(w[0]) for w in words], autojunk=False)
        match = {}
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                match[blk.a + k] = blk.b + k
        if edge == "start":
            k = next((i for i, t in enumerate(toks) if t[1] > c), None)
        else:
            k = next((i for i in range(len(toks) - 1, -1, -1) if toks[i][0] < c), None)
        if k is not None:
            if k in match:
                w = words[match[k]]
                return round(float(w[1] if edge == "start" else w[2]), 2)
            # A word clean-up changed ("Hollenbek" -> "Hollenbeck") has no match of its own:
            # it is the word after its matched neighbour before, or before its neighbour after.
            if k - 1 in match and match[k - 1] + 1 < len(words) and (k + 1 not in match or match[k + 1] - match[k - 1] == 2):
                w = words[match[k - 1] + 1]
                return round(float(w[1] if edge == "start" else w[2]), 2)
            if k + 1 in match and match[k + 1] - 1 >= 0 and k - 1 not in match:
                w = words[match[k + 1] - 1]
                return round(float(w[1] if edge == "start" else w[2]), 2)
    frac = max(0.0, min(1.0, (c - a) / max(1, b - a)))
    return round(row["start"] + (row["end"] - row["start"]) * frac, 2)


def locate(m: dict, c0: int, c1: int) -> dict | None:
    rows = [r for r in m["rows"] if r["c0"] < c1 and c0 < r["c1"]]
    if not rows:
        return None
    if any(r.get("left_out") for r in rows):
        return {"left_out": True}
    main = [r for r in rows if not r.get("aside")] or rows
    speakers = []
    for r in main:
        if r.get("speaker") and r["speaker"] not in speakers:
            speakers.append(r["speaker"])
    start = time_at(rows[0], m["text"], max(c0, rows[0]["c0"]), "start")
    end = time_at(rows[-1], m["text"], min(c1, rows[-1]["c1"]), "end")
    if end < start:
        end = start
    return {"start": start, "end": end, "speakers": speakers}


def run(corpus: Path, plan: bool = False, force: bool = False, quiet: bool = False) -> int:
    ms = maps(corpus)
    scanned = added = already = left = unplaced = 0
    for f in extraction_files(corpus):
        lines = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        dirty = False
        for o in lines:
            m = ms.get(o.get("representation_ref"))
            loc = o.get("locator") or {}
            if not m or loc.get("type") != "char_range":
                continue
            scanned += 1
            secs = o.get("secondary_locators") or []
            had = next((s for s in secs if s.get("type") == "timestamp_range"), None)
            if had and not force and had.get("representation_ref") == m["audio"]:
                already += 1
                continue
            v = loc.get("value") or {}
            got = locate(m, v.get("start", 0), v.get("end", 0))
            if not got:
                unplaced += 1
                continue
            if got.get("left_out"):
                left += 1
                continue
            new = {"type": "timestamp_range", "representation_ref": m["audio"],
                   "value": {"start": got["start"], "end": got["end"]}, "unit": "s", "conforms_to": "media-frags"}
            secs = [s for s in secs if s.get("type") != "timestamp_range"] + [new]
            if secs != o.get("secondary_locators") or (o.get("ext") or {}).get("upc-audio", {}).get("speakers") != got["speakers"]:
                o["secondary_locators"] = secs
                o.setdefault("ext", {})["upc-audio"] = {"speakers": got["speakers"]}
                added += 1
                dirty = True
        if dirty and not plan:
            tmp = f.with_suffix(f.suffix + ".tmp")
            tmp.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in lines), encoding="utf-8")
            tmp.replace(f)
    if not quiet:
        C.counts_header("Times", [
            ("transcripts with timings", len(ms)),
            ("passages in them", scanned),
            ("times recorded" + (" (planned)" if plan else ""), added),
            ("already had one (left alone)", already),
            ("touch a left-out stretch (no time)", left),
            ("fall in no segment", unplaced),
        ])
    if added and not plan:
        C.upc("regen", str(corpus))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    return run(Path(a.corpus).expanduser(), a.plan, a.force)


if __name__ == "__main__":
    sys.exit(main())
