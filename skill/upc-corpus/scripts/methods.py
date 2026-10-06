#!/usr/bin/env python3
"""Fill the Methods page with the corpus's own numbers.

    python3 methods.py --corpus <dir> --original https://example.org/library/1.0/ --out <methods.md>

Reads the template, the corpus's own if it has one (<corpus>/.upc/upc-corpus/site/
methods.template.md: its words are the project's to change), else
../references/methods.template.md, and fills every {name} from the corpus and the rating records: counts of papers and
passages, designs and grades from the ratings `store` confirmed, agreement from
`appraise.py report`, citation tiers from the impact codings, and statement confidence
for the original and the revised overviews from the vote. A {name} with no value stops
the script rather than printing a blank. The page is then passed to `publish.py --about`.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import appraise as A  # noqa: E402
import citations as CIT  # noqa: E402
import common as C  # noqa: E402

TEMPLATE = Path(__file__).resolve().parent.parent / "references" / "methods.template.md"
GRADE_ORDER = ["High", "Moderate", "Low", "Very low", A.NA]


def pct(x) -> str:
    return "—" if x is None else f"{round(100 * x)}%"


def counted(c: collections.Counter, order: list | None = None, label=lambda k: k) -> str:
    keys = [k for k in (order or []) if c.get(k)] + [k for k, _ in c.most_common() if k not in (order or [])]
    return ", ".join(f"{label(k)} {c[k]}" for k in keys if k is not None)


def numbers(corpus: Path, original: str) -> dict:
    R = A.rubric(corpus)
    data = A.load_corpus(corpus)
    base = A.state(corpus)
    confirmed = C.load_json(base / "store" / "confirmed.json") or {}
    vote = C.load_json(base / "vote.json") or {}
    report = C.load_json(base / "report.json") or {}
    papers = confirmed or vote.get("papers", {})
    corp = C.load_json(corpus / "corpus.json", {}) or {}
    proposed = sum((C.load_json(f, {}) or {}).get("proposed", 0)
                   for f in (corpus / ".upc" / "upc-corpus" / "code_pass").glob("*/*.json"))

    designs = collections.Counter()
    for p in papers.values():
        d = (p.get("design") or {}).get("design")
        if d:
            designs[R["by_code"][d]["label"].lower() if d in R["by_code"] else d] += 1
    grades = collections.Counter(p.get("grade") for p in papers.values() if p.get("grade"))
    origins = collections.Counter(v.get("origin") for p in papers.values() for v in (p.get("passages") or {}).values()
                                  if v.get("origin"))

    rr = report.get("run_to_run", {})
    run_agree = "; ".join(f"{pct(rr[k]['all_agree'])} of {what}" for k, what in (
        ("design", "designs"), ("criteria (all questions)", "checklist answers"),
        ("claim-origin", "whose-claim labels"), ("claim-basis", "what-backs-it labels"),
        ("statement verdict", "statement checks")) if k in rr)
    vb = report.get("vs_blind", {})
    blind_line = "; ".join(f"on {what} {pct(vb[k]['agree'])} of the time (κ {A.fmt(vb[k]['kappa'])}, AC1 {A.fmt(vb[k]['ac1'])})"
                           for k, what in (("design", "the design"), ("grade", "the grade"),
                                           ("criteria (all questions)", "the checklist answers"),
                                           ("claim-origin", "whose claim a passage makes"),
                                           ("claim-basis", "what backs it")) if k in vb)
    blind = C.blind_coding(corpus)

    impact = collections.Counter(c["code"] for c in CIT.impact_codings(corpus))
    labels = {code: lab.lower() for code, lab, _ in CIT.TIERS}
    fetched = C.load_json(CIT.state(corpus) / "fetched.json") or {}
    fdate = max((f.get("fetched", "") for f in fetched.get("fetches", [])), default="")

    # the current revisions (criteria-v2, or v2.1 with claim groups; one superseded by a later revision is
    # left out) against the overviews and home summary as hosted
    syns = data["syntheses"]
    is_rev = lambda d: str(((d.get("ext") or {}).get("upc-corpus") or {}).get("criteria", "")).startswith("criteria-v2")  # noqa: E731
    replaced = {d.get("supersedes") for d in syns.values() if d.get("supersedes")}
    revised = {s for s, d in syns.items() if is_rev(d) and s not in replaced}
    is_home = lambda d: (((d.get("ext") or {}).get("upc-site") or {}).get("placement") == "home")  # noqa: E731
    home = {s for s in revised if is_home(syns[s])}
    revised -= home
    old = {s for s, d in syns.items() if d.get("type") in ("thematic", "answer") and not is_rev(d)}
    conf_old, conf_new, conf_home = collections.Counter(), collections.Counter(), collections.Counter()
    sup_old, sup_new, sup_home = collections.Counter(), collections.Counter(), collections.Counter()
    same_lead = 0
    for s, recs in (vote.get("statements") or {}).items():
        for r in recs.values():
            which = 0 if s in old else 1 if s in revised else 2 if s in home else None
            if which is None:
                continue
            (conf_old, conf_new, conf_home)[which][r["confidence"]["label"]] += 1
            (sup_old, sup_new, sup_home)[which][A.SUPPORT.get(r["confidence"]["label"], "weak")] += 1
            same_lead += which == 1 and bool((r.get("plain") or {}).get("same_lead"))
    places = collections.Counter(k for p in papers.values() if p.get("grade")
                                 for k in A.places_of((p.get("design") or {}).get("countries") or []))
    place_label = {k: lab for k, lab, _ in A.PLACES}
    home_model = next(((((syns[s].get("provenance") or {}).get("produced_by") or {}).get("model")) for s in home), "")
    single = tot = 0
    for s in old:
        for c in data["syntheses"][s].get("claims", []):
            srcs = {data["exts"][e]["source_id"] for e in c.get("evidence_ids", []) if e in data["exts"]}
            if srcs:
                tot += 1
                single += len(srcs) == 1
    order = ["very high", "high", "medium", "low", "very low", "not supported by its passages", "runs disagreed", "not checked"]
    return {
        "title": corp.get("title", "library"), "date": time.strftime("%-d %B %Y"), "original": original,
        "papers": len(data["sources"]), "passages": f"{len(data['exts']):,}", "proposed": f"{proposed:,}" if proposed else "",
        "themes": len(revised), "revision_label": "Revised from rated evidence",
        "model": A.MODEL, "temperature": A.TEMPERATURE,
        "designs_line": counted(designs), "grades_line": counted(grades, GRADE_ORDER),
        "origins_line": counted(origins, A.ORIGINS, lambda k: A.ORIGIN_LABEL.get(k, k).lower()),
        "run_agree": run_agree, "blind_papers": len(blind.get("papers", {})), "blind_passages": len(blind.get("passages", {})),
        "blind_who": (f"{blind['name']} (another model, not a person)" if blind.get("kind") == "model"
                      else blind.get("name", "")),
        "blind_line": blind_line, "impact_line": counted(impact, [c for c, _, _ in CIT.TIERS], lambda k: labels[k]),
        "citations_date": time.strftime("%-d %B %Y", time.strptime(fdate, "%Y-%m-%d")) if fdate else "",
        "old_single": single, "old_statements": tot,
        "conf_old": counted(conf_old, order), "conf_new": counted(conf_new, order),
        "support_old": plain_counts(sup_old), "support_new": plain_counts(sup_new),
        "home_line": f"{sum(sup_home.values())} statements, " + plain_counts(sup_home), "home_model": home_model,
        "same_lead": same_lead, "origin_agree": pct((rr.get("claim-origin") or {}).get("all_agree")),
        "places_line": counted(places, [k for k, _, _ in A.PLACES], lambda k: place_label[k].lower()
                               .replace("united states", "United States").replace("europe", "Europe")),
    }


def plain_counts(c: collections.Counter) -> str:
    return ", ".join(f"{c[k]} {A.SUPPORT_LABEL[k].lower()}" for k in ("well", "some", "limited", "weak"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--original", required=True, help="the original edition's address")
    ap.add_argument("--out", required=True)
    ap.add_argument("--template", default="", help="default: the corpus's own, else the shipped one")
    args = ap.parse_args()
    own = Path(args.corpus).expanduser() / ".upc" / "upc-corpus" / "site" / "methods.template.md"
    args.template = args.template or str(own if own.exists() else TEMPLATE)
    nums = numbers(Path(args.corpus).expanduser(), args.original)
    empty = [k for k, v in nums.items() if v in ("", None)]
    if empty:
        C.die(f"no value for {', '.join(empty)}: run the ratings, report, citations and the revised overviews first")
    text = Path(args.template).read_text(encoding="utf-8")
    # A template's "**Draft …" line is for whoever approves the wording, not the page.
    text = "\n".join(ln for ln in text.splitlines() if not ln.startswith("**Draft"))
    out = text.format_map(nums)
    Path(args.out).write_text(out.replace("\n\n\n", "\n\n"), encoding="utf-8")
    print(json.dumps({"status": "ok", "out": args.out, **{k: nums[k] for k in ("papers", "passages", "themes")}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
