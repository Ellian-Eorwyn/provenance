#!/usr/bin/env python3
"""What is in the corpus, and what should worry you about it.

    python3 report.py --corpus <dir> [--codebook theory] [--json]

This is the script the agent reads before judging anything. It precomputes every
number so no tallying is needed, and it separates three things that look alike
in a raw validator dump:

  * **broken** — the corpus does not hold together (errors)
  * **worth a look** — advisories that are normal in an active corpus
  * **quiet** — sources nothing was found in, codes nobody used

Agreement between coders is computed here and never stored: it is a projection
of the codings, and storing it would let it go stale (spec/12).
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402


def load_codings(corpus: Path) -> list[dict]:
    out = []
    for items in sorted(corpus.glob("codings/*/items.jsonl")):
        for line in items.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def load_extractions(corpus: Path) -> dict[str, dict]:
    out = {}
    paths = list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl"))
    for f in paths:
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            out[o["extraction_id"]] = o
    return out


def cohens_kappa(pairs: list[tuple[str, str]]) -> float | None:
    """Chance-corrected agreement for two raters over the same targets."""
    if not pairs:
        return None
    n = len(pairs)
    agree = sum(1 for a, b in pairs if a == b) / n
    labels = {l for p in pairs for l in p}
    pe = sum((sum(1 for a, _ in pairs if a == l) / n) * (sum(1 for _, b in pairs if b == l) / n)
             for l in labels)
    return None if pe >= 1 else round((agree - pe) / (1 - pe), 3)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--codebook", default="", help="detail one codebook by slug")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    if not (corpus / "corpus.json").exists():
        C.die(f"{corpus} is not a corpus")

    rep = C.upc("validate", str(corpus))
    errors = rep.get("errors", [])
    warnings = rep.get("warnings", [])
    books = {}
    for f in sorted((corpus / "codebooks").glob("cbk-*.json")):
        b = C.load_json(f)
        if b:
            books[b["codebook_id"]] = b
    codings = [c for c in load_codings(corpus) if (c.get("status") or "active") == "active"]
    exts = load_extractions(corpus)
    sources = C.corpus_reps(corpus)

    # --- per code, per unit ---
    per_code = collections.Counter()
    per_code_sources = collections.defaultdict(set)
    coders = collections.Counter()
    for c in codings:
        b = books.get(c["codebook_ref"])
        slug = b["slug"] if b else c["codebook_ref"]
        label = c.get("code", c.get("value"))
        per_code[(slug, label)] += 1
        coders[c["coder"]] += 1
        tgt = c.get("target", {})
        if tgt.get("kind") == "extraction":
            e = exts.get(tgt["id"])
            if e:
                per_code_sources[(slug, label)].add(e["source_id"])
        elif tgt.get("kind") == "source":
            per_code_sources[(slug, label)].add(tgt["id"])

    coded_sources = {e["source_id"] for e in exts.values()}
    quiet = [a for a, i in sources.items() if i["source_id"] not in coded_sources]
    unused = [(b["slug"], c["code"]) for b in books.values() for c in b.get("codes", [])
              if not per_code.get((b["slug"], c["code"]))]
    refound = [e for e in exts.values() if (e.get("anchoring") or {}).get("method") == "normalized"]

    # --- agreement, only where two coders judged the same target ---
    by_target = collections.defaultdict(dict)
    for c in codings:
        b = books.get(c["codebook_ref"])
        if not b or b.get("multi_label"):
            continue           # agreement on a multi-label code is a different statistic
        t = c.get("target", {})
        by_target[(b["slug"], t.get("kind"), t.get("id"))][c["coder"]] = c.get("code", c.get("value"))
    agreement = {}
    for (slug, _, _), judged in by_target.items():
        if len(judged) < 2:
            continue
        names = sorted(judged)
        agreement.setdefault(slug, {"pairs": [], "raters": set()})
        agreement[slug]["pairs"].append((judged[names[0]], judged[names[1]]))
        agreement[slug]["raters"].update(names)

    summary = {
        "status": rep.get("status"), "level": rep.get("level"),
        "errors": len(errors), "warnings": len(warnings),
        "sources": len(sources), "passages": len(exts), "codings": len(codings),
        "codebooks": len(books), "coders": dict(coders),
        "sources_with_no_passages": len(quiet),
        "codes_never_used": len(unused),
        "anchored_by_normalization": len(refound),
    }
    if args.json:
        print(json.dumps({"summary": summary,
                          "per_code": {f"{s}:{c}": {"passages": n, "sources": len(per_code_sources[(s, c)])}
                                       for (s, c), n in sorted(per_code.items())},
                          "quiet_sources": quiet, "codes_never_used": unused}, indent=1))
        return 0

    C.counts_header("Corpus", [
        ("state", f"{rep.get('status')} at {rep.get('level')}"),
        ("errors", len(errors)),
        ("advisories", len(warnings)),
        ("sources", len(sources)),
        ("passages", len(exts)),
        ("codings", len(codings)),
        ("codebooks", len(books)),
        ("coders", ", ".join(f"{k} ({v})" for k, v in coders.most_common()) or "none"),
    ])

    if errors:
        print("BROKEN — these must be fixed:")
        for code, n in collections.Counter(e["code"] for e in errors).most_common():
            print(f"  {n:5}  {code}")
        print()

    if warnings:
        print("Advisories (normal in an active corpus):")
        for code, n in collections.Counter(w["code"] for w in warnings).most_common(10):
            print(f"  {n:5}  {code}")
        print()

    for b in sorted(books.values(), key=lambda x: x["slug"]):
        if args.codebook and b["slug"] != args.codebook:
            continue
        rows = [(c["code"], c.get("label", c["code"]),
                 per_code.get((b["slug"], c["code"]), 0),
                 len(per_code_sources.get((b["slug"], c["code"]), ())))
                for c in b.get("codes", [])]
        rows.sort(key=lambda r: (-r[2], r[0]))
        total = sum(r[2] for r in rows)
        unit = b.get("unit", "passage")
        print(f"## {b['title']}  ({total} codings, unit: {unit})")
        for code, label, n, ns in rows:
            bar = "█" * min(30, round(n / max(1, max(r[2] for r in rows)) * 30)) if n else ""
            what = ("source" if unit == "source" else "passage") + ("" if n == 1 else "s")
            where = "source" + ("" if ns == 1 else "s")
            print(f"  {label[:34]:34} {n:5} {what:9} in {ns:4} {where:8} {bar}")
        print()

    if agreement:
        print("Agreement between coders (computed here, never stored):")
        for slug, d in sorted(agreement.items()):
            pairs = d["pairs"]
            pct = 100 * sum(1 for a, b2 in pairs if a == b2) / len(pairs)
            k = cohens_kappa(pairs)
            print(f"  {slug:24} {len(pairs):4} shared targets  {pct:5.0f}% agree  "
                  f"kappa {k if k is not None else 'n/a'}  ({', '.join(sorted(d['raters']))})")
        print()
    elif len(coders) > 1:
        print("Two coders exist but never judged the same target, so agreement cannot be computed.\n")

    if quiet:
        print(f"Sources with no passages ({len(quiet)}): {', '.join(sorted(quiet)[:14])}"
              f"{' …' if len(quiet) > 14 else ''}")
    if unused:
        print(f"Codes never used ({len(unused)}): "
              f"{', '.join(f'{s}/{c}' for s, c in unused[:14])}{' …' if len(unused) > 14 else ''}")
    if refound:
        print(f"Passages located after normalising the model's wording: {len(refound)} "
              f"(each stores the document's own characters; all were gated)")
    print("\nReport complete.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
