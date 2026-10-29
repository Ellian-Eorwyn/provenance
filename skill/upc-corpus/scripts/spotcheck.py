#!/usr/bin/env python3
"""Draw a sample for a person to check, then record what they said.

    python3 spotcheck.py --corpus <dir> --per-code 20 --out spotcheck.csv
    python3 spotcheck.py --corpus <dir> --ingest spotcheck.csv --coder <your-handle>
    python3 spotcheck.py --corpus <dir> --blind <dir> [--papers 15 --passages 40 --seed 1]
    python3 spotcheck.py --corpus <dir> --blind-ingest <dir> --coder <handle> [--coder-kind model --model <id>] [--name <shown as>]

`--blind` draws a second coder's sheet for the evidence ratings (appraise.py),
from the pilot set, before any model rating of it exists: papers stratified by
the screen's kind of study (used to sample, never shown), each as the text the
rating model reads, and passages shown in their "In context" window. Nothing on
the sheet comes from a model's rating. `--blind-ingest` reads the coder's answers
back, checks every quotation against the paper, grades each paper by the same
rules, and keeps it beside the vote for `appraise.py report`.

The sample is stratified by code and reproducible from `--seed`, so two people
checking the same corpus see the same passages and the numbers can be compared.

The filled sheet becomes **human codings sitting beside the model's**, under the
person's own coder handle. Nothing is overwritten and no judgement is thrown
away: where the person and the model differ, the corpus keeps both and every
surface shows the disagreement rather than resolving it. That is what makes the
precision figure in `report.py` mean anything.

Verdicts:

    agree         the code is right for this passage
    wrong-code    the passage is real but the code is wrong  (put the right one in `correct`)
    not-relevant  the passage does not instantiate any code in that codebook
    wrong-span    the quotation is a poor span: truncated, or not self-contained
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

FIELDS = ["verdict", "correct", "note", "codebook", "code", "coder",
          "quote", "source", "year", "extraction_id", "codebook_ref"]
VERDICTS = {"agree", "wrong-code", "not-relevant", "wrong-span"}


def load(corpus: Path):
    books = {}
    for f in sorted((corpus / "codebooks").glob("cbk-*.json")):
        b = C.load_json(f)
        if b:
            books[b["codebook_id"]] = b
    exts = {}
    for f in list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                o = json.loads(line)
                exts[o["extraction_id"]] = o
    codings = []
    for f in corpus.glob("codings/*/items.jsonl"):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                c = json.loads(line)
                if (c.get("status") or "active") == "active":
                    codings.append(c)
    return books, exts, codings


# ---- the blind sheet for the evidence ratings ----

BLIND_README = """# Blind coding sheet: {name} evidence ratings

You are the second coder. Code this sheet using **only** the rubric and these files. Do not open anything else in
the corpus or its tool state (`.upc/`), and do not look for any model's ratings: there must be none in what you read.

Read first: {rubric}/rubric.md, {rubric}/designs.json, and the profile files in {rubric}/profiles/.

## Papers ({n_papers})
`papers.json` lists each paper with `text_file`, the paper's text exactly as the rating model reads it (reference
list cut, venue name removed). For each paper, read the text and write one JSON object per line to
`answers/papers.jsonl`:

    {{"slug": "...", "design": "<code from designs.json>", "second_design": "<code or none>",
      "sector": "<one of designs.json sectors>", "countries": ["..."],
      "design_quote": "<exact sentence from the text>", "design_reason": "<≤25 words>",
      "answers": {{"<profile>": {{"q1": {{"answer": "yes|partly|not found|can't tell",
                                         "quote": "<exact sentence(s) from the text, for yes or partly; else empty>",
                                         "reason": "<≤25 words>"}}, ...}}}}}}

- `second_design`: as designs.json says (required for mixed-methods; allowed for grey-report); otherwise "none".
- Answer every question of the profile your design picks (both profiles for two strands).
- Quotations must be copied **exactly**, character for character, from the text file: one or two consecutive
  sentences, no ellipses. They are checked; an answer whose quotation is not in the text counts as "can't tell".

## Passages ({n_passages})
`passages.json` lists each passage with the sentences around it; the passage itself is between « and ». Write one
JSON object per line to `answers/passages.jsonl`:

    {{"extraction_id": "ext-...", "origin": "<claim-origin code>", "basis": "<claim-basis code>", "reason": "<≤25 words>"}}

The codes and their meanings are in rubric.md, Level 2.
"""


def blind_sheet(corpus: Path, out: Path, n_papers: int, n_passages: int, seed: int) -> int:
    import appraise as A  # noqa: PLC0415
    pilot = C.load_json(C.state_dir(corpus, "appraise") / "sets" / "pilot.json")
    if not pilot:
        C.die("no pilot set: run `appraise.py plan --set pilot …` first")
    papers_dir = Path(A.state(corpus, "papers"))
    rated = [p.stem for p in papers_dir.glob("*.json")]
    data = A.load_corpus(corpus)
    in_pilot = [sid for sid in pilot["papers"] if sid in data["sources"]]
    clash = [data["sources"][s]["slug"] for s in in_pilot if data["sources"][s]["slug"] in rated]
    if clash:
        C.die(f"{len(clash)} pilot papers already have model ratings ({', '.join(clash[:4])}…); a blind sheet must "
              "be drawn before any exist")
    rng = random.Random(seed)
    # papers: stratified by the screen's kind of study (sampling only; never shown), and short enough to read whole
    books = {b["codebook_id"]: b for b in (C.load_json(f) for f in corpus.glob("codebooks/cbk-*.json")) if b}
    klass = {}
    for f in corpus.glob("codings/*/items.jsonl"):
        for line in f.read_text(encoding="utf-8").splitlines():
            c = json.loads(line) if line.strip() else None
            if c and (books.get(c["codebook_ref"]) or {}).get("slug") == "source-class" and c["target"]["kind"] == "source":
                klass[c["target"]["id"]] = c.get("code")
    texts = {}
    for sid in in_pilot:
        s = data["sources"][sid]
        texts[sid] = A.model_text(Path(s["text_path"]).read_text(encoding="utf-8"), s["container"])[0]
    short = [sid for sid in in_pilot if len(texts[sid]) <= 110_000]
    strata: dict[str, list] = {}
    for sid in sorted(short):
        strata.setdefault(klass.get(sid, "unknown"), []).append(sid)
    for v in strata.values():
        rng.shuffle(v)
    chosen = []
    while len(chosen) < n_papers and any(strata.values()):
        for k in sorted(strata):
            if strata[k] and len(chosen) < n_papers:
                chosen.append(strata[k].pop())
    # passages: from all pilot papers, half carrying an in-text citation
    windows = C.load_json(C.state_dir(corpus, "appraise") / "windows.json", {}) or {}
    pool = sorted(e for sid in in_pilot for e in data["sources"][sid]["passages"])
    cited = [e for e in pool if A.CITE_RE.search(data["exts"][e]["direct_quote"])]
    plain = [e for e in pool if e not in set(cited)]
    rng.shuffle(cited)
    rng.shuffle(plain)
    picked = sorted(cited[:n_passages // 2] + plain[:n_passages - n_passages // 2])

    (out / "papers").mkdir(parents=True, exist_ok=True)
    (out / "answers").mkdir(exist_ok=True)
    plist = []
    for sid in chosen:
        s = data["sources"][sid]
        tf = out / "papers" / f"{s['slug']}.txt"
        tf.write_text(texts[sid], encoding="utf-8")
        plist.append({"slug": s["slug"], "source_id": sid, "title": s["title"], "text_file": str(tf),
                      "chars": len(texts[sid])})
    qlist = []
    for e in picked:
        x = data["exts"][e]
        w = windows.get(e) or [x["direct_quote"], 0, len(x["direct_quote"])]
        s = data["sources"][x["source_id"]]
        qlist.append({"extraction_id": e, "paper": f"{A.author_year(s)}, {s['title']}",
                      "in_context": w[0][:w[1]] + "«" + w[0][w[1]:w[2]] + "»" + w[0][w[2]:]})
    C.save_json(out / "papers.json", plist)
    C.save_json(out / "passages.json", qlist)
    (out / "README.md").write_text(BLIND_README.format(name=A.short_name(corpus), rubric=A.appraisal_dir(corpus), n_papers=len(plist),
                                                       n_passages=len(qlist)), encoding="utf-8")
    C.save_json(out / "sheet.json", {"seed": seed, "pilot_set": str(C.state_dir(corpus, "appraise") / "sets" / "pilot.json"),
                                     "papers": [p["source_id"] for p in plist], "passages": picked,
                                     "strata": {k: klass.get(k, "unknown") for k in chosen}})
    C.counts_header("Blind sheet", [
        ("papers", f"{len(plist)} (stratified by kind of study: "
                   + ", ".join(f"{k} {n}" for k, n in collections.Counter(klass.get(s, 'unknown') for s in chosen).items()) + ")"),
        ("passages", f"{len(qlist)} ({min(len(cited), n_passages // 2)} with an in-text citation)"),
        ("model ratings on the sheet", 0),
        ("written to", str(out)),
    ])
    return 0


def blind_ingest(corpus: Path, folder: Path, coder: str, kind: str = "human", model: str = "", name: str = "") -> int:
    import appraise as A  # noqa: PLC0415
    R = A.rubric(corpus)
    data = A.load_corpus(corpus)
    sheet = C.load_json(folder / "sheet.json", {}) or {}
    bysl = {s["slug"]: sid for sid, s in data["sources"].items()}
    papers, passages, bad = {}, {}, []
    for line in (folder / "answers" / "papers.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        sid = bysl.get(r.get("slug"))
        if not sid or sid not in sheet.get("papers", []):
            bad.append(f"paper not on the sheet: {r.get('slug')}")
            continue
        raw = Path(data["sources"][sid]["text_path"]).read_text(encoding="utf-8")
        nraw = A.norm(raw)
        strands = A.profiles_for(R, r.get("design"), r.get("second_design"))
        answers, plain = {}, {}
        for prof, _, _ in strands:
            got = (r.get("answers") or {}).get(prof) or {}
            for q in R["profiles"][prof]["questions"]:
                a = got.get(q["id"]) or {"answer": "can't tell"}
                a["quote_check"] = A.check_quote(raw, nraw, a.get("quote", "")) if a.get("quote") else "missing"
                a["answer"] = A.answer_of(a)
                a["dim"] = q["dim"]
                answers.setdefault(prof, {})[q["id"]] = a
                plain.setdefault(prof, {})[q["id"]] = a["answer"]
        grade, why = A.grade_paper(R, strands, plain)
        papers[sid] = {"design": r.get("design"), "second_design": r.get("second_design"), "sector": r.get("sector"),
                       "countries": r.get("countries") or [], "answers": answers, "grade": grade, "grade_why": why,
                       "design_quote_check": A.check_quote(raw, nraw, r.get("design_quote", ""))}
    for line in (folder / "answers" / "passages.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        e = r.get("extraction_id")
        if e not in sheet.get("passages", []):
            bad.append(f"passage not on the sheet: {e}")
            continue
        if r.get("origin") not in A.ORIGINS or r.get("basis") not in A.BASES:
            bad.append(f"{e}: unknown code {r.get('origin')}/{r.get('basis')}")
            continue
        passages[e] = {"origin": r["origin"], "basis": r["basis"], "reason": r.get("reason", "")}
    out = C.state_dir(corpus, "appraise") / "blind" / "coding.json"
    name = name or coder
    note = f"{name}, coding blind" + ("; another model, not a person" if kind == "model" else "")
    C.save_json(out, {"coder": coder, "kind": kind, **({"model": model} if kind == "model" else {}), "name": name,
                      "note": note, "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "sheet": str(folder),
                      "papers": papers, "passages": passages})
    qc = collections.Counter(a["quote_check"] for p in papers.values() for ans in p["answers"].values()
                             for a in ans.values() if a.get("quote"))
    C.counts_header("Blind coding recorded", [
        ("coder", f"{coder} ({'model ' + model if kind == 'model' else 'person'})"), ("papers", f"{len(papers)} of {len(sheet.get('papers', []))}"),
        ("passages", f"{len(passages)} of {len(sheet.get('passages', []))}"),
        ("quotations", ", ".join(f"{k} {n}" for k, n in qc.most_common()) or "none"),
        ("grades", ", ".join(f"{k} {n}" for k, n in collections.Counter(p["grade"] for p in papers.values()).most_common())),
        ("rejected", len(bad)), ("kept in", str(out)),
    ], notes=bad[:10])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--per-code", type=int, default=20)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--codebook", default="", help="sample one codebook only")
    ap.add_argument("--out", default="spotcheck.csv")
    ap.add_argument("--ingest", default="", help="read a filled sheet back in")
    ap.add_argument("--coder", default="", help="the person's coder handle, for --ingest")
    ap.add_argument("--set", dest="cds", default="", help="coding set for --ingest (default cds-<coder>)")
    ap.add_argument("--blind", default="", help="write a blind sheet for the evidence ratings into this folder")
    ap.add_argument("--blind-ingest", default="", help="read a filled blind sheet back from this folder")
    ap.add_argument("--coder-kind", default="human", choices=["human", "model"], help="who coded the blind sheet")
    ap.add_argument("--model", default="", help="the model that coded the blind sheet, with --coder-kind model")
    ap.add_argument("--name", default="", help="how pages name the blind coder (default: --coder)")
    ap.add_argument("--papers", type=int, default=15)
    ap.add_argument("--passages", type=int, default=40)
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    if args.blind:
        return blind_sheet(corpus, Path(args.blind).expanduser(), args.papers, args.passages, args.seed)
    if args.blind_ingest:
        if not args.coder:
            C.die("--blind-ingest needs --coder")
        if args.coder_kind == "model" and not args.model:
            C.die("--coder-kind model needs --model (the model that coded the sheet)")
        return blind_ingest(corpus, Path(args.blind_ingest).expanduser(), args.coder, args.coder_kind, args.model, args.name)
    books, exts, codings = load(corpus)
    sources = C.corpus_reps(corpus)
    by_sid = {s["source_id"]: (a, s) for a, s in sources.items()}

    # ---- read a filled sheet back in ----
    if args.ingest:
        if not args.coder:
            C.die("--ingest needs --coder (the person who checked)")
        rows = list(csv.DictReader(open(args.ingest, encoding="utf-8-sig")))
        records, skipped, bad = [], 0, []
        for r in rows:
            v = (r.get("verdict") or "").strip().lower()
            if not v:
                skipped += 1
                continue
            if v not in VERDICTS:
                bad.append(v)
                continue
            if v == "wrong-span":
                continue          # a span complaint is about the extraction, not the code
            code = r["code"] if v == "agree" else (r.get("correct") or "").strip()
            if v == "not-relevant":
                code = "none"
            if not code:
                bad.append(f"{v} with no 'correct' value")
                continue
            book = books.get(r["codebook_ref"])
            if not book or not any(c["code"] == code for c in book.get("codes", [])):
                bad.append(f"unknown code {code}")
                continue
            records.append({
                "codebook_ref": r["codebook_ref"], "code": code,
                "target": {"kind": "extraction", "id": r["extraction_id"]},
                "coder": args.coder, "confidence": "high", "confidence_score": 1.0,
                "rationale": (r.get("note") or f"spot-check: {v}")[:200],
            })
        cds = args.cds or f"cds-{args.coder}"
        res = C.upc_jsonl("code", "--corpus", str(corpus), "--set", cds,
                          "--coder-kind", "human", "--tool", "upc-corpus", records=records) if records else {"tally": {}}
        C.upc("regen", str(corpus))
        C.counts_header("Spot-check recorded", [
            ("rows in the sheet", len(rows)),
            ("with a verdict", len(rows) - skipped),
            ("written as codings", (res.get("tally") or {}).get("coded", 0)),
            ("unchanged (already agreed)", (res.get("tally") or {}).get("unchanged", 0)),
            ("span complaints (no coding)", sum(1 for r in rows if (r.get('verdict') or '').strip().lower() == 'wrong-span')),
            ("rejected", len(bad)),
            ("coder", f"{args.coder} (human)"),
        ])
        for b in bad[:8]:
            print(f"  rejected: {b}")
        print("Run report.py to see agreement between this and the model.")
        return 0

    # ---- draw the sample ----
    rng = random.Random(args.seed)
    by_code: dict[tuple, list] = {}
    for c in codings:
        t = c.get("target", {})
        if t.get("kind") != "extraction" or t["id"] not in exts:
            continue
        b = books.get(c["codebook_ref"])
        if not b or (args.codebook and b["slug"] != args.codebook):
            continue
        by_code.setdefault((b["slug"], c.get("code", c.get("value"))), []).append(c)

    rows = []
    for (slug, code), items in sorted(by_code.items()):
        rng.shuffle(items)
        for c in items[:args.per_code]:
            e = exts[c["target"]["id"]]
            alias, s = by_sid.get(e["source_id"], ("?", {}))
            rows.append({
                "verdict": "", "correct": "", "note": "",
                "codebook": slug, "code": code, "coder": c["coder"],
                "quote": e.get("direct_quote") or e.get("text", ""),
                "source": f"{alias} {s.get('title', '')[:60]}",
                "year": "", "extraction_id": e["extraction_id"],
                "codebook_ref": c["codebook_ref"],
            })
    out = Path(args.out)
    with open(out, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    C.counts_header("Spot-check sheet", [
        ("codes sampled", len(by_code)),
        ("rows to check", len(rows)),
        ("per code (max)", args.per_code),
        ("seed", args.seed),
        ("written to", str(out)),
    ])
    print("Fill the `verdict` column with: agree / wrong-code / not-relevant / wrong-span.")
    print("For wrong-code, put the right code in `correct`. Then run with --ingest.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
