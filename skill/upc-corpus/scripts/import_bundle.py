#!/usr/bin/env python3
"""A literature-extraction bundle -> a UPC corpus.

    python3 import_bundle.py --bundle <dir> --corpus <dir> [--namespace literature] [--title T] [--limit N] [--plan]

The literature-extraction skill writes a bundle (`export-bundle`): a reading
copy of every document, its catalog data from the YAML header, and, from a
run, its evidence items with each quotation's exact characters in the reading
copy. This puts them into a UPC corpus, so the rest of this skill (codebook
coding, screening, search, spot-checks, overviews, the browsable site) works
on material that never was a PDF with a manifest: a folder of Markdown notes.

What goes where:

  * each document -> a source with two copies: the reading copy first (the site
    shows the first text copy and highlights quotations in it, and passages are
    anchored in it; `parent` points at the original) and the original file;
  * each item with a placed quotation -> a passage through `upc anchor`,
    carrying the item's paraphrase as `text`, its explicit/inferred label and
    its confidence. claim/finding/method/limitation/definition keep their UPC
    type, quoted_evidence becomes `quote`, every other type `evidence`;
  * each item's own type -> a coding in the `item-type` codebook (multi-label,
    so two items quoting one span keep both types). Its rationale is the item's
    paraphrase, because the site shows coding rationales ("Why:") and never an
    extraction's `text`;
  * page and section -> secondary locators: navigation, never identity.

Nothing is forced. An item whose quotation is missing, too short to place, or
occurs more than once in its document stays in the extraction run and is
listed. Resumable and idempotent: `upc` recognises what it already holds, and
a document whose reading copy changed since it was imported is refused rather
than added a second time.
"""

from __future__ import annotations

import argparse
import bisect
import json
import os
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C           # noqa: E402
import make_codebooks as MC  # noqa: E402

BUNDLE_FORMAT = "literature-extraction-bundle/1"
TOOL = "upc-corpus"
TOOL_VERSION = "1.1.0"
DEFAULT_NAMESPACE = "literature"
NATIVE_TYPES = {"claim", "finding", "method", "limitation", "definition"}
CSL_TYPES = {
    "forum post": "post", "html article": "webpage", "web page": "webpage", "webpage": "webpage",
    "journal article": "article-journal", "article": "article-journal", "book": "book", "chapter": "chapter",
}
CONF_SCORE = {"high": 0.9, "medium": 0.6, "low": 0.3}
CODING_BATCH = 2000
RATIONALE_CHARS = 300
# Each `upc anchor` call reloads the whole corpus (upc.mjs anchorCmd), so one
# call per document costs more as the corpus grows. Measured 2026-09-21: 0.08 s
# per call at 12 sources, 0.20 s at 500; a 500-post import took 2.1 minutes.
ANCHOR_BASE_SECONDS = 0.18
ANCHOR_SECONDS_PER_SOURCE = 0.00025
# Each call also rewrites its whole extraction set, so a large import is spread
# over sets of this many documents (one set for 9,245 forum posts would mean
# tens of gigabytes of rewrites).
DOCUMENTS_PER_SET = 500


def slugify(text: str, limit: int = 60) -> str:
    value = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")[:limit].strip("-") or "source"


def upc_type(item_type: str) -> str:
    if item_type == "quoted_evidence":
        return "quote"
    return item_type if item_type in NATIVE_TYPES else "evidence"


def type_code(item_type: str) -> str:
    """Codes appear in site URLs and [theme:book/code] links: no underscores."""
    return str(item_type).replace("_", "-")


def read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def load_bundle(directory: Path) -> tuple[dict, list[dict], list[dict]]:
    bundle = C.load_json(directory / "bundle.json")
    if not bundle or bundle.get("format") != BUNDLE_FORMAT:
        raise C.Unavailable(f"{directory} is not a literature-extraction bundle ({BUNDLE_FORMAT}); "
                            "write one with `literature-extraction.py export-bundle`")
    return bundle, read_jsonl(directory / "sources.jsonl"), read_jsonl(directory / "items.jsonl")


def placeable(item: dict) -> bool:
    return bool(item.get("span")) and item.get("occurrences") == 1


def corpus_namespace(corpus: Path, requested: str | None) -> str:
    """One namespace per corpus: the one earlier imports recorded, else the
    one its codebooks use, else --namespace, else "literature". A mismatch
    would mint a second `item-type` codebook with a colliding slug."""
    recorded = (C.load_json(corpus / ".upc" / "upc-corpus" / "imports" / "namespace.json", {}) or {}).get("namespace")
    books = [C.load_json(f, {}) for f in sorted((corpus / "codebooks").glob("cbk-*.json"))]
    used = Counter(b.get("namespace") for b in books if b and b.get("namespace")).most_common(1)
    existing = recorded or (used[0][0] if used else None)
    if requested and existing and requested != existing:
        raise C.Unavailable(f"this corpus uses the namespace '{existing}'; import with --namespace {existing}")
    namespace = requested or existing or DEFAULT_NAMESPACE
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", namespace):
        raise C.Unavailable(f"namespace '{namespace}' must be lowercase letters, digits and hyphens")
    return namespace


def source_record(entry: dict, bundle_dir: Path, namespace: str, bundle: dict, now: str) -> tuple[dict, str | None]:
    """A `upc add source` record and a note when the original file is gone."""
    title = entry.get("title") or entry["documentId"]
    authors = [a for a in entry.get("authors") or [] if isinstance(a, dict) and a.get("family")]
    year = entry.get("year")
    original = Path(entry["originalPath"])
    bib = {"item_type": CSL_TYPES.get(str(entry.get("sourceType") or "").strip().lower(), "document"), "title": title}
    evidence = {"title": {"value": title, "origin": "user_provided", "evidence": f"catalog header of {original.name}"}}
    if authors:
        bib["authors"] = authors
        from_name = entry.get("authorsFrom") == "file name"
        evidence["authors"] = {"value": "; ".join(a["family"] for a in authors),
                               "origin": "filename" if from_name else "user_provided",
                               "evidence": f"{'file name' if from_name else 'catalog header'} of {original.name}",
                               "confidence": 0.7 if from_name else 0.9}
    if isinstance(year, int):
        bib["issued"] = {"date_parts": [[year]]}
        from_name = entry.get("yearFrom") == "file name"
        evidence["year"] = {"value": year, "origin": "filename" if from_name else "user_provided",
                            "evidence": f"{'file name' if from_name else 'catalog header'} of {original.name}"
                                        + (f"; {entry['yearNote']}" if entry.get("yearNote") else ""),
                            "confidence": 0.5 if entry.get("yearNote") else 0.9}
    if entry.get("url"):
        bib["url"] = entry["url"]  # only here: a top-level url would set the source's identity
    first = authors[0]["family"] if authors else ""
    files = [{"path": str(bundle_dir / entry["text"]), "role": "text", "media_type": "text/plain",
              "produced_by": "conversion"}]
    note = None
    if original.is_file():
        files[0]["parent"] = 1
        files.append({"path": str(original),
                      "role": "markdown" if entry.get("originalMediaType") == "text/markdown" else "text",
                      "media_type": entry.get("originalMediaType") or "text/markdown", "produced_by": "import"})
    else:
        note = f"original file missing ({original}); imported the reading copy only"
    record = {
        "slug": slugify("-".join(part for part in (first, str(year or ""), title) if part)),
        "title": title,
        "source_kind": "document",
        "bibliographic": bib,
        "field_evidence": evidence,
        "aliases": {namespace: entry["documentId"]},
        "files": files,
        "provenance": {"produced_by": {"tool": TOOL, "tool_version": TOOL_VERSION, "method": "import"},
                       "created_at": now},
        "ext": {"literature-extraction": {"bundle": bundle.get("name"), "documentId": entry["documentId"],
                                          "run": (bundle.get("run") or {}).get("directory"),
                                          "status": entry.get("status")}},
    }
    return record, note


def bare_sha(value: str | None) -> str:
    return str(value or "").split(":", 1)[-1]


def locators_for(entry: dict, rep: str, start: int) -> list[dict]:
    """Page and section secondary locators for a passage starting at ``start``
    in the reading copy. Every locator names its representation; a page must be
    a whole number from 1, a section a non-empty heading (one malformed locator
    fails the whole corpus at validation level 0)."""
    out = []
    pages = entry.get("pages") or []
    index = bisect.bisect_right([offset for offset, _label in pages], start) - 1
    if index >= 0 and str(pages[index][1]).isdigit() and int(pages[index][1]) >= 1:
        out.append({"type": "page", "representation_ref": rep, "value": int(pages[index][1]), "unit": "page"})
    sections = entry.get("sections") or []
    index = bisect.bisect_right([offset for offset, _heading in sections], start) - 1
    if index >= 0 and str(sections[index][1]).strip():
        out.append({"type": "section", "representation_ref": rep, "value": str(sections[index][1]).strip()})
    return out


class ImportLock:
    """`upc` takes no lock and every write rewrites whole files, so two imports
    into one corpus must never overlap."""

    def __init__(self, corpus: Path):
        self.path = C.state_dir(corpus) / "import.lock"

    def __enter__(self):
        try:
            handle = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                holder = int(self.path.read_text().strip() or 0)
                os.kill(holder, 0)
                raise C.Unavailable(f"another import (PID {holder}) is writing to this corpus") from None
            except (ValueError, ProcessLookupError, PermissionError):
                self.path.unlink(missing_ok=True)  # a dead holder's lock
                handle = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(handle, str(os.getpid()).encode())
        os.close(handle)
        return self

    def __exit__(self, *_exc):
        self.path.unlink(missing_ok=True)


def estimate_minutes(existing_sources: int, new_sources: int, anchor_calls: int) -> float:
    mean_size = existing_sources + new_sources / 2
    return round(anchor_calls * (ANCHOR_BASE_SECONDS + ANCHOR_SECONDS_PER_SOURCE * mean_size) / 60, 1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bundle", required=True, help="a folder written by literature-extraction export-bundle")
    ap.add_argument("--corpus", required=True, help="a new or existing UPC corpus folder")
    ap.add_argument("--namespace", default=None, help=f"alias and codebook namespace (default {DEFAULT_NAMESPACE}, "
                                                      "or whatever this corpus already uses)")
    ap.add_argument("--title", default="", help="title of a new corpus (default: the bundle's name)")
    ap.add_argument("--limit", type=int, default=0, help="import at most N documents (a pilot)")
    ap.add_argument("--plan", action="store_true", help="report what would happen; write nothing")
    args = ap.parse_args()

    bundle_dir = Path(args.bundle).expanduser().resolve()
    corpus = Path(args.corpus).expanduser().resolve()
    try:
        spec = C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))
    bundle, entries, items = load_bundle(bundle_dir)
    name = bundle.get("name") or bundle_dir.name
    key = slugify(name, 40)
    coder = f"le-{key}"
    namespace = corpus_namespace(corpus, args.namespace)
    run = bundle.get("run") or {}
    prompt_version = run.get("promptVersion") or "literature-extraction"
    state_path = corpus / ".upc" / "upc-corpus" / "imports" / key / "state.json"
    state = C.load_json(state_path, {}) or {}
    done = state.get("documents", {})

    items_by_doc: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        items_by_doc[item["documentId"]].append(item)
    todo = [e for e in entries if not done.get(e["documentId"], {}).get("complete")]
    if args.limit:
        todo = todo[: args.limit]
    todo_items = [item for e in todo for item in items_by_doc.get(e["documentId"], [])]
    reasons = Counter(item.get("notResolved") or "occurs more than once" for item in todo_items if not placeable(item))
    existing_sources = len(list(corpus.glob("sources/*/source.json")))
    anchor_calls = sum(1 for e in todo if any(placeable(i) for i in items_by_doc.get(e["documentId"], [])))

    C.counts_header("Import plan", [
        ("bundle", f"{name} ({'sources only' if bundle.get('sourcesOnly') else 'sources and items'})"),
        ("documents in bundle", len(entries)),
        ("already imported", sum(1 for e in entries if done.get(e["documentId"], {}).get("complete"))),
        ("to import now", len(todo)),
        ("items to import", len(todo_items)),
        ("  with a placed quotation", sum(1 for i in todo_items if placeable(i))),
        ("  staying in the run only", sum(reasons.values())),
        ("corpus", f"{corpus} ({'existing, ' + str(existing_sources) + ' sources' if (corpus / 'corpus.json').exists() else 'new'})"),
        ("namespace", namespace),
        ("coder for item types", coder),
        ("estimated time", f"about {estimate_minutes(existing_sources, len(todo), anchor_calls)} minutes "
                           f"({anchor_calls} anchoring calls; each reloads the corpus)"),
        ("upc", spec),
    ], notes=[f"not placeable: {dict(reasons)}"] if reasons else [])
    if args.plan:
        print("Planning only; nothing was written.")
        return 0
    if not todo:
        print("Nothing to do; every document in this bundle is already in the corpus.")
        return 0

    t_start = time.time()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    created = C.create_corpus(corpus, spec, args.title or name)
    with ImportLock(corpus):
        C.save_json(corpus / ".upc" / "upc-corpus" / "imports" / "namespace.json", {"namespace": namespace})
        totals = Counter()
        notes = []

        # --- sources: refuse a document whose reading copy changed since it was imported ---
        records, record_entries = [], []
        for entry in todo:
            prior = done.get(entry["documentId"])
            if prior and prior.get("text_sha256") and prior["text_sha256"] != entry.get("textSha256"):
                totals["sources refused: reading copy changed"] += 1
                notes.append(f"{entry['documentId']}: its reading copy changed since it was imported; "
                             "import the new bundle into a new corpus")
                continue
            record, note = source_record(entry, bundle_dir, namespace, bundle, now)
            if note:
                notes.append(f"{entry['documentId']}: {note}")
            records.append(record)
            record_entries.append(entry)
        added = C.upc_jsonl("add", "source", "--corpus", str(corpus), "--batch", "--tool", TOOL, records=records) \
            if records else {"results": []}
        placed_sources = []
        folders = {}  # source id -> its folder; `upc add source` names the folder only when it adds one
        for sj in corpus.glob("sources/*/source.json"):
            folders[(C.load_json(sj, {}) or {}).get("source_id")] = sj.parent.name
        for entry, result in zip(record_entries, (added or {}).get("results", [])):
            status = result.get("status")
            totals[f"sources {status}"] += 1
            if status not in ("added", "exists"):
                notes.append(f"{entry['documentId']}: {result.get('detail', 'add failed')}")
                continue
            result["slug"] = result.get("slug") or folders.get(result.get("source_id"))
            source = C.load_json(corpus / "sources" / str(result["slug"]) / "source.json", {}) or {}
            if status == "exists" and namespace in (source.get("aliases") or {}) \
                    and source["aliases"][namespace] != entry["documentId"]:
                notes.append(f"{entry['documentId']}: same text as {source['aliases'][namespace]}; "
                             f"its passages join that source ({result.get('source_id')})")
            rep = C.reading_copy(source.get("representations", []))
            if not rep:
                notes.append(f"{entry['documentId']}: no reading copy in the corpus")
                continue
            if bare_sha(rep.get("sha256")) and bare_sha(rep.get("sha256")) != entry.get("textSha256"):
                totals["sources refused: reading copy changed"] += 1
                notes.append(f"{entry['documentId']}: the corpus holds a different reading copy "
                             f"({result['source_id']}); not anchoring into it")
                continue
            done[entry["documentId"]] = {"source_id": result["source_id"], "slug": result["slug"],
                                         "text_rep": rep["representation_id"],
                                         "text_sha256": entry.get("textSha256"), "complete": False}
            placed_sources.append(entry)

        # --- passages: one anchoring call per document, the bundle's exact spans ---
        order = {e["documentId"]: n for n, e in enumerate(entries)}
        sharded = len(entries) > DOCUMENTS_PER_SET

        def set_for(entry):
            return f"exs-{coder}-{order[entry['documentId']] // DOCUMENTS_PER_SET + 1:03d}" if sharded else f"exs-{coder}"

        mapping, left_out, passage_docs = [], [], {}
        for position, entry in enumerate(placed_sources, 1):
            doc_items = items_by_doc.get(entry["documentId"], [])
            ready = [item for item in doc_items if placeable(item)]
            for item in doc_items:
                if not placeable(item):
                    left_out.append({"itemId": item.get("itemId"), "documentId": item["documentId"],
                                     "reason": item.get("notResolved") or "occurs more than once",
                                     "quote": item.get("directQuotes")})
            if ready:
                rep = done[entry["documentId"]]["text_rep"]
                result = C.upc_jsonl(
                    "anchor", "--corpus", str(corpus), "--rep", rep, "--normalize", "--set", set_for(entry),
                    "--tool", "literature-extraction", "--model", entry.get("model") or "unknown",
                    "--prompt-version", prompt_version,
                    records=[{"quote": item["span"], "type": upc_type(item["itemType"]), "text": item["text"],
                              "interpretation": item.get("interpretation"), "confidence": item.get("confidence"),
                              **({"note": item["notes"]} if item.get("notes") else {})} for item in ready])
                results = (result or {}).get("results", []) if isinstance(result, dict) else []
                by_index = {r.get("i"): r for r in results}
                for index, item in enumerate(ready):
                    r = by_index.get(index, {})
                    status = r.get("status", "no result")
                    totals[f"passages {status}"] += 1
                    if status in ("anchored", "refound", "exists"):
                        mapping.append({"itemId": item.get("itemId"), "documentId": item["documentId"],
                                        "extractionId": r["extraction_id"], "status": status,
                                        "type": item["itemType"], "text": item["text"],
                                        "confidence": item.get("confidence")})
                        passage_docs[r["extraction_id"]] = entry
                    else:
                        left_out.append({"itemId": item.get("itemId"), "documentId": item["documentId"],
                                         "reason": f"upc anchor: {status}", "quote": item["span"]})
            done[entry["documentId"]]["complete"] = True
            if position % 25 == 0 or position == len(placed_sources):
                C.save_json(state_path, {"namespace": namespace, "bundle": name, "documents": done})
                elapsed = time.time() - t_start
                print(f"  [{position}/{len(placed_sources)}] documents placed "
                      f"(~{int(elapsed / position * (len(placed_sources) - position) / 60)} min left)", flush=True)

        # --- item types: one codebook, one coding per placed item ---
        codings_written = Counter()
        if mapping and run.get("itemTypes") is not None:
            types = {t["type"]: t.get("definition", "") for t in run.get("itemTypes", [])}
            for row in mapping:
                types.setdefault(row["type"], "")
            obj, dest, status, _warnings = MC.build_codebook(corpus, {
                "slug": "item-type", "title": "Item type (literature-extraction)", "unit": "passage",
                "multi_label": True, "closed": True, "tool": TOOL, "method": "import",
                "question": "What kind of evidence the extraction model took this passage to be.",
                "codes": [{"code": type_code(t), "label": t.replace("_", " "),
                           **({"definition": d} if d else {})} for t, d in types.items()],
            }, namespace)
            MC.write_codebooks(corpus, [(obj, dest, status)])
            models = Counter(entry.get("model") or "unknown" for entry in placed_sources)
            codings = [{"codebook_ref": obj["codebook_id"], "code": type_code(row["type"]),
                        "target": {"kind": "extraction", "id": row["extractionId"]}, "coder": coder,
                        "confidence": row["confidence"] if row["confidence"] in CONF_SCORE else "medium",
                        "confidence_score": CONF_SCORE.get(row["confidence"], 0.6),
                        "rationale": row["text"][:RATIONALE_CHARS]} for row in mapping]
            for start in range(0, len(codings), CODING_BATCH):
                out = C.upc_jsonl("code", "--corpus", str(corpus), "--set", f"cds-{coder}", "--coder-kind", "model",
                                  "--tool", "literature-extraction", "--model", models.most_common(1)[0][0],
                                  "--prompt-version", prompt_version, records=codings[start:start + CODING_BATCH])
                codings_written.update((out or {}).get("tally", {}) if isinstance(out, dict) else {})

        # --- page and section, as secondary locators on this import's passages ---
        located = 0
        for set_file in sorted(corpus.glob(f"extractions/exs-{coder}*/items.jsonl")) if passage_docs else []:
            rows = read_jsonl(set_file)
            changed = False
            for obj in rows:
                entry = passage_docs.get(obj.get("extraction_id"))
                loc = obj.get("locator") or {}
                start = (loc.get("value") or {}).get("start")
                if not entry or not isinstance(start, int):
                    continue
                present = {s.get("type") for s in obj.get("secondary_locators") or []}
                extra = [s for s in locators_for(entry, obj.get("representation_ref"), start) if s["type"] not in present]
                if extra:
                    obj["secondary_locators"] = (obj.get("secondary_locators") or []) + extra
                    located += 1
                    changed = True
            if changed:
                tmp = set_file.with_suffix(".jsonl.tmp")
                tmp.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in rows), encoding="utf-8")
                tmp.replace(set_file)

        C.save_json(state_path, {"namespace": namespace, "bundle": name, "documents": done})
        import_dir = state_path.parent
        with open(import_dir / "item_map.jsonl", "a", encoding="utf-8") as fh:
            for row in mapping:
                fh.write(json.dumps({k: row[k] for k in ("itemId", "documentId", "extractionId", "status")}) + "\n")
        with open(import_dir / "not_imported.jsonl", "a", encoding="utf-8") as fh:
            for row in left_out:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        C.upc("regen", str(corpus))
        rep = C.upc("validate", str(corpus))
        C.upc("event", "--corpus", str(corpus), check=False, stdin=json.dumps({
            "activity_type": "import", "tool": TOOL, "status": "success",
            "notes": (f"literature-extraction bundle '{name}' ({bundle_dir}): {len(placed_sources)} documents, "
                      f"{len(mapping)} passages, {codings_written.get('coded', 0)} item-type codings"),
        }))
    secs = time.time() - t_start
    C.log_timing(corpus, {"stage": "import_bundle", "documents": len(placed_sources), "passages": len(mapping),
                          "anchor_calls": anchor_calls, "seconds": round(secs, 1)})
    state_line = (f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors"
                  if isinstance(rep, dict) else "UNAVAILABLE: validate did not return a report")
    C.counts_header("Import result", [
        ("corpus", f"{corpus}{' (new)' if created else ''}"),
        *sorted((k, v) for k, v in totals.items()),
        ("items left in the run only", len(left_out)),
        ("item-type codings written", codings_written.get("coded", 0)),
        ("item-type codings unchanged", codings_written.get("unchanged", 0)),
        ("passages given a page or section", located),
        ("corpus state", state_line),
        ("minutes", round(secs / 60, 1)),
    ])
    for note in notes[:12]:
        print(f"  NOTE {note}")
    if isinstance(rep, dict):
        for e in rep.get("errors", [])[:6]:
            print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:100]}")
    print(f"  item ids -> passages: {import_dir / 'item_map.jsonl'}")
    if left_out:
        print(f"  items not imported, with reasons: {import_dir / 'not_imported.jsonl'}")
    print(f"Next: make_codebooks.py --namespace {namespace}, then code_pass.py / screen.py / embed.py / publish.py.")
    print("Import finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
