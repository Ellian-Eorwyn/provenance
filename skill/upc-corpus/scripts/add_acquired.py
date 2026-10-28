#!/usr/bin/env python3
"""Fetched material -> UPC sources that say where their bytes came from.

    python3 add_acquired.py --corpus <dir> --items acquired.jsonl [--title T] [--plan]

`ingest.py` takes a folder of PDFs and a bibliographic manifest. This takes
what the research pipeline fetched, one JSON object per line:

    {"key": "doi:10.1000/x" | "url:https://…",      stable across runs
     "kind": "pdf" | "xml" | "web" | "data",
     "file": "/path/to/the fetched bytes",            PDF, full-text XML, the page's raw HTML, or a record (JSON/XML)
     "reading_copy": "/path/page.md",                 web: page-reader's markdown; data: a plain-text reading
     "provenance": {…},                               web: page-reader's record; data: ASR's fetch retrieval
     "title": "…", "doi": "…", "bibliographic": {…CSL…},
     "asr": {"registry_id", "source_id", "access_id", "endpoint_id"?, "fetch_id"?} | null,
     "discovery": {"query": "…", "discovered_from": "…"}}

An `xml` item is a publisher's full-text XML, the version of record where the publisher serves full text only as
XML (Elsevier's Article Retrieval API: an entitled PDF request gets the first page only). The XML is kept as the
original and xmltext.py makes its reading copy; a response that is metadata only is refused, never stored as a text.

A PDF's or full-text XML's fetch record is its pdf-harvest sidecar (`<file>.acq.json`); a page's
is the page-reader `provenance` block; a data record's (an IRS return, an API
answer) is the `retrieval` block of ASR's fetch sidecar, which already speaks
UPC. A data record keeps its original bytes and gets a plain-text reading for
quotation (the producer's conversion, e.g. one line per filing). Either becomes the source's
`retrieval`, whose sha256 must be the stored original's: an item whose bytes
no longer match their record is refused, not re-labelled.

Each source gets a textual reading copy for quotations: a PDF's page-aware
text (pdftext.py, as `ingest.py` makes it), or the page's markdown. The ASR
link follows ASR's crosswalk (crosswalks/upc.md): `ext.authority`,
`aliases.authority` and `discovery.discovered_from = "authority:<asc-id>"`.
A source found outside every registry is marked `ext.hermes.asr =
"unregistered"` with its host, so the gap is visible rather than silent.

`retrieval.canonical_url` is never set: `upc add source` mints the id from it
while the validator does not accept it as an id input (schema: "does NOT feed
identity"), so it would produce an id_mismatch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
import common as C          # noqa: E402
import pdftext              # noqa: E402
import xmltext              # noqa: E402

TOOL = {"tool": "upc-corpus/add_acquired", "tool_version": "1.0.0"}
RETRIEVAL_KEYS = ("original_url", "final_url", "fetch_status", "http_status", "content_type",
                  "fetch_method", "fetched_at", "extraction_method")
MIN_TEXT = 200


METHODS = {"http", "playwright", "readability", "structured_data", "ocr", "conversion", "vision", "model", "manual", "import"}


def method_of(v: str | None) -> str:
    """UPC's word for how a reading copy was made: its own vocabulary, else the x- form
    (the page reader's fallback extractor "dom-body" becomes "x-dom-body")."""
    if not v:
        return "readability"
    if v in METHODS:
        return v
    import re  # noqa: PLC0415
    return "x-" + (re.sub(r"[^a-z0-9]+", "-", v.lower()).strip("-") or "unknown")

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_record(item: dict) -> dict:
    """The acquisition record for an item: the pdf-harvest sidecar, or the page-reader block."""
    if item["kind"] in ("pdf", "xml"):
        rec = C.load_json(str(item["file"]) + ".acq.json", None)
        if rec is None:
            raise ValueError("no acquisition sidecar (<file>.acq.json); fetch it through pdf-harvest")
        return rec
    rec = item.get("provenance")
    if not rec:
        raise ValueError(f"a {item['kind']} item needs its fetch record (provenance)")
    return rec


def retrieval_of(rec: dict) -> tuple[dict, dict]:
    """UPC `retrieval` plus the extras that have no UPC field (kept under ext.hermes)."""
    ret = {k: rec[k] for k in RETRIEVAL_KEYS if rec.get(k) is not None}
    ret["sha256"] = "sha256:" + rec["sha256"].removeprefix("sha256:")
    extras = {k: rec[k] for k in ("route", "tool", "tool_version", "served_sha256", "served_bytes", "transform", "bytes")
              if rec.get(k) is not None}
    return ret, extras


def build(item: dict, text_dir: Path) -> dict:
    src_file = Path(item["file"]).expanduser()
    if not src_file.is_file():
        raise ValueError(f"file not found: {src_file}")
    rec = fetch_record(item)
    got = sha256_file(src_file)
    if got != rec.get("sha256", "").removeprefix("sha256:"):
        raise ValueError(f"the stored bytes (sha256 {got[:12]}) are not the ones fetched "
                         f"({str(rec.get('sha256'))[:12]}); re-fetch rather than relabel")
    retrieval, extras = retrieval_of(rec)

    if item["kind"] == "pdf":
        txt = text_dir / f"{hashlib.sha256(item['key'].encode()).hexdigest()[:16]}.txt"
        if not txt.exists():
            info = pdftext.convert(str(src_file))
            txt.write_text(info["text"], encoding="utf-8")
            C.save_json(txt.with_suffix(".info.json"), {k: v for k, v in info.items() if k != "text"})
        info = C.load_json(txt.with_suffix(".info.json"), {})
        files = [
            {"path": str(src_file), "role": "document_pdf", "media_type": "application/pdf",
             "produced_by": "import", **({"page_count": info["pages"]} if info.get("pages") else {})},
            {"path": str(txt), "role": "text", "media_type": "text/plain", "produced_by": "conversion", "parent": 0},
        ]
        reading = txt
    elif item["kind"] == "xml":
        txt = text_dir / f"{hashlib.sha256(item['key'].encode()).hexdigest()[:16]}.txt"
        if not txt.exists():
            info = xmltext.convert(str(src_file))
            if not info["full_text"]:
                raise ValueError(f"the XML is not a full text ({info['format']}): the request was not entitled")
            txt.write_text(info["text"], encoding="utf-8")
            C.save_json(txt.with_suffix(".info.json"), {k: v for k, v in info.items() if k != "text"})
        files = [
            {"path": str(src_file), "role": "original", "media_type": "text/xml", "produced_by": "import"},
            {"path": str(txt), "role": "text", "media_type": "text/plain", "produced_by": "conversion", "parent": 0},
        ]
        reading = txt
    elif item["kind"] == "data":
        body = Path(item["reading_copy"]).expanduser().read_text(encoding="utf-8").lstrip("\ufeff").replace("\r\n", "\n")
        txt = text_dir / f"{hashlib.sha256(item['key'].encode()).hexdigest()[:16]}.txt"
        txt.write_text(body, encoding="utf-8")
        ctype = (rec.get("content_type") or "application/octet-stream").split(";")[0].strip()
        files = [
            {"path": str(src_file), "role": "original", "media_type": ctype, "produced_by": "import"},
            {"path": str(txt), "role": "text", "media_type": "text/plain", "produced_by": "conversion", "parent": 0},
        ]
        reading = txt
    else:
        md = Path(item["reading_copy"]).expanduser()
        # §02: tool-produced text is UTF-8 without a BOM, with LF line ends.
        body = md.read_text(encoding="utf-8").lstrip("﻿").replace("\r\n", "\n")
        norm = text_dir / f"{hashlib.sha256(item['key'].encode()).hexdigest()[:16]}.md"
        norm.write_text(body, encoding="utf-8")
        ctype = (rec.get("content_type") or "text/html").split(";")[0].strip()
        files = [
            {"path": str(src_file), "role": "raw_html", "media_type": ctype, "produced_by": "import"},
            {"path": str(norm), "role": "clean_markdown", "media_type": "text/markdown",
             "produced_by": method_of(rec.get("extraction_method")), "parent": 0},
        ]
        reading = norm
    chars = len(reading.read_text(encoding="utf-8").strip())
    if chars < MIN_TEXT:
        raise ValueError(f"only {chars} characters of text — a scan needing OCR, or a page that did not render")

    ext: dict = {"hermes": {"acquisition": extras, "key": item["key"]}}
    aliases = {"hermes": item["key"]}
    discovery = dict(item.get("discovery") or {})
    asr = item.get("asr")
    if asr:
        ext["authority"] = {k: v for k, v in asr.items() if v is not None}
        if asr.get("fetch_id"):
            aliases["authority"] = asr["fetch_id"]
        discovery["discovered_from"] = f"authority:{asr['source_id']}"
    else:
        ext["hermes"]["asr"] = "unregistered"
        ext["hermes"]["host"] = urlparse(retrieval.get("final_url") or retrieval.get("original_url") or "").netloc

    out = {
        "title": item.get("title") or src_file.stem,
        "source_kind": {"pdf": "document", "xml": "document", "data": "dataset"}.get(item["kind"], "url"),
        "retrieval": retrieval,
        "aliases": aliases,
        "ext": ext,
        "files": files,
        "provenance": {"produced_by": {**TOOL, "method": "import"},
                       "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
    }
    if discovery:
        out["discovery"] = discovery
    if item.get("bibliographic"):
        out["bibliographic"] = item["bibliographic"]
    if item.get("doi"):
        out["identifiers"] = [{"scheme": "doi", "value": item["doi"]}]
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--items", required=True, help="JSONL, one fetched item per line")
    ap.add_argument("--title", default="", help="corpus title, when creating it")
    ap.add_argument("--plan", action="store_true", help="report what would happen; write nothing")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    try:
        spec = C.check_compat()
        C.require_tools("pdftotext", "pdfinfo")
    except C.Unavailable as e:
        C.die(str(e))
    items = [json.loads(line) for line in Path(args.items).expanduser().read_text(encoding="utf-8").splitlines()
             if line.strip()]
    done = C.load_json(C.state_dir(corpus) / "acquired.json", {}) if corpus.exists() else {}
    todo = [it for it in items if it["key"] not in done]

    C.counts_header("Add acquired: plan", [
        ("items", len(items)),
        ("already in the corpus", len(items) - len(todo)),
        ("to add now", len(todo)),
        ("pdf / xml / web / data", " / ".join(str(sum(i["kind"] == k for i in todo))
                                              for k in ("pdf", "xml", "web", "data"))),
        ("corpus", str(corpus)),
        ("upc", spec),
    ])
    if args.plan:
        print("Planning only; nothing was written.")
        return 0
    if not todo:
        print("Nothing to do; every item is already in the corpus.")
        return 0

    C.create_corpus(corpus, spec, args.title or corpus.name)
    text_dir = C.state_dir(corpus, "text")
    records, refused, t0 = [], [], time.time()
    for it in todo:
        try:
            records.append((it["key"], build(it, text_dir)))
        except (ValueError, KeyError, OSError) as e:
            refused.append((it.get("key", "?"), str(e)))

    added = exists = failed = 0
    if records:
        res = C.upc_jsonl("add", "source", "--corpus", str(corpus), "--batch", "--tool", TOOL["tool"],
                          records=[r for _, r in records])
        for (key, _), out in zip(records, res.get("results", [])):
            if out.get("status") in ("added", "exists"):
                done[key] = {"source_id": out.get("source_id"), "slug": out.get("slug") or out.get("dir")}
                added += out["status"] == "added"
                exists += out["status"] == "exists"
            else:
                failed += 1
                refused.append((key, out.get("detail", "add failed")))
        C.save_json(C.state_dir(corpus) / "acquired.json", done)
        C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    secs = round(time.time() - t0, 1)
    C.log_timing(corpus, {"stage": "add_acquired", "n": len(records), "seconds": secs})

    C.counts_header("Add acquired: result", [
        ("sources added", added),
        ("already present (same URL)", exists),
        ("refused", len(refused)),
        ("corpus level", f"{rep.get('status')} {rep.get('level')}"),
        ("validation errors", len(rep.get("errors", []))),
        ("seconds", secs),
    ])
    for key, why in refused[:20]:
        print(f"  UNAVAILABLE {key}: {why}")
    for e in rep.get("errors", [])[:8]:
        print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:100]}")
    return 0 if not rep.get("errors") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
