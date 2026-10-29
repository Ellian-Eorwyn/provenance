#!/usr/bin/env python3
"""Judge each paper as a whole: how relevant it is, and what kind of study it is.

    python3 screen.py --corpus <dir> --coder <project>-screen-v1 [--model task] [--url … | --pool]

This is the cheap pass. It answers the questions a newcomer asks first — *which
of these papers should I actually read, and what kind of thing is each one?* —
against the source-level codebooks, using the small fast model rather than the
large model that reads whole documents for quotable passages. `--pool` screens on
every server in the machine's pool at once (llm_pool.py, one worker each; `task`
goes to them as `chat`), writing the corpus one paper at a time.

`--context` says what the research team is studying; it defaults to the
corpus title. Say it as a question with its why, for example: "how households adopt
rooftop solar, and what explains who adopts first".

It reads the opening and the closing of each paper, not the whole thing: title,
abstract and introduction say what a paper is, and the conclusion says what it
found. That is enough for this judgement and about ten times cheaper than the
passage pass.

These are **judgements, not facts**, and they are recorded under their own coder
name so they sit beside the passage coding and beside any human's, rather
than being mistaken for the corpus's own opinion.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import llm_pool  # noqa: E402

HEAD_CHARS = 5000
TAIL_CHARS = 2500
CONF_SCORE = {"high": 0.9, "medium": 0.6, "low": 0.3}


def source_books(corpus: Path) -> list[dict]:
    """Only the codebooks that judge a whole paper."""
    out = []
    for f in sorted((corpus / "codebooks").glob("cbk-*.json")):
        b = C.load_json(f)
        if b and (b.get("unit") or "passage") in ("source", "either"):
            out.append(b)
    return out


def system_prompt(books: list[dict], context: str) -> str:
    lines = [
        f"You are triaging documents for a research team studying {context.strip().rstrip('.')}.",
        "",
        "You are given one document's title, opening and closing. Judge the document AS A WHOLE.",
        "",
        "RULES:",
        "1. Answer with one code from each scheme below, except where a scheme says several may apply.",
        "2. Judge what the document IS, not what you wish it were. A theory paper with no case is not empirical.",
        "3. If the opening does not say, choose the closest code rather than inventing one.",
        "",
        "SCHEMES:",
    ]
    for b in books:
        multi = " (several may apply)" if b.get("multi_label") else " (choose exactly one)"
        lines.append("")
        lines.append(f"## {b['slug']} — {b.get('question') or b.get('title')}{multi}")
        for c in b.get("codes", []):
            lines.append(f"- {c['code']}: {c.get('label', c['code'])}. {c.get('definition', '')}")
    lines += [
        "",
        'Return JSON: {"judgements":[{"scheme":"<slug>","code":"<code>",'
        '"why":"<12 words or fewer>","confidence":"high|medium|low"}]}',
    ]
    return "\n".join(lines)


SCHEMA = {
    "type": "object",
    "properties": {
        "judgements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scheme": {"type": "string"},
                    "code": {"type": "string"},
                    "why": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["scheme", "code"],
            },
        }
    },
    "required": ["judgements"],
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--coder", default="", help="the screener's handle (default: settings coders.screen)")
    ap.add_argument("--model", default="task")
    ap.add_argument("--url", default=C.TASK_URL)
    ap.add_argument("--pool", action="store_true",
                    help="screen on every server in the machine's pool at once (one worker each)")
    ap.add_argument("--set", dest="cds", default=None)
    ap.add_argument("--prompt-version", default="screen.v2")
    ap.add_argument("--context", default="",
                    help="what the research team is studying (default: the corpus title)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="")
    ap.add_argument("--plan", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    args.coder = args.coder or (C.corpus_settings(corpus).get("coders") or {}).get("screen") \
        or C.die("pass --coder (the screener's handle, e.g. <project>-screen-v1)")
    cds = args.cds or f"cds-{args.coder}"
    try:
        spec = C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))

    books = source_books(corpus)
    if not books:
        C.die("no source-level codebooks (none with unit 'source' or 'either')")
    by_slug = {b["slug"]: b for b in books}
    sources = C.corpus_reps(corpus)
    st_dir = C.state_dir(corpus, "screen", args.coder)

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    todo = []
    for alias, info in sorted(sources.items()):
        if only and alias not in only:
            continue
        if not info["text_path"]:
            print(f"  UNAVAILABLE {alias}: no text to read")
            continue
        if (st_dir / f"{alias}.json").exists():
            continue
        todo.append((alias, info))
    if args.limit:
        todo = todo[:args.limit]

    title = (C.load_json(corpus / "corpus.json", {}) or {}).get("title") or corpus.name
    prompt = system_prompt(books, args.context or f"the material in the corpus titled '{title}'")
    endpoints = dict(llm_pool.ENDPOINTS) if args.pool else {}
    C.counts_header("Screening plan", [
        ("sources", len(sources)),
        ("already screened", len(list(st_dir.glob("*.json")))),
        ("to screen now", len(todo)),
        ("schemes", ", ".join(b["slug"] for b in books)),
        ("coder", f"{args.coder} (model)"),
        ("model", f"{args.model} on {', '.join(endpoints)}" if endpoints else f"{args.model} at {args.url}"),
        ("upc", spec),
    ])
    if args.plan:
        print(prompt[:1200])
        print("\nPlanning only; nothing was written.")
        return 0
    if not todo:
        print("Nothing to screen.")
        return 0

    totals = {"papers": 0, "failed": 0, "coded": 0, "unchanged": 0, "dropped": 0}
    t0 = time.time()

    def judge(alias: str, info: dict, url: str, pooled: bool = False) -> dict:
        """The model's answer on one paper: {"parsed", "model", "seconds"}, or {"failed": why}."""
        text = Path(info["text_path"]).read_text(encoding="utf-8")
        user = (f"TITLE: {info['title']}\n\nOPENING:\n{text[:HEAD_CHARS]}\n\n"
                f"CLOSING:\n{text[-TAIL_CHARS:]}")
        model = llm_pool.model_for(url, args.model)
        try:
            res = C.llm_chat(prompt, user, url=url, model=model, max_tokens=1200, schema=SCHEMA)
        except C.Unavailable as e:
            if pooled:
                raise llm_pool.Unavailable(str(e)) from None
            return {"failed": str(e)}
        if pooled and llm_pool.is_relayed(res.get("headers") or {}, url):
            raise llm_pool.Relayed(url)
        parsed = C.parse_json_loose(res["content"])
        if not parsed or "judgements" not in parsed:
            return {"failed": f"no usable JSON (finish: {res.get('finish_reason')})"}
        return {"parsed": parsed, "model": model, "seconds": res["seconds"]}

    def store(alias: str, info: dict, got: dict, server: str = "") -> None:
        """One paper's judgements into the corpus (`upc code`) and its state file. Pooled, under the pool's lock."""
        if "failed" in got:
            print(f"  UNAVAILABLE {alias}: {got['failed']}")
            totals["failed"] += 1
            return
        records, seen = [], set()
        for jdg in got["parsed"]["judgements"]:
            book = by_slug.get(str(jdg.get("scheme", "")).strip())
            code = str(jdg.get("code", "")).strip()
            if not book or not any(c["code"] == code for c in book.get("codes", [])):
                totals["dropped"] += 1
                continue
            # A single-label scheme gets one answer, whatever the model returned.
            key = book["codebook_id"] if not book.get("multi_label") else (book["codebook_id"], code)
            if key in seen:
                totals["dropped"] += 1
                continue
            seen.add(key)
            conf = jdg.get("confidence") if jdg.get("confidence") in CONF_SCORE else "medium"
            records.append({
                "codebook_ref": book["codebook_id"], "code": code,
                "target": {"kind": "source", "id": info["source_id"]},
                "coder": args.coder, "confidence": conf,
                "confidence_score": CONF_SCORE[conf],
                "rationale": (jdg.get("why") or "")[:160],
            })
        out = C.upc_jsonl("code", "--corpus", str(corpus), "--set", cds,
                          "--coder-kind", "model", "--tool", "upc-corpus",
                          "--model", got["model"], "--prompt-version", args.prompt_version,
                          records=records) if records else {"tally": {}}
        tally = out.get("tally", {}) if isinstance(out, dict) else {}
        C.save_json(st_dir / f"{alias}.json",
                    {"alias": alias, "source_id": info["source_id"],
                     "judgements": len(records), "tally": tally,
                     "seconds": round(got["seconds"], 1), **({"server": server} if server else {})})
        totals["papers"] += 1
        totals["coded"] += tally.get("coded", 0)
        totals["unchanged"] += tally.get("unchanged", 0)
        n = totals["papers"] + totals["failed"]
        if n % 25 == 0 or n == len(todo):
            rate = (time.time() - t0) / n
            print(f"  [{n}/{len(todo)}] {alias}: {len(records)} judgements{f' on {server}' if server else ''} "
                  f"(~{int(rate * (len(todo) - n)) // 60}m left)", flush=True)

    if endpoints:
        problems, left = llm_pool.run_all(todo, lambda item, name, url: judge(*item, url, pooled=True),
                                          lambda item, got, name, _s: store(*item, got, name), endpoints)
        for prob in dict.fromkeys(problems):
            print(f"  POOL {prob}", flush=True)
        if left:
            print(f"  {len(left)} papers left: no server could take them; run the same command again", flush=True)
    else:
        for alias, info in todo:
            store(alias, info, judge(alias, info, args.url))

    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    state = (f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors"
             if isinstance(rep, dict) else "UNAVAILABLE: validate did not return a report")
    secs = time.time() - t0
    C.counts_header("Screening result", [
        ("papers screened", totals["papers"]),
        ("papers that failed", totals["failed"]),
        ("judgements written", totals["coded"]),
        ("already agreed", totals["unchanged"]),
        ("answers dropped as invalid", totals["dropped"]),
        ("corpus", state),
        ("minutes", round(secs / 60, 1)),
        ("seconds per paper", round(secs / max(1, totals["papers"]), 1)),
    ])
    print("These are model judgements about whole papers, recorded under their own")
    print("coder name. They sit beside the passage coding; they do not override it.")
    print("Screening finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
