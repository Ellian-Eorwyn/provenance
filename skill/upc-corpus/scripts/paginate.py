#!/usr/bin/env python3
"""Give every passage a page number in its original PDF.

    python3 paginate.py --corpus <dir> [--plan] [--force] [--changes <file.json>]

A quotation is verified against the *text extracted from* a PDF, which has no
pages. That is honest but inconvenient: to check a quote against the published
article you need to know where in it to look. This works out where each PDF page
begins in the extracted text, then records the page each passage falls on.

Three things make it safe:

  * **The corpus text is never touched.** The page map is recovered by searching
    the existing text for each page's own letters (pdftext.locate_pages).
    Re-converting differently would change the text's hash and orphan every
    quotation anchored in it.
  * **A page is a `secondary_locator`, which is advisory and excluded from the
    `ext-` identity recipe** (spec/03). So adding one re-mints nothing, dangles
    nothing, and cannot affect whether a quotation verifies. A page number is
    navigation, never evidence — the character range remains the only thing the
    gate looks at.
  * **Every map is checked twice before it is used.** Its health (offsets never
    go backwards, most pages located, each page's share of the text close to its
    length): a source whose map fails gets no new page numbers. And every page
    recorded is checked against the PDF itself: the page whose own text holds
    the quotation's opening letters (pdftext.page_of_quote).

Idempotent: a passage that already has a page is left alone, unless --force.
With --force, --changes writes every page that changed as approved corrections
for `compare_site.py --content --approved`, for the owner to look over first.
"""

from __future__ import annotations

import argparse
import bisect
import datetime
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import pdftext      # noqa: E402


def extraction_files(corpus: Path) -> list[Path]:
    return sorted(list(corpus.glob("sources/*/extractions.jsonl"))
                  + list(corpus.glob("extractions/*/items.jsonl")))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--plan", action="store_true", help="report only; write nothing")
    ap.add_argument("--force", action="store_true", help="recompute pages that are already recorded")
    ap.add_argument("--changes", help="write the pages that changed to this JSON file (compare_site --approved)")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    try:
        C.check_compat()
        C.require_tools("pdftotext")
    except C.Unavailable as e:
        C.die(str(e))

    # --- build a page map per source ---
    maps: dict[str, dict] = {}
    alias_of_rep: dict[str, str] = {}
    pages_total = located = interpolated = empty = text_only = 0
    text_only_reps: set[str] = set()
    unmapped, unhealthy = [], []
    for sj in sorted(corpus.glob("sources/*/source.json")):
        d = C.load_json(sj, {})
        if not d:
            continue
        pdf = next((r for r in d.get("representations", []) if r.get("media_type") == "application/pdf"), None)
        txt = C.reading_copy(d.get("representations", []))
        alias = C.alias_of(d)
        if not pdf:
            text_only += 1  # a text source (e.g. imported from a bundle): its pages came with it
            text_only_reps.update(r["representation_id"] for r in d.get("representations", []))
            continue
        if not txt:
            unmapped.append((alias, "no text copy"))
            continue
        tpath = corpus / txt["path"]
        ppath = corpus / pdf["path"]
        if not tpath.exists() or not ppath.exists():
            unmapped.append((alias, "bytes missing"))
            continue
        try:
            m = pdftext.page_map(str(ppath), tpath.read_text(encoding="utf-8"))
        except Exception as e:
            unmapped.append((alias, f"{type(e).__name__}: {e}"))
            continue
        h = m["health"]
        pages_total += h["pages"]
        located += h["located"]
        interpolated += h["interpolated"]
        empty += h["empty"]
        alias_of_rep[txt["representation_id"]] = alias
        if not h["ok"]:
            why = f"{h['located']} of {h['with_text']} pages with text located"
            if h["odd_lengths"]:
                why += f"; pages {', '.join(map(str, h['odd_lengths'][:6]))} take an odd share of the text"
            if h["backwards"]:
                why += "; offsets go backwards"
            unhealthy.append((alias, why))
            continue
        maps[txt["representation_id"]] = m

    # --- attach a page to each passage, and check it against the PDF ---
    scanned = added = already = skipped = same = 0
    changed_pages: dict[str, dict] = {}
    right = wrong = cannot_tell = 0
    wrong_list = []
    for f in extraction_files(corpus):
        lines = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        dirty = False
        for o in lines:
            if not o.get("direct_quote"):
                continue
            scanned += 1
            secs = o.get("secondary_locators") or []
            had = next((s.get("value") for s in secs if s.get("type") == "page"), None)
            rep = o.get("representation_ref")
            m = maps.get(rep)
            if m is None and rep in text_only_reps:
                continue  # a text-only source: no PDF pages to number
            if had is not None and not args.force:
                already += 1
                page = had
            else:
                loc = o.get("locator") or {}
                start = (loc.get("value") or {}).get("start")
                if not m or loc.get("type") != "char_range" or not isinstance(start, int):
                    skipped += 1
                    continue
                offsets = m["offsets"]
                page = bisect.bisect_right(offsets, start)  # 1-based: offsets[0] is page 1
                page = max(1, min(page, len(offsets)))
                if page == had:
                    same += 1
                else:
                    secs = [s for s in secs if s.get("type") != "page"]
                    secs.append({
                        "type": "page",
                        "representation_ref": rep,
                        "value": page,
                        "unit": "page",
                        "conforms_to": "pdf-open-params",
                    })
                    o["secondary_locators"] = secs
                    added += 1
                    dirty = True
                    if had is not None:
                        changed_pages[o["extraction_id"]] = {"pg": [had, page], "source": alias_of_rep.get(rep, "")}
            if m:
                truth = pdftext.page_of_quote(m["page_letters"], o["direct_quote"])
                if truth is None:
                    cannot_tell += 1
                elif truth == page:
                    right += 1
                else:
                    wrong += 1
                    wrong_list.append((alias_of_rep.get(rep, ""), o.get("extraction_id"), page, truth))
        if dirty and not args.plan:
            tmp = f.with_suffix(f.suffix + ".tmp")
            tmp.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in lines), encoding="utf-8")
            tmp.replace(f)

    C.counts_header("Pages", [
        ("sources mapped", len(maps)),
        ("text-only sources (no PDF; skipped)", text_only),
        ("pages located", f"{located} of {pages_total}"
                          + (f" ({100 * located / pages_total:.0f}%)" if pages_total else "")),
        ("pages placed between neighbours", interpolated),
        ("pages with no text", empty),
        ("sources whose page map looks wrong (no pages recorded)", len(unhealthy)),
        ("sources with no map", len(unmapped)),
        ("passages scanned", scanned),
        ("pages recorded" + (" (planned)" if args.plan else ""), added),
        ("of which corrected an earlier page", len(changed_pages)),
        ("recomputed and unchanged", same),
        ("already had one (left alone)", already),
        ("could not be placed", skipped),
    ])
    for alias, why in (unhealthy + unmapped)[:20]:
        print(f"  {alias}: {why}")
    print(f"\nChecked against the PDF: {right} right, {wrong} wrong, {cannot_tell} can't tell "
          "(their opening words are on several pages, or on none).")
    for alias, eid, page, truth in wrong_list[:20]:
        print(f"  WRONG {alias} {eid}: page {page}, but its opening words are on page {truth}")
    if changed_pages:
        print(f"\nPages that change ({len(changed_pages)}):")
        for eid, c in list(changed_pages.items())[:20]:
            print(f"  {c['source']} {eid}: page {c['pg'][0]} → {c['pg'][1]}")
        if len(changed_pages) > 20:
            print(f"  … and {len(changed_pages) - 20} more")
        if args.changes:
            why = f"page found by its own letters (paginate.py, {datetime.date.today().isoformat()})"
            Path(args.changes).write_text(json.dumps(
                {"passages": {eid: {"pg": c["pg"], "source": c["source"], "why": why}
                              for eid, c in changed_pages.items()}}, ensure_ascii=False, indent=1) + "\n",
                encoding="utf-8")
            print(f"Written for compare_site.py --approved: {args.changes}")
    if args.plan:
        print("Planning only; nothing was written.")
        return 0

    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    state = (f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors"
             if isinstance(rep, dict) else "UNAVAILABLE: validate did not return a report")
    print(f"\nCorpus: {state}")
    if isinstance(rep, dict):
        for e in rep.get("errors", [])[:5]:
            print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:100]}")
    print("A page is navigation, not evidence: the character range is still the only")
    print("thing the quotation gate looks at, and no extraction id changed.")
    print("Pagination finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
