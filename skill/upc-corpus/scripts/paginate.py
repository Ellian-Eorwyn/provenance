#!/usr/bin/env python3
"""Give every passage its place in the original: a page in a PDF, a section and paragraph in a full-text XML.

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

A full-text XML (a publisher's version of record, xmltext.py) has no pages, so its passages are placed by the
paper's own sections instead, the same three ways round:

  * **The reading copy is never touched.** The XML original is read again by xmltext.structure(), and its text is
    compared byte for byte with the stored reading copy. Only when they are the same is the map used; a source
    whose text was made by another version of xmltext gets no map and is named.
  * **The map is a representation of its own** (spec/02: `metadata`, application/vnd.upc.structure+json, its parent
    the reading copy), stored once beside it. It says what each block of the reading copy is, which section holds
    it and its paragraph number there, so the reader's site can show headings, tables and captions as they are
    and number the paragraphs in the margin.
  * **A section is a `secondary_locator`** (`type: "section"`, the section as the paper names it, its label,
    title and the passage's paragraph), advisory and outside the id recipe like a page: a passage then cites as
    "§3.2 ¶4" where a PDF passage says "p. 12".

Idempotent: a passage that already has a page or a section is left alone, unless --force.
With --force, --changes writes every page that changed as approved corrections
for `compare_site.py --content --approved`, for the owner to look over first.
"""

from __future__ import annotations

import argparse
import bisect
import datetime
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import pdftext      # noqa: E402
import xmltext      # noqa: E402

TOOL = {"tool": "upc-corpus/paginate", "tool_version": "1.1.0"}


def extraction_files(corpus: Path) -> list[Path]:
    return sorted(list(corpus.glob("sources/*/extractions.jsonl"))
                  + list(corpus.glob("extractions/*/items.jsonl")))


def xml_maps(corpus: Path, found: list, plan: bool) -> tuple[dict, dict]:
    """Each full-text XML source's structure map, stored as a representation if it is not yet. -> (maps by the
    reading copy's id, what happened)."""
    maps, made, have, differ, none, missing, added_reps = {}, 0, 0, [], 0, [], []
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for sj, d, xml, txt in found:
        alias = C.alias_of(d)
        old = next((r for r in d.get("representations", []) if r.get("media_type") == C.STRUCTURE
                    and r.get("parent_representation_ref") == txt["representation_id"]), None)
        if old and (corpus / old["path"]).exists():
            m = C.load_json(corpus / old["path"])
            if isinstance(m, dict) and m.get("blocks"):
                maps[txt["representation_id"]] = m
                have += 1
                continue
        tpath, xpath = corpus / txt["path"], corpus / xml["path"]
        if not tpath.exists() or not xpath.exists():
            missing.append(alias)
            continue
        try:
            s = xmltext.structure(str(xpath))
        except Exception as e:  # noqa: BLE001
            missing.append(f"{alias} ({type(e).__name__}: {e})")
            continue
        if s["map"] is None:
            none += 1  # rawtext or not a full text: no structure the XML vouches for
            continue
        if s["text"].encode("utf-8") != tpath.read_bytes():
            differ.append(alias)
            continue
        maps[txt["representation_id"]] = s["map"]
        made += 1
        if not plan:
            rec, _ = C.add_child_rep(
                corpus, sj, txt, xmltext.map_bytes(s["map"]), Path(txt["path"]).stem + ".structure.json",
                role="metadata", media_type=C.STRUCTURE, produced_by="conversion",
                provenance={"produced_by": {**TOOL, "method": "conversion"}, "created_at": now,
                            "derived_from": {"source_ids": [d["source_id"]],
                                             "representation_refs": [xml["representation_id"],
                                                                     txt["representation_id"]]}})
            added_reps.append(rec["representation_id"])
    if added_reps:
        C.upc("event", "--corpus", str(corpus), check=False, stdin=json.dumps({
            "activity_type": "extract", **TOOL, "started_at": now, "status": "success",
            "outputs": {"representation_refs": added_reps},
            "notes": f"structure maps of {len(added_reps)} reading copies made from full-text XML ({s_version()})",
        }))
    return maps, {"made": made, "have": have, "differ": differ, "none": none, "missing": missing}


def s_version() -> str:
    return f"xmltext {xmltext.VERSION}"


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
    xml_found = []
    for sj in sorted(corpus.glob("sources/*/source.json")):
        d = C.load_json(sj, {})
        if not d:
            continue
        pdf = next((r for r in d.get("representations", []) if r.get("media_type") == "application/pdf"), None)
        txt = C.reading_copy(d.get("representations", []))
        alias = C.alias_of(d)
        xml = next((r for r in d.get("representations", []) if r.get("media_type") in C.XML_TYPES and txt
                    and txt.get("parent_representation_ref") == r.get("representation_id")), None)
        if xml and not pdf:
            xml_found.append((sj, d, xml, txt))  # placed by its sections, below
            continue
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

    # --- a full-text XML's structure map, for its sections ---
    sec_maps, xs = xml_maps(corpus, xml_found, args.plan)
    sec_added = sec_already = sec_same = sec_skipped = 0

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
            if rep in sec_maps:
                loc = o.get("locator") or {}
                start = (loc.get("value") or {}).get("start")
                secs = o.get("secondary_locators") or []
                had = next((s for s in secs if s.get("type") == "section" and s.get("block")), None)
                if had is not None and not args.force:
                    sec_already += 1
                    continue
                place = xmltext.place(sec_maps[rep], start) if loc.get("type") == "char_range" and \
                    isinstance(start, int) else None
                if place is None:
                    sec_skipped += 1
                    continue
                new = {"type": "section", "representation_ref": rep, **{k: v for k, v in place.items() if k != "type"}}
                if new == had:
                    sec_same += 1
                    continue
                o["secondary_locators"] = [s for s in secs if s is not had] + [new]
                sec_added += 1
                dirty = True
                continue
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
    if xml_found:
        print()
        C.counts_header("Sections (full-text XML)", [
            ("XML sources", len(xml_found)),
            ("structure maps made" + (" (planned)" if args.plan else ""), xs["made"]),
            ("structure maps already stored", xs["have"]),
            ("text differs from what " + s_version() + " makes (no map)", len(xs["differ"])),
            ("no structure in the XML (rawtext; their passages keep line numbers)", xs["none"]),
            ("XML or text missing", len(xs["missing"])),
            ("sections recorded" + (" (planned)" if args.plan else ""), sec_added),
            ("recomputed and unchanged", sec_same),
            ("already had one (left alone)", sec_already),
            ("could not be placed", sec_skipped),
        ])
        for alias in (xs["differ"] + xs["missing"])[:20]:
            print(f"  {alias}: " + ("its reading copy is not what " + s_version() + " makes from its XML"
                                    if alias in xs["differ"] else "missing"))
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
    print("A page or a section is navigation, not evidence: the character range is still")
    print("the only thing the quotation gate looks at, and no extraction id changed.")
    print("Pagination finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
