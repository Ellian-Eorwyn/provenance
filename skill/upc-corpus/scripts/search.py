#!/usr/bin/env python3
"""Find passages about something, across the whole corpus, in one call.

    python3 search.py --corpus <dir> "how do installers shape what households choose"
    python3 search.py --corpus <dir> "carbon lock-in" --keyword
    python3 search.py --corpus <dir> "<question>" --code theory:mlp
    python3 search.py --corpus <dir> "<question>" --anchor

Three sources of hits, merged and de-duplicated:

  * **already-coded passages** whose text matches — these are best, because they
    are already gated and already have an id you can cite;
  * **semantic** hits from the embedding index, for wording the question does not
    share with the text;
  * **keyword** hits, for exact terms an embedding will happily blur.

`--anchor` turns the best sentence of an uncoded hit into a real, gated passage
via `upc anchor --normalize`, so it can be quoted with a citation marker. Without
it, nothing is written: search is read-only by default.

This is designed to be called ONCE. It returns everything needed to answer, so
there is no reason to search again with a slightly different phrasing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import embed as E   # noqa: E402


def load_passages(corpus: Path) -> list[dict]:
    out = []
    books = {}
    for f in sorted((corpus / "codebooks").glob("cbk-*.json")):
        b = C.load_json(f)
        if b:
            books[b["codebook_id"]] = b
    codings = {}
    for items in sorted(corpus.glob("codings/*/items.jsonl")):
        for line in items.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            if (c.get("status") or "active") != "active":
                continue
            t = c.get("target", {})
            if t.get("kind") != "extraction":
                continue
            b = books.get(c["codebook_ref"])
            codings.setdefault(t["id"], []).append(
                f"{b['slug'] if b else '?'}:{c.get('code', c.get('value'))}")
    paths = list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl"))
    for f in paths:
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            o = json.loads(line)
            if not o.get("direct_quote"):
                continue
            out.append({"id": o["extraction_id"], "source_id": o["source_id"],
                        "quote": o["direct_quote"], "codes": codings.get(o["extraction_id"], [])})
    return out


def best_sentence(text: str, lo: int = 40, hi: int = 340) -> str | None:
    """The longest sentence in a chunk that is quotable at all."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    ok = [p.strip() for p in parts if lo <= len(p.strip()) <= hi]
    return max(ok, key=len) if ok else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("question")
    ap.add_argument("--limit", type=int, default=15)
    ap.add_argument("--code", default="", help="restrict coded hits to slug:code")
    ap.add_argument("--keyword", action="store_true", help="keyword only, no embeddings")
    ap.add_argument("--anchor", action="store_true", help="mint gated passages for uncoded hits")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    sources = C.corpus_reps(corpus)
    by_sid = {s["source_id"]: (alias, s) for alias, s in sources.items()}
    terms = [t for t in re.findall(r"\w{4,}", args.question.lower()) if t not in
             {"what", "which", "does", "this", "that", "with", "from", "have", "about", "they", "their"}]

    # 1. coded passages
    coded = []
    for p in load_passages(corpus):
        if args.code and args.code not in p["codes"]:
            continue
        hay = p["quote"].lower()
        score = sum(1 for t in terms if t in hay)
        if score:
            alias, s = by_sid.get(p["source_id"], ("?", {}))
            coded.append({"kind": "coded", "score": score, "id": p["id"], "alias": alias,
                          "title": s.get("title", ""), "quote": p["quote"], "codes": p["codes"]})
    coded.sort(key=lambda h: -h["score"])

    # 2. semantic
    semantic = []
    if not args.keyword:
        try:
            for h in E.search(corpus, args.question, args.limit):
                alias, s = by_sid.get(h["source_id"], (h.get("alias", "?"), {}))
                semantic.append({"kind": "semantic", "score": h["score"], "alias": alias,
                                 "title": s.get("title", ""), "rep": h["rep"],
                                 "char_range": h["char_range"], "preview": h["preview"]})
        except C.Unavailable as e:
            print(f"UNAVAILABLE: semantic search — {e}")
            print("(falling back to keyword only)\n")

    # 3. keyword over the reading copies
    keyword = []
    if terms:
        pat = re.compile("|".join(re.escape(t) for t in terms), re.I)
        for alias, s in sorted(sources.items()):
            if not s["text_path"]:
                continue
            text = Path(s["text_path"]).read_text(encoding="utf-8")
            hits = [m.start() for m in pat.finditer(text)][:3]
            for pos in hits:
                a, b = max(0, pos - 200), min(len(text), pos + 260)
                keyword.append({"kind": "keyword", "score": 1, "alias": alias,
                                "title": s["title"], "rep": s["text_rep"],
                                "char_range": {"start": a, "end": b}, "preview": text[a:b]})
    keyword = keyword[:args.limit]

    # Merge: a coded passage always beats an uncoded hit from the same source.
    seen_sources = {h["alias"] for h in coded}
    merged = coded[:args.limit] + \
        [h for h in semantic if h["alias"] not in seen_sources][:args.limit] + \
        [h for h in keyword if h["alias"] not in seen_sources][:max(0, args.limit // 2)]

    minted = 0
    if args.anchor:
        for h in merged:
            if h["kind"] == "coded" or "rep" not in h:
                continue
            sent = best_sentence(h["preview"])
            if not sent:
                continue
            res = C.upc_jsonl("anchor", "--corpus", str(corpus), "--rep", h["rep"], "--normalize",
                              "--type", "evidence", "--tool", "upc-corpus",
                              "--query", args.question,
                              records=[{"quote": sent}])
            r = (res.get("results") or [{}])[0]
            if r.get("status") in ("anchored", "refound", "exists"):
                h["id"] = r["extraction_id"]
                h["quote"] = sent
                minted += 1

    C.counts_header("Search", [
        ("question", args.question),
        ("already-coded passages", len(coded)),
        ("semantic hits", len(semantic)),
        ("keyword hits", len(keyword)),
        ("shown", len(merged)),
        ("newly anchored", minted if args.anchor else "not requested"),
    ])
    if args.json:
        print(json.dumps(merged, ensure_ascii=False, indent=1))
        return 0
    for h in merged:
        head = f"  [{h['kind']}]"
        if h.get("id"):
            head += f" {h['id']}"
        print(f"{head}  {h['alias']} — {h.get('title', '')[:60]}")
        if h.get("codes"):
            print(f"      codes: {', '.join(h['codes'])}")
        body = h.get("quote") or h.get("preview", "")
        print(f"      {body[:260].replace(chr(10), ' ')}")
    print("\nTo quote any of these, run `upc quote <ext-id> --corpus <dir>` and copy what it prints.")
    print("Search complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
