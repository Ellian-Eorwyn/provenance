#!/usr/bin/env python3
"""Find and code the passages in every source, with a local model.

    python3 code_pass.py --corpus <dir> --coder <project>-<model>-v1 [--limit N] [--only s0001]

Per source: the whole document goes in (a document longer than `--max-chars`
in consecutive parts, one call each), a list of candidate passages comes back,
each carrying **every code that applies to it across all the codebooks**. Then `upc anchor --normalize` decides whether each proposed
span is really in the document, and `upc code` records the judgements against
the spans that survived.

Why one call rather than one per codebook: a passage that invokes the multi-level
perspective is usually also *about* something — power, lock-in, actors. Asking
each codebook separately produces passages that carry exactly one code, and a
theory x dimension matrix built from those is empty in every cell. This was
measured on the first pilot; the cross-tabulation is the point of the exercise,
so the codes have to be assigned together.

Resumable: state per source under `<corpus>/.upc/upc-corpus/code_pass/<coder>/`.
Re-running is idempotent — `upc anchor` and `upc code` both recognise work they
have already done, so a re-run writes nothing and reports `exists`/`unchanged`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

MIN_QUOTE = 24
MAX_QUOTE = 380
CONF_SCORE = {"high": 0.9, "medium": 0.6, "low": 0.3}


def load_codebooks(corpus: Path) -> list[dict]:
    books = []
    for f in sorted((corpus / "codebooks").glob("cbk-*.json")):
        d = C.load_json(f)
        if d:
            books.append(d)
    return books


def system_prompt(books: list[dict], unit: str = "passage") -> str:
    use = [b for b in books if (b.get("unit") or "passage") in (unit, "either")]
    lines = [
        "You are reading one document and marking the passages a research team will want to quote.",
        "",
        "For each passage you mark, copy the words exactly and say which codes apply to it.",
        "A passage usually carries codes from more than one codebook: the theory it invokes AND",
        "what it is about. Give every code that genuinely applies, from any codebook below.",
        "",
        "RULES. These matter more than how many passages you find:",
        f"1. Copy each quote EXACTLY as it appears, including punctuation, capitalisation and citations.",
        f"2. A quote is between {MIN_QUOTE} and {MAX_QUOTE} characters: one or two sentences, never more than ~60 words.",
        "3. No ellipses, no '[...]', no joining separate sentences, no tidying the wording.",
        "4. Prefer the shortest span that clearly shows the point.",
        "5. At most 3 passages for any one code, and at most 24 passages in total.",
        "6. If the paper does not instantiate a code, leave it out. Abstaining is correct and expected.",
        "7. Never quote a reference list, acknowledgements, author affiliations, or page headers and footers.",
        "8. Do not use the code 'none' unless no other code in that codebook applies.",
        "",
        "CODEBOOKS:",
    ]
    for b in use:
        lines.append("")
        lines.append(f"## {b['slug']} — {b.get('question') or b.get('title')}")
        for c in b.get("codes", []):
            ex = f"  Example: \"{c['examples'][0]}\"" if c.get("examples") else ""
            lines.append(f"- {c['code']}: {c.get('label', c['code'])}. {c.get('definition', '')}{ex}")
    lines += [
        "",
        'Return JSON exactly like this:',
        '{"passages":[{"quote":"<verbatim span>",'
        '"codes":[{"codebook":"<slug>","code":"<code>"}],'
        '"rationale":"<20 words or fewer>","confidence":"high|medium|low"}]}',
    ]
    return "\n".join(lines)


SCHEMA = {
    "type": "object",
    "properties": {
        "passages": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "quote": {"type": "string"},
                    "codes": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"codebook": {"type": "string"}, "code": {"type": "string"}},
                            "required": ["codebook", "code"],
                        },
                    },
                    "rationale": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["quote", "codes", "confidence"],
            },
        }
    },
    "required": ["passages"],
}


def split_for_model(text: str, budget: int) -> list[str]:
    """Consecutive parts of at most ``budget`` characters, cut at paragraph
    breaks (then line breaks, then anywhere), so a long document is read in
    full rather than cut off: books run to 400,000 characters."""
    if len(text) <= budget:
        return [text]
    pieces: list[str] = []
    for paragraph in text.split("\n\n"):
        chunk = paragraph + "\n\n"
        if len(chunk) <= budget:
            pieces.append(chunk)
            continue
        for line in paragraph.split("\n"):
            line += "\n"
            while len(line) > budget:
                pieces.append(line[:budget])
                line = line[budget:]
            pieces.append(line)
    parts: list[str] = []
    current, size = [], 0
    for piece in pieces:
        if current and size + len(piece) > budget:
            parts.append("".join(current))
            current, size = [], 0
        current.append(piece)
        size += len(piece)
    if current:
        parts.append("".join(current))
    return [part for part in parts if part.strip()] or [text[:budget]]


def clean_passages(raw: list[dict], books_by_slug: dict[str, dict]) -> tuple[list[dict], dict]:
    """Drop what cannot possibly be coded, and say why. No model call."""
    drops = {"too_short": 0, "too_long": 0, "ellipsis": 0, "unknown_code": 0, "no_codes": 0, "duplicate": 0}
    seen: set[str] = set()
    out = []
    for p in raw:
        q = (p.get("quote") or "").strip()
        if len(q) < MIN_QUOTE:
            drops["too_short"] += 1
            continue
        if len(q) > MAX_QUOTE * 2:
            drops["too_long"] += 1
            continue
        if "..." in q or "…" in q or "[…]" in q:
            drops["ellipsis"] += 1
            continue
        if q in seen:
            drops["duplicate"] += 1
            continue
        codes = []
        for c in p.get("codes") or []:
            book = books_by_slug.get(str(c.get("codebook", "")).strip())
            if not book:
                drops["unknown_code"] += 1
                continue
            code = str(c.get("code", "")).strip()
            if code == "none":
                continue
            if not any(x["code"] == code for x in book.get("codes", [])):
                drops["unknown_code"] += 1
                continue
            codes.append({"codebook_ref": book["codebook_id"], "code": code})
        if not codes:
            drops["no_codes"] += 1
            continue
        seen.add(q)
        out.append({"quote": q, "codes": codes,
                    "rationale": (p.get("rationale") or "")[:200],
                    "confidence": p.get("confidence") if p.get("confidence") in CONF_SCORE else "medium"})
    return out, drops


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--coder", default="", help="the coder's handle (default: settings coders.code)")
    ap.add_argument("--model", default=C.DEFAULT_MODEL)
    ap.add_argument("--url", default=C.CHAT_URL)
    ap.add_argument("--set", dest="cds", default=None, help="coding set id (default cds-<coder>)")
    ap.add_argument("--extraction-set", dest="exs", default=None)
    ap.add_argument("--prompt-version", default="code_pass.v3")
    ap.add_argument("--query", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="comma-separated manifest ids")
    ap.add_argument("--max-chars", type=int, default=110000,
                    help="document text per model call; longer documents are read in parts")
    ap.add_argument("--max-tokens", type=int, default=8000, help="room for the model's answer")
    ap.add_argument("--plan", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    args.coder = args.coder or (C.corpus_settings(corpus).get("coders") or {}).get("code") \
        or C.die("pass --coder (the coder's handle, e.g. <project>-<model>-v1)")
    cds = args.cds or f"cds-{args.coder}"
    exs = args.exs or f"exs-{args.coder}"
    try:
        spec = C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))

    books = load_codebooks(corpus)
    if not books:
        C.die(f"no codebooks in {corpus}/codebooks — author them before coding")
    books_by_slug = {b["slug"]: b for b in books}
    sources = C.corpus_reps(corpus)
    if not sources:
        C.die(f"no sources in {corpus} — run ingest.py first")

    st_dir = C.state_dir(corpus, "code_pass", args.coder)
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    todo = []
    for alias, info in sorted(sources.items()):
        if only and alias not in only:
            continue
        if not info["text_rep"]:
            print(f"  UNAVAILABLE {alias}: no text copy to quote from")
            continue
        if (st_dir / f"{alias}.json").exists():
            continue
        todo.append((alias, info))
    if args.limit:
        todo = todo[:args.limit]

    prompt = system_prompt(books)
    calls = [len(split_for_model(Path(info["text_path"]).read_text(encoding="utf-8"), args.max_chars))
             for _alias, info in todo]
    C.counts_header("Coding plan", [
        ("sources in corpus", len(sources)),
        ("already coded by this coder", len(list(st_dir.glob("*.json")))),
        ("to code now", len(todo)),
        ("read in several parts", f"{sum(1 for c in calls if c > 1)} documents "
                                  f"({sum(calls)} model calls in all, at most {args.max_chars:,} characters each)"),
        ("codebooks", f"{len(books)} ({', '.join(b['slug'] for b in books)})"),
        ("coder", args.coder),
        ("model", f"{args.model} at {args.url}"),
        ("prompt", f"{args.prompt_version} ({len(prompt)} chars)"),
        ("upc", spec),
    ])
    if args.plan:
        print(prompt[:1500])
        print("\nPlanning only; nothing was written.")
        return 0
    if not todo:
        print("Nothing to code; every source already has a pass from this coder.")
        return 0

    totals = {"papers": 0, "proposed": 0, "kept": 0, "anchored": 0, "refound": 0,
              "not_found": 0, "ambiguous": 0, "coded": 0, "unchanged": 0, "failed_papers": 0,
              "multi_part": 0, "widened": 0}
    drops_all: dict[str, int] = {}
    t_start = time.time()

    for n, (alias, info) in enumerate(todo, 1):
        t0 = time.time()
        text = Path(info["text_path"]).read_text(encoding="utf-8")
        parts = split_for_model(text, args.max_chars)
        proposed, res, failed = [], None, None
        usage = {"prompt_tokens": 0, "completion_tokens": 0}
        for k, part in enumerate(parts, 1):
            where = f" (part {k} of {len(parts)}; mark passages from this part only)" if len(parts) > 1 else ""
            user = f"DOCUMENT: {info['title']}{where}\n\n{part}"
            # A rich paper can run past the answer budget, and a truncated JSON object
            # parses as nothing at all — losing the whole paper rather than its tail.
            # Measured: 12 of 178 papers hit this. Retry once with more room and a
            # tighter per-code cap before giving up on the paper.
            parsed = None
            for attempt, (cap, extra) in enumerate((
                    (args.max_tokens, ""),
                    (min(args.max_tokens * 2, 16000),
                     "\n\nIMPORTANT: keep the whole answer short. At most 2 passages per code "
                     "and at most 14 passages in total. A complete short answer beats a long one "
                     "that gets cut off."))):
                try:
                    res = C.llm_chat(prompt + extra, user, url=args.url, model=args.model,
                                     max_tokens=cap, schema=SCHEMA)
                except C.Unavailable as e:
                    print(f"  UNAVAILABLE {alias}: {e}")
                    res = None
                    break
                parsed = C.parse_json_loose(res["content"])
                if parsed and "passages" in parsed:
                    if attempt:
                        print(f"      {alias}: recovered on a second, tighter attempt")
                    break
                if res.get("finish_reason") != "length":
                    break
                parsed = None
            if not parsed or "passages" not in parsed:
                failed = (k, (res or {}).get("finish_reason", "no response"))
                break
            proposed.extend(parsed["passages"])
            for key in usage:
                usage[key] += (res or {}).get(key) or 0
        if failed:
            part_label = f"part {failed[0]} of {len(parts)}: " if len(parts) > 1 else ""
            print(f"  UNAVAILABLE {alias}: {part_label}the model did not return usable JSON (finish: {failed[1]})")
            totals["failed_papers"] += 1
            continue
        if len(parts) > 1:
            totals["multi_part"] += 1
        kept, drops = clean_passages(proposed, books_by_slug)
        # A quote that occurs more than once would be refused as ambiguous; a
        # few more words of its own line usually make it unique.
        for p in kept:
            if C.occurrences(text, p["quote"]) > 1:
                wider = C.widen_to_unique(text, p["quote"])
                if wider:
                    p["quote"] = wider
                    totals["widened"] += 1
        for k, v in drops.items():
            drops_all[k] = drops_all.get(k, 0) + v

        # The model proposes; the tool decides what is real.
        anchor_res = C.upc_jsonl(
            "anchor", "--corpus", str(corpus), "--rep", info["text_rep"], "--normalize",
            "--set", exs, "--type", "passage", "--tool", "upc-corpus",
            "--model", args.model, "--prompt-version", args.prompt_version,
            *(["--query", args.query] if args.query else []),
            records=[{"quote": p["quote"], "note": p["rationale"], "confidence": p["confidence"]}
                     for p in kept],
        )
        results = anchor_res.get("results", []) if isinstance(anchor_res, dict) else []
        codings = []
        for item in results:
            if item.get("status") not in ("anchored", "refound", "exists"):
                continue
            p = kept[item["i"]]
            for code in p["codes"]:
                codings.append({
                    "codebook_ref": code["codebook_ref"], "code": code["code"],
                    "target": {"kind": "extraction", "id": item["extraction_id"]},
                    "coder": args.coder,
                    "confidence": p["confidence"],
                    "confidence_score": CONF_SCORE[p["confidence"]],
                    "rationale": p["rationale"],
                    **({"query": args.query} if args.query else {}),
                })
        code_res = C.upc_jsonl(
            "code", "--corpus", str(corpus), "--set", cds, "--coder-kind", "model",
            "--tool", "upc-corpus", "--model", args.model,
            "--prompt-version", args.prompt_version,
            records=codings,
        ) if codings else {"tally": {}}

        at = anchor_res.get("tally", {}) if isinstance(anchor_res, dict) else {}
        ct = code_res.get("tally", {}) if isinstance(code_res, dict) else {}
        rec = {
            "alias": alias, "source_id": info["source_id"],
            "proposed": len(proposed), "kept": len(kept), "drops": drops,
            "anchor": at, "code": ct, "parts": len(parts),
            "seconds": round(time.time() - t0, 1),
            "prompt_tokens": usage["prompt_tokens"], "completion_tokens": usage["completion_tokens"],
            "finish_reason": (res or {}).get("finish_reason"),
        }
        C.save_json(st_dir / f"{alias}.json", rec)
        C.log_timing(corpus, {"stage": "code_pass", **rec})

        totals["papers"] += 1
        totals["proposed"] += len(proposed)
        totals["kept"] += len(kept)
        for k in ("anchored", "refound", "not_found", "ambiguous"):
            totals[k] += at.get(k, 0)
        totals["coded"] += ct.get("coded", 0)
        totals["unchanged"] += ct.get("unchanged", 0)

        rate = (time.time() - t_start) / n
        left = int(rate * (len(todo) - n))
        print(f"  [{n}/{len(todo)}] {alias}: {len(proposed)} proposed, "
              f"{at.get('anchored', 0)}+{at.get('refound', 0)} anchored, "
              f"{ct.get('coded', 0)} codings, {rec['seconds']}s"
              f"  (~{left // 60}m {left % 60}s left)")

    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    secs = round(time.time() - t_start, 1)
    anchored_total = totals["anchored"] + totals["refound"]
    pct = (100 * anchored_total / totals["kept"]) if totals["kept"] else 0

    C.counts_header("Coding result", [
        ("papers coded", totals["papers"]),
        ("papers that failed", totals["failed_papers"]),
        ("papers read in several parts", totals["multi_part"]),
        ("passages proposed", totals["proposed"]),
        ("passages kept after checks", totals["kept"]),
        ("anchored exactly", totals["anchored"]),
        ("anchored after normalising", totals["refound"]),
        ("could not be found", totals["not_found"]),
        ("ambiguous (appear twice)", totals["ambiguous"]),
        ("widened to be unique first", totals["widened"]),
        ("anchoring rate", f"{pct:.0f}%"),
        ("codings written", totals["coded"]),
        ("codings unchanged", totals["unchanged"]),
        ("corpus", f"{rep.get('status')} {rep.get('level')}, "
                   f"{len(rep.get('errors', []))} errors"),
        ("minutes", round(secs / 60, 1)),
        ("seconds per paper", round(secs / max(1, totals['papers']), 1)),
    ], notes=[f"dropped before anchoring: {json.dumps(drops_all)}" if drops_all else ""])
    for e in rep.get("errors", [])[:6]:
        print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:100]}")
    print("Coding pass finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
