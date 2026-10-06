#!/usr/bin/env python3
"""Citation measures from OpenAlex, shown beside the evidence grade and never combined with it.

    python3 citations.py fetch --corpus <dir>                  (OpenAlex through ASR, ≤50 DOIs a call)
    python3 citations.py code  --corpus <dir> [--into <clone>] --write   (one `impact` coding per paper)
    python3 citations.py check --corpus <dir>                  (every figure found again in ASR's payload)
    python3 citations.py show  --corpus <dir>

Why apart from the grade: field-normalised citations correlate with expert ratings of
quality at only about 0.1–0.5 (Thelwall et al. 2023), and in a 179-paper library 116 of 178 papers
are already in their field's top 10%, so citations can't separate strong from weak here
(Leiden Manifesto P1, P6, P8; DORA). One source, OpenAlex (providers differ by about 30%),
as its percentile in field and year, in tiers; a paper under 24 months old is "too recent".

Every call goes through ASR (`authority fetch scholarly openalex works-by-doi`), which keeps
the payload in its store and journals the fetch. Each coding's rationale carries the
figures, the fetch id and the payload's sha256; `check` opens that payload again, re-hashes
it and finds every figure in it. `publish.py` refuses to build a corpus with impact codings
unless `check` passes. The coder is a rule (`openalex-impact-v1`, kind `rule`, UPC 1.15.0):
no model or person judged anything here.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

CODER = "openalex-impact-v1"
SELECT = ("id,doi,title,publication_year,publication_date,cited_by_count,citation_normalized_percentile,"
          "fwci,is_retracted,type,primary_topic")
BATCH = 50
TIERS = [
    ("top-1", "Top 1% in field and year", "In the top 1% of works of its field and publication year by citations "
     "(OpenAlex's normalised percentile)."),
    ("top-10", "Top 10% in field and year", "In the top 10%, but not the top 1%, of works of its field and year by "
     "citations (OpenAlex)."),
    ("above-median", "Above the median for its field and year", "Cited more than half the works of its field and "
     "year, but not in the top 10% (OpenAlex)."),
    ("below-median", "Below the median for its field and year", "Cited less than half the works of its field and "
     "year (OpenAlex)."),
    ("too-recent", "Too recent to judge", "Published under 24 months before the figures were fetched: citations "
     "haven't had time to accumulate."),
    ("not-indexed", "Not in OpenAlex", "OpenAlex has no work with this DOI, or it lacks a field percentile."),
]
RATIONALE = re.compile(r"^Cited (?P<cited>\d+) times; percentile (?P<pct>[\d.]+|none) in field and year; "
                       r"FWCI (?P<fwci>[\d.]+|none); retracted: (?P<retracted>yes|no); type (?P<type>[^;]*); "
                       r"subfield (?P<subfield>[^;]*); OpenAlex (?P<wid>W\d+); fetch (?P<fetch>fch-[0-9a-f]+), "
                       r"sha256 (?P<sha>[0-9a-f]{64}); as of (?P<asof>\d{4}-\d{2}-\d{2})\.")


def state(corpus: Path) -> Path:
    return C.state_dir(corpus, "citations")


def dois(corpus: Path) -> dict[str, str]:
    """source id → DOI (lower case), for every source that has one."""
    out = {}
    for sj in sorted(corpus.glob("sources/*/source.json")):
        d = C.load_json(sj, {}) or {}
        doi = ((d.get("bibliographic") or {}).get("doi") or
               next((i.get("value") for i in d.get("identifiers") or [] if i.get("scheme") == "doi"), ""))
        if doi and d.get("source_id"):
            out[d["source_id"]] = doi.strip().lower().removeprefix("https://doi.org/")
    return out


def tier_of(work: dict | None, asof: date) -> str:
    if not work:
        return "not-indexed"
    pub = work.get("publication_date") or f"{work.get('publication_year') or 1900}-01-01"
    y, m, d = (int(x) for x in pub[:10].split("-"))
    if (asof.year - y) * 12 + (asof.month - m) - (1 if asof.day < d else 0) < 24:
        return "too-recent"
    p = work.get("citation_normalized_percentile") or {}
    if p.get("value") is None:
        return "not-indexed"
    if p.get("is_in_top_1_percent"):
        return "top-1"
    if p.get("is_in_top_10_percent"):
        return "top-10"
    return "above-median" if p["value"] >= 0.5 else "below-median"


def rationale(work: dict, fetch: dict, asof: str) -> str:
    p = (work.get("citation_normalized_percentile") or {}).get("value")
    topic = work.get("primary_topic") or {}
    return (f"Cited {work.get('cited_by_count', 0)} times; percentile {'none' if p is None else round(p * 100, 1)} "
            f"in field and year; FWCI {'none' if work.get('fwci') is None else round(work['fwci'], 2)}; "
            f"retracted: {'yes' if work.get('is_retracted') else 'no'}; type {work.get('type') or ''}; "
            f"subfield {((topic.get('subfield') or {}).get('display_name') or '').replace(';', ',')}; "
            f"OpenAlex {str(work.get('id', '')).rsplit('/', 1)[-1]}; fetch {fetch['fetch_id']}, sha256 {fetch['sha256']}; "
            f"as of {asof}.")


def payload_works(path: Path) -> dict[str, dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    return {str(w.get("doi") or "").lower().removeprefix("https://doi.org/"): w for w in d.get("results", [])}


def cmd_fetch(args) -> int:
    corpus = Path(args.corpus).expanduser()
    want = dois(corpus)
    rec = C.load_json(state(corpus) / "fetched.json", {}) or {}
    todo = sorted({d for d in want.values()} - set(rec.get("found", {})) - set(rec.get("missing", []))) \
        if not args.again else sorted(set(want.values()))
    C.counts_header("Citations: fetch", [("sources with a DOI", len(want)), ("to fetch", len(todo)),
                                         ("calls", -(-len(todo) // BATCH)), ("through", "ASR scholarly/openalex works-by-doi")])
    found, fetches = dict(rec.get("found", {})), list(rec.get("fetches", []))
    for i in range(0, len(todo), BATCH):
        batch = todo[i:i + BATCH]
        path, data = C.fetch_raw("scholarly", "openalex", "works-by-doi",
                                 {"doi": "|".join(batch), "per_page": BATCH, "select": SELECT})
        if path is None:
            print(f"  FAILED batch {i // BATCH + 1}: {data.get('note') or data}")
            continue
        works = payload_works(path)
        f = {"fetch_id": data["fetch_id"], "sha256": data["sha256"], "payload": str(path),
             "fetched": date.today().isoformat(), "dois": batch}
        fetches.append(f)
        for d in batch:
            if d in works:
                found[d] = {"fetch_id": f["fetch_id"]}
        print(f"  batch {i // BATCH + 1}: {len(works)} of {len(batch)} found · {data['fetch_id']}")
    missing = sorted(set(want.values()) - set(found))
    C.save_json(state(corpus) / "fetched.json", {"found": found, "missing": missing, "fetches": fetches})
    print(f"\nFound {len(found)} of {len(set(want.values()))} DOIs; not in OpenAlex: {len(missing)}.")
    return 0


def _fetch_by_id(rec: dict) -> dict:
    return {f["fetch_id"]: f for f in rec.get("fetches", [])}


def cmd_code(args) -> int:
    corpus = Path(args.corpus).expanduser()
    into = Path(args.into).expanduser() if args.into else corpus
    rec = C.load_json(state(corpus) / "fetched.json")
    if not rec:
        C.die("nothing fetched yet: run `citations.py fetch` first")
    fx = _fetch_by_id(rec)
    want = dois(into)
    rows, tiers = [], collections.Counter()
    for sid, doi in sorted(want.items()):
        hit = rec["found"].get(doi)
        f = fx.get((hit or {}).get("fetch_id"))
        work = payload_works(Path(f["payload"])).get(doi) if f else None
        asof = date.fromisoformat(f["fetched"]) if f else date.today()
        t = tier_of(work, asof)
        tiers[t] += 1
        row = {"code": t, "target": {"kind": "source", "id": sid}, "coder": CODER}
        if work:
            row["rationale"] = rationale(work, f, asof.isoformat())
        rows.append(row)
    C.counts_header("Citations: code", [("into", str(into)), ("papers", len(rows)), ("tiers", dict(tiers)),
                                        ("coder", f"{CODER} (rule)")])
    if not args.write:
        print("Planning only; nothing was written. Add --write.")
        return 0
    import make_codebooks as MC  # noqa: E402
    book = {"slug": "impact", "title": "Citation impact (OpenAlex)", "unit": "source", "tool": "citations.py",
            "method": "manual", "ext": {"upc-site": {"group": "evidence"}},
            "question": "How often is the paper cited, against others of its field and year? Shown beside the "
                        "evidence grade, never combined with it: citations measure attention, not rigour.",
            "codes": [{"code": c, "label": lab, "definition": d} for c, lab, d in TIERS]}
    ns = C.namespace_of(into, args.namespace)
    obj, dest, status, _ = MC.build_codebook(into, book, ns)
    MC.write_codebooks(into, [(obj, dest, status)])
    for r in rows:
        r["codebook_ref"] = obj["codebook_id"]
    res = C.upc_jsonl("code", "--corpus", str(into), "--set", f"cds-{ns}-impact-v1", "--coder-kind", "rule",
                      "--tool", "citations.py", "--method", "manual", records=rows)
    print(f"Coded: {(res or {}).get('tally')}")
    return cmd_check(argparse.Namespace(corpus=str(into), state_from=str(corpus)))


def impact_codings(corpus: Path) -> list[dict]:
    out = []
    for f in corpus.glob("codings/*/items.jsonl"):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                c = json.loads(line)
                if c.get("coder") == CODER and (c.get("status") or "active") == "active":
                    out.append(c)
    return out


def check(corpus: Path, state_from: Path | None = None) -> tuple[int, list[str]]:
    """(figures checked, problems). Re-hashes each payload and finds every figure again."""
    rec = C.load_json(state(state_from or corpus) / "fetched.json", {}) or {}
    fx = _fetch_by_id(rec)
    want = dois(corpus)
    problems, n, hashed = [], 0, {}
    for c in impact_codings(corpus):
        sid = c["target"]["id"]
        m = RATIONALE.match(c.get("rationale") or "")
        if c.get("code") == "not-indexed" and not c.get("rationale"):
            continue
        if not m:
            problems.append(f"{sid}: rationale doesn't read as figures: {(c.get('rationale') or '')[:80]!r}")
            continue
        f = fx.get(m["fetch"])
        if not f:
            problems.append(f"{sid}: fetch {m['fetch']} isn't in the fetch record")
            continue
        p = Path(f["payload"])
        if p not in hashed:
            hashed[p] = hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
        if hashed[p] != m["sha"] or f["sha256"] != m["sha"]:
            problems.append(f"{sid}: payload {p.name} no longer has sha256 {m['sha'][:12]}…")
            continue
        work = payload_works(p).get(want.get(sid, ""))
        if not work:
            problems.append(f"{sid}: DOI {want.get(sid)} isn't in payload {p.name}")
            continue
        again = rationale(work, f, m["asof"])
        if again != c["rationale"]:
            problems.append(f"{sid}: figures differ from the payload: {again[:90]!r}")
            continue
        if tier_of(work, date.fromisoformat(m["asof"])) != c["code"]:
            problems.append(f"{sid}: tier {c['code']} doesn't follow from the payload")
            continue
        n += 1
    return n, problems


def cmd_check(args) -> int:
    corpus = Path(args.corpus).expanduser()
    n, problems = check(corpus, Path(args.state_from).expanduser() if getattr(args, "state_from", None) else None)
    for p in problems[:20]:
        print(f"  PROBLEM {p}")
    print(f"Citation figures: {n} papers found again in ASR's payloads, {len(problems)} problems.")
    return 0 if not problems else 1


def cmd_show(args) -> int:
    corpus = Path(args.corpus).expanduser()
    cs = impact_codings(corpus)
    t = collections.Counter(c["code"] for c in cs)
    C.counts_header("Citation impact", [(lab, t.get(code, 0)) for code, lab, _ in TIERS] + [("papers", len(cs))])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("fetch", "code", "check", "show"):
        s = sub.add_parser(name)
        s.add_argument("--corpus", required=True)
        if name == "fetch":
            s.add_argument("--again", action="store_true", help="fetch every DOI again")
        if name == "code":
            s.add_argument("--into", default="")
            s.add_argument("--namespace", default="", help="default: the corpus's own")
            s.add_argument("--write", action="store_true")
        if name == "check":
            s.add_argument("--state-from", default="", help="the corpus whose fetch record to use (a clone's original)")
    args = ap.parse_args()
    return {"fetch": cmd_fetch, "code": cmd_code, "check": cmd_check, "show": cmd_show}[args.cmd](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
