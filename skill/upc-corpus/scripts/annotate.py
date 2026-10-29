#!/usr/bin/env python3
"""Annotate each paper, field by field, with a local model.

    python3 annotate.py --corpus <dir> --fields <spec.json> --coder <project>-annotate-<model>-v1
                        [--model think|chat] [--context "<what the team is studying>"]
                        [--ids s0001,s0002] [--limit N] [--plan] [--redo]

The field spec says what an annotation holds, one object per field (a list, or
{"fields": [...]}):

    [{"key": "setting", "label": "Setting", "kind": "code", "scheme": "building-type", "max_words": 25},
     {"key": "barriers", "label": "Barriers and enablers", "kind": "text", "max_words": 60,
      "guide": "what slowed or helped the change, as the paper reports it"}]

A "code" field picks from the named codebook's codes (one, or several when the
codebook is multi-label) and adds a one-line note; a "text" field is a sentence
or two. Both list the passages they rest on (the answer's shape allows only the
ids the model was shown). `guide` (optional) says what the field means;
`max_words` defaults to 25 for a note and 60 for a text.

Per paper the model reads its title, the opening of its reading copy (the first
5,000 characters: abstract and introduction say what a paper is) and the passages
already coded in it, each with its id and codes. Not the whole paper: the coding
pass read that, and an annotation stands on what it marked.

The model proposes, the tool disposes:
  * a code outside its codebook is dropped; a single-label field keeps one code;
  * a citation of a passage the model was not shown is removed;
  * quotation marks in a note or a text are removed: the one quotation a field
    carries is its `quote`, kept only when `upc anchor` finds it in the paper (into
    a hidden set, so it is checked but not listed as a passage; a quote that is a
    coded passage resolves to that passage);
  * words over `max_words` are cut, at a sentence end when one fits; a first sentence
    up to half again the limit is kept whole rather than cut mid-phrase.

Each annotation is a generation (`upc add generation`, type x-annotation), so `upc`
re-checks its quotations and pins the text it was read from. `ext["upc-site"].card`
shows it as an "Annotation" card on the paper's page; `ext["upc-corpus"].annotation`
holds the fields for `sources_table.py`. It is labelled as a model's work.

A paper this coder has annotated is skipped; `--redo` writes it again (same inputs:
replaced; different passages: a new generation, and the newest is the one shown).
Every server in the config's pool works at once (llm_pool.py); writes are one at a time.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
import corpus_view as V  # noqa: E402
import llm_pool as P  # noqa: E402

TOOL = {"tool": "upc-corpus/annotate", "tool_version": "1.0.0"}
TYPE, CARD, PROMPT_VERSION, TEMPERATURE = "x-annotation", "Annotation", "annotate.v1", 0.2
HEAD_CHARS = 5000
NOT_REPORTED = "Not reported."
EXT_ANY = re.compile(r"[\[(]?\b(ext-[0-9a-f]{12})\b[\])]?")
EXT_MARK = re.compile(r"\[ext-[0-9a-f]{12}\]")
QUOTE_MARKS = re.compile(r'["“”]')
TIGHTER = ("\n\nIMPORTANT: your last answer was cut off. Keep every field short, cite at most two "
           "passages per field, and leave \"quote\" empty unless it is essential.")


def load_fields(path: str, books: dict[str, dict]) -> list[dict]:
    """The field spec, checked: unique slug keys, a known kind, a codebook for every code field."""
    raw = C.load_json(Path(path).expanduser())
    raw = raw.get("fields") if isinstance(raw, dict) else raw
    if not isinstance(raw, list) or not raw:
        C.die(f"{path}: not a field spec (a JSON list of {{key, label, kind, scheme?, max_words}})")
    out, seen = [], set()
    for i, f in enumerate(raw):
        key, kind = str(f.get("key") or ""), f.get("kind") or "text"
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", key) or key in seen:
            C.die(f"{path}: field {i + 1} needs a unique lower-case key (got {key!r})")
        if kind not in ("code", "text"):
            C.die(f"{path}: field {key}: kind must be \"code\" or \"text\" (got {kind!r})")
        seen.add(key)
        fld = {"key": key, "label": str(f.get("label") or key), "kind": kind,
               "max_words": int(f.get("max_words") or (25 if kind == "code" else 60)), "guide": str(f.get("guide") or "")}
        if kind == "code":
            if f.get("scheme") not in books:
                C.die(f"{path}: field {key}: scheme {f.get('scheme')!r} is not a codebook here ({', '.join(sorted(books))})")
            fld["scheme"] = f["scheme"]
        out.append(fld)
    return out


def coded_passages(corpus: Path, books_by_id: dict[str, dict]) -> dict[str, list[dict]]:
    """source_id -> its coded passages in document order: id, quote and codes ("Codebook: Code").
    Hidden sets (checked evidence, not passages) are left out."""
    hidden = {m.parent.name for m in corpus.glob("extractions/*/manifest.json")
              if (((C.load_json(m, {}) or {}).get("ext") or {}).get("upc-site") or {}).get("hidden")}
    exts = {e["extraction_id"]: e
            for f in list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl"))
            if f.parent.name not in hidden for e in V.read_jsonl(f)
            if e.get("direct_quote") and (e.get("status") or "active") == "active"}
    tags: dict[str, list[str]] = {}
    for f in corpus.glob("codings/*/items.jsonl"):
        for c in V.read_jsonl(f):
            t, book = c.get("target") or {}, books_by_id.get(c.get("codebook_ref"))
            if t.get("kind") != "extraction" or t.get("id") not in exts or not book or c.get("code") in (None, "none") \
                    or (c.get("status") or "active") != "active":
                continue
            label = next((x.get("label") or x["code"] for x in book.get("codes", []) if x["code"] == c["code"]), c["code"])
            tag = f"{book.get('title') or book['slug']}: {label}"
            if tag not in tags.setdefault(t["id"], []):
                tags[t["id"]].append(tag)
    out: dict[str, list[dict]] = {}
    for xid, ts in tags.items():
        e = exts[xid]
        at = ((e.get("locator") or {}).get("value") or {}).get("start")
        out.setdefault(e["source_id"], []).append({"id": xid, "quote": e["direct_quote"], "codes": ts,
                                                   "at": at if isinstance(at, int) else 0})
    for ps in out.values():
        ps.sort(key=lambda p: p["at"])
    return out


def shown(passages: list[dict], cap: int) -> list[dict]:
    """At most `cap` passages, the most-coded first, back in document order."""
    if len(passages) <= cap:
        return passages
    keep = {p["id"] for p in sorted(passages, key=lambda p: -len(p["codes"]))[:cap]}
    return [p for p in passages if p["id"] in keep]


def system_prompt(fields: list[dict], books: dict[str, dict], context: str) -> str:
    L = [f"You are annotating one paper for a research team studying {context.strip().rstrip('.')}.",
         "You are given its title, its opening, and the passages a coder marked in it, each with its id and codes.",
         "Write each field below from what THIS paper says.", "", "FIELDS:"]
    for n, f in enumerate(fields, 1):
        guide = f" {f['guide'].rstrip('.')}." if f["guide"] else ""
        if f["kind"] == "code":
            b = books[f["scheme"]]
            how = "one or more codes" if b.get("multi_label") else "exactly one code"
            L += ["", f"{n}. {f['key']}: {f['label']}.{guide} Give {how} from this list (none when the paper "
                      f"does not say) and a note of at most {f['max_words']} words."]
            L += [f"   - {c['code']}: {c.get('label', c['code'])}. {c.get('definition', '')}".rstrip()
                  for c in b.get("codes", []) if c["code"] != "none"]
        else:
            L += ["", f"{n}. {f['key']}: {f['label']}.{guide} One or two sentences, at most {f['max_words']} words."]
    shape = ", ".join(f'"{f["key"]}": ' + ('{"codes": ["<code>"], "note": "<note>"' if f["kind"] == "code"
                                           else '{"text": "<sentences>"') + ', "passages": ["<id>"], "quote": ""}'
                      for f in fields)
    L += ["", "RULES:",
          "1. Say only what this paper says or shows. Where it says nothing on a field, give no code, or write: Not reported.",
          "2. In each field's \"passages\", list the ids (from PASSAGES) of the passages it rests on: usually one to "
          "three. Leave it empty only when the field rests on the opening alone.",
          "3. Put no quotation marks in a note or a text. To quote the paper, copy one sentence (at most 40 words) "
          "EXACTLY from the opening or a passage into that field's \"quote\"; otherwise leave \"quote\" empty.",
          "4. Plain words: no lists, no headings, no Markdown.",
          "", "Return JSON exactly like this:", "{\"fields\": {" + shape + "}}"]
    return "\n".join(L)


def user_prompt(title: str, opening: str, passages: list[dict]) -> str:
    rows = [f"[{p['id']}] ({'; '.join(p['codes'])}) {p['quote']}" for p in passages]
    return (f"TITLE: {title}\n\nOPENING (its first {len(opening):,} characters):\n{opening}\n\n"
            + (f"PASSAGES ({len(rows)} coded in this paper):\n" + "\n".join(rows) if rows
               else "PASSAGES: none are coded in this paper yet; work from the opening."))


def schema(fields: list[dict], books: dict[str, dict], ids: list[str]) -> dict:
    """The answer's shape. Its passage lists can hold only the ids this paper's prompt shows."""
    cites = {"type": "array", "items": {"type": "string", "enum": ids}} if ids else {"type": "array", "maxItems": 0}
    props = {}
    for f in fields:
        if f["kind"] == "code":
            codes = [c["code"] for c in books[f["scheme"]].get("codes", []) if c["code"] != "none"]
            body = {"codes": {"type": "array", "items": {"type": "string", "enum": codes}}, "note": {"type": "string"}}
        else:
            body = {"text": {"type": "string"}}
        props[f["key"]] = {"type": "object", "properties": {**body, "passages": cites, "quote": {"type": "string"}},
                           "required": [*body, "passages"]}
    return {"type": "object", "required": ["fields"],
            "properties": {"fields": {"type": "object", "properties": props, "required": list(props)}}}


def words(s: str) -> int:
    return len(EXT_MARK.sub(" ", s).split())


def tidy(s, ids: set[str], max_words: int, drops: dict) -> tuple[str, list[str]]:
    """A note or text as it may be published: citations of shown passages only, as [ext-…];
    no quotation marks; at most max_words words (citations not counted)."""
    cites: list[str] = []

    def keep(m):
        if m.group(1) in ids:
            cites.append(m.group(1))
            return f"[{m.group(1)}]"
        drops["unknown_citation"] += 1
        return ""
    s = EXT_ANY.sub(keep, re.sub(r"\s+", " ", str(s or "")).strip())
    if QUOTE_MARKS.search(s):
        drops["quotation_marks"] += 1
        s = QUOTE_MARKS.sub("", s)
    s = re.sub(r"\s+([,.;:])", r"\1", re.sub(r"\(\s*\)|\[\s*\]", "", s))
    s = re.sub(r"\s{2,}", " ", s).strip()
    if words(s) > max_words:
        drops["trimmed"] += 1
        out = ""
        sentences = re.split(r"(?<=[.!?])\s+(?!\[ext-)", s)
        for sentence in sentences:
            if words((out + " " + sentence).strip()) > max_words:
                break
            out = (out + " " + sentence).strip()
        if not out and words(sentences[0]) <= max_words * 3 // 2:
            out = sentences[0]  # one sentence a little over reads better whole than cut mid-phrase
        if not out:
            toks, n = [], 0
            for t in s.split():
                n += 0 if EXT_MARK.fullmatch(t.strip(".,;:")) else 1
                if n > max_words:
                    break
                toks.append(t)
            out = " ".join(toks).rstrip(",;:") + "…"
        s = out
    return s, list(dict.fromkeys(x for x in cites if f"[{x}]" in s))


def clean(raw: dict | None, fields: list[dict], books: dict[str, dict], ids: set[str]) -> tuple[dict, dict]:
    """The model's answer, kept only where it holds. No model call, no corpus write."""
    drops = dict.fromkeys(("missing_field", "unknown_code", "extra_code", "unknown_citation", "quotation_marks",
                           "trimmed", "quote_unusable", "quote_not_found", "quote_unrenderable"), 0)
    got = (raw or {}).get("fields") if isinstance((raw or {}).get("fields"), dict) else {}
    out = {}
    for f in fields:
        a = got.get(f["key"])
        if not isinstance(a, dict):
            drops["missing_field"] += 1
            a = {}
        rec: dict = {}
        if f["kind"] == "code":
            b = books[f["scheme"]]
            known = {c["code"] for c in b.get("codes", [])} - {"none"}
            codes = [c for c in dict.fromkeys(str(x).strip() for x in a.get("codes") or []) if c != "none"]
            drops["unknown_code"] += sum(1 for c in codes if c not in known)
            codes = [c for c in codes if c in known]
            if not b.get("multi_label") and len(codes) > 1:
                drops["extra_code"] += len(codes) - 1
                codes = codes[:1]
            rec["codes"] = codes
            note = str(a.get("note") or "")
            said = [c.get("label") or c["code"] for c in b.get("codes", []) if c["code"] in codes] or [NOT_REPORTED.rstrip(".")]
            for label in said:  # the card prints the codes (or "Not reported.") before the note: don't say them twice
                cut = re.sub(rf"^\s*{re.escape(label)}\s*[.;:,]\s*", "", note, flags=re.I)
                note = cut[:1].upper() + cut[1:] if cut != note else note
            body, cites = tidy(note, ids, f["max_words"], drops)
        else:
            body, cites = tidy(a.get("text"), ids, f["max_words"], drops)
            body = body or NOT_REPORTED
        listed = [str(x).strip() for x in a.get("passages") or []]
        drops["unknown_citation"] += sum(1 for x in listed if x not in ids)
        extra = [x for x in dict.fromkeys(listed) if x in ids and x not in cites]
        rec["note" if f["kind"] == "code" else "text"] = " ".join([body, *(f"[{x}]" for x in extra)]).strip()
        rec["cites"] = cites + extra
        q = re.sub(r"\s+", " ", EXT_MARK.sub("", str(a.get("quote") or ""))).strip().strip('"“” ')
        if q and (len(q) < 12 or len(q) > 400 or "..." in q or "…" in q):
            drops["quote_unusable"] += 1
        elif q:
            rec["proposed_quote"] = q
        out[f["key"]] = rec
    return out, drops


def anchor_quotes(corpus: Path, info: dict, text: str, recs: dict, set_id: str, model: str, drops: dict) -> None:
    """Each proposed quote, kept only where `upc anchor` finds it in the paper and a card can
    show it (one line, no double quote). Checked with --dry-run first, so a quote that cannot
    be shown leaves nothing behind."""
    want = [(k, r.pop("proposed_quote")) for k, r in recs.items() if r.get("proposed_quote")]
    if not want:
        return
    cands = [{"quote": (C.widen_to_unique(text, q) or q) if C.occurrences(text, q) > 1 else q} for _, q in want]
    base = ["anchor", "--corpus", str(corpus), "--rep", info["text_rep"], "--source", info["source_id"],
            "--hidden", "--set", set_id, "--type", "passage", "--tool", TOOL["tool"], "--model", model,
            "--prompt-version", PROMPT_VERSION]
    trial = (C.upc_jsonl(*base, "--normalize", "--dry-run", records=cands) or {}).get("results", [])
    ok = []
    for r in trial:
        stored = r.get("stored_quote") or cands[r["i"]]["quote"]
        if r.get("status") not in ("anchored", "refound", "exists"):
            drops["quote_not_found"] += 1
        elif '"' in stored or "\n" in stored:
            drops["quote_unrenderable"] += 1
        else:
            ok.append((want[r["i"]][0], stored))
    if not ok:
        return
    done = (C.upc_jsonl(*base, records=[{"quote": q, "note": f"annotation: {k}"} for k, q in ok]) or {}).get("results", [])
    for r in done:
        k, q = ok[r["i"]]
        if r.get("status") in ("anchored", "exists"):
            recs[k]["quote"] = {"text": q, "extraction_id": r["extraction_id"]}
        else:
            drops["quote_not_found"] += 1


def short_cite(sj: dict) -> str:
    bib = sj.get("bibliographic") or {}
    first = ((bib.get("authors") or bib.get("author") or [{}])[0] or {})
    name = first.get("family") or first.get("literal") or ""
    year = str((((bib.get("issued") or {}).get("date_parts") or [[""]])[0] or [""])[0] or "")
    return " ".join(x for x in (name, year) if x) or sj.get("title") or sj["source_id"]


def card_markdown(fields: list[dict], recs: dict, books: dict[str, dict], model: str, coder: str) -> str:
    L = [f"*Written by a model ({model}, as {coder}) from the paper's opening and its coded passages. "
         "Quotations are checked against the paper; the rest is the model's reading.*", ""]
    for f in fields:
        r = recs[f["key"]]
        if f["kind"] == "code":
            labels = {c["code"]: c.get("label") or c["code"] for c in books[f["scheme"]].get("codes", [])}
            body = (", ".join(labels[c] for c in r["codes"]) or "Not reported") + "." + (f" {r['note']}" if r["note"] else "")
        else:
            body = r["text"]
        if r.get("quote"):
            body += f" \"{r['quote']['text']}\" [{r['quote']['extraction_id']}]"
        L += [f"**{QUOTE_MARKS.sub('', f['label'])}:** {body}", ""]
    return "\n".join(L)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--fields", required=True, help="the field spec (JSON)")
    ap.add_argument("--coder", required=True, help="the annotator's handle, e.g. <project>-annotate-<model>-v1")
    ap.add_argument("--model", default=C.DEFAULT_MODEL, help="the model name sent to the servers (think, chat, …)")
    ap.add_argument("--context", default="", help="what the research team is studying (default: the corpus title)")
    ap.add_argument("--ids", default="", help="comma-separated aliases, slugs or source ids")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-passages", type=int, default=40, help="coded passages shown per paper, the most-coded first")
    ap.add_argument("--max-tokens", type=int, default=2500, help="room for the answer (thinking gets more on top)")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--redo", action="store_true", help="annotate again the papers this coder has done")
    args = ap.parse_args(argv)

    corpus = Path(args.corpus).expanduser()
    spec = C.check_compat()
    books = {b["slug"]: b for b in (C.load_json(f) for f in sorted((corpus / "codebooks").glob("cbk-*.json"))) if b}
    fields = load_fields(args.fields, books)
    sources = C.corpus_reps(corpus)
    model = args.model + (f" ({C.CONFIG['model_tag']})" if C.CONFIG.get("model_tag") else "")
    done = {g["_source_id"] for g in V.generations(corpus, TYPE)
            if ((g.get("ext") or {}).get("upc-corpus") or {}).get("annotation", {}).get("coder") == args.coder}
    coded = coded_passages(corpus, {b["codebook_id"]: b for b in books.values()})
    want = {x.strip() for x in args.ids.split(",") if x.strip()}
    todo = []
    for alias, info in sorted(sources.items()):
        if want and not want & {alias, info["slug"], info["source_id"]}:
            continue
        if not info["text_rep"]:
            print(f"  UNAVAILABLE {alias}: no text copy to read")
        elif args.redo or info["source_id"] not in done:
            todo.append((alias, info))
    todo = todo[:args.limit] if args.limit else todo

    title = (C.load_json(corpus / "corpus.json", {}) or {}).get("title") or corpus.name
    system = system_prompt(fields, books, args.context or f"the material in the corpus titled '{title}'")
    items = []
    for alias, info in todo:
        text = Path(info["text_path"]).read_text(encoding="utf-8")
        ps = shown(coded.get(info["source_id"], []), args.max_passages)
        items.append((alias, info, text, ps, user_prompt(info["title"], text[:HEAD_CHARS], ps),
                      schema(fields, books, [p["id"] for p in ps])))
    C.counts_header("Annotation plan", [
        ("sources", len(sources)), ("already annotated by this coder", len(done)), ("to annotate now", len(items)),
        ("without coded passages (opening only)", sum(1 for it in items if not it[3])),
        ("fields", ", ".join(f"{f['key']} ({f['kind']})" for f in fields)), ("coder", f"{args.coder} (model)"),
        ("model", f"{model} on {', '.join(P.ENDPOINTS)}"), ("prompt", f"{PROMPT_VERSION} ({len(system):,} chars)"),
        ("upc", spec)])
    if args.plan:
        print(system + ("\n\n--- first paper ---\n" + items[0][4][:1500] if items else ""))
        print("\nPlanning only; nothing was written.")
        return 0
    if not items:
        print("Nothing to annotate.")
        return 0

    set_id = f"exs-{args.coder}-quotes"
    spec_sha = "sha256:" + hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()
    tally = {"written": 0, "failed": 0, "refused": 0, "quotes": 0}
    drops_all: dict[str, int] = {}
    t0 = time.time()

    def work(item, name, url):
        for extra, cap in (("", args.max_tokens), (TIGHTER, args.max_tokens * 2)):
            try:
                parsed = C.parse_json_loose(P.chat(url, system + extra, item[4], cap, model=args.model,
                                                   temperature=TEMPERATURE, schema=item[5]))
            except P.TooLong:
                continue
            if parsed and isinstance(parsed.get("fields"), dict):
                return parsed
            return None
        return None

    def on_done(item, parsed, name, secs):
        try:
            store(item, parsed, name, secs)
        except (C.Unavailable, OSError, ValueError, KeyError) as exc:  # one paper's failure, not the run's
            tally["failed"] += 1
            print(f"  UNAVAILABLE {item[0]}: {type(exc).__name__}: {exc}")

    def store(item, parsed, name, secs):
        alias, info, text, ps, user, _shape = item
        if parsed is None:
            tally["failed"] += 1
            print(f"  UNAVAILABLE {alias}: the model gave no usable JSON")
            return
        recs, drops = clean(parsed, fields, books, {p["id"] for p in ps})
        anchor_quotes(corpus, info, text, recs, set_id, model, drops)
        for k, v in drops.items():
            drops_all[k] = drops_all.get(k, 0) + v
        sj = C.load_json(corpus / "sources" / info["slug"] / "source.json", {}) or {}
        md = C.state_dir(corpus, "annotate", args.coder) / f"{info['slug']}.md"
        md.write_text(card_markdown(fields, recs, books, model, args.coder), encoding="utf-8")
        rows = []
        for f in fields:
            r = recs[f["key"]]
            if f["kind"] == "code":
                labels = {c["code"]: c.get("label") or c["code"] for c in books[f["scheme"]].get("codes", [])}
                r["code_labels"] = [labels[c] for c in r["codes"]]
            rows.append({k: v for k, v in f.items() if k != "max_words"} | r)
        gen = {"type": TYPE, "title": f"Annotation: {short_cite(sj)}", "source_id": info["source_id"],
               "representation_ref": info["text_rep"], "extraction_ids": [p["id"] for p in ps],
               "provenance": {"produced_by": {**TOOL, "model": model, "method": "model", "prompt_version": PROMPT_VERSION}},
               "ext": {"upc-site": {"card": CARD, "order": 0},
                       "upc-corpus": {"annotation": {"coder": args.coder, "model": model, "prompt_version": PROMPT_VERSION,
                                                     "temperature": TEMPERATURE, "fields_sha256": spec_sha,
                                                     "passages_shown": len(ps), "opening_chars": min(len(text), HEAD_CHARS),
                                                     "fields": rows}}}}
        res = C.upc("add", "generation", "--corpus", str(corpus), "--output", str(md), "--tool", TOOL["tool"],
                    *(["--replace"] if args.redo else []), stdin=json.dumps(gen), check=False)
        status = res.get("status") if isinstance(res, dict) else None
        quotes = sum(1 for r in recs.values() if r.get("quote"))
        if status in ("ok", "exists", "replaced"):
            tally["written"] += 1
            tally["quotes"] += quotes
            print(f"  [{tally['written']}/{len(items)}] {alias}: {len(ps)} passages read, {quotes} quotes kept, "
                  f"{secs:.0f}s on {name}", flush=True)
        else:
            tally["refused"] += 1
            print(f"  REFUSED {alias}: {(res or {}).get('detail') if isinstance(res, dict) else res}")
        C.log_timing(corpus, {"stage": "annotate", "alias": alias, "source_id": info["source_id"], "coder": args.coder,
                              "status": status, "seconds": round(secs, 1), "server": name, "passages": len(ps),
                              "prompt_chars": len(system) + len(user)})

    problems, left = P.run_all(items, work, on_done)
    for p in problems:
        print(f"  NOTE {p}")
    for item in left:
        print(f"  UNAVAILABLE {item[0]}: no server could take it")
    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    C.counts_header("Annotation result", [
        ("annotations written", tally["written"]), ("failed (no usable answer)", tally["failed"] + len(left)),
        ("refused by upc", tally["refused"]), ("quotes kept (checked in the paper)", tally["quotes"]),
        ("corpus", f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors"
                   if isinstance(rep, dict) else "UNAVAILABLE: validate did not return a report"),
        ("minutes", round((time.time() - t0) / 60, 1))],
        notes=[f"dropped or cut: {json.dumps({k: v for k, v in drops_all.items() if v})}"] if any(drops_all.values()) else [])
    print("These are a model's annotations, recorded under their own coder and labelled so on every card.")
    print("Annotation finished.")
    return 0 if not (tally["failed"] or tally["refused"] or left) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
