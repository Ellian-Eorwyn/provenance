#!/usr/bin/env python3
"""A dossier: what a set of documents says that matters to one project, written for one audience.

    python3 dossier.py init  --corpus <dir> --audience <a.yaml> --project <p.yaml> --title T [options]
    python3 dossier.py add   --corpus <dir> --from <entry.json> --writer "<who>" [--model M] [--replace] [--plan]
    python3 dossier.py write --corpus <dir> [--source <id>] [--redo] [--plan]
    python3 dossier.py brief --corpus <dir> --from <brief.json> --writer "<who>" [--model M] [--plan]
    python3 dossier.py build --corpus <dir> --out <dir> [--copies] [--no-docx] [--no-xlsx] [--no-images]
    python3 dossier.py check --corpus <dir>

Two profiles steer it. Both are kept outside the corpus and reused from one dossier
to the next (shapes in references/profiles/):

  * an AUDIENCE: who reads it, what they already know, what they look for, how
    they like to read, and phrases that must never be published;
  * a PROJECT: what it is, and the lenses (usually its tasks) that relevance is
    judged against.

The objects are UPC's own, so a dossier is a projection (spec/09):

  * one `x-dossier-entry` generation per document. It holds the writer's summary,
    notes and questions (labelled with the writer's name) and the document's key
    points, figures, dates, people and positions, terms and the works it cites,
    each with a quotation that `upc anchor` found in the stored source. A
    quotation it cannot find is dropped and reported, never stored.
  * one `x-dossier-brief` synthesis: the cover memo across the documents, every
    theme backed by quotations that hop C checks.

`add` takes an entry written anywhere (a person, Claude, any model); `write` has
the configured local model write it. Both go through the same gate.

`build` refuses a corpus that does not validate and finds every quotation again
in the stored source. It then writes the site (a cover with the memo, one folder
per document, a timeline, who's who, terms, leads and method), a Word file and a
spreadsheet. It reads the Word file back and refuses if a quotation is missing
from it. It also refuses if a never-publish phrase (from either profile or the
config) or a local path would appear in anything it writes. The build record is
kept beside the output folder, never in it.

The entry and brief shapes are in references/dossier.md.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html as htmlmod
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
from corpus_view import (check_extraction, esc, extractions, find_span, generations, latest_per_source,  # noqa: E402
                         meta_content, suppressed_in, thumbnail, validate)

TOOL = {"tool": "upc-corpus/dossier", "tool_version": "1.0.0"}
ENTRY, BRIEF = "x-dossier-entry", "x-dossier-brief"
SCHEMAS = Path(__file__).resolve().parents[1] / "references" / "profiles"
MAX_COPY = 25 * 1024 * 1024  # a static host's per-file limit (Cloudflare Pages)
ITEMS = ("key_points", "figures", "dates", "actors", "terms", "cites")
ITEM_LABEL = {"key_points": "key point", "figures": "figure", "dates": "date", "actors": "person or organization",
              "terms": "term", "cites": "cited work"}
KIND_LABEL = {"paper": "Journal article", "report": "Report", "white-paper": "White paper", "filing": "Regulatory filing",
              "comments": "Comments", "decision": "Decision", "web-page": "Web page", "slides": "Slides",
              "blog": "Blog post", "docket": "Docket document", "other": "Document"}


# ------------------------------------------------------------------ profiles
_TYPES = {"string": str, "array": list, "object": dict, "integer": int, "number": (int, float), "boolean": bool}


def schema_errors(schema: dict, value, where: str = "", root: dict | None = None) -> list[str]:
    """The few JSON Schema rules the profile schemas use (type, required, properties,
    additionalProperties, items, enum, pattern, minItems, minLength, minimum, $ref)."""
    root = root or schema
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            node = node[part]
        return schema_errors(node, value, where, root)
    here = where or "profile"
    t = schema.get("type")
    if t:
        ts = t if isinstance(t, list) else [t]
        if not any(isinstance(value, _TYPES[x]) and not (x in ("integer", "number") and isinstance(value, bool))
                   for x in ts):
            return [f"{here}: should be {' or '.join(ts)}, not {type(value).__name__}"]
    errs = []
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{here}: should be one of {schema['enum']}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(f"{here}: {value!r} should match {schema['pattern']}")
        if len(value) < schema.get("minLength", 0):
            errs.append(f"{here}: {value!r} is shorter than {schema['minLength']} characters")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value < schema.get("minimum", value):
        errs.append(f"{here}: should be at least {schema['minimum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errs.append(f"{here}: needs at least {schema['minItems']}")
        if isinstance(schema.get("items"), dict):
            for i, v in enumerate(value):
                errs += schema_errors(schema["items"], v, f"{here}[{i}]", root)
    if isinstance(value, dict):
        dot = f"{where}." if where else ""
        errs += [f"{dot}{k}: missing" for k in schema.get("required", []) if value.get(k) in (None, "", [], {})]
        props, extra = schema.get("properties", {}), schema.get("additionalProperties")
        for k, v in value.items():
            if k in props:
                errs += schema_errors(props[k], v, f"{dot}{k}", root)
            elif isinstance(extra, dict):
                errs += schema_errors(extra, v, f"{dot}{k}", root)
    return errs


def _plain_dates(x):
    """YAML reads an unquoted 2026-10-19 as a date; a profile means the text."""
    if isinstance(x, (dt.date, dt.datetime)):
        return x.isoformat()
    if isinstance(x, list):
        return [_plain_dates(v) for v in x]
    if isinstance(x, dict):
        return {k: _plain_dates(v) for k, v in x.items()}
    return x


def load_profile(path: str | Path, kind: str) -> dict:
    """A profile (YAML or JSON), checked against references/profiles/<kind>.schema.json."""
    p = Path(path).expanduser()
    if not p.exists():
        raise SystemExit(f"no such {kind} profile: {p}")
    text = p.read_text(encoding="utf-8")
    if p.suffix in (".yaml", ".yml"):
        try:
            import yaml  # noqa: PLC0415
        except ImportError:
            raise C.Unavailable("reading a YAML profile needs PyYAML (pip install pyyaml); or give it as JSON") from None
        data = _plain_dates(yaml.safe_load(text))
    else:
        data = json.loads(text)
    schema = C.load_json(SCHEMAS / f"{kind}.schema.json", {})
    errs = schema_errors(schema, data)
    if kind == "project" and not errs:
        slugs = [lens["slug"] for lens in data["lenses"]]
        errs += [f"lenses: {s!r} is used twice" for s in sorted({s for s in slugs if slugs.count(s) > 1})]
    if errs:
        raise SystemExit(f"the {kind} profile {p.name} does not fit references/profiles/{kind}.schema.json:\n  "
                         + "\n  ".join(errs[:12]))
    return data


def lens_titles(project: dict) -> dict[str, str]:
    return {lens["slug"]: lens.get("short") or lens["title"] for lens in project["lenses"]}


# ------------------------------------------------------------------ config and sources
def cfg_path(corpus: Path) -> Path:
    return C.state_dir(corpus, "dossier") / "dossier.json"


def load_cfg(corpus: Path) -> dict:
    cfg = C.load_json(cfg_path(corpus), None)
    if not cfg:
        raise SystemExit(f"no dossier here yet: run `dossier.py init --corpus {corpus} …` first")
    return cfg


def source_index(corpus: Path) -> dict[str, dict]:
    """Every source with a reading copy, by source_id and by alias (the same dict)."""
    out: dict[str, dict] = {}
    for alias, info in C.corpus_reps(corpus).items():
        sj = C.load_json(corpus / "sources" / info["slug"] / "source.json", {})
        reps = sj.get("representations", [])
        pdf = next((r for r in reps if str(r.get("media_type", "")).endswith("pdf") and r.get("path")), None)
        raw = next((r for r in reps if r.get("role") == "raw_html" and r.get("path")), None)
        ret = sj.get("retrieval") or {}
        full = {**info, "alias": alias, "record": sj,
                "pdf_path": corpus / pdf["path"] if pdf else None,
                "raw_path": corpus / raw["path"] if raw else None,
                "url": ret.get("final_url") or ret.get("original_url"),
                "fetched_at": ret.get("fetched_at"),
                "sha256": str(ret.get("sha256") or (pdf or raw or {}).get("sha256") or "").removeprefix("sha256:")}
        out[alias] = full
        out[info["source_id"]] = full
    return out


def exs_id(corpus: Path) -> str:
    ns = C.corpus_settings(corpus).get("namespace") or re.sub(r"[^a-z0-9]+", "-", corpus.name.lower()).strip("-")
    return f"exs-{ns or 'dossier'}-dossier"


def anchor_quotes(corpus: Path, info: dict, quotes: list[str | None], *, model: str, prompt: str,
                  dry: bool = False) -> list[dict]:
    """Each proposed quotation, found in the source's reading copy by `upc anchor`:
    {quote (the stored characters), extraction_id}, or {quote, status} where it was not.

    Before asking, the same two repairs deep-research's anchor() makes: a quote that
    differs from the page only in case, curly marks, dashes or spacing becomes the
    page's own characters, and one that occurs twice is widened to the shortest
    unique span. Neither can invent text: both return the document's characters."""
    text = Path(info["text_path"]).read_text(encoding="utf-8")
    fixed = []
    for q in quotes:
        q = re.sub(r"[ \t]+", " ", str(q or "")).strip()
        if q and q not in text:
            q = find_span(q, text) or q
        if q and C.occurrences(text, q) > 1:
            q = C.widen_to_unique(text, q) or q
        fixed.append(q)
    out = [{"quote": q, "status": "no quotation given"} for q in fixed]
    todo = [i for i, q in enumerate(fixed) if q]
    if not todo:
        return out
    # --source: a reading copy shared by two sources (one paper saved twice) is one
    # representation; the passages belong to the source this entry is about.
    args = ["anchor", "--corpus", str(corpus), "--rep", info["text_rep"], "--source", info["source_id"],
            "--normalize", "--set", exs_id(corpus),
            "--type", "evidence", "--tool", TOOL["tool"], "--model", model or "unknown", "--prompt-version", prompt]
    res = C.upc_jsonl(*args, *(["--dry-run"] if dry else []), records=[{"quote": fixed[i]} for i in todo])
    if not isinstance(res, dict) or "results" not in res:
        raise C.Unavailable(f"upc anchor gave no results: {str(res)[:200]}")
    by_i = {r["i"]: r for r in res["results"]}
    exts = {} if dry else extractions(corpus)
    for j, i in enumerate(todo):
        r = by_i.get(j) or {}
        if r.get("status") in ("anchored", "refound", "exists"):
            eid = r.get("extraction_id")
            stored = (exts.get(eid) or {}).get("direct_quote") or r.get("stored_quote") or fixed[i]
            out[i] = {"quote": stored, "extraction_id": eid}
        else:
            out[i] = {"quote": fixed[i], "status": r.get("status") or "no result"}
    return out


def pdf_pages(path: Path | None) -> int | None:
    if not path or not path.exists():
        return None
    p = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True)
    m = re.search(r"^Pages:\s+(\d+)", p.stdout, re.M)
    return int(m.group(1)) if m else None


# ------------------------------------------------------------------ init
def cmd_init(corpus: Path, a) -> int:
    cfg = C.load_json(cfg_path(corpus), {}) or {}
    for key, val in (("title", a.title), ("subtitle", a.subtitle), ("prepared_for", a.prepared_for),
                     ("prepared_by", a.prepared_by), ("date", a.date), ("stamp", a.stamp), ("file_no", a.file_no),
                     ("file_name", a.file_name)):
        if val is not None:
            cfg[key] = val
    if a.audience:
        cfg["audience"] = str(Path(a.audience).expanduser().resolve())
    if a.project:
        cfg["project"] = str(Path(a.project).expanduser().resolve())
    if a.order:
        cfg["order"] = [x.strip() for x in a.order.split(",") if x.strip()]
    if a.suppress:
        cfg["suppress"] = sorted(set(cfg.get("suppress", [])) | set(a.suppress))
    if a.sections:
        secs = C.load_json(a.sections, None)
        if not isinstance(secs, list) or not all(isinstance(s, dict) and s.get("slug") and s.get("title") for s in secs):
            raise SystemExit("--sections: a JSON list of {slug, title, description}")
        cfg["sections"] = secs
    for need in ("title", "audience", "project"):
        if not cfg.get(need):
            raise SystemExit(f"init needs --{need} the first time")
    aud, proj = load_profile(cfg["audience"], "audience"), load_profile(cfg["project"], "project")
    if a.request_source:
        idx = source_index(corpus)
        info = idx.get(a.request_source)
        if not info or not info.get("text_rep"):
            raise SystemExit(f"--request-source: no source {a.request_source!r} with a reading copy in this corpus")
        req = {"source_id": info["source_id"], "by": a.request_by or (cfg.get("request") or {}).get("by"),
               "date": a.request_date or (cfg.get("request") or {}).get("date")}
        if a.request_quote:
            got = anchor_quotes(corpus, info, [a.request_quote], model="none (a person chose it)",
                                prompt="dossier-request@1")[0]
            if not got.get("extraction_id"):
                raise SystemExit(f"--request-quote is not in the request source ({got.get('status')})")
            req.update(extraction_id=got["extraction_id"], quote=got["quote"])
        cfg["request"] = req
    cfg.setdefault("date", dt.date.today().isoformat())
    cfg.setdefault("prepared_for", f"{aud['readers'][0]['name']}, {aud['name']}")
    cfg.setdefault("stamp", f"For {aud['name']} · {proj['name']}")
    C.save_json(cfg_path(corpus), cfg)
    C.counts_header("Dossier: config", [("config", cfg_path(corpus)), ("title", cfg["title"]),
                                        ("audience", f"{aud['name']} ({len(aud['readers'])} readers)"),
                                        ("project", f"{proj['name']} ({len(proj['lenses'])} lenses)"),
                                        ("request", (cfg.get("request") or {}).get("source_id") or "—")])
    return 0


# ------------------------------------------------------------------ add (an entry)
def _prose(s: str) -> str:
    """The writer's words in the generation's Markdown: a straight double quotation
    mark there would read as an unchecked quotation, so it becomes a single one."""
    return re.sub(r"\s+", " ", str(s or "")).replace('"', "'").strip()


def marker(quote: str, eid: str) -> str:
    """A UPC quote marker (spec/04): inline, or the block form when the quotation
    holds a double quotation mark or a line break."""
    if '"' in quote or "\n" in quote:
        return f"```quote {eid}\n{quote}\n```"
    return f'"{quote}" [{eid}]'


def entry_markdown(e: dict, project: dict) -> str:
    lt = lens_titles(project)
    md = [f"# {_prose(e['title'])}", "", f"Written by {_prose(e['writer'])}.", "", _prose(e["summary"]), ""]
    if e.get("why_it_matters"):
        md += [f"## Why it matters for {_prose(project['name'])}", ""]
        md += [f"- {lt.get(w.get('lens'), 'General')}: {_prose(w.get('text'))}" for w in e["why_it_matters"]] + [""]
    for sec in ITEMS:
        if not e.get(sec):
            continue
        md += [f"## {sec.replace('_', ' ').capitalize()}", ""]
        for it in e[sec]:
            head = {"key_points": it.get("text"), "figures": f"{it.get('label')}: {it.get('value')}",
                    "dates": f"{it.get('date')}: {it.get('event')}", "actors": f"{it.get('name')}: {it.get('stance')}",
                    "terms": f"{it.get('term')}: {it.get('definition')}",
                    "cites": f"{it.get('ref')}" + (f" ({it.get('note')})" if it.get("note") else "")}[sec]
            md += [_prose(head), "", marker(it["quote"], it["extraction_id"]), ""]
    if e.get("questions"):
        md += ["## Questions for the team", ""] + [f"- {_prose(q)}" for q in e["questions"]] + [""]
    return "\n".join(md)


def _check_entry_shape(entry: dict, project: dict, sections: list[dict] | None = None) -> list[str]:
    lenses = {lens["slug"] for lens in project["lenses"]}
    errs = []
    if entry.get("section") and entry["section"] not in {s["slug"] for s in sections or []}:
        errs.append(f"section: {entry['section']!r} is not one of the config's sections "
                    f"({', '.join(s['slug'] for s in sections or []) or 'none set: init --sections'})")
    if not str(entry.get("summary") or "").strip():
        errs.append("summary: missing")
    for i, w in enumerate(entry.get("why_it_matters") or []):
        if w.get("lens") not in lenses:
            errs.append(f"why_it_matters[{i}].lens: {w.get('lens')!r} is not a lens of {project['name']}")
    for k, v in (entry.get("relevance") or {}).items():
        if k not in lenses:
            errs.append(f"relevance: {k!r} is not a lens of {project['name']}")
        elif not (isinstance(v, int) and 0 <= v <= 3):
            errs.append(f"relevance.{k}: should be 0, 1, 2 or 3")
    for i, kp in enumerate(entry.get("key_points") or []):
        if kp.get("lens") and kp["lens"] not in lenses:
            errs.append(f"key_points[{i}].lens: {kp['lens']!r} is not a lens of {project['name']}")
    if errs:
        errs.append(f"(the lenses are: {', '.join(sorted(lenses))})")
    return errs


def add_entry(corpus: Path, entry: dict, *, writer: str, model: str | None = None, method: str = "model",
              replace: bool = False, plan: bool = False, prompt: str = "dossier-entry@1") -> dict:
    """Anchor an entry's quotations and store it as an x-dossier-entry generation."""
    cfg = load_cfg(corpus)
    project = load_profile(cfg["project"], "project")
    idx = source_index(corpus)
    info = idx.get(entry.get("source"))
    if not info:
        raise SystemExit(f"no source {entry.get('source')!r} with a reading copy in this corpus "
                         "(give its source_id or alias; `upc validate` lists them)")
    errs = _check_entry_shape(entry, project, cfg.get("sections"))
    if errs:
        raise SystemExit("the entry does not fit (references/dossier.md, 'An entry'):\n  " + "\n  ".join(errs))
    model_label = model or writer

    flat = [(sec, i, it) for sec in ITEMS for i, it in enumerate(entry.get(sec) or []) if isinstance(it, dict)]
    got = anchor_quotes(corpus, info, [it.get("quote") for _, _, it in flat], model=model_label, prompt=prompt, dry=plan)
    kept: dict[str, list] = {sec: [] for sec in ITEMS}
    refused = []
    for (sec, i, it), g in zip(flat, got):
        if g.get("extraction_id") or (plan and "status" not in g):
            kept[sec].append({**{k: v for k, v in it.items() if k != "quote"}, "quote": g["quote"],
                              "extraction_id": g.get("extraction_id")})
        else:
            refused.append({"section": sec, "item": i, "quote": str(it.get("quote") or "")[:200], "status": g.get("status")})

    sug = None
    if entry.get("suggested_by"):
        s = entry["suggested_by"]
        req = cfg.get("request") or {}
        sinfo = idx.get(s.get("source") or req.get("source_id"))
        if not sinfo:
            refused.append({"section": "suggested_by", "item": 0, "quote": str(s.get("quote"))[:200],
                            "status": "no request source (init --request-source, or give suggested_by.source)"})
        else:
            g = anchor_quotes(corpus, sinfo, [s.get("quote")], model=model_label, prompt=prompt, dry=plan)[0]
            if g.get("extraction_id") or (plan and "status" not in g):
                sug = {"by": s.get("by") or req.get("by"), "source_id": sinfo["source_id"],
                       "extraction_id": g.get("extraction_id"), "quote": g["quote"]}
            else:
                refused.append({"section": "suggested_by", "item": 0, "quote": str(s.get("quote"))[:200],
                                "status": g.get("status")})

    pages = pdf_pages(info.get("pdf_path"))
    exhibits = []
    for i, ex in enumerate(entry.get("exhibits") or []):
        pg = ex.get("page")
        if not pages or not isinstance(pg, int) or not 1 <= pg <= pages:
            refused.append({"section": "exhibits", "item": i, "quote": str(ex.get("caption"))[:200],
                            "status": f"page {pg!r} is not a page of this source's PDF ({pages or 'no PDF'})"})
        else:
            exhibits.append({"page": pg, "caption": str(ex.get("caption") or "").strip()})

    keep = ("title", "short_title", "section", "kind", "authors", "author_org", "date", "identifier", "license", "summary",
            "why_it_matters", "relevance", "questions", "read_chars", "total_chars")
    e = {**{k: entry[k] for k in keep if entry.get(k) not in (None, "", [], {})}, "writer": writer,
         "title": entry.get("title") or info["title"], "pages": pages or entry.get("pages"),
         **kept, "suggested_by": sug, "exhibits": exhibits, "refused": refused}
    report = {"source_id": info["source_id"], "title": e["title"], "kept": {s: len(v) for s, v in kept.items()},
              "refused": refused, "suggested_by": bool(sug), "exhibits": len(exhibits)}
    if plan:
        report["status"] = "plan"
        return report
    md_path = C.state_dir(corpus, "dossier", "entries") / f"{info['slug']}.md"
    md_path.write_text(entry_markdown(e, project), encoding="utf-8")
    produced = {**TOOL, "method": method, "prompt_version": prompt, **({"model": model} if model else {})}
    res = C.upc("add", "generation", "--corpus", str(corpus), "--output", str(md_path), "--tool", TOOL["tool"],
                *(["--replace"] if replace else []), check=False, stdin=json.dumps({
                    "type": ENTRY, "title": e["title"], "source_id": info["source_id"],
                    "representation_ref": info["text_rep"], "provenance": {"produced_by": produced},
                    "ext": {"upc_corpus": {"dossier_entry": e}}}))
    if not (isinstance(res, dict) and res.get("status") in ("ok", "exists", "replaced")):
        fails = (res or {}).get("failures", []) if isinstance(res, dict) else []
        detail = (res or {}).get("detail") if isinstance(res, dict) else res
        raise SystemExit(f"the entry was refused: {detail}\n  " + "\n  ".join(
            f"{f.get('marker')}: {f.get('reason')}" for f in fails[:8]))
    report.update(status=res["status"], generation_id=res["generation_id"])
    return report


def print_entry_report(rep: dict) -> None:
    kept = ", ".join(f"{n} {ITEM_LABEL[s]}{'s' if n != 1 else ''}" for s, n in rep["kept"].items() if n) or "no quotations"
    print(f"  {rep['title'][:70]:72} {rep.get('status', '')}: {kept}"
          + (f"; {rep['exhibits']} exhibit(s)" if rep.get("exhibits") else "")
          + ("; suggested-by quote" if rep.get("suggested_by") else ""))
    for r in rep["refused"]:
        print(f"    NOT FOUND {r['section']}[{r['item']}] ({r['status']}): {r['quote'][:110]!r}")


# ------------------------------------------------------------------ write (the local model)
def entry_schema(project: dict) -> dict:
    lenses = [lens["slug"] for lens in project["lenses"]]
    s, q = {"type": "string"}, {"type": "string"}
    obj = lambda **p: {"type": "object", "properties": p, "required": list(p)}  # noqa: E731
    arr = lambda item: {"type": "array", "items": item}  # noqa: E731
    return obj(kind={"type": "string", "enum": list(KIND_LABEL)}, author_org=s, date=s, summary=s,
               why_it_matters=arr(obj(lens={"type": "string", "enum": lenses}, text=s)),
               relevance={"type": "object", "properties": {k: {"type": "integer", "minimum": 0, "maximum": 3} for k in lenses}},
               key_points=arr(obj(text=s, lens={"type": "string", "enum": lenses}, quote=q)),
               figures=arr(obj(label=s, value=s, quote=q)), dates=arr(obj(date=s, event=s, quote=q)),
               actors=arr(obj(name=s, type=s, stance=s, quote=q)), terms=arr(obj(term=s, definition=s, quote=q)),
               cites=arr(obj(ref=s, note=s, quote=q)), questions=arr(s))


def style_text(aud: dict) -> str:
    s = aud.get("style") or ["plain, short, specific"]
    return "; ".join(f"{k}: {v}" for k, v in s.items()) if isinstance(s, dict) else "; ".join(s)


def write_prompt(aud: dict, proj: dict) -> str:
    readers = "; ".join(f"{r['name']} ({r['role']})" for r in aud["readers"])
    lenses = "\n".join(f"- {lens['slug']}: {lens['title']}: {lens['description']}" for lens in proj["lenses"])
    return f"""You write one entry of a dossier: what one document says that matters to a project, for its readers.

The readers: {aud['name']}{' (' + aud['organization'] + ')' if aud.get('organization') else ''}: {readers}.
They already know (do not explain): {'; '.join(aud.get('knows') or ['—'])}.
They look for: {'; '.join(aud['wants'])}.
How they like to read: {style_text(aud)}.

The project: {proj['name']}{' (' + proj['full_name'] + ')' if proj.get('full_name') else ''}.
Judge relevance against these lenses:
{lenses}
Project rules: {'; '.join(proj.get('rules') or ['—'])}.

Output JSON only:
- kind, author_org (who wrote or issued it), date (as the document gives it).
- summary: about {aud.get('summary_words', 120)} words in your own words: what the document is, what it argues or
  finds, and whose view it represents. Only what the document says; no quotation marks; nothing from your own knowledge.
- why_it_matters: for each lens it really bears on, one or two sentences on why, for this project.
- relevance: 0-3 for every lens (0 none, 1 background, 2 useful, 3 central).
- key_points (3-8), figures, dates, actors (people or organizations and the position the document gives them),
  terms (defined in the document), cites (earlier works it leans on most), questions (for the team, at most 3).
- Every quote: copied character for character from the document, one sentence or less (at most 60 words),
  from a single passage. A quotation not in the document is thrown away, and so is its item."""


def cmd_write(corpus: Path, source: str | None, redo: bool, plan: bool, max_chars: int) -> int:
    cfg = load_cfg(corpus)
    aud, proj = load_profile(cfg["audience"], "audience"), load_profile(cfg["project"], "project")
    idx = source_index(corpus)
    have = {e["_source_id"] for e in entries(corpus)}
    req = (cfg.get("request") or {}).get("source_id")
    seen, todo = set(), []
    for info in idx.values():
        sid = info["source_id"]
        if sid in seen or sid == req or not info.get("text_rep"):
            continue
        seen.add(sid)
        if source and source not in (sid, info["alias"]):
            continue
        if redo or sid not in have:
            todo.append(info)
    C.counts_header("Write: plan", [("documents", len(seen)), ("with an entry", len(have)), ("to write now", len(todo)),
                                    ("model", f"{C.DEFAULT_MODEL} at {C.CHAT_URL}"), ("characters read, at most", max_chars)])
    if plan or not todo:
        return 0
    system, schema = write_prompt(aud, proj), entry_schema(proj)
    t0, failed = time.time(), 0
    for info in todo:
        text = Path(info["text_path"]).read_text(encoding="utf-8")
        try:
            out = C.llm_chat(system, f"Title: {info['title']}\nURL: {info.get('url') or '—'}\n\n{text[:max_chars]}",
                             schema=schema, max_tokens=6000, temperature=0.2)
        except C.Unavailable as e:
            print(f"  UNAVAILABLE {info['title'][:60]}: {e}")
            failed += 1
            continue
        d = C.parse_json_loose(out["content"]) or {}
        if not d.get("summary"):
            print(f"  NO ENTRY {info['title'][:60]}: the model's reply had no summary")
            failed += 1
            continue
        d.update(source=info["source_id"], read_chars=min(len(text), max_chars), total_chars=len(text))
        rep = add_entry(corpus, d, writer=f"{C.AGENT_NAME} ({C.DEFAULT_MODEL})", model=C.DEFAULT_MODEL,
                        replace=redo, prompt="dossier-entry@1")
        print_entry_report(rep)
    C.upc("regen", str(corpus), check=False)
    C.counts_header("Write: result", [("written", len(todo) - failed), ("failed", failed),
                                      ("seconds", round(time.time() - t0, 1))])
    return 1 if failed else 0


# ------------------------------------------------------------------ brief (the cover memo)
BRIEF_SECTIONS = (("themes", "Themes"), ("tensions", "Where the documents pull apart"), ("for_project", None))


def add_brief(corpus: Path, brief: dict, *, writer: str, model: str | None = None, method: str = "model",
              plan: bool = False, prompt: str = "dossier-brief@1") -> dict:
    cfg = load_cfg(corpus)
    proj = load_profile(cfg["project"], "project")
    lenses, lt = {lens["slug"] for lens in proj["lenses"]}, lens_titles(proj)
    idx = source_index(corpus)
    exts = extractions(corpus)
    refused, model_label = [], model or writer

    # Anchor each quotation in its own source, one CLI call per source.
    asks: dict[str, list] = {}
    for sec, _ in BRIEF_SECTIONS:
        for i, item in enumerate(brief.get(sec) or []):
            if sec == "for_project" and item.get("lens") not in lenses:
                raise SystemExit(f"for_project[{i}].lens: {item.get('lens')!r} is not a lens of {proj['name']}")
            for j, ev in enumerate(item.get("evidence") or []):
                if ev.get("extraction_id"):
                    continue
                info = idx.get(ev.get("source"))
                if not info:
                    refused.append({"where": f"{sec}[{i}].evidence[{j}]", "status": f"no source {ev.get('source')!r}"})
                    continue
                asks.setdefault(info["source_id"], []).append((sec, i, j, ev.get("quote")))
    found: dict[tuple, dict] = {}
    for sid, items in asks.items():
        got = anchor_quotes(corpus, idx[sid], [q for *_, q in items], model=model_label, prompt=prompt, dry=plan)
        for (sec, i, j, _), g in zip(items, got):
            found[(sec, i, j)] = g
    if not plan:
        exts = extractions(corpus)

    out: dict = {"writer": writer, "title": brief.get("title") or "Cover memo", "lede": brief.get("lede", ""),
                 "next_steps": brief.get("next_steps") or [], "reading_order": []}
    used: set[str] = set()
    for sec, _ in BRIEF_SECTIONS:
        out[sec] = []
        for i, item in enumerate(brief.get(sec) or []):
            evs = []
            for j, ev in enumerate(item.get("evidence") or []):
                if ev.get("extraction_id"):
                    e = exts.get(ev["extraction_id"])
                    if not e or not e.get("direct_quote"):
                        refused.append({"where": f"{sec}[{i}].evidence[{j}]", "status": f"no passage {ev['extraction_id']}"})
                        continue
                    evs.append({"extraction_id": ev["extraction_id"], "quote": e["direct_quote"], "source_id": e["source_id"]})
                else:
                    g = found.get((sec, i, j)) or {}
                    if g.get("extraction_id") or (plan and "status" not in g and g):
                        evs.append({"extraction_id": g.get("extraction_id"), "quote": g["quote"],
                                    "source_id": idx[ev["source"]]["source_id"]})
                    elif g:
                        refused.append({"where": f"{sec}[{i}].evidence[{j}]", "status": g.get("status"),
                                        "quote": str(ev.get("quote"))[:200]})
            if sec != "for_project" and not evs:
                refused.append({"where": f"{sec}[{i}]", "status": "no quotation was found for it, so it was left out",
                                "quote": str(item.get("title"))[:120]})
                continue
            used.update(e["source_id"] for e in evs)
            out[sec].append({**{k: v for k, v in item.items() if k != "evidence"}, "evidence": evs})
    for i, r in enumerate(brief.get("reading_order") or []):
        info = idx.get(r.get("source"))
        if not info:
            refused.append({"where": f"reading_order[{i}]", "status": f"no source {r.get('source')!r}"})
            continue
        out["reading_order"].append({"source_id": info["source_id"], "why": r.get("why", "")})
    out["refused"] = refused
    report = {"themes": len(out["themes"]), "tensions": len(out["tensions"]), "for_project": len(out["for_project"]),
              "quotations": sum(len(x["evidence"]) for s, _ in BRIEF_SECTIONS for x in out[s]), "refused": refused}
    if plan:
        report["status"] = "plan"
        return report
    if not out["themes"]:
        raise SystemExit("the brief has no theme with a quotation found in its source; nothing was written")

    titles = {sid: idx[sid]["title"] for sid in used}
    md = [f"# {_prose(out['title'])}", "", f"Written by {_prose(writer)}.", "", _prose(out["lede"]), ""]
    claims, n = [], 0
    for sec, head in BRIEF_SECTIONS:
        if not out[sec]:
            continue
        md += [f"## {head or 'For ' + _prose(proj['name'])}", ""]
        for item in out[sec]:
            title = item.get("title") or lt.get(item.get("lens"), "")
            md += [f"### {_prose(title)}", "", _prose(item.get("text")), ""]
            for ev in item["evidence"]:
                md += [marker(ev["quote"], ev["extraction_id"]), f"({_prose(titles[ev['source_id']])} · {ev['source_id']})", ""]
            if item["evidence"]:
                n += 1
                claims.append({"claim_id": f"cl-{n:04d}", "text": f"{title}: {_prose(item.get('text'))}"[:600],
                               "evidence_ids": [ev["extraction_id"] for ev in item["evidence"]],
                               "source_ids": sorted({ev["source_id"] for ev in item["evidence"]}), "confidence": "medium"})
    if out["next_steps"]:
        md += ["## Next steps", ""] + [f"- [ ] {_prose(s)}" for s in out["next_steps"]] + [""]
    md += ["## Sources", ""] + [f"- {sid}: {_prose(titles[sid])}" for sid in sorted(used)] + [""]
    md_path = C.state_dir(corpus, "dossier") / "brief.md"
    md_path.write_text("\n".join(md), encoding="utf-8")
    prior = current_brief(corpus)
    produced = {**TOOL, "method": method, "prompt_version": prompt, **({"model": model} if model else {})}
    res = C.upc("add", "synthesis", "--corpus", str(corpus), "--output", str(md_path), "--tool", TOOL["tool"],
                *(["--supersedes", prior["synthesis_id"]] if prior else []), check=False, stdin=json.dumps({
                    "type": BRIEF, "title": out["title"], "claims": claims,
                    "question": f"What do these documents say that matters to {proj['name']}?",
                    "provenance": {"produced_by": produced}, "ext": {"upc_corpus": {"dossier_brief": out}}}))
    if not (isinstance(res, dict) and res.get("status") == "ok"):
        fails = (res or {}).get("failures", []) if isinstance(res, dict) else []
        raise SystemExit(f"the brief was refused: {(res or {}).get('detail') if isinstance(res, dict) else res}\n  "
                         + "\n  ".join(f"{f.get('marker')}: {f.get('reason')}" for f in fails[:8]))
    report.update(status="ok", synthesis_id=res["synthesis_id"])
    return report


# ------------------------------------------------------------------ reading the dossier back
def entries(corpus: Path) -> list[dict]:
    """The newest entry for each document (an older one stays in the corpus as history)."""
    out = []
    for g in latest_per_source(generations(corpus, ENTRY)):
        e = ((g.get("ext") or {}).get("upc_corpus") or {}).get("dossier_entry")
        if e:
            out.append({**e, "_gen": g["generation_id"], "_source_id": g["_source_id"], "_created": g["_created"],
                        "_model": ((g.get("provenance") or {}).get("produced_by") or {}).get("model")})
    return out


def current_brief(corpus: Path) -> dict | None:
    best = None
    for sj in corpus.glob("syntheses/*/synthesis.json"):
        y = C.load_json(sj, {})
        if y.get("type") != BRIEF or y.get("superseded_by"):
            continue
        if best is None or (y.get("provenance") or {}).get("created_at", "") > (best.get("provenance") or {}).get("created_at", ""):
            best = y
    return best


def page_of(e: dict) -> int | None:
    return next((s.get("value") for s in e.get("secondary_locators") or [] if s.get("type") == "page"), None)


def recheck(corpus: Path, es: list[dict], br: dict | None, cfg: dict) -> tuple[list[str], int]:
    """Find every quotation again in its stored source; attach its page. -> (problems, count)."""
    exts = extractions(corpus)
    problems, n = [], 0

    def one(item: dict, where: str):
        nonlocal n
        eid = item.get("extraction_id")
        if not eid:
            problems.append(f"{where}: no passage id")
            return
        try:
            e = check_extraction(corpus, eid, exts)
        except SystemExit as err:
            problems.append(f"{where}: {err}")
            return
        if e["direct_quote"] != item.get("quote"):
            problems.append(f"{where}: its quotation differs from the stored passage {eid}")
            return
        item["page"] = page_of(e)
        n += 1

    for en in es:
        for sec in ITEMS:
            for i, it in enumerate(en.get(sec) or []):
                one(it, f"{en['title'][:50]} · {sec}[{i}]")
        if en.get("suggested_by"):
            one(en["suggested_by"], f"{en['title'][:50]} · suggested_by")
    if br:
        b = br["ext"]["upc_corpus"]["dossier_brief"]
        for sec, _ in BRIEF_SECTIONS:
            for i, item in enumerate(b.get(sec) or []):
                for j, ev in enumerate(item.get("evidence") or []):
                    one(ev, f"brief · {sec}[{i}].evidence[{j}]")
    if (cfg.get("request") or {}).get("extraction_id"):
        one(cfg["request"], "config · request")
    return problems, n


def cmd_check(corpus: Path) -> int:
    rep = validate(corpus)
    cfg = load_cfg(corpus)
    aud, proj = load_profile(cfg["audience"], "audience"), load_profile(cfg["project"], "project")
    es, br = entries(corpus), current_brief(corpus)
    problems, n = recheck(corpus, es, br, cfg)
    errors = rep.get("errors") or []
    C.counts_header("Dossier: check", [("corpus errors (upc validate)", len(errors)), ("entries", len(es)),
                                       ("cover memo", br["synthesis_id"] if br else "none yet"),
                                       ("quotations found again", n), ("quotations NOT found", len(problems)),
                                       ("audience", aud["name"]), ("project", proj["name"])])
    for e in errors[:8]:
        print(f"  ERROR {e.get('code')}: {str(e.get('detail'))[:140]}")
    for p in problems[:20]:
        print(f"  NOT FOUND {p}")
    return 1 if errors or problems else 0


# ------------------------------------------------------------------ the site
CSS = """
:root{--desk:#ebe6db;--folder:#f2e2b6;--folder-2:#e8d39d;--folder-edge:#cdb47a;--paper:#fffdf8;--ink:#24201a;
--muted:#6b6354;--rule:#e3dac8;--stamp:#a3302a;--link:#22567f;--postit:#fff0a0;--postit-ink:#3a3212;--chip:#f7efd9;
--tape:rgba(246,236,196,.78);--shadow:0 1px 2px rgba(60,45,20,.08),0 6px 18px rgba(60,45,20,.08);
--mono:"American Typewriter","Courier Prime","Courier New",ui-monospace,Menlo,monospace;
--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--desk:#15140f;--folder:#383021;--folder-2:#463c28;
--folder-edge:#5e5034;--paper:#1e1c18;--ink:#ece5d8;--muted:#a99f8d;--rule:#36312a;--stamp:#e57f72;--link:#8fbde4;
--postit:#4a4322;--postit-ink:#f5ecc3;--chip:#2a261e;--tape:rgba(120,110,80,.5);
--shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.3)}}
:root[data-theme=dark]{--desk:#15140f;--folder:#383021;--folder-2:#463c28;--folder-edge:#5e5034;--paper:#1e1c18;
--ink:#ece5d8;--muted:#a99f8d;--rule:#36312a;--stamp:#e57f72;--link:#8fbde4;--postit:#4a4322;--postit-ink:#f5ecc3;
--chip:#2a261e;--tape:rgba(120,110,80,.5)}
*{box-sizing:border-box}
body{margin:0;background:var(--desk);color:var(--ink);font:16px/1.6 var(--sans);-webkit-text-size-adjust:100%}
a{color:var(--link)}
h1,h2,h3{font-family:var(--serif);font-weight:600;line-height:1.2;margin:0 0 .5em}
h1{font-size:clamp(1.8rem,4.2vw,2.8rem);letter-spacing:-.01em}
h2{font-size:1.45rem} h3{font-size:1.12rem}
p{margin:0 0 .8em}
.wrap{max-width:1140px;margin:0 auto;padding:0 16px 40px}
nav.tabs{display:flex;gap:4px;overflow-x:auto;padding:22px 0 0;scrollbar-width:thin}
nav.tabs a{flex:0 0 auto;background:var(--folder-2);color:var(--ink);text-decoration:none;font:600 .74rem/1 var(--mono);
letter-spacing:.07em;text-transform:uppercase;padding:11px 15px 10px;border:1px solid var(--folder-edge);border-bottom:none;
border-radius:10px 10px 0 0}
nav.tabs a.here{background:var(--folder);position:relative;top:1px}
main.folder{background:var(--folder);border:1px solid var(--folder-edge);border-radius:0 12px 12px 12px;
padding:clamp(16px,3vw,36px);box-shadow:var(--shadow)}
.sheet{background:var(--paper);border:1px solid var(--rule);border-radius:3px;padding:clamp(16px,3vw,30px);
box-shadow:var(--shadow);position:relative;margin:0 0 22px}
.label{font:600 .72rem/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.byline,.src{font-size:.84rem;color:var(--muted)}
.lede{font-size:1.06rem;color:var(--muted);max-width:68ch}
.stamp{display:inline-block;font:700 .8rem/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--stamp);
border:2.5px solid var(--stamp);border-radius:6px;padding:8px 11px;transform:rotate(-3deg);opacity:.88}
.cover-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
dl.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 22px;margin:18px 0}
dl.meta dt{font:600 .7rem/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
dl.meta dd{margin:2px 0 0}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--paper);border:1px solid var(--folder-edge);
color:var(--ink);text-decoration:none;font-size:.9rem;padding:8px 13px;border-radius:8px;margin:0 8px 8px 0}
.btn:hover{border-color:var(--ink)}
.cover-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:26px;align-items:start;margin-top:26px}
.memo{padding-top:34px}
.clip{position:absolute;top:-24px;left:26px;width:22px;height:64px;color:var(--muted);transform:rotate(7deg)}
.memo-head{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font:.86rem/1.45 var(--mono);
border-bottom:2px solid var(--rule);padding-bottom:12px;margin-bottom:16px}
.memo-head b{letter-spacing:.06em}
.theme{border-top:1px solid var(--rule);padding-top:14px;margin-top:16px}
blockquote.q{margin:8px 0 4px;padding:3px 0 3px 14px;border-left:3px solid var(--folder-edge);font-family:var(--serif);
font-size:1.02rem}
ul.ev,ol.points,ul.plain{list-style:none;margin:0;padding:0}
ul.ev li{margin:0 0 10px}
.postit{background:var(--postit);color:var(--postit-ink);padding:14px 16px 16px;box-shadow:0 2px 7px rgba(60,45,20,.2);
transform:rotate(-1deg);border-bottom-right-radius:22px 7px;margin:0 0 18px}
.postit h3,.postit .label{color:var(--postit-ink)}
.postit ol{margin:6px 0 0;padding-left:20px} .postit li{margin:0 0 6px}
.postits{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px;margin:6px 0 22px}
.postits .postit:nth-child(even){transform:rotate(1.1deg)}
.postit .who{display:block;font-size:.72rem;opacity:.75;margin-top:6px}
.slip{background:var(--paper);border:1px dashed var(--folder-edge);padding:12px 14px;margin:0 0 18px;font-size:.92rem}
.slip blockquote{margin:6px 0 0;font-family:var(--serif)}
.lensbar{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 18px}
.lensbar button{font:inherit;font-size:.82rem;border:1px solid var(--folder-edge);background:var(--chip);color:var(--ink);
padding:5px 11px;border-radius:999px;cursor:pointer}
.lensbar button[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:30px 20px;padding-top:14px}
.group{margin:0 0 30px} .group-title{font-size:1.15rem;margin:18px 0 2px;padding-top:14px;border-top:2px solid var(--folder-edge)}
.doc-card{position:relative;background:var(--paper);border:1px solid var(--rule);border-radius:3px 3px 6px 6px;
box-shadow:var(--shadow);display:flex;flex-direction:column}
.doc-card .tab{position:absolute;top:-17px;left:14px;background:var(--folder-2);border:1px solid var(--folder-edge);
border-bottom:none;border-radius:7px 7px 0 0;padding:3px 10px;font:600 .72rem/1.3 var(--mono);letter-spacing:.08em}
.doc-card .shot{display:block;height:150px;overflow:hidden;border-bottom:1px solid var(--rule);background:var(--chip)}
.doc-card .shot img{width:100%;display:block}
.doc-card .shot.ph{display:flex;align-items:flex-end;padding:12px;font:600 .8rem var(--mono);color:var(--muted)}
.doc-card .body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:6px;flex:1}
.doc-card h3{margin:0;font-size:1.05rem} .doc-card h3 a{color:var(--ink);text-decoration:none}
.doc-card h3 a:hover{text-decoration:underline}
.kind{align-self:flex-start;font:600 .66rem/1.2 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--stamp)}
.teaser{font-size:.9rem;margin:0}
.rel{display:flex;flex-wrap:wrap;gap:5px;margin-top:auto;padding-top:6px}
.rel span{font-size:.72rem;background:var(--chip);border:1px solid var(--rule);border-radius:999px;padding:1px 8px;white-space:nowrap}
.rel b{letter-spacing:1px;color:var(--stamp);font-weight:400}
.crumbs{font-size:.86rem;margin:0 0 12px}
.docgrid{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:26px;align-items:start}
.side .shot{background:var(--paper);padding:8px;box-shadow:var(--shadow);margin:0 0 16px;transform:rotate(.6deg)}
.side .shot img{width:100%;display:block}
dl.facts{margin:0;font-size:.88rem} dl.facts dt{font:600 .68rem/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;
color:var(--muted);margin-top:10px} dl.facts dd{margin:2px 0 0;overflow-wrap:anywhere}
ol.points>li{padding:12px 0;border-top:1px solid var(--rule)} ol.points>li:first-child{border-top:none}
.lens{font:600 .66rem/1.2 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.scroll{overflow-x:auto}
table.ledger{width:100%;border-collapse:collapse;font-size:.9rem}
table.ledger th{font:600 .68rem/1.2 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted);
text-align:left;border-bottom:2px solid var(--rule);padding:8px}
table.ledger td{border-bottom:1px solid var(--rule);padding:9px 8px;vertical-align:top}
table.ledger td.q{font-family:var(--serif);min-width:16em}
code{font-size:.8rem;overflow-wrap:anywhere}
.exhibits{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:26px;margin-top:10px}
figure.exhibit{margin:0;background:var(--paper);padding:10px 10px 8px;box-shadow:var(--shadow);position:relative}
figure.exhibit::before{content:"";position:absolute;top:-11px;left:50%;width:96px;height:24px;margin-left:-48px;
background:var(--tape);transform:rotate(-2deg);box-shadow:0 1px 2px rgba(0,0,0,.08)}
figure.exhibit img{width:100%;display:block;border:1px solid var(--rule)}
figure.exhibit figcaption{font-size:.82rem;color:var(--muted);margin-top:6px}
ul.check li{padding-left:28px;position:relative;margin:0 0 8px}
ul.check li::before{content:"";position:absolute;left:2px;top:4px;width:14px;height:14px;border:1.5px solid var(--muted);border-radius:3px}
button.copy{font:600 .68rem/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--rule);
background:transparent;color:var(--muted);border-radius:5px;padding:3px 7px;margin-left:8px;cursor:pointer}
.prevnext{display:flex;justify-content:space-between;gap:12px;margin-top:18px;font-size:.9rem}
.note{font-size:.84rem;color:var(--muted)}
footer.site{margin:26px 0 0;color:var(--muted);font-size:.82rem;max-width:80ch}
.hide{display:none!important}
@media (max-width:820px){.cover-grid,.docgrid{grid-template-columns:minmax(0,1fr)}.side{order:-1}
.side .shot{max-width:260px}}
@media print{body{background:#fff}nav.tabs,.lensbar,button.copy,.btn{display:none}main.folder,.sheet,.doc-card,
figure.exhibit{box-shadow:none;border-color:#ccc;background:#fff}.postit,.stamp,.side .shot{transform:none}
.postit{border:1px solid #bbb}a{color:inherit}}
"""

JS = """
document.querySelectorAll('.lensbar button').forEach(function(b){b.addEventListener('click',function(){
var k=b.dataset.lens;document.querySelectorAll('.lensbar button').forEach(function(x){x.setAttribute('aria-pressed',x===b)});
document.querySelectorAll('[data-lenses]').forEach(function(c){c.classList.toggle('hide',k!=='all'&&(' '+c.dataset.lenses+' ').indexOf(' '+k+' ')<0)});
document.querySelectorAll('.group').forEach(function(g){g.classList.toggle('hide',!g.querySelector('[data-lenses]:not(.hide)'))});});});
document.addEventListener('click',function(e){var b=e.target.closest('button.copy');if(!b)return;var t=b.getAttribute('data-cite');
function done(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1400)}
if(navigator.clipboard){navigator.clipboard.writeText(t).then(done,function(){})}});
"""

CLIP = ('<svg class="clip" viewBox="0 0 22 64" aria-hidden="true"><path d="M6 14v36a5 5 0 0 0 10 0V9a7.5 7.5 0 0 0-15 0v42" '
        'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>')


def fmt_day(s: str | None) -> str:
    if not s:
        return ""
    try:
        return dt.date.fromisoformat(str(s)[:10]).strftime("%-d %b %Y")
    except ValueError:
        return str(s)


def slug(s: str, n: int = 48) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:n].strip("-") or "document"


def short_title(d: dict) -> str:
    if d.get("short_title"):
        return d["short_title"]
    year = re.search(r"(19|20)\d\d", str(d.get("date") or ""))
    if d.get("author_org") and year:
        return f"{d['author_org']} {year.group(0)}"
    t = d["title"]
    return t if len(t) <= 60 else t[:57].rsplit(" ", 1)[0] + "…"


def cite_text(quote: str, d: dict, page: int | None) -> str:
    return f"“{quote}” ({short_title(d)}{f', p. {page}' if page else ''})"


def quote_html(item: dict, d: dict, link: str | None = None) -> str:
    src = f'<a href="{esc(link)}">{esc(short_title(d))}</a>' if link else esc(short_title(d))
    page = f", p. {item['page']}" if item.get("page") else ""
    return (f'<blockquote class="q">“{esc(item["quote"])}”</blockquote><div class="src">{src}{page}'
            f'<button class="copy" type="button" data-cite="{esc(cite_text(item["quote"], d, item.get("page")))}">Copy</button></div>')


def dots(n: int) -> str:
    return f'<b aria-label="{n} of 3">{"●" * n}{"○" * (3 - n)}</b>'


def rel_html(d: dict, ctx: dict) -> str:
    rel = d.get("relevance") or {}
    spans = [f'<span>{esc(ctx["lt"][k])} {dots(v)}</span>' for k, v in sorted(rel.items(), key=lambda kv: -kv[1])
             if v and k in ctx["lt"]]
    return f'<div class="rel">{"".join(spans)}</div>' if spans else ""


def lenses_of(d: dict) -> str:
    return " ".join(k for k, v in (d.get("relevance") or {}).items() if v >= 2)


def page_html(title: str, body: str, ctx: dict, here: str, depth: int = 0) -> str:
    up = "../" * depth
    tabs = [("index.html", "Cover"), ("timeline.html", "Timeline"), ("people.html", "Who's who"),
            ("terms.html", "Terms"), ("leads.html", "Leads"), ("method.html", "Method")]
    nav = "".join(f'<a href="{up}{h}" class="{"here" if h == here else ""}">{esc(t)}</a>'
                  for h, t in tabs if h in ctx["pages"])
    cfg = ctx["cfg"]
    foot = (f'Prepared for {esc(cfg["prepared_for"])}{" by " + esc(cfg["prepared_by"]) if cfg.get("prepared_by") else ""}, '
            f'{esc(fmt_day(cfg.get("date")))}. Summaries, notes and the memo are their writers\' own words, labelled as such. '
            "Every quotation matches the saved copy of its source, character for character. Fixity is not authenticity: "
            f'a match shows which words were read, not that they are right. <a href="{up}method.html">How this was made</a>.')
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="build" content="{esc(ctx['build'])}"><title>{esc(title)}</title><style>{CSS}</style></head><body>
<div class="wrap"><nav class="tabs" aria-label="Sections">{nav}</nav><main class="folder">{body}</main>
<footer class="site">{foot}</footer></div><script>{JS}</script></body></html>
"""


def cover_html(ctx: dict) -> str:
    cfg, aud, proj, docs, b = ctx["cfg"], ctx["aud"], ctx["proj"], ctx["docs"], ctx["brief"]
    dl = "".join(f'<a class="btn" href="{esc(f)}" download>{esc(label)}</a>' for f, label in ctx["downloads"])
    meta = [("Prepared for", cfg["prepared_for"]),
            ("Project", proj["name"] + (f" · {proj['full_name']}" if proj.get("full_name") else "")),
            ("Prepared by", cfg.get("prepared_by") or ""), ("Date", fmt_day(cfg.get("date")))]
    head = (f'<header><div class="cover-top"><span class="label">{esc(cfg.get("file_no") or "Dossier")} · '
            f'{len(docs)} documents</span><span class="stamp">{esc(cfg.get("stamp"))}</span></div>'
            f'<h1>{esc(cfg["title"])}</h1>' + (f'<p class="lede">{esc(cfg["subtitle"])}</p>' if cfg.get("subtitle") else "")
            + '<dl class="meta">' + "".join(f"<div><dt>{esc(k)}</dt><dd>{esc(v)}</dd></div>" for k, v in meta if v)
            + f"</dl><div>{dl}</div></header>")
    by_sid = {d["_source_id"]: d for d in docs}
    memo = ""
    if b:
        def ev_list(evs):
            return '<ul class="ev">' + "".join(
                f'<li>{quote_html(ev, by_sid[ev["source_id"]], "docs/" + by_sid[ev["source_id"]]["_file"]) if ev["source_id"] in by_sid else quote_html(ev, ctx["others"][ev["source_id"]])}</li>'
                for ev in evs) + "</ul>"
        parts = [f'<p>{esc(b.get("lede"))}</p>'] if b.get("lede") else []
        for sec, title in (("themes", "Themes"), ("tensions", "Where the documents pull apart")):
            if b.get(sec):
                parts.append(f"<h2>{title}</h2>" + "".join(
                    f'<section class="theme"><h3>{esc(t.get("title"))}</h3><p>{esc(t.get("text"))}</p>{ev_list(t["evidence"])}</section>'
                    for t in b[sec]))
        if b.get("for_project"):
            parts.append(f"<h2>What it means for {esc(proj['name'])}</h2>" + "".join(
                f'<section class="theme"><span class="lens">{esc(ctx["lt"].get(t.get("lens"), ""))}</span>'
                f'<p>{esc(t.get("text"))}</p>{ev_list(t["evidence"]) if t.get("evidence") else ""}</section>'
                for t in b["for_project"]))
        if b.get("next_steps"):
            parts.append('<h2>Next steps</h2><ul class="plain check">' + "".join(f"<li>{esc(s)}</li>" for s in b["next_steps"]) + "</ul>")
        memo = (f'<article class="sheet memo">{CLIP}<div class="memo-head"><b>TO</b><span>{esc(cfg["prepared_for"])}</span>'
                f'<b>FROM</b><span>{esc(cfg.get("prepared_by") or "")}</span><b>RE</b><span>{esc(cfg["title"])}</span>'
                f'<b>DATE</b><span>{esc(fmt_day(cfg.get("date")))}</span></div>'
                f'<p class="label">Memo · written by {esc(b["writer"])}</p>{"".join(parts)}</article>')
    aside = []
    req = cfg.get("request") or {}
    if req.get("quote"):
        aside.append(f'<div class="slip"><span class="label">Routing slip</span><p style="margin:4px 0 0">Resources suggested by '
                     f'<b>{esc(req.get("by") or "")}</b>{", " + esc(fmt_day(req.get("date"))) if req.get("date") else ""}.</p>'
                     f'<blockquote>“{esc(req["quote"])}”</blockquote></div>')
    order = (b or {}).get("reading_order") or [{"source_id": d["_source_id"], "why": ""} for d in docs[:5]]
    items = "".join(f'<li><a href="docs/{esc(by_sid[r["source_id"]]["_file"])}">{esc(short_title(by_sid[r["source_id"]]))}</a>'
                    f'{" — " + esc(r["why"]) if r.get("why") else ""}</li>' for r in order if r["source_id"] in by_sid)
    if items:
        aside.append(f'<div class="postit"><span class="label">Start here</span><ol>{items}</ol>'
                     f'<span class="who">— {esc((b or {}).get("writer") or cfg.get("prepared_by") or "")}</span></div>')
    grid = (f'<div class="cover-grid"><div>{memo or "<p class=note>No cover memo yet.</p>"}</div><aside>{"".join(aside)}</aside></div>')
    chips = ('<div class="lensbar" role="group" aria-label="Show documents by lens"><button data-lens="all" aria-pressed="true">All</button>'
             + "".join(f'<button data-lens="{esc(k)}" aria-pressed="false">{esc(v)}</button>' for k, v in ctx["lt"].items()
                       if any(k in lenses_of(d).split() for d in docs)) + "</div>")
    cards = "".join(
        (f'<div class="group" id="{esc(s["slug"])}"><h3 class="group-title">{esc(s["title"])}</h3>'
         + (f'<p class="note">{esc(s.get("description"))}</p>' if s.get("description") else "") if s else '<div class="group">')
        + f'<div class="cards">{"".join(card_html(d, ctx) for d in ds)}</div></div>' for s, ds in doc_groups(ctx))
    return (head + grid + f'<section id="documents" style="margin-top:18px"><h2>The documents</h2>'
            f'<p class="note">Lenses show how much each document bears on {esc(proj["name"])}: ●●● central, ●●○ useful, ●○○ background.</p>'
            f'{chips}{cards}</section>')


def card_html(d: dict, ctx: dict) -> str:
    img = (f'<a class="shot" href="docs/{esc(d["_file"])}" tabindex="-1"><img src="{esc(d["_cover"])}" alt="" loading="lazy"></a>'
           if d.get("_cover") else f'<a class="shot ph" href="docs/{esc(d["_file"])}" tabindex="-1">{esc(KIND_LABEL.get(d.get("kind"), d.get("kind") or "Document"))}</a>')
    first = re.split(r"(?<=[.!?])\s+", str(d.get("summary") or "").strip(), maxsplit=1)[0]
    sug = d.get("suggested_by")
    slip = (f'<p class="note" style="margin:0"><span class="label">{esc(sug.get("by") or "Suggested")}:</span> “{esc(sug["quote"])}”</p>'
            if sug else "")
    by = " · ".join(esc(x) for x in (d.get("author_org"), d.get("date")) if x)
    return (f'<article class="doc-card" data-lenses="{esc(lenses_of(d))}"><span class="tab">{esc(d["_no"])}</span>{img}'
            f'<div class="body"><span class="kind">{esc(KIND_LABEL.get(d.get("kind"), d.get("kind") or "Document"))}</span>'
            f'<h3><a href="docs/{esc(d["_file"])}">{esc(d["title"])}</a></h3><div class="byline">{by}</div>'
            f'<p class="teaser">{esc(first)}</p>{slip}{rel_html(d, ctx)}</div></article>')


def doc_html(d: dict, ctx: dict, prev: dict | None, nxt: dict | None) -> str:
    proj, lt = ctx["proj"], ctx["lt"]
    by = " · ".join(esc(x) for x in (d.get("authors"), d.get("author_org"), d.get("date"), d.get("identifier")) if x)
    sec = next((s for s in ctx["cfg"].get("sections") or [] if s["slug"] == d.get("section")), None)
    out = [f'<p class="crumbs"><a href="../index.html#{esc(sec["slug"]) if sec else "documents"}">← All documents</a> · '
           f'File {esc(d["_no"])} of {len(ctx["docs"])}{" · " + esc(sec["title"]) if sec else ""}</p>',
           f'<header><span class="kind">{esc(KIND_LABEL.get(d.get("kind"), d.get("kind") or "Document"))}</span>'
           f'<h1>{esc(d["title"])}</h1><p class="byline">{by}</p></header>']
    sug = d.get("suggested_by")
    main = []
    if sug:
        main.append(f'<div class="slip"><span class="label">Why it is in the file · {esc(sug.get("by") or "")}</span>'
                    f'<blockquote>“{esc(sug["quote"])}”</blockquote></div>')
    partial = (f'<p class="note">The writer read the first {d["read_chars"]:,} of {d["total_chars"]:,} characters.</p>'
               if d.get("read_chars") and d.get("total_chars") and d["read_chars"] < d["total_chars"] else "")
    main.append(f'<section class="sheet"><p class="label">Summary · by {esc(d["writer"])}</p><p>{esc(d.get("summary"))}</p>{partial}</section>')
    if d.get("why_it_matters"):
        main.append(f'<h2>Why it matters for {esc(proj["name"])}</h2><div class="postits">' + "".join(
            f'<div class="postit"><span class="label">{esc(lt.get(w.get("lens"), ""))}</span><p style="margin:4px 0 0">{esc(w.get("text"))}</p>'
            f'<span class="who">— {esc(d["writer"])}</span></div>' for w in d["why_it_matters"]) + "</div>")
    if d.get("key_points"):
        main.append('<section class="sheet"><h2>Key points</h2><ol class="points">' + "".join(
            f'<li>{f"<span class=lens>{esc(lt[k["lens"]])}</span>" if k.get("lens") in lt else ""}<p style="margin:2px 0 0">{esc(k.get("text"))}</p>'
            f'{quote_html(k, d)}</li>' for k in d["key_points"]) + "</ol></section>")
    tables = (("figures", "Numbers", ("What", "Figure"), ("label", "value")),
              ("dates", "Dates", ("When", "What"), ("date", "event")),
              ("actors", "Who's who in it", ("Who", "Position"), ("name", "stance")),
              ("terms", "Terms", ("Term", "Meaning"), ("term", "definition")))
    for sec, head, cols, keys in tables:
        if d.get(sec):
            rows = "".join(f'<tr><td>{esc(it.get(keys[0]))}{"<br><span class=note>" + esc(it["type"]) + "</span>" if it.get("type") else ""}</td>'
                           f'<td>{esc(it.get(keys[1]))}</td><td class="q">{quote_html(it, d)}</td></tr>' for it in d[sec])
            main.append(f'<section class="sheet"><h2>{head}</h2><div class="scroll"><table class="ledger"><tr><th>{cols[0]}</th>'
                        f'<th>{cols[1]}</th><th>The document says</th></tr>{rows}</table></div></section>')
    if d.get("_exhibits"):
        main.append('<section><h2>Exhibits</h2><div class="exhibits">' + "".join(
            f'<figure class="exhibit"><a href="../{esc(x["img"])}"><img src="../{esc(x["img"])}" alt="{esc(x["caption"])}" loading="lazy"></a>'
            f'<figcaption>{esc(x["caption"])} — page {x["page"]}</figcaption></figure>' for x in d["_exhibits"]) + "</div></section>")
    if d.get("questions"):
        main.append(f'<section class="sheet"><h2>Questions for the team</h2><p class="label">by {esc(d["writer"])}</p><ul class="plain check">'
                    + "".join(f"<li>{esc(q)}</li>" for q in d["questions"]) + "</ul></section>")
    if d.get("cites"):
        main.append('<section class="sheet"><h2>What it leans on</h2><ul class="ev">' + "".join(
            f'<li><b>{esc(c.get("ref"))}</b>{" — " + esc(c["note"]) if c.get("note") else ""}'
            f'{(" · <a href=" + chr(34) + esc(c["_link"]) + chr(34) + ">in this dossier</a>") if c.get("_link") else ""}{quote_html(c, d)}</li>'
            for c in d["cites"]) + "</ul></section>")
    facts = [("Kind", KIND_LABEL.get(d.get("kind"), d.get("kind"))), ("By", d.get("author_org")), ("Date", d.get("date")),
             ("Identifier", d.get("identifier")), ("Pages", d.get("pages")), ("License", d.get("license"))]
    dlh = "".join(f"<dt>{k}</dt><dd>{esc(v)}</dd>" for k, v in facts if v)
    src = d["_src"]
    if src.get("url"):
        dlh += f'<dt>Original</dt><dd><a href="{esc(src["url"])}" target="_blank" rel="noopener">{esc(src["url"])}</a></dd>'
    if d.get("_copy"):
        dlh += f'<dt>Saved copy</dt><dd><a href="../{esc(d["_copy"])}" download>PDF, {d["_copy_size"]}</a></dd>'
    elif d.get("_copy_note"):
        dlh += f'<dt>Saved copy</dt><dd>{esc(d["_copy_note"])}</dd>'
    if src.get("fetched_at"):
        dlh += f"<dt>Saved on</dt><dd>{esc(fmt_day(src['fetched_at']))}</dd>"
    if src.get("sha256"):
        dlh += f'<dt>SHA-256</dt><dd><code>{esc(src["sha256"][:16])}…</code></dd>'
    shot = f'<figure class="shot"><img src="../{esc(d["_cover"])}" alt="First page"></figure>' if d.get("_cover") else ""
    side = f'<aside class="side">{shot}<dl class="facts">{dlh}</dl>{rel_html(d, ctx)}</aside>'
    pn = ('<nav class="prevnext">' + (f'<a href="{esc(prev["_file"])}">← {esc(short_title(prev))}</a>' if prev else "<span></span>")
          + (f'<a href="{esc(nxt["_file"])}">{esc(short_title(nxt))} →</a>' if nxt else "<span></span>") + "</nav>")
    return "".join(out) + f'<div class="docgrid"><div class="main">{"".join(main)}</div>{side}</div>{pn}'


def gathered(ctx: dict, sec: str) -> list[tuple[dict, dict]]:
    return [(it, d) for d in ctx["docs"] for it in d.get(sec) or []]


def src_cell(it: dict, d: dict) -> str:
    return (f'<a href="docs/{esc(d["_file"])}">{esc(short_title(d))}</a>{", p. " + str(it["page"]) if it.get("page") else ""}'
            f'<button class="copy" type="button" data-cite="{esc(cite_text(it["quote"], d, it.get("page")))}">Copy</button>')


def date_key(s: str) -> str:
    m = re.match(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", str(s or ""))
    if m:
        return f"{m.group(1)}-{m.group(2) or '00'}-{m.group(3) or '00'}"
    y = re.search(r"(19|20)\d\d", str(s or ""))
    return f"{y.group(0)}-99-99" if y else "9999"


def timeline_html(ctx: dict) -> str:
    rows = sorted(gathered(ctx, "dates"), key=lambda p: (date_key(p[0].get("date")), p[1]["_no"]))
    body = "".join(f'<tr><td style="white-space:nowrap">{esc(it.get("date"))}</td><td>{esc(it.get("event"))}</td>'
                   f'<td class="q">“{esc(it["quote"])}”</td><td>{src_cell(it, d)}</td></tr>' for it, d in rows)
    return ('<h1>Timeline</h1><p class="lede">Every date the documents give, in order. The event is the writer\'s words; '
            'the quotation is the document\'s.</p><div class="sheet"><div class="scroll"><table class="ledger">'
            f'<tr><th>When</th><th>What</th><th>The document says</th><th>Source</th></tr>{body}</table></div></div>')


def people_html(ctx: dict) -> str:
    groups: dict[str, list] = {}
    for it, d in gathered(ctx, "actors"):
        groups.setdefault(re.sub(r"\s+", " ", str(it.get("name") or "")).strip(), []).append((it, d))
    out = ['<h1>Who\'s who</h1><p class="lede">The people and organizations the documents name, and the position each '
           'document gives them. Positions are the writer\'s words; the quotations are the documents\'.</p>']
    for name in sorted(groups, key=str.lower):
        kinds = sorted({str(it.get("type")) for it, _ in groups[name] if it.get("type")})
        out.append(f'<section class="sheet"><h2>{esc(name)}</h2>{"<p class=label>" + esc(" · ".join(kinds)) + "</p>" if kinds else ""}'
                   '<ul class="ev">' + "".join(f'<li><p style="margin:0">{esc(it.get("stance"))}</p><blockquote class="q">“{esc(it["quote"])}”</blockquote>'
                                              f'<div class="src">{src_cell(it, d)}</div></li>' for it, d in groups[name]) + "</ul></section>")
    return "".join(out)


def terms_html(ctx: dict) -> str:
    rows = sorted(gathered(ctx, "terms"), key=lambda p: str(p[0].get("term")).lower())
    body = "".join(f'<tr><td><b>{esc(it.get("term"))}</b></td><td>{esc(it.get("definition"))}</td>'
                   f'<td class="q">“{esc(it["quote"])}”</td><td>{src_cell(it, d)}</td></tr>' for it, d in rows)
    return ('<h1>Terms</h1><p class="lede">Terms the documents define or lean on. Meanings are the writer\'s words, '
            'each beside the passage it comes from.</p><div class="sheet"><div class="scroll"><table class="ledger">'
            f'<tr><th>Term</th><th>Meaning</th><th>The document says</th><th>Source</th></tr>{body}</table></div></div>')


def leads_html(ctx: dict) -> str:
    rows = gathered(ctx, "cites")
    body = "".join(f'<tr><td><b>{esc(it.get("ref"))}</b>{"<br><span class=note>" + esc(it["note"]) + "</span>" if it.get("note") else ""}</td>'
                   f'<td>{("<a href=" + chr(34) + "docs/" + esc(it["_link"]) + chr(34) + ">in this dossier</a>") if it.get("_link") else "not yet gathered"}</td>'
                   f'<td class="q">“{esc(it["quote"])}”</td><td>{src_cell(it, d)}</td></tr>' for it, d in rows)
    return ('<h1>Leads</h1><p class="lede">Earlier work the documents lean on. Each line is quoted from the document that '
            'cites it; those not in this dossier yet are leads to follow.</p><div class="sheet"><div class="scroll"><table class="ledger">'
            f'<tr><th>Work</th><th>Here?</th><th>Cited as</th><th>Cited in</th></tr>{body}</table></div></div>')


def method_html(ctx: dict) -> str:
    cfg, aud, proj = ctx["cfg"], ctx["aud"], ctx["proj"]
    rows = "".join(
        f'<tr><td>{esc(d["_no"])}</td><td><a href="docs/{esc(d["_file"])}">{esc(d["title"])}</a></td>'
        f'<td>{("<a href=" + chr(34) + esc(d["_src"]["url"]) + chr(34) + " target=_blank rel=noopener>original</a>") if d["_src"].get("url") else "—"}</td>'
        f'<td>{esc(fmt_day(d["_src"].get("fetched_at")))}</td><td><code>{esc((d["_src"].get("sha256") or "")[:16])}</code></td>'
        f'<td>{esc(d["writer"])}</td></tr>' for d in ctx["docs"])
    writers = sorted({d["writer"] for d in ctx["docs"]} | ({ctx["brief"]["writer"]} if ctx["brief"] else set()))
    readers = "".join(f"<li>{esc(r['name'])} — {esc(r['role'])}</li>" for r in aud["readers"])
    lenses = "".join(f"<li><b>{esc(lens['title'])}</b>: {esc(lens['description'])}</li>" for lens in proj["lenses"])
    dropped = ctx["dropped"]
    return f"""<h1>How this was made</h1>
<div class="sheet"><h2>The method</h2><ul>
<li>Each document was saved as it was served or received, with its exact bytes, its SHA-256 hash and when and where it came from.
The saved copies are kept with the corpus{"; the PDFs are offered for download here" if any(d.get("_copy") for d in ctx["docs"]) else ""}.</li>
<li>For each document, a writer ({esc(", ".join(writers))}) wrote a summary, notes and questions in their own words, labelled as such,
and proposed the passages behind each key point, figure, date, position, term and cited work.</li>
<li>A program then looked for every proposed quotation in the saved text, character for character. Only those it found are shown:
{ctx["quotes"]} quotations here{f", and {dropped} proposed quotations that were not found were left out" if dropped else ""}.
It looked again when this page was built.</li>
<li>A page number is the page as a PDF viewer counts it, which can differ from the number printed on the page.</li>
<li>The memo's themes each rest on quotations checked the same way. Relevance (●) is the writer's judgement against the project's lenses.</li>
<li>Fixity is not authenticity: a matching hash shows which bytes were read, not that what they say is right.
Provenance is not truth.</li></ul></div>
<div class="sheet"><h2>Written for</h2><p><b>{esc(aud['name'])}</b>{", " + esc(aud['organization']) if aud.get('organization') else ""}</p><ul>{readers}</ul>
<h2 style="margin-top:18px">The lenses ({esc(proj['name'])})</h2><ul>{lenses}</ul></div>
<div class="sheet"><h2>The documents</h2><div class="scroll"><table class="ledger"><tr><th>No.</th><th>Document</th><th>Where from</th>
<th>Saved</th><th>SHA-256</th><th>Entry written by</th></tr>{rows}</table></div></div>"""


# ------------------------------------------------------------------ images and copies
def render_page(pdf: Path, page: int, dest: Path, width: int) -> bool:
    """One PDF page as a JPEG (poppler's pdftoppm), unless it is already there."""
    if dest.exists():
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    p = subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile", "-scale-to", str(width), "-jpeg",
                        "-jpegopt", "quality=82", str(pdf), str(dest.with_suffix(""))], capture_output=True, text=True)
    return p.returncode == 0 and dest.exists()


# ------------------------------------------------------------------ the Word file
_MD_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!<>|~^$\"'@&=:%])")


def md(s) -> str:
    """Text pandoc reads literally: one line, every Markdown character escaped."""
    return _MD_SPECIAL.sub(r"\\\1", re.sub(r"\s+", " ", str(s or "")).strip())


def docx_markdown(ctx: dict, out: Path) -> str:
    cfg, proj, b = ctx["cfg"], ctx["proj"], ctx["brief"]
    lt = ctx["lt"]
    by_sid = {d["_source_id"]: d for d in ctx["docs"]}
    meta = {"title": cfg["title"], "subtitle": cfg.get("subtitle") or "",
            "author": [f"Prepared for {cfg['prepared_for']}"] + ([f"Prepared by {cfg['prepared_by']}"] if cfg.get("prepared_by") else []),
            "date": fmt_day(cfg.get("date"))}
    L = ["---"] + [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in meta.items() if v] + ["---", ""]

    def q(it, d):
        page = f", p. {it['page']}" if it.get("page") else ""
        return [f"> {md(it['quote'])}", ">", f"> — {md(short_title(d))}{md(page)}", ""]

    if b:
        L += ["# Cover memo", "", f"*{md('Written by ' + b['writer'] + '. Every quotation matches the saved copy of its source, character for character.')}*", ""]
        if b.get("lede"):
            L += [md(b["lede"]), ""]
        for sec, title in (("themes", "Themes"), ("tensions", "Where the documents pull apart")):
            if b.get(sec):
                L += [f"## {title}", ""]
                for t in b[sec]:
                    L += [f"### {md(t.get('title'))}", "", md(t.get("text")), ""]
                    for ev in t["evidence"]:
                        L += q(ev, by_sid.get(ev["source_id"]) or ctx["others"][ev["source_id"]])
        if b.get("for_project"):
            L += [f"## What it means for {md(proj['name'])}", ""]
            for t in b["for_project"]:
                L += [f"**{md(lt.get(t.get('lens'), ''))}.** {md(t.get('text'))}", ""]
                for ev in t.get("evidence") or []:
                    L += q(ev, by_sid.get(ev["source_id"]) or ctx["others"][ev["source_id"]])
        if b.get("next_steps"):
            L += ["## Next steps", ""] + [f"- ☐ {md(s)}" for s in b["next_steps"]] + [""]
        if b.get("reading_order"):
            L += ["## Where to start", ""] + [f"{i}. {md(short_title(by_sid[r['source_id']]))}" + (f" — {md(r['why'])}" if r.get("why") else "")
                                             for i, r in enumerate(b["reading_order"], 1) if r["source_id"] in by_sid] + [""]
    L += ["# The documents", ""]
    seen_sec = None
    for d in ctx["docs"]:
        if d.get("section") != seen_sec:
            seen_sec = d.get("section")
            s = next((s for s in ctx["cfg"].get("sections") or [] if s["slug"] == seen_sec), None)
            if s:
                L += [f"*{md(s['title'])}*" + (f" — {md(s['description'])}" if s.get("description") else ""), ""]
        L += [f"## {md(d['_no'])} · {md(d['title'])}", ""]
        facts = " · ".join(str(x) for x in (KIND_LABEL.get(d.get("kind"), d.get("kind")), d.get("author_org"), d.get("date"),
                                            d.get("identifier"), f"{d['pages']} pages" if d.get("pages") else None) if x)
        L += [f"*{md(facts)}*", ""]
        if d["_src"].get("url"):
            L += [f"Original: <{d['_src']['url']}>", ""]
        if d.get("suggested_by"):
            L += [f"**{md('Why it is in the file (' + (d['suggested_by'].get('by') or '') + ')')}**", ""]
            L += [f"> {md(d['suggested_by']['quote'])}", ""]
        L += [f"**{md('Summary, by ' + d['writer'])}.** {md(d.get('summary'))}", ""]
        if d.get("why_it_matters"):
            L += [f"**{md('Why it matters for ' + proj['name'])}**", ""]
            L += [f"- **{md(lt.get(w.get('lens'), ''))}:** {md(w.get('text'))}" for w in d["why_it_matters"]] + [""]
        if d.get("key_points"):
            L += ["### Key points", ""]
            for i, k in enumerate(d["key_points"], 1):
                L += [f"**{i}\\.** {md(k.get('text'))}", ""] + q(k, d)
        for sec, head, a, bb in (("figures", "Numbers", "label", "value"), ("dates", "Dates", "date", "event"),
                                 ("actors", "Who's who in it", "name", "stance"), ("terms", "Terms", "term", "definition")):
            if d.get(sec):
                L += [f"### {head}", ""]
                for it in d[sec]:
                    L += [f"**{md(it.get(a))}:** {md(it.get(bb))}", ""] + q(it, d)
        if d.get("questions"):
            L += ["### Questions for the team", ""] + [f"- ☐ {md(x)}" for x in d["questions"]] + [""]
        for x in d.get("_exhibits") or []:
            L += [f"![{md(x['caption'] + ' — ' + short_title(d) + ', page ' + str(x['page']))}]({(out / x['img']).as_posix()}){{width=6in}}", ""]
    leads = gathered(ctx, "cites")
    if leads:
        L += ["# Appendix: leads", "", md("Earlier work the documents lean on, each quoted from the document that cites it."), ""]
        for it, d in leads:
            L += [f"**{md(it.get('ref'))}** {md(('— ' + it['note']) if it.get('note') else '')}", ""] + q(it, d)
    L += ["# Appendix: sources and method", "",
          md("Each document was saved with its exact bytes and their SHA-256 hash. Every quotation in this file was found "
             "again in the saved text, character for character, when the file was made. Summaries, notes and the memo are "
             "their writers' own words. A page number is the page as a PDF viewer counts it, which can differ from the "
             "number printed on the page. Fixity is not authenticity: a match shows which words were read, not that they "
             "are right."), ""]
    for d in ctx["docs"]:
        bits = [x for x in (d["_src"].get("url"), f"saved {fmt_day(d['_src'].get('fetched_at'))}" if d["_src"].get("fetched_at") else None,
                            f"SHA-256 {d['_src']['sha256'][:16]}…" if d["_src"].get("sha256") else None) if x]
        L += [f"- **{md(d['_no'])}** {md(d['title'])}: {md(' · '.join(bits))}"]
    return "\n".join(L) + "\n"


FONT = '<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'


def _sz(hp: int) -> str:
    return f'<w:sz w:val="{hp}"/><w:szCs w:val="{hp}"/>'


def _style(sid, name, based, ppr, rpr, extra=""):
    return (f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/>' + (f'<w:basedOn w:val="{based}"/>' if based else "")
            + extra + "<w:qFormat/>" + (f"<w:pPr>{ppr}</w:pPr>" if ppr else "") + (f"<w:rPr>{rpr}</w:rPr>" if rpr else "") + "</w:style>")


def _heading(level, size, before, color):
    return _style(f"Heading{level}", f"heading {level}", "Normal",
                  f'<w:keepNext/><w:keepLines/><w:spacing w:before="{before}" w:after="100"/><w:outlineLvl w:val="{level - 1}"/>',
                  FONT + f'<w:b/><w:color w:val="{color}"/>' + _sz(size), '<w:next w:val="BodyText"/>')


DOCX_STYLES = {
    "BodyText": _style("BodyText", "Body Text", "Normal", '<w:spacing w:before="0" w:after="140" w:line="276" w:lineRule="auto"/>', ""),
    "FirstParagraph": _style("FirstParagraph", "First Paragraph", "BodyText", "", ""),
    "Compact": _style("Compact", "Compact", "BodyText", '<w:spacing w:before="0" w:after="60"/>', ""),
    "Title": _style("Title", "Title", "Normal", '<w:spacing w:before="1200" w:after="200"/>',
                    FONT + '<w:b/><w:color w:val="3A2F1E"/>' + _sz(48)),
    "Subtitle": _style("Subtitle", "Subtitle", "Title", '<w:spacing w:before="0" w:after="400"/>',
                       '<w:b w:val="0"/><w:color w:val="6B6354"/>' + _sz(28)),
    "Author": _style("Author", "Author", "Normal", '<w:spacing w:after="60"/>', FONT + _sz(24)),
    "Date": _style("Date", "Date", "Normal", '<w:spacing w:after="600"/>', FONT + '<w:color w:val="6B6354"/>' + _sz(24)),
    "Heading1": _heading(1, 34, 480, "3A2F1E"),
    "Heading2": _heading(2, 28, 360, "3A2F1E"),
    "Heading3": _heading(3, 24, 240, "6B5530"),
    "BlockText": _style("BlockText", "Block Text", "BodyText",
                        '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CDB47A"/></w:pBdr>'
                        '<w:spacing w:before="40" w:after="40"/><w:ind w:left="420" w:right="240"/>',
                        '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/>' + _sz(21)),
    "ImageCaption": _style("ImageCaption", "Image Caption", "BodyText", '<w:spacing w:after="240"/>',
                           '<w:i/><w:color w:val="6B6354"/>' + _sz(18)),
}
DOCX_DEFAULTS = ("<w:docDefaults><w:rPrDefault><w:rPr>" + FONT + _sz(22) +
                 '<w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
                 '<w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>')


def reference_docx(dest: Path) -> Path:
    """pandoc's own reference document, restyled (Calibri, warm headings, ruled block quotes)."""
    default = dest.with_name("default-reference.docx")
    subprocess.run(["pandoc", "-o", str(default), "--print-default-data-file", "reference.docx"],
                   check=True, capture_output=True, timeout=60)
    with zipfile.ZipFile(default) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/styles.xml":
                xml = re.sub(r"(?s)<w:docDefaults>.*?</w:docDefaults>", DOCX_DEFAULTS, data.decode("utf-8"), count=1)
                for sid, block in DOCX_STYLES.items():
                    xml, n = re.subn(r'(?s)<w:style [^>]*w:styleId="%s".*?</w:style>' % sid, block, xml)
                    if n == 0:
                        xml = xml.replace("</w:styles>", block + "</w:styles>")
                data = xml.encode("utf-8")
            zout.writestr(item, data)
    return dest


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", htmlmod.unescape(s)).strip()


def docx_text(path: Path) -> str:
    """The words in a .docx, paragraph by paragraph."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    xml = re.sub(r"<w:tab/>|<w:br/>", " ", xml)
    paras = [re.sub(r"<[^>]+>", "", p) for p in re.findall(r"(?s)<w:p[ >].*?</w:p>", xml)]
    return "\n".join(_norm_ws(p) for p in paras)


def make_docx(ctx: dict, out: Path, dest: Path, tmp: Path) -> tuple[str, list[str]]:
    """-> (the Markdown it was made from, quotations missing from the Word file)."""
    C.require_tools("pandoc")
    text = docx_markdown(ctx, out)
    src = tmp / "dossier.md"
    src.write_text(text, encoding="utf-8")
    ref = reference_docx(tmp / "reference.docx")
    p = subprocess.run(["pandoc", str(src), "-f", "markdown-smart", "-t", "docx", "--reference-doc", str(ref),
                        "--resource-path", str(out), "-o", str(dest)], capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise C.Unavailable(f"pandoc failed: {p.stderr.strip()[:400]}")
    words = _norm_ws(docx_text(dest)).replace("\n", " ")
    missing = [it["quote"] for it in all_quotes(ctx) if _norm_ws(it["quote"]) not in words]
    return text, missing


def all_quotes(ctx: dict) -> list[dict]:
    out = [it for d in ctx["docs"] for sec in ITEMS for it in d.get(sec) or []]
    out += [d["suggested_by"] for d in ctx["docs"] if d.get("suggested_by")]
    if ctx["brief"]:
        b = ctx["brief"]
        out += [ev for sec, _ in BRIEF_SECTIONS for t in b.get(sec) or [] for ev in t.get("evidence") or []]
    return out


# ------------------------------------------------------------------ the spreadsheet
_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def make_xlsx(ctx: dict, dest: Path) -> tuple[dict[str, int], str]:
    """-> (rows per sheet, every cell's text for the publish checks)."""
    from openpyxl import Workbook  # noqa: PLC0415
    from openpyxl.styles import Alignment, Font, PatternFill  # noqa: PLC0415
    wb = Workbook()
    wb.remove(wb.active)
    when = dt.datetime.fromisoformat(f"{str(ctx['cfg'].get('date'))[:10]}T00:00:00")
    wb.properties.created = wb.properties.modified = when
    wb.properties.creator = ctx["cfg"].get("prepared_by") or "upc-corpus dossier"
    wb.properties.title = ctx["cfg"]["title"]
    lt = ctx["lt"]
    head_font, head_fill = Font(bold=True), PatternFill("solid", fgColor="F2E2B6")
    wrap = Alignment(wrap_text=True, vertical="top")
    counts, text = {}, []

    def sheet(name, cols, widths, rows):
        ws = wb.create_sheet(name)
        ws.append(cols)
        for c in ws[1]:
            c.font, c.fill = head_font, head_fill
        for r in rows:
            vals = [_ILLEGAL.sub("", v)[:32000] if isinstance(v, str) else v for v in r]
            ws.append(vals)
            text.extend(str(v) for v in vals if v is not None)
        for i, w in enumerate(widths):
            ws.column_dimensions[chr(65 + i)].width = w
        for row in ws.iter_rows(min_row=2):
            for c in row:
                c.alignment = wrap
        ws.freeze_panes = "A2"
        counts[name] = len(rows)
        text.extend(cols)

    def src(it, d):
        return [short_title(d), it.get("page"), it["quote"], it.get("extraction_id")]

    docs = ctx["docs"]
    secs = {s["slug"]: s["title"] for s in ctx["cfg"].get("sections") or []}
    sheet("Documents", ["No.", "Section", "Title", "Kind", "By", "Date", "Identifier", "Pages", "Original URL", "Saved", "SHA-256",
                        "Suggested by", "Their words", "Entry written by", *[f"{v} (0-3)" for v in lt.values()]],
          [6, 22, 50, 16, 24, 12, 18, 7, 40, 12, 20, 18, 50, 22] + [12] * len(lt),
          [[d["_no"], secs.get(d.get("section"), ""), d["title"], KIND_LABEL.get(d.get("kind"), d.get("kind")), d.get("author_org"), d.get("date"),
            d.get("identifier"), d.get("pages"), d["_src"].get("url"), fmt_day(d["_src"].get("fetched_at")),
            d["_src"].get("sha256"), (d.get("suggested_by") or {}).get("by"), (d.get("suggested_by") or {}).get("quote"),
            d["writer"], *[(d.get("relevance") or {}).get(k, 0) for k in lt]] for d in docs])
    tail = ["Document", "Page", "The document says", "Passage id"]
    tw = [24, 7, 60, 18]
    sheet("Key points", ["Lens", "Point", *tail], [16, 50, *tw],
          [[lt.get(it.get("lens"), ""), it.get("text"), *src(it, d)] for it, d in gathered(ctx, "key_points")])
    sheet("Numbers", ["What", "Figure", *tail], [36, 20, *tw],
          [[it.get("label"), it.get("value"), *src(it, d)] for it, d in gathered(ctx, "figures")])
    sheet("Timeline", ["When", "What", *tail], [14, 50, *tw],
          [[it.get("date"), it.get("event"), *src(it, d)]
           for it, d in sorted(gathered(ctx, "dates"), key=lambda p: (date_key(p[0].get("date")), p[1]["_no"]))])
    sheet("Who's who", ["Name", "Type", "Position", *tail], [28, 18, 50, *tw],
          [[it.get("name"), it.get("type"), it.get("stance"), *src(it, d)]
           for it, d in sorted(gathered(ctx, "actors"), key=lambda p: str(p[0].get("name")).lower())])
    sheet("Terms", ["Term", "Meaning", *tail], [24, 50, *tw],
          [[it.get("term"), it.get("definition"), *src(it, d)]
           for it, d in sorted(gathered(ctx, "terms"), key=lambda p: str(p[0].get("term")).lower())])
    sheet("Leads", ["Work", "Note", "In this dossier", *tail], [50, 30, 14, *tw],
          [[it.get("ref"), it.get("note"), "yes" if it.get("_link") else "no", *src(it, d)] for it, d in gathered(ctx, "cites")])
    sheet("Questions", ["Document", "Question", "Asked by"], [30, 80, 22],
          [[short_title(d), qn, d["writer"]] for d in docs for qn in d.get("questions") or []])
    sheet("Lenses", ["Lens", "Short", "What it covers"], [40, 16, 80],
          [[lens["title"], lt[lens["slug"]], lens["description"]] for lens in ctx["proj"]["lenses"]])
    wb.save(dest)
    return counts, "\n".join(text)


# ------------------------------------------------------------------ build
def local_paths_in(texts: dict[str, str], corpus: Path) -> list[tuple[str, str]]:
    needles = ["file://", "/Users/", "/home/", str(Path.home()), str(corpus)]
    return [(name, n) for name, t in texts.items() for n in needles if n and n in t]


def order_docs(es: list[dict], cfg: dict, idx: dict) -> list[dict]:
    """By section (the config's order), then the config's document order, then relevance."""
    want = [idx[x]["source_id"] for x in cfg.get("order") or [] if x in idx]
    rank = {sid: i for i, sid in enumerate(want)}
    sec = {s["slug"]: i for i, s in enumerate(cfg.get("sections") or [])}
    return sorted(es, key=lambda e: (sec.get(e.get("section"), len(sec)), rank.get(e["_source_id"], len(rank)),
                                     -sum((e.get("relevance") or {}).values()), e["title"].lower()))


def doc_groups(ctx: dict) -> list[tuple[dict | None, list[dict]]]:
    """The documents by section, in order; one untitled group when the config has none."""
    secs = ctx["cfg"].get("sections") or []
    groups = [(s, [d for d in ctx["docs"] if d.get("section") == s["slug"]]) for s in secs]
    rest = [d for d in ctx["docs"] if d.get("section") not in {s["slug"] for s in secs}]
    if rest:
        groups.append(({"slug": "other", "title": "Other documents", "description": ""} if secs else None, rest))
    return [(s, ds) for s, ds in groups if ds]


def build(corpus: Path, out: Path, *, copies: bool = False, docx: bool = True, xlsx: bool = True,
          images: bool = True) -> dict:
    corpus, out = Path(corpus).resolve(), Path(out).resolve()
    rep = validate(corpus)
    if rep.get("errors"):
        raise SystemExit("the corpus does not validate; a dossier is built only from one that does:\n  "
                         + "\n  ".join(f"{e.get('code')}: {str(e.get('detail'))[:120]}" for e in rep["errors"][:8]))
    cfg = load_cfg(corpus)
    aud, proj = load_profile(cfg["audience"], "audience"), load_profile(cfg["project"], "project")
    es = entries(corpus)
    if not es:
        raise SystemExit("no entries yet (dossier.py add or write)")
    br_obj = current_brief(corpus)
    problems, nq = recheck(corpus, es, br_obj, cfg)
    if problems:
        raise SystemExit("refusing to build: quotations not found again in their sources:\n  " + "\n  ".join(problems[:12]))
    br = br_obj["ext"]["upc_corpus"]["dossier_brief"] if br_obj else None
    idx = source_index(corpus)
    docs = order_docs(es, cfg, idx)
    width = len(str(len(docs)))
    for i, d in enumerate(docs, 1):
        d["_no"] = f"{i:0{max(2, width)}d}"
        d["_src"] = idx.get(d["_source_id"]) or {}
        d["_file"] = f"{d['_no']}-{slug(short_title(d))}.html"
    in_dossier = {d["_source_id"]: d for d in docs}
    for d in docs:
        for c in d.get("cites") or []:
            target = idx.get(c.get("in_corpus") or "") or {}
            if target.get("source_id") in in_dossier:
                c["_link"] = in_dossier[target["source_id"]]["_file"]  # beside the citing page, in docs/
    # A memo quotation from a source with no entry of its own (the request note, say) still needs a name.
    others = {sid: {"title": info["title"], "short_title": info["title"][:60]} for sid, info in idx.items()
              if info["source_id"] == sid and sid not in in_dossier}
    # Fold the build inputs into one id, so an unchanged dossier rebuilds identically.
    digest = hashlib.sha256(json.dumps([cfg, aud, proj, [d["_gen"] for d in docs], (br_obj or {}).get("synthesis_id"),
                                        TOOL], sort_keys=True, default=str).encode()).hexdigest()[:12]
    ctx = {"cfg": cfg, "aud": aud, "proj": proj, "docs": docs, "brief": br, "lt": lens_titles(proj), "others": others,
           "build": f"{str(cfg.get('date'))[:10]}-{digest}", "quotes": nq,
           "dropped": sum(len(d.get("refused") or []) for d in docs) + len((br or {}).get("refused") or []),
           "pages": {"index.html", "method.html"}}
    for sec, name in (("dates", "timeline.html"), ("actors", "people.html"), ("terms", "terms.html"), ("cites", "leads.html")):
        if gathered(ctx, sec):
            ctx["pages"].add(name)

    out.mkdir(parents=True, exist_ok=True)
    produced: set[str] = set()
    img_log: list = []
    known = {i["file"]: i for i in C.load_json(manifest_path(out), {}).get("images", []) if i.get("file")}
    for d in docs:
        src, key = d["_src"], slug(d["_src"].get("slug") or d["_source_id"], 60)
        pdf = src.get("pdf_path")
        if images and pdf and Path(pdf).exists():
            rel = f"img/{key}-cover.jpg"
            if render_page(Path(pdf), 1, out / rel, 640):
                d["_cover"] = rel
                produced.add(rel)
            d["_exhibits"] = []
            for x in d.get("exhibits") or []:
                rel = f"img/{key}-p{x['page']}.jpg"
                if render_page(Path(pdf), x["page"], out / rel, 1500):
                    d["_exhibits"].append({**x, "img": rel})
                    produced.add(rel)
        elif images and src.get("raw_path") and Path(src["raw_path"]).exists():
            og = meta_content(Path(src["raw_path"]).read_text(encoding="utf-8", errors="replace")[:400_000], "og:image", "twitter:image")
            rel = thumbnail(og, out, img_log, known)
            if rel:
                d["_cover"] = rel
                produced.add(rel)
        if copies and pdf and Path(pdf).exists():
            size = Path(pdf).stat().st_size
            if size <= MAX_COPY:
                rel = f"files/{d['_no']}-{slug(short_title(d))}.pdf"
                dest = out / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists() or dest.stat().st_size != size:
                    shutil.copyfile(pdf, dest)
                d["_copy"], d["_copy_size"] = rel, size_label(size)
                produced.add(rel)
            else:
                d["_copy_note"] = f"too large to include here ({round(size / 1_048_576)} MB); read it at the original link"

    name = slug(cfg.get("file_name") or cfg["title"], 60)
    downloads = []
    texts: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as tmpd:
        tmp = Path(tmpd)
        rows = {}
        if docx:
            md_text, missing = make_docx(ctx, out, tmp / f"{name}.docx", tmp)
            if missing:
                raise SystemExit("refusing to build: quotations missing from the Word file:\n  "
                                 + "\n  ".join(repr(m[:90]) for m in missing[:8]))
            texts[f"{name}.docx (source)"] = md_text.replace(str(out), "")  # image paths are the build's own
            texts[f"{name}.docx"] = docx_text(tmp / f"{name}.docx")
            downloads.append((f"{name}.docx", f"Word (.docx, {size_label((tmp / f'{name}.docx').stat().st_size)})"))
        if xlsx:
            rows, cells = make_xlsx(ctx, tmp / f"{name}.xlsx")
            texts[f"{name}.xlsx"] = cells
            downloads.append((f"{name}.xlsx", f"Spreadsheet (.xlsx, {size_label((tmp / f'{name}.xlsx').stat().st_size)})"))
        ctx["downloads"] = downloads

        pages = {"index.html": page_html(cfg["title"], cover_html(ctx), ctx, "index.html"),
                 "method.html": page_html(f"Method · {cfg['title']}", method_html(ctx), ctx, "method.html")}
        for i, d in enumerate(docs):
            pages[f"docs/{d['_file']}"] = page_html(f"{short_title(d)} · {cfg['title']}",
                                                    doc_html(d, ctx, docs[i - 1] if i else None, docs[i + 1] if i + 1 < len(docs) else None),
                                                    ctx, "index.html", depth=1)
        for name_, fn in (("timeline.html", timeline_html), ("people.html", people_html), ("terms.html", terms_html),
                          ("leads.html", leads_html)):
            if name_ in ctx["pages"]:
                pages[name_] = page_html(f"{name_.split('.')[0].capitalize()} · {cfg['title']}", fn(ctx), ctx, name_)
        texts.update(pages)

        never = list(aud.get("never_publish") or []) + list(proj.get("never_publish") or []) + list(cfg.get("suppress") or [])
        hits = suppressed_in(texts, never)
        if hits:
            raise SystemExit("refusing to build: a never-publish phrase would appear:\n  "
                             + "\n  ".join(f"{n}: {w!r}" for n, w in hits[:12]))
        leaks = local_paths_in(texts, corpus)
        if leaks:
            raise SystemExit("refusing to build: a local path would be published:\n  "
                             + "\n  ".join(f"{n}: {w!r}" for n, w in leaks[:12]))
        for rel, text in pages.items():
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_text(text, encoding="utf-8")
            produced.add(rel)
        for f, _ in downloads:
            shutil.copyfile(tmp / f, out / f)
            produced.add(f)
    for f in sorted(out.rglob("*"), reverse=True):  # anything an earlier build made that this one did not
        rel = f.relative_to(out).as_posix()
        if f.is_file() and rel not in produced:
            f.unlink()
        elif f.is_dir() and not any(f.iterdir()):
            f.rmdir()
    C.save_json(manifest_path(out), {"built": ctx["build"], **TOOL, "corpus": str(corpus), "pages": sorted(pages),
                                     "documents": [{"no": d["_no"], "source_id": d["_source_id"], "generation_id": d["_gen"]} for d in docs],
                                     "brief": (br_obj or {}).get("synthesis_id"), "quotations": nq, "images": img_log,
                                     "downloads": [f for f, _ in downloads], "rows": rows})
    C.upc("event", "--corpus", str(corpus), check=False, stdin=json.dumps({
        "activity_type": "export", "tool": TOOL["tool"], "started_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "status": "success", "inputs": {"generation_ids": [d["_gen"] for d in docs]},
        "notes": f"dossier: {len(docs)} documents, {nq} quotations -> {out.name}"}))
    return {"documents": len(docs), "quotations": nq, "pages": len(pages), "downloads": [f for f, _ in downloads],
            "rows": rows, "covers": sum(bool(d.get("_cover")) for d in docs),
            "exhibits": sum(len(d.get("_exhibits") or []) for d in docs),
            "copies": sum(bool(d.get("_copy")) for d in docs), "out": str(out), "build": ctx["build"]}


def size_label(n: int) -> str:
    return f"{n / 1_048_576:.1f} MB" if n >= 1_048_576 else f"{max(1, round(n / 1024))} KB"


def manifest_path(out: Path) -> Path:
    """The build record lives beside the site, not in it: it names local paths."""
    return out.parent / f"{out.name}.build.json"


# ------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init", help="write or update the dossier's config")
    p.add_argument("--corpus", required=True)
    for f in ("audience", "project", "title", "subtitle", "prepared-for", "prepared-by", "date", "stamp", "file-no",
              "file-name", "order", "request-source", "request-quote", "request-by", "request-date"):
        p.add_argument(f"--{f}")
    p.add_argument("--suppress", action="append", help="a phrase that must never be published (repeatable)")
    p.add_argument("--sections", help="a JSON file: [{slug, title, description}], the groups documents are shown in")
    for name in ("add", "brief"):
        p = sub.add_parser(name, help=f"store {'an entry' if name == 'add' else 'the cover memo'} written elsewhere")
        p.add_argument("--corpus", required=True)
        p.add_argument("--from", dest="src", required=True, help="the JSON file (references/dossier.md)")
        p.add_argument("--writer", required=True, help="whose words these are, as the pages name them")
        p.add_argument("--model", help="the model's name, when a model wrote it")
        p.add_argument("--method", default="model", help="model, or manual for a person")
        p.add_argument("--plan", action="store_true", help="check the quotations, write nothing")
        if name == "add":
            p.add_argument("--replace", action="store_true", help="rewrite an entry made from the same passages")
    p = sub.add_parser("write", help="have the configured model write the entries")
    p.add_argument("--corpus", required=True)
    p.add_argument("--source")
    p.add_argument("--redo", action="store_true")
    p.add_argument("--plan", action="store_true")
    p.add_argument("--max-chars", type=int, default=48000)
    p = sub.add_parser("build", help="the site, the Word file and the spreadsheet")
    p.add_argument("--corpus", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--copies", action="store_true", help="offer each PDF (up to 25 MiB) for download")
    p.add_argument("--no-docx", action="store_true")
    p.add_argument("--no-xlsx", action="store_true")
    p.add_argument("--no-images", action="store_true")
    p = sub.add_parser("check", help="find every quotation again; write nothing")
    p.add_argument("--corpus", required=True)
    a = ap.parse_args()
    corpus = Path(a.corpus).expanduser().resolve()
    if a.cmd == "init":
        return cmd_init(corpus, a)
    if a.cmd == "add":
        entry = C.load_json(a.src, None)
        if not isinstance(entry, dict):
            raise SystemExit(f"{a.src}: not a JSON object")
        rep = add_entry(corpus, entry, writer=a.writer, model=a.model, method=a.method, replace=a.replace, plan=a.plan)
        print_entry_report(rep)
        if not a.plan:
            C.upc("regen", str(corpus), check=False)
        return 0
    if a.cmd == "brief":
        b = C.load_json(a.src, None)
        if not isinstance(b, dict):
            raise SystemExit(f"{a.src}: not a JSON object")
        rep = add_brief(corpus, b, writer=a.writer, model=a.model, method=a.method, plan=a.plan)
        C.counts_header("Brief", [("status", rep.get("status")), ("themes", rep["themes"]), ("tensions", rep["tensions"]),
                                  ("for the project", rep["for_project"]), ("quotations", rep["quotations"]),
                                  ("not found", len(rep["refused"]))])
        for r in rep["refused"]:
            print(f"  NOT FOUND {r['where']} ({r['status']}): {r.get('quote', '')[:110]!r}")
        if not a.plan:
            C.upc("regen", str(corpus), check=False)
        return 0
    if a.cmd == "write":
        return cmd_write(corpus, a.source, a.redo, a.plan, a.max_chars)
    if a.cmd == "check":
        return cmd_check(corpus)
    t0 = time.time()
    res = build(corpus, Path(a.out).expanduser(), copies=a.copies, docx=not a.no_docx, xlsx=not a.no_xlsx,
                images=not a.no_images)
    C.counts_header("Dossier", [("documents", res["documents"]), ("quotations, found again", res["quotations"]),
                                ("pages", res["pages"]), ("first-page images", res["covers"]), ("exhibits", res["exhibits"]),
                                ("PDF copies", res["copies"]), ("downloads", ", ".join(res["downloads"]) or "none"),
                                ("spreadsheet rows", ", ".join(f"{k} {v}" for k, v in res["rows"].items()) or "—"),
                                ("site", res["out"]), ("build", res["build"]), ("seconds", round(time.time() - t0, 1))])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as e:
        C.die(f"UNAVAILABLE: {e}")
