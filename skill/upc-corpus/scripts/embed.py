#!/usr/bin/env python3
"""A semantic index over the corpus's text, as a regenerable projection.

    python3 embed.py --corpus <dir> build [--force]
    python3 embed.py --corpus <dir> search "how do installers shape adoption" [--limit 15]
    python3 embed.py --corpus <dir> status

The index lives in the corpus's tool-private scratch (`.upc/index/embeddings/`),
never among its objects: it is derived, disposable and tied to one embedding
model. Rows carry the exact character range of their chunk, so any hit can be
turned into a real, gated quotation later by handing that span to `upc anchor`.

Chunking follows the embedding server's measured limits rather than a guess: it
runs with a 512-token micro-batch, and a chunk beyond roughly 600 tokens returns
HTTP 500, so chunks are capped at 1400 characters and batches at 8.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None


def index_dir(corpus: Path) -> Path:
    d = corpus / ".upc" / "index" / "embeddings" / "qwen3-embedding-4b"
    d.mkdir(parents=True, exist_ok=True)
    return d


def chunk_text(text: str) -> list[tuple[int, int]]:
    """Paragraph-aligned chunks as (start, end) character offsets.

    Python string indices are codepoints, which is exactly what a UPC char_range
    is, so these offsets can be used for anchoring without conversion.
    """
    spans: list[tuple[int, int]] = []
    pos = 0
    buf_start = 0
    buf_len = 0
    for para in text.split("\n\n"):
        p_start = pos
        pos += len(para) + 2
        p_len = len(para)
        if p_len < C.MIN_CHUNK_CHARS:
            continue
        if p_len > C.MAX_CHUNK_CHARS:
            # A very long paragraph is split on sentence ends, not mid-word.
            s = 0
            while s < p_len:
                e = min(s + C.MAX_CHUNK_CHARS, p_len)
                if e < p_len:
                    dot = para.rfind(". ", s + 200, e)
                    if dot > 0:
                        e = dot + 1
                spans.append((p_start + s, p_start + e))
                s = e
            continue
        if buf_len and buf_len + p_len > C.MAX_CHUNK_CHARS:
            spans.append((buf_start, buf_start + buf_len))
            buf_len = 0
        if not buf_len:
            buf_start = p_start
        buf_len = (p_start - buf_start) + p_len
    if buf_len:
        spans.append((buf_start, buf_start + buf_len))
    return spans


def build(corpus: Path, force: bool) -> int:
    d = index_dir(corpus)
    info = C.load_json(d / "info.json", {}) or {}
    rows_path, vec_path = d / "rows.jsonl", d / "vectors.f32"
    sources = C.corpus_reps(corpus)

    # A row is stale when its representation's bytes changed or the model did.
    prior_rows, prior_vecs = [], None
    if not force and rows_path.exists() and vec_path.exists() and info.get("model") == C.EMBED_MODEL:
        prior_rows = [json.loads(l) for l in rows_path.read_text(encoding="utf-8").splitlines() if l.strip()]
        raw = vec_path.read_bytes()
        prior_vecs = np.frombuffer(raw, dtype="<f4").reshape(-1, C.EMBED_DIMS) if np is not None else None
    fresh_by_rep = {}
    for i, r in enumerate(prior_rows):
        fresh_by_rep.setdefault(r["rep"], []).append(i)

    rows, vectors, reused, embedded, t0 = [], [], 0, 0, time.time()
    for alias, s in sorted(sources.items()):
        if not s["text_rep"] or not s["text_path"]:
            continue
        text = Path(s["text_path"]).read_text(encoding="utf-8")
        keep = fresh_by_rep.get(s["text_rep"])
        if keep and prior_vecs is not None:
            for i in keep:
                rows.append(prior_rows[i])
                vectors.append(prior_vecs[i])
            reused += len(keep)
            continue
        spans = chunk_text(text)
        payload = [text[a:b] for a, b in spans]
        for i in range(0, len(payload), C.EMBED_BATCH):
            batch = payload[i:i + C.EMBED_BATCH]
            got = C.embed_resilient(batch)
            for k, vec in enumerate(got):
                if vec is None:
                    continue
                a, b = spans[i + k]
                rows.append({"rep": s["text_rep"], "source_id": s["source_id"], "alias": alias,
                             "char_range": {"start": a, "end": b},
                             "preview": text[a:min(b, a + 240)]})
                vectors.append(np.asarray(vec, dtype="<f4") if np is not None else vec)
                embedded += 1
        print(f"  {alias}: {len(spans)} chunks")

    if np is None:
        C.die("numpy is required to build the index")
    mat = np.vstack(vectors).astype("<f4") if vectors else np.zeros((0, C.EMBED_DIMS), dtype="<f4")
    vec_path.write_bytes(mat.tobytes())
    rows_path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    centroid = mat.mean(axis=0) if len(mat) else np.zeros(C.EMBED_DIMS, dtype="<f4")
    C.save_json(d / "info.json", {
        "model": C.EMBED_MODEL, "dims": C.EMBED_DIMS, "rows": len(rows),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "centroid": [float(x) for x in centroid],
    })
    secs = round(time.time() - t0, 1)
    C.log_timing(corpus, {"stage": "embed", "rows": len(rows), "seconds": secs})

    # The index is derived data, but the fact that it was built belongs in the journal.
    C.upc("event", "--corpus", str(corpus), stdin=json.dumps({
        "activity_type": "embed", "tool": "upc-corpus",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "success",
        "notes": f"semantic index: {len(rows)} chunks over {len(sources)} sources ({C.EMBED_MODEL})",
    }), check=False)

    C.counts_header("Search index", [
        ("chunks indexed", len(rows)),
        ("newly embedded", embedded),
        ("reused unchanged", reused),
        ("sources", len(sources)),
        ("model", f"{C.EMBED_MODEL} ({C.EMBED_DIMS} dims)"),
        ("seconds", secs),
    ])
    print("Index built.")
    return 0


def search(corpus: Path, query: str, limit: int) -> list[dict]:
    d = index_dir(corpus)
    info = C.load_json(d / "info.json", {})
    if not info:
        raise C.Unavailable("no search index yet — run `embed.py build` first")
    rows = [json.loads(l) for l in (d / "rows.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    mat = np.frombuffer((d / "vectors.f32").read_bytes(), dtype="<f4").reshape(-1, C.EMBED_DIMS)
    q = np.asarray(C.embed_batch([query])[0], dtype="<f4")

    # Qwen3 embeddings sit around 0.69 cosine even for unrelated text, so the
    # corpus centroid is removed before comparing: what matters is which chunk is
    # closer to the question than the corpus's own middle, not the raw number.
    centroid = np.asarray(info.get("centroid") or np.zeros(C.EMBED_DIMS), dtype="<f4")
    m = mat - centroid
    qv = q - centroid
    denom = (np.linalg.norm(m, axis=1) * np.linalg.norm(qv)) + 1e-9
    scores = (m @ qv) / denom
    order = np.argsort(-scores)[:limit]
    return [{**rows[i], "score": round(float(scores[i]), 3)} for i in order]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("action", choices=["build", "search", "status"])
    ap.add_argument("query", nargs="?", default="")
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    if np is None:
        C.die("numpy is not installed in this interpreter")
    if args.action == "build":
        return build(corpus, args.force)
    if args.action == "status":
        info = C.load_json(index_dir(corpus) / "info.json", {})
        C.counts_header("Search index", [("rows", info.get("rows", 0)),
                                         ("model", info.get("model", "—")),
                                         ("built", info.get("built_at", "never"))])
        return 0
    if not args.query:
        C.die("search needs a question")
    hits = search(corpus, args.query, args.limit)
    if args.json:
        print(json.dumps(hits, ensure_ascii=False, indent=1))
        return 0
    C.counts_header("Search", [("question", args.query), ("hits", len(hits))])
    for h in hits:
        print(f"  [{h['score']:+.3f}] {h['alias']} chars {h['char_range']['start']}–{h['char_range']['end']}")
        print(f"      {h['preview'][:200].replace(chr(10), ' ')}")
    print("\nSearch complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
