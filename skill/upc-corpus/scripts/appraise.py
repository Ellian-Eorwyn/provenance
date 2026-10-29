#!/usr/bin/env python3
"""Rate the evidence: papers, passages and overview statements, with local models.

    python3 appraise.py plan    --corpus <dir> --set pilot --syntheses syn-…,syn-… --codes domain:heat-pump-adoption,…
    python3 appraise.py plan    --corpus <dir> --set all
    python3 appraise.py run     --corpus <dir> --set pilot|all [--only design] [--runs 3]
                                [--not-before HH:MM] [--stop-at HH:MM]
    python3 appraise.py statements --corpus <dir> --set pilot|all|revised [--not-before …] [--stop-at …]
    python3 appraise.py vote    --corpus <dir>
    python3 appraise.py report  --corpus <dir> [--set pilot]
    python3 appraise.py table   --corpus <dir> --out designs.md
    python3 appraise.py status  --corpus <dir>
    python3 appraise.py store   --corpus <dir> [--into <clone>] [--blind] --write   (into the corpus, UPC 1.15.0)
    python3 appraise.py overnight --corpus <dir> [--not-before 22:00] [--stop-at 06:00] [--dry-run]
                                (every step of the full run, resumable; one notice at the end)
    python3 appraise.py venues  --corpus <dir> --source <sources.xlsx>   (where each paper was published)
    python3 appraise.py recheck --corpus <dir>   (every stored quotation checked again; no model calls)

The rubric is in ../references/appraisal/ (rubric.md, designs.json, profiles/,
domains/), or in the corpus's own copy at <corpus>/.upc/upc-corpus/appraisal/; the project
owns its wording. What happens, per paper, on one machine so the
server's prompt cache holds the paper:

  1. design ×3 (which of 12 designs; that picks a profile), voted;
  2. the profile's questions ×3 (yes / partly / not found / can't tell, each yes or
     partly with a quotation from the paper), per strand for mixed methods;
  3. every passage of the paper ×3, at most 12 per call, shuffled per run:
     whose claim it is (claim-origin) and what backs it (claim-basis).

The model reads the paper's text with its reference list cut and its venue's
name taken out; it never sees the venue, citation counts or the screen's codes.
A yes or partly whose quotation is not in the paper counts as "can't tell". The
grade comes from rules over the voted answers (rubric.md), never from a sum.

Every call's answer is saved as it arrives, under
<corpus>/.upc/upc-corpus/appraise/<prompt version>/, so a run resumes where it
stopped. Only `store` writes to the corpus (UPC 1.15.0): each yes or partly's
quotation into a hidden extraction set through `upc anchor` (one it can't confirm
turns the answer into can't tell, and the grade is recomputed), a rating card per
paper, codings in four evidence schemes, and one statement-support matrix per
overview.

Every server in the config's pool at once (llm_pool.py, one worker per server). When
a server is someone's everyday model, full passes run overnight (--not-before /
--stop-at). A worker whose proxy relays to another server in the pool stops rather
than doubling up on it.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import os
import random
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

import llm_pool as P  # noqa: E402

PROMPT_VERSION = "appraise.v1"
LAYOUT = "paper-in-system"      # where a paper's text goes; records made before 2026-10-29 were "paper-in-user"
MODEL = os.environ.get("APPRAISE_MODEL", "chat")       # thinking off unless the pilot shows it's needed
EFFORT = os.environ.get("APPRAISE_EFFORT", "")          # with think: none|low|medium|xhigh (the proxy's levels)
# The checklist (the questions the grade rests on) may use another model than the rest (the pilot, 10-05:
# think agreed better with the blind coding on the checklist, at about 1.8x the time of chat for everything).
CRITERIA_MODEL = os.environ.get("APPRAISE_CRITERIA_MODEL", MODEL)
CRITERIA_EFFORT = os.environ.get("APPRAISE_CRITERIA_EFFORT", EFFORT if CRITERIA_MODEL == MODEL else "")
MODEL_DESC = MODEL + ("" if (CRITERIA_MODEL, CRITERIA_EFFORT) == (MODEL, EFFORT) else
                      f"; the checklist {CRITERIA_MODEL}" + (f" ({CRITERIA_EFFORT})" if CRITERIA_EFFORT else ""))
# A trial with another model keeps its own records, beside the chat run's, never mixed into its vote.
STATE_NAME = (PROMPT_VERSION if MODEL == "chat" else f"{PROMPT_VERSION}-{MODEL}" + (f"-{EFFORT}" if EFFORT else "")) + \
    ("" if (CRITERIA_MODEL, CRITERIA_EFFORT) == (MODEL, EFFORT) else
     f"-checklist-{CRITERIA_MODEL}" + (f"-{CRITERIA_EFFORT}" if CRITERIA_EFFORT else ""))
TEMPERATURE = 0.3
RUNS = 3
# `overnight` waits for the first time and starts nothing new after the second; a machine's
# config can move the window ("overnight_window": ["23:00", "03:15"]).
WINDOW = tuple(C.CONFIG.get("overnight_window") or ("22:00", "06:00"))
PAUSED = 3                                               # exit code: stopped at --stop-at, items left; run again
CHUNK = 12                                               # passages per call
# Does a paper fit a server's context window (the config's "context")? English prose runs about 4.1 characters
# a token (a 382,223-character paper was 92,864 tokens); 3.4 leaves room for tables and numbers. The
# reserve covers the system prompt, the task, and an answer with its retry and thinking room.
CHARS_PER_TOKEN = 3.4
RESERVE_TOKENS = 16000
APPRAISAL = Path(__file__).resolve().parent.parent / "references" / "appraisal"

ANSWERS = ["yes", "partly", "not found", "can't tell"]
ORIGINS = ["own-finding", "reported", "theoretical", "interpretation", "recommendation", "background", "speculation"]
BASES = ["data", "case", "cited-study", "argument", "none"]
VERDICTS = ["supports", "partly", "does not support"]
GAPS = ["none", "broader", "stronger", "other setting", "relays others"]
LEVELS = ["Very low", "Low", "Moderate", "High"]
NA = "Not appraisable"

CITE_RE = re.compile(r"\((?:[A-Z][A-Za-z'\-]+(?: et al\.)?(?:,| and| &)?[^()]{0,60}?\d{4}[a-z]?)\)"
                     r"|\[\d+(?:[,–-]\s*\d+)*\]|\b[A-Z][a-z]+ et al\.")


# --- the rubric --------------------------------------------------------------

def load_domain(corpus: Path | None) -> dict | None:
    """The setting the corpus's team works in, from its settings' "domain": the name of a
    file in ../references/appraisal/domains/, a path to one, or the object itself. None
    when the corpus names none: papers then get no setting."""
    if corpus is None:
        return None
    d = C.corpus_settings(corpus).get("domain")
    if not d or isinstance(d, dict):
        return d or None
    p = Path(d).expanduser()
    if not p.suffix:
        p = appraisal_dir(corpus) / "domains" / f"{d}.json"
        if not p.is_file():
            p = APPRAISAL / "domains" / f"{d}.json"
    elif not p.is_absolute():
        p = Path(corpus) / p
    return json.loads(p.read_text(encoding="utf-8"))


def appraisal_dir(corpus: Path | None = None) -> Path:
    """The rubric's folder: the corpus's own copy (<corpus>/.upc/upc-corpus/appraisal/, with designs.json,
    profiles/ and rubric.md) when it has one, so a project that needs other wording edits its copy and never
    another project's; else the toolkit's."""
    if corpus is not None:
        own = Path(corpus) / ".upc" / "upc-corpus" / "appraisal"
        if (own / "designs.json").is_file():
            return own
    return APPRAISAL


def rubric(corpus: Path | None = None) -> dict:
    where = appraisal_dir(corpus)
    designs = json.loads((where / "designs.json").read_text(encoding="utf-8"))
    profiles = {p.stem: json.loads(p.read_text(encoding="utf-8"))
                for p in sorted((where / "profiles").glob("*.json"))}
    by_code = {d["code"]: d for d in designs["designs"]}
    return {"designs": designs, "by_code": by_code, "profiles": profiles, "domain": load_domain(corpus), "dir": where,
            "places": own_places(corpus), "lead_rule": (C.corpus_settings(corpus).get("lead_author") if corpus else None)
            or "family"}


def own_places(corpus: Path | None) -> dict | None:
    """A corpus whose settings name "places_codebook" (the slug of its own source-level codebook of places)
    keeps its own places: {"slug", "codebook_id", "order": [codes], "labels": {code: label}, "by_source":
    {source_id: [codes]}} from that codebook's active codings, any coder. Statements then say where their
    evidence comes from in the corpus's own words, and `store` writes no `place` scheme of its own (it would
    take the same id and replace the corpus's codebook). None when the settings name none."""
    slug = C.corpus_settings(corpus).get("places_codebook") if corpus is not None else None
    if not slug:
        return None
    ns = C.namespace_of(corpus)
    book = None
    for f in sorted(Path(corpus).glob("codebooks/*.json")):
        d = C.load_json(f, {}) or {}
        if d.get("slug") == slug and d.get("namespace") == ns:
            book = d
    if not book:
        C.die(f"settings name places_codebook {slug!r}, but the corpus has no {ns} codebook with that slug")
    order = [c["code"] for c in book.get("codes", [])]
    by_source: dict[str, set] = collections.defaultdict(set)
    for f in Path(corpus).glob("codings/*/items.jsonl"):
        for line in f.read_text(encoding="utf-8").splitlines():
            o = json.loads(line) if line.strip() else {}
            if o.get("codebook_ref") == book["codebook_id"] and (o.get("status") or "active") == "active" \
                    and (o.get("target") or {}).get("kind") == "source" and o.get("code") in order:
                by_source[o["target"]["id"]].add(o["code"])
    return {"slug": slug, "codebook_id": book["codebook_id"], "order": order,
            "labels": {c["code"]: c.get("label") or c["code"] for c in book.get("codes", [])},
            "by_source": {k: [c for c in order if c in v] for k, v in by_source.items()}}


# --- the corpus ----------------------------------------------------------------

def hidden_sets(corpus: Path) -> set[str]:
    out = set()
    for man in corpus.glob("extractions/*/manifest.json"):
        m = C.load_json(man, {}) or {}
        if ((m.get("ext") or {}).get("upc-site") or {}).get("hidden"):
            out.add(man.parent.name)
    return out


def load_corpus(corpus: Path) -> dict:
    """Sources, their reading copies, their passages and the syntheses."""
    reps = C.corpus_reps(corpus)
    sources = {}
    venues = C.load_json(C.state_dir(corpus, "appraise") / "venues.json", {}) or {}
    for alias, info in reps.items():
        sj = C.load_json(corpus / "sources" / info["slug"] / "source.json", {}) or {}
        bib = sj.get("bibliographic") or {}
        issued = (bib.get("issued") or {}).get("date_parts") or [[None]] if isinstance(bib.get("issued"), dict) else [[bib.get("issued")]]
        sources[info["source_id"]] = {**info, "alias": alias, "bib": bib,
                                      "container": bib.get("container_title") or bib.get("container-title")
                                      or venues.get(info["source_id"], ""),
                                      "year": str((issued[0] or [None])[0] or bib.get("year") or "")[:4],
                                      "passages": []}
    hidden = hidden_sets(corpus)
    exts = {}
    files = list(corpus.glob("sources/*/extractions.jsonl")) + \
        [f for f in corpus.glob("extractions/*/items.jsonl") if f.parent.name not in hidden]
    for f in files:
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            o = json.loads(line)
            if not o.get("direct_quote") or (o.get("status") or "active") != "active":
                continue
            exts[o["extraction_id"]] = o
            if o["source_id"] in sources:
                sources[o["source_id"]]["passages"].append(o["extraction_id"])
    syns = {}
    for f in corpus.glob("syntheses/*/synthesis.json"):
        d = C.load_json(f, {}) or {}
        if d.get("synthesis_id"):
            syns[d["synthesis_id"]] = d
    return {"sources": sources, "exts": exts, "syntheses": syns}


def author_year(src: dict) -> str:
    """"Geels 2017", "Geels and Sovacool 2019", "Geels et al. 2017"."""
    names = [(a.get("family") or a.get("literal") or a.get("name") or "") if isinstance(a, dict) else str(a).split(",")[0]
             for a in (src.get("bib") or {}).get("authors") or []]
    names = [n for n in names if n]
    who = (names[0] if len(names) == 1 else f"{names[0]} and {names[1]}" if len(names) == 2
           else f"{names[0]} et al." if names else src.get("alias", ""))
    return f"{who} {src.get('year') or ''}".strip()


REF_HEAD = re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(references|reference list|bibliography|literature cited|works cited|"
                      r"references and notes|notes and references)\b\s*:?\s*(?=$|[A-Z])", re.I)
# What a reference list is dense in: names with initials, years, volumes and pages, links.
REF_NAMES = re.compile(r"\b[A-Z][A-Za-z'\-]+,? (?:[A-Z]\.? ?){1,3}[,.:;(]|\b[A-Z][a-z]+, [A-Z]\.(?: ?[A-Z]\.)?"
                       r"|\b(?:[A-Z]\.\s?){1,3}[A-Z][a-z]+|\[\d{1,3}\]|(?:^|\s)\d{1,3}\.\s+[A-Z][a-z]+,? [A-Z]")
REF_YEAR = re.compile(r"\b(?:19|20)\d\d[a-z]?\b")
REF_LINK = re.compile(r"doi|https?://|\bvol\.|\bpp\.|\d+\(\d+\)|\d+[-–]\d+")


def references_start(text: str) -> tuple[int | None, str]:
    """Where the reference list starts: a "References" heading in the last 60% of
    the text, else a trailing run of blocks dense in names, years and pages (≥ 3
    per 100 characters, measured on a 179-paper library: 84 headings, 36 by density, 59 left
    whole). A list that can't be found stays in; prose is never cut for one."""
    blocks = [(m.start(), m.group(0)) for m in re.finditer(r"\S[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*", text)]
    n = len(text)
    for a, t in blocks:
        if a > 0.4 * n and REF_HEAD.match(t):
            return a, "heading"
    start, skips = None, 0
    for a, t in reversed(blocks):
        if len(t) < 80:
            continue
        score = (len(REF_NAMES.findall(t)) + len(REF_YEAR.findall(t)) + len(REF_LINK.findall(t))) / len(t) * 100
        if score >= 3.0:
            start, skips = a, 0
        elif start is None and skips < 2 and len(t) < 600:
            skips += 1                  # a publisher's footer after the list
        else:
            break
    if start is not None and start > 0.4 * n:
        return start, "density"
    return None, ""


KEEP_TAIL = re.compile(r"^\s*(acknowledg|funding|declaration|conflicts? of interest|competing interest|"
                       r"credit author|author contributions|data availability)", re.I)
BOILER = re.compile(r"journal homepage|contents lists available|sciencedirect|elsevier|springer|wiley|taylor & francis|"
                    r"©|copyright|all rights reserved|creative commons|received \d|accepted \d|available online|"
                    r"published online|cite this article", re.I)


def model_text(text: str, container: str) -> tuple[str, dict]:
    """The paper as the model reads it: the reference list cut (declarations and
    funding kept: they answer D6), and the venue's name taken out (the model
    never sees where it was published)."""
    notes = {"chars_in": len(text)}
    at, how = references_start(text)
    if at is not None:
        head, tail = text[:at], text[at:]
        keep, kept = [], 0
        for block in re.split(r"\n{2,}", tail):
            if KEEP_TAIL.match(block) and kept < 4000:
                keep.append(block[:1500])
                kept += len(keep[-1])
        text = head.rstrip() + ("\n\n" + "\n\n".join(keep) if keep else "") + "\n"
        notes["references_cut_chars"] = len(tail)
        notes["references_found_by"] = how
    lines, dropped, seen = [], 0, 0
    venue = container.strip()
    for line in text.split("\n"):
        short = len(line) <= 200
        if venue and len(venue) > 4 and venue in line:      # case-sensitive: "Energy Policy", not "energy policy"
            if short:
                dropped += 1
                seen += len(line) + 1
                continue
            if seen < 5000:                                  # a long front-matter line naming the journal
                line = line.replace(venue, "[journal]")
                dropped += 1
        if short and seen < 5000 and BOILER.search(line):
            dropped += 1
            seen += len(line) + 1
            continue
        lines.append(line)
        seen += len(line) + 1
    notes["venue_lines_dropped"] = dropped
    out = "\n".join(lines)
    notes["chars_out"] = len(out)
    return out, notes


# --- quotations --------------------------------------------------------------

_TRANS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
                        "−": "-", "­": None, " ": " "})


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").translate(_TRANS)
    s = re.sub(r"-\s*\n\s*", "", s)
    return re.sub(r"\s+", " ", s).strip().lower()


ELLIPSIS = re.compile(r"\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*")


QUOTE_TRIM = " .,;:\"“”'‘’"


def fragments(q: str) -> list[str]:
    """A quotation the model shortened with '...' or '…' as the paper's own pieces, each
    checked on its own (pieces under 12 characters say nothing and are dropped). Quote
    marks and punctuation at a piece's ends are trimmed: the model adds a closing full stop
    or quote mark the paper doesn't have, and trimming only ever removes characters."""
    parts = ELLIPSIS.split(q or "") if ELLIPSIS.search(q or "") else [q or ""]
    return [f for f in (x.strip().strip(QUOTE_TRIM) for x in parts) if len(f) >= 12]


def check_one(text: str, ntext: str, q: str) -> str:
    n = C.occurrences(text, q, 2)
    if n == 1:
        return "exact"
    if n > 1:
        return "ambiguous"
    nq = norm(q)
    if len(nq) >= 12 and nq in ntext:
        return "normalized"
    return "not found"


def check_quote(text: str, ntext: str, q: str) -> str:
    """'exact' | 'ambiguous' | 'normalized' | 'elided' | 'missing' | 'not found'. An
    elided quotation counts only when every piece is in the paper. The final word is
    `upc anchor` at store time; this decides which run answers count."""
    frags = fragments(q)
    if not frags or max(len(f) for f in frags) < 12:
        return "missing"
    got = [check_one(text, ntext, f) for f in frags]
    if any(g == "not found" for g in got):
        return "not found"
    return got[0] if len(frags) == 1 else "elided"


QUOTE_OK = {"exact", "ambiguous", "normalized", "elided"}


# --- one model call ---------------------------------------------------------------

SYS = """You are appraising one research paper for a team that needs to know how well its evidence supports what it claims.
You are given the paper's text, then one task about it.

Rules:
- Base every answer only on the paper's text. If the text does not show something, say so; do not assume it.
- Quotations are copied exactly, character for character, from the paper: one or two consecutive sentences, at most about 50 words, no ellipses, nothing joined or tidied.
- Reasons are short: 25 words or fewer.
- Do not judge the paper by where it was published, who wrote it or how often it is cited.
- Answer in exactly the JSON format the task asks for."""


class Step(RuntimeError):
    """A call that came back without usable JSON."""


def chat_json(url: str, system: str, user: str, schema: dict, max_tokens: int, *, seed: int | None = None,
              timeout: int = 1800, model: str | None = None, effort: str | None = None) -> tuple[dict, dict]:
    """One call. Raises P.Relayed / P.Unavailable (the pool puts the item back),
    Step when the reply isn't usable JSON even after one retry with more room."""
    cap = max_tokens
    model = model or MODEL
    effort = EFFORT if effort is None else effort
    for attempt in range(2):
        body = {"model": model, "max_tokens": cap + (C.THINK_HEADROOM if model in ("think", "code") else 0),
                "temperature": TEMPERATURE, "cache_prompt": True,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "response_format": {"type": "json_schema", "json_schema": {"name": "result", "schema": schema}}}
        if seed is not None:
            body["seed"] = seed
        if effort:
            body["reasoning_effort"] = effort
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                relayed = P.is_relayed(r.headers, url)
                payload = json.load(r)
        except urllib.error.HTTPError as exc:
            raise P.Unavailable(f"{url} answered HTTP {exc.code}: {exc.read()[:200]!r}")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise P.Unavailable(f"{url} didn't answer ({exc})")
        if relayed:
            raise P.Relayed(url)
        choice = (payload.get("choices") or [{}])[0]
        usage = payload.get("usage") or {}
        meta = {"seconds": round(time.time() - t0, 2), "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
                "finish": choice.get("finish_reason"), "cap": cap}
        content = re.sub(r"<think>.*?</think>", "", (choice.get("message") or {}).get("content") or "", flags=re.S)
        parsed = C.parse_json_loose(content)
        if parsed is not None and choice.get("finish_reason") != "length":
            return parsed, meta
        cap *= 2                                      # cut off or garbled: once more, with room
    raise Step(f"no usable JSON (finish {meta['finish']}, cap {meta['cap']})")


def seed_for(*parts) -> int:
    return int(hashlib.sha256(":".join(map(str, parts)).encode()).hexdigest()[:8], 16)


# --- the tasks ---------------------------------------------------------------------

def design_task(R: dict) -> tuple[str, dict]:
    ds = R["designs"]
    lines = ["Name this paper's research design: what kind of evidence it produces or uses for its own conclusions.",
             "Pick one design from this list:", ""]
    for d in ds["designs"]:
        lines.append(f"- {d['code']}: {d['label']}. {d['definition']}")
    lines += ["",
              "second_design: for mixed-methods, the strand that is NOT the main one; for grey-report, the design of "
              "its own data or model if it has any. Otherwise \"none\". It must be one of: "
              + ", ".join(ds["second_strand"]["allowed_designs"]) + ".",
              "sector: the sector the paper studies, one of: " + "; ".join(ds["sectors"]) + ".",
              "countries: the countries the paper's evidence comes from (empty if none or not stated).",
              "",
              "First quote the sentence from the paper that best shows its design (usually in the abstract or methods), "
              "then give your reason, then the labels."]
    codes = [d["code"] for d in ds["designs"]]
    schema = {"type": "object", "additionalProperties": False,
              "required": ["quote", "reason", "design", "second_design", "sector", "countries"],
              "properties": {"quote": {"type": "string"}, "reason": {"type": "string"},
                             "design": {"type": "string", "enum": codes},
                             "second_design": {"type": "string", "enum": ["none"] + ds["second_strand"]["allowed_designs"]},
                             "sector": {"type": "string", "enum": ds["sectors"]},
                             "countries": {"type": "array", "items": {"type": "string"}, "maxItems": 12}}}
    return "\n".join(lines), schema


def strands_task(R: dict) -> tuple[str, dict]:
    """Mixed methods: name both strands. (The design call names only the secondary one.)"""
    allowed = R["designs"]["second_strand"]["allowed_designs"]
    lines = ["This paper combines two strands of evidence (mixed methods). Name the design of each strand:",
             "- main_design: the strand the paper's conclusions rest on most;",
             "- other_design: the other strand.", "Each is one of:", ""]
    for c in allowed:
        d = R["by_code"][c]
        lines.append(f"- {c}: {d['label']}. {d['definition']}")
    lines += ["", "First quote the sentence from the paper that best shows the two strands, then your reason, then the labels."]
    schema = {"type": "object", "additionalProperties": False, "required": ["quote", "reason", "main_design", "other_design"],
              "properties": {"quote": {"type": "string"}, "reason": {"type": "string"},
                             "main_design": {"type": "string", "enum": allowed},
                             "other_design": {"type": "string", "enum": allowed}}}
    return "\n".join(lines), schema


def criteria_task(R: dict, profile: str, design_label: str) -> tuple[str, dict]:
    p = R["profiles"][profile]
    lines = [f"This paper is a {design_label.lower()}, appraised as {p['title'].lower()} research.",
             "Answer each question below about this paper.", "",
             "For each question: first, for yes or partly, quote the sentence from the paper that shows it "
             "(for not found or can't tell, leave quote empty); then your reason; then the answer:",
             "- yes: the paper does this, and the quotation shows it;",
             "- partly: it does some of it;",
             "- not found: the paper does not do this, or never says so;",
             "- can't tell: the text is unclear or garbled.", "", "QUESTIONS:"]
    for q in p["questions"]:
        lines.append(f"{q['id']}: {q['text']}")
    ids = [q["id"] for q in p["questions"]]
    schema = {"type": "object", "additionalProperties": False, "required": ["answers"],
              "properties": {"answers": {"type": "array", "minItems": len(ids), "maxItems": len(ids),
                                         "items": {"type": "object", "additionalProperties": False,
                                                   "required": ["id", "quote", "reason", "answer"],
                                                   "properties": {"id": {"type": "string", "enum": ids},
                                                                  "quote": {"type": "string"},
                                                                  "reason": {"type": "string"},
                                                                  "answer": {"type": "string", "enum": ANSWERS}}}}}}
    return "\n".join(lines), schema


ORIGIN_DEF = {
    "own-finding": "a result of this paper's own data, cases, model or analysis (in a review, a conclusion the authors draw across the reviewed studies)",
    "reported": "reports what another work found or said, usually with a citation",
    "theoretical": "a conceptual statement: definition, framework, proposition, typology",
    "interpretation": "the authors' interpretation or explanation of findings, theirs or others'",
    "recommendation": "what someone should do: policy, practice or research advice",
    "background": "context or common knowledge setting the scene",
    "speculation": "a conjecture, prediction or possibility the paper does not test",
}
BASIS_DEF = {
    "data": "measured or surveyed data, statistics or model results shown in this paper",
    "case": "evidence from cases, interviews, documents or observation shown in this paper",
    "cited-study": "a study the passage cites",
    "argument": "reasoning only, no evidence shown",
    "none": "nothing shown: an assertion",
}


def passages_task(items: list[tuple[str, str, str]]) -> tuple[str, dict]:
    """items: [(key, quote, cite note)]"""
    lines = ["Below are passages quoted from this paper. For each passage, first give a short reason, then label:",
             "", "origin, whose claim it is:"]
    lines += [f"- {k}: {v}" for k, v in ORIGIN_DEF.items()]
    lines += ["", "basis, what backs it in this paper:"]
    lines += [f"- {k}: {v}" for k, v in BASIS_DEF.items()]
    lines += ["", "Judge each passage where it sits in the paper, not on its own.", "", "PASSAGES:"]
    for key, quote, note in items:
        lines.append(f"{key}: «{quote}»" + (f"  [contains an in-text citation: {note}]" if note else ""))
    keys = [k for k, _, _ in items]
    schema = {"type": "object", "additionalProperties": False, "required": ["passages"],
              "properties": {"passages": {"type": "array", "minItems": len(keys), "maxItems": len(keys),
                                          "items": {"type": "object", "additionalProperties": False,
                                                    "required": ["key", "reason", "origin", "basis"],
                                                    "properties": {"key": {"type": "string", "enum": keys},
                                                                   "reason": {"type": "string"},
                                                                   "origin": {"type": "string", "enum": ORIGINS},
                                                                   "basis": {"type": "string", "enum": BASES}}}}}}
    return "\n".join(lines), schema


SYS_STATEMENT = """You check statements from a literature overview against the passages they cite.
Each passage is shown inside the sentences around it in its paper, with the passage itself between « and ».

For each passage, decide whether the passage itself supports the statement:
- supports: the passage says what the statement says;
- partly: it supports part of it, or a weaker version;
- does not support: it says something else, or nothing about it.

Then name the gap between the statement and the passage, if there is one:
- broader: the statement generalises beyond the passage (more places, groups, technologies or times);
- stronger: the statement is more certain or more causal than the passage;
- other setting: the statement applies the passage to a place or sector the passage did not study;
- relays others: the passage reports another work's finding, and the statement presents it as this paper's own finding or as established;
- none: no gap.

Judge only by what the passage and its surrounding sentences say. Reasons are 25 words or fewer.
Answer in exactly the JSON format asked for."""


def statement_task(claim: str, items: list[tuple[str, str, str]]) -> tuple[str, dict]:
    """items: [(key, paper label, window with «passage»)]"""
    lines = [f"STATEMENT: {claim}", "", "PASSAGES IT CITES:"]
    for key, label, window in items:
        lines += ["", f"[{key}] from {label}:", window]
    lines += ["", "For each passage: first your reason, then the verdict, then the gap."]
    keys = [k for k, _, _ in items]
    schema = {"type": "object", "additionalProperties": False, "required": ["passages"],
              "properties": {"passages": {"type": "array", "minItems": len(keys), "maxItems": len(keys),
                                          "items": {"type": "object", "additionalProperties": False,
                                                    "required": ["key", "reason", "verdict", "gap"],
                                                    "properties": {"key": {"type": "string", "enum": keys},
                                                                   "reason": {"type": "string"},
                                                                   "verdict": {"type": "string", "enum": VERDICTS},
                                                                   "gap": {"type": "string", "enum": GAPS}}}}}}
    return "\n".join(lines), schema


# --- votes, grades, confidence -------------------------------------------------

def majority(values: list):
    """The value most runs gave, or None when no value has a majority."""
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    (top, n), = collections.Counter(vals).most_common(1)
    return top if n * 2 > len(vals) else None


def profiles_for(R: dict, design: str | None, second: str | None, main: str | None = None) -> list[tuple[str, str, str]]:
    """[(profile, design code, start level)] — two strands for mixed methods (main and
    other, from the strands call) and for a report with its own data or model. Two
    strands under one profile are rated once, from the higher start."""
    if not design:
        return []
    out = []
    d = R["by_code"].get(design)
    if design == "mixed-methods" and main and main != "none":
        d = R["by_code"].get(main)
        if d and d.get("profile"):
            out.append((d["profile"], main, d["start"]))
    elif d and d.get("profile"):
        out.append((d["profile"], design, d["start"]))
    if second and second != "none":
        s = R["by_code"].get(second)
        if s and s.get("profile") and (design == "mixed-methods" or design == "grey-report"):
            if any(p == s["profile"] for p, _, _ in out):
                return out
            out.append((s["profile"], second, s["start"]))
    return out


def strands_of(R: dict, dv: dict) -> list[tuple[str, str, str]]:
    """The strands of a voted design (dv), with the mixed-methods pair when it was asked."""
    sv = dv.get("strands") or {}
    if dv.get("design") == "mixed-methods" and sv.get("main_design"):
        return profiles_for(R, "mixed-methods", sv.get("other_design") or dv.get("second_design"), sv["main_design"])
    return profiles_for(R, dv.get("design"), dv.get("second_design"))


# A design's own definition, checked against the answers before it may start high (rubric.md rule 1b).
START_NEEDS = {"systematic-review": ({"q6": ("yes",), "q7": ("yes", "partly")},
                                     "a systematic review whose search and inclusion (q6) and weighing of its "
                                     "studies (q7) aren't shown")}


def grade_one(profile: dict, start: str, answers: dict[str, str], design: str | None = None) -> tuple[str, list[str]]:
    """rubric.md 'From answers to a grade', for one strand."""
    qs = profile["questions"]
    crit = set(profile["critical"])
    why = []
    ct = sum(1 for q in qs if answers.get(q["id"], "can't tell") == "can't tell")
    if ct * 2 > len(qs):
        return NA, [f"{ct} of {len(qs)} questions can't be told from the text"]
    lvl = LEVELS.index(start)
    why.append(f"starts at {start}")
    needs, what = START_NEEDS.get(design or "", ({}, ""))
    if needs and lvl > LEVELS.index("Moderate") and not all(answers.get(q) in ok for q, ok in needs.items()):
        lvl = LEVELS.index("Moderate")
        why[-1] = f"starts at Moderate, as {what}"
    by_dim = collections.defaultdict(list)
    for q in qs:
        by_dim[q["dim"]].append(answers.get(q["id"], "can't tell"))
    unmet = sorted(d for d in crit if by_dim.get(d)
                   and not any(a in ("yes", "partly") for a in by_dim[d]) and "not found" in by_dim[d])
    unclear = sorted(d for d in crit if by_dim.get(d) and all(a == "can't tell" for a in by_dim[d]))
    if unmet:
        cap = 1 if len(unmet) == 1 else 0
        if lvl > cap:
            lvl = cap
        why.append(f"critical {', '.join(unmet)} unmet: at most {LEVELS[cap]}")
    for d in unclear:
        lvl -= 1
        why.append(f"critical {d} unclear: down one")
    nf = sum(1 for q in qs if q["dim"] not in crit and answers.get(q["id"]) == "not found")
    if nf >= 2:
        lvl -= 1
        why.append(f"{nf} other questions not found: down one")
    lvl = max(lvl, 0)
    return LEVELS[lvl], why


def grade_paper(R: dict, strands: list[tuple[str, str, str]], answers_by_profile: dict) -> tuple[str, list[str]]:
    grades = []
    for prof, design, start in strands:
        g, why = grade_one(R["profiles"][prof], start, answers_by_profile.get(prof, {}), design)
        grades.append((g, f"{R['profiles'][prof]['title']}: {g} ({'; '.join(why)})"))
    if not grades:
        return NA, ["no design was agreed"]
    rated = [g for g, _ in grades if g != NA]
    if not rated:
        return NA, [w for _, w in grades]
    worst = min(rated, key=LEVELS.index)
    notes = [w for _, w in grades]
    if len(grades) > 1:
        notes.append(f"two strands: the weaker, {worst}, stands")
    return worst, notes


IPCC = {("limited", "low"): "very low", ("limited", "medium"): "low", ("limited", "high"): "medium",
        ("medium", "low"): "low", ("medium", "medium"): "medium", ("medium", "high"): "high",
        ("robust", "low"): "medium", ("robust", "medium"): "high", ("robust", "high"): "very high"}
RELAYED = {"reported", "background"}


def confidence(rows: list[dict]) -> dict:
    """rows: one per cited passage, {source_id, lead, verdict, gap, origin, grade, setting}. rubric.md Level 3.
    Agreement is counted by lead author, not by paper (2026-10-06): three papers by one lead author
    restating one framework are one voice, not three. A row without `lead` counts as its own paper."""
    verdicts = [r["verdict"] for r in rows if r.get("verdict")]
    if not verdicts:
        # checked, but the three runs split three ways on every passage: say so, don't call it unchecked
        split = any(len({v for v in r.get("verdict_runs") or [] if v}) > 1 for r in rows)
        return {"label": "runs disagreed" if split else "not checked"}
    if all(v == "does not support" for v in verdicts):
        return {"label": "not supported by its passages", "evidence": None, "agreement": None, "independent": 0, "papers": 0}
    indep, papers = {}, set()
    for r in rows:
        if r.get("verdict") in ("supports", "partly") and r.get("origin") and r["origin"] not in RELAYED:
            who = r.get("lead") or r["source_id"]
            papers.add(r["source_id"])
            g = r.get("grade") or NA
            if who not in indep or (g in LEVELS and (indep[who] not in LEVELS or LEVELS.index(g) > LEVELS.index(indep[who]))):
                indep[who] = g
    n = len(indep)
    good = sum(1 for g in indep.values() if g in ("Moderate", "High"))
    if n >= 3 and good >= 2:
        ev = "robust"
    elif n >= 2 or (n == 1 and "High" in indep.values()):
        ev = "medium"
    else:
        ev = "limited"
    gaps = [r.get("gap") for r in rows if r.get("gap") and r["gap"] != "none"]
    partly = verdicts.count("partly")
    if "does not support" in verdicts or partly * 2 > len(verdicts):
        ag = "low"
    elif partly or gaps:
        ag = "medium"
    else:
        ag = "high"
    if ag == "high" and n < 2:
        ag = "medium"          # agreement is concurrence across authors: one author can't agree with themself
    settings = sorted({r.get("setting") for r in rows if r.get("verdict") in ("supports", "partly") and r.get("setting")})
    return {"label": IPCC[(ev, ag)], "evidence": ev, "agreement": ag, "independent": n, "papers": len(papers),
            "independent_moderate_or_better": good, "gaps": sorted(set(gaps)), "settings": settings}


def plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).lower().strip()


def lead_of(src: dict, rule: str = "family") -> str:
    """The first author's family name, folded ("Geels", "Gééls" → "geels"); "" when the record has no authors.
    With the rule "family-initial" (a corpus's settings, "lead_author"), a person's first initial joins it, so
    three different Wangs stay three ("wang y", "wang z"); an organisation stays its whole name."""
    for a in (src.get("bib") or {}).get("authors") or []:
        n = (a.get("family") or a.get("literal") or a.get("name") or "") if isinstance(a, dict) else str(a).split(",")[0]
        if n.strip():
            given = (a.get("given") or "").strip() if isinstance(a, dict) and a.get("family") else ""
            return fold(n) + (f" {fold(given)[:1]}" if rule == "family-initial" and given else "")
    return ""


# --- the plain words the site shows (2026-10-06) ---------------------------------------------
# IPCC's five levels stay in the record and on the Methods page; the pages say these four. Very high and
# high merge: in two checks of the same home summary they swapped places, so the line between them isn't stable.
SUPPORT = {"very high": "well", "high": "well", "medium": "some", "low": "limited", "very low": "weak"}
SUPPORT_LABEL = {"well": "Well supported", "some": "Some support", "limited": "Limited", "weak": "Weak or unclear"}
KIND_LABEL = {"finding": "Finding from data or cases", "framework": "About a framework", "argument": "Argument or interpretation",
              "recommendation": "Recommendation", "unsupported": "Not backed by its passages"}
US_NAMES = {"united states", "usa", "us", "u.s.", "u.s.a.", "united states of america", "america"}
US_STATES = {"california", "new york", "texas", "massachusetts", "oregon", "washington", "colorado", "minnesota",
             "illinois", "vermont", "maine", "hawaii", "arizona", "michigan", "pennsylvania", "florida"}
EUROPE_NAMES = {"europe", "european union", "eu", "uk", "united kingdom", "great britain", "britain", "england",
                "scotland", "wales", "northern ireland", "ireland", "netherlands", "the netherlands", "belgium",
                "luxembourg", "france", "germany", "austria", "switzerland", "italy", "spain", "portugal", "greece",
                "denmark", "sweden", "norway", "finland", "iceland", "estonia", "latvia", "lithuania", "poland",
                "czech republic", "czechia", "slovakia", "hungary", "slovenia", "croatia", "romania", "bulgaria",
                "serbia", "cyprus", "malta", "scandinavia", "nordic countries"}
SHOWN = {"united kingdom": "UK", "great britain": "UK", "britain": "UK", "usa": "US", "united states": "US",
         "u.s.": "US", "u.s.a.": "US", "united states of america": "US", "us": "US", "european union": "EU",
         "the netherlands": "Netherlands"}
PLACES = [("us", "United States", "The paper's evidence comes from the United States, or one of its states."),
          ("europe", "Europe", "The paper's evidence comes from Europe: the UK, the EU or another European country."),
          ("elsewhere", "Elsewhere", "The paper's evidence comes from outside the United States and Europe."),
          ("not-stated", "No one place", "The paper names no country its evidence comes from: theory, most reviews, "
                                         "global studies.")]


def country_parts(country: str) -> list[str]:
    """"California, USA" → ["California", "USA"]: a model sometimes names a place with its country."""
    return [p.strip(" ()") for p in re.split(r"\s*(?:,|;|/|&|\band\b)\s*", country or "") if p.strip(" ()")]


def region_of(country: str) -> str:
    regions = set()
    for part in country_parts(country) or [country]:
        c = fold(part)
        regions.add("us" if c in US_NAMES or c in US_STATES or "united states" in c
                    else "europe" if c in EUROPE_NAMES else "elsewhere")
    return next(k for k in ("us", "europe", "elsewhere") if k in regions)


def places_of(countries: list[str]) -> list[str]:
    """The place codes for a paper's agreed countries, in PLACES order; ["not-stated"] for none."""
    got = {region_of(p) for c in countries or [] if c.strip() for p in country_parts(c) or [c]}
    return [k for k, _, _ in PLACES if k in got] or ["not-stated"]


def shown_country(c: str) -> str:
    return SHOWN.get(fold(c), c.strip())


DESIGN_SHORT = {"experimental": "experiment", "observational-quantitative": "survey or statistics",
                "measured-performance": "field measurement", "model-simulation": "model", "case-study": "case study",
                "qualitative-interview": "interviews", "mixed-methods": "mixed methods",
                "systematic-review": "systematic review", "narrative-review": "review", "theory-conceptual": "theory",
                "commentary": "commentary", "grey-report": "report", "program-evaluation": "program evaluation"}


def kind_of(sup: list[dict]) -> str:
    """What sort of statement it is, from what its supporting passages are (rules, no model)."""
    if not sup:
        return "unsupported"
    origins = {r.get("origin") for r in sup}
    basis = {r.get("basis") for r in sup}
    if origins <= {"theoretical", "background", "reported"} and not basis & {"data", "case"}:
        return "framework"
    if origins & {"own-finding", "interpretation"} and basis & {"data", "case"}:
        return "finding"
    if origins <= {"recommendation", "speculation", "theoretical"}:
        return "recommendation"
    return "argument"


def plain_of(rows: list[dict], conf: dict, papers: dict, own: dict | None = None) -> dict:
    """The site's plain fields for one statement: support in four words, how many lead authors and papers agree,
    what kind of statement it is, where its independent evidence comes from and what kind of study it is."""
    sup = [r for r in rows if r.get("verdict") in ("supports", "partly")]
    indep = [r for r in sup if r.get("origin") and r["origin"] not in RELAYED]
    key = SUPPORT.get(conf.get("label"), "weak")
    countries, designs = [], []
    for r in indep:
        dv = (papers.get(r.get("source_id")) or {}).get("design") or {}
        countries += [shown_country(c) for c in dv.get("countries") or [] if c.strip()]
        if dv.get("design"):
            designs.append(DESIGN_SHORT.get(dv["design"], dv["design"]))
    leads = {r.get("lead") or r["source_id"] for r in indep}
    if own:     # the corpus's own places (own_places), in its codebook's order
        got = {k for r in indep for k in (papers.get(r.get("source_id")) or {}).get("places") or []}
        places = [k for k in own["order"] if k in got]
    else:
        places = [k for k, _, _ in PLACES if k != "not-stated" and any(region_of(c) == k for c in countries)]
    return {"support": key, "support_label": SUPPORT_LABEL[key], "studies": len(leads),
            "papers": len({r["source_id"] for r in indep}), "same_lead": len({r["source_id"] for r in indep}) >= 2 and len(leads) == 1,
            "relayed_only": bool(sup) and not indep, "kind": kind_of(sup),
            "places": places, "countries": list(dict.fromkeys(countries)), "designs": list(dict.fromkeys(designs))}


def setting_of(R: dict, design_vote: dict | None) -> str | None:
    """target, near or other: is the paper in the domain's target sectors, its places (the
    `place` scheme's codes: us, europe, elsewhere), both or neither? None without a domain."""
    dom = R.get("domain")
    if not design_vote or not dom:
        return None
    t = dom["target"]
    sector = design_vote.get("sector") or ""
    in_place = any(region_of(c) in t.get("places", []) for c in design_vote.get("countries") or [] if c.strip())
    in_sector = sector in t.get("sectors", [])
    if in_sector and in_place:
        return "target"
    if in_sector or in_place:
        return "near"
    return "other"


# --- state ---------------------------------------------------------------------------

def state(corpus: Path, *parts) -> Path:
    return C.state_dir(corpus, "appraise", STATE_NAME, *parts)


def paper_file(corpus: Path, slug: str) -> Path:
    return state(corpus, "papers") / f"{slug}.json"


def load_set(corpus: Path, name: str) -> dict:
    f = C.state_dir(corpus, "appraise") / "sets" / f"{name}.json"
    d = C.load_json(f)
    if not d:
        C.die(f"no set '{name}': run `appraise.py plan --set {name} …` first")
    return d


# --- running ---------------------------------------------------------------------------

class Runner:
    def __init__(self, corpus: Path, only: str, runs: int, stop_at: datetime | None):
        self.corpus, self.only, self.runs, self.stop_at = corpus, only, runs, stop_at
        self.R = rubric(corpus)
        self.data = load_corpus(corpus)
        self.lock = threading.Lock()
        self.done = 0
        self.calls = 0
        self.failed: list[str] = []

    def log(self, msg: str) -> None:
        with self.lock:
            print(msg, flush=True)

    def work(self, sid: str, name: str, url: str):
        if self.stop_at and datetime.now() >= self.stop_at:
            raise P.Unavailable(f"stop time {self.stop_at:%H:%M} reached")
        src = self.data["sources"][sid]
        pf = paper_file(self.corpus, src["slug"])
        st = C.load_json(pf, {}) or {}
        raw = Path(src["text_path"]).read_text(encoding="utf-8")
        text, notes = model_text(raw, src["container"])
        ntext = norm(raw)
        st.update({"source_id": sid, "slug": src["slug"], "prompt_version": PROMPT_VERSION, "model": MODEL,
                   "text_rep": src["text_rep"], "text_notes": notes})
        st.setdefault("machine", name)
        # The paper goes in the system message and the task in the user's (2026-10-29; before, both were one user
        # message). The words are the same; a server that reuses a prompt only from the end of its system message
        # (NInfer saves a checkpoint there once it has seen that prefix twice) then reads each paper twice, not on
        # every one of its 12-15 calls. Each paper's state says which layout made it.
        system = f"{SYS}\n\nPAPER TEXT:\n<<<\n{text}\n>>>"
        st.setdefault("layout", "paper-in-user" if (st.get("design") or {}).get("runs") else LAYOUT)
        if st["layout"] != LAYOUT:
            why = (f"begun with the paper in the {st['layout'].split('-')[-1]} message; finish it with that version, "
                   "or move its state aside to start it again")
            self.failed.append(f"{src['slug']}: {why}")
            return {"slug": src["slug"], "calls": 0, "error": why}
        save = lambda: C.save_json(pf, st)  # noqa: E731
        t0 = time.time()
        calls = 0

        def call(task: str, schema: dict, cap: int, *key, model=None, effort=None):
            nonlocal calls
            calls += 1
            out, meta = chat_json(url, system, "TASK:\n" + task, schema, cap, seed=seed_for(src["slug"], *key),
                                  model=model, effort=effort)
            meta["machine"] = name
            return out, meta

        # 1. design ×runs, voted
        dz = st.setdefault("design", {"runs": []})
        task, schema = design_task(self.R)
        while len(dz["runs"]) < self.runs:
            r = len(dz["runs"]) + 1
            try:
                out, meta = call(task, schema, 500, "design", r)
            except Step as e:
                self.failed.append(f"{src['slug']} design run {r}: {e}")
                save()
                return {"slug": src["slug"], "calls": calls, "error": str(e)}
            out["quote_check"] = check_quote(raw, ntext, out.get("quote", ""))
            out["meta"] = meta
            dz["runs"].append(out)
            save()
        dz["vote"] = vote_design(dz["runs"])
        save()
        # 1b. mixed methods: both strands ×runs, voted
        if dz["vote"].get("design") == "mixed-methods":
            sz = st.setdefault("strands", {"runs": []})
            task, schema = strands_task(self.R)
            while len(sz["runs"]) < self.runs:
                r = len(sz["runs"]) + 1
                try:
                    out, meta = call(task, schema, 500, "strands", r)
                except Step as e:
                    self.failed.append(f"{src['slug']} strands run {r}: {e}")
                    save()
                    return {"slug": src["slug"], "calls": calls, "error": str(e)}
                out["quote_check"] = check_quote(raw, ntext, out.get("quote", ""))
                out["meta"] = meta
                sz["runs"].append(out)
                save()
            dz["vote"]["strands"] = vote_strands(sz["runs"])
            save()
        if self.only == "design":
            return {"slug": src["slug"], "calls": calls, "seconds": round(time.time() - t0, 1)}

        # 2. the profile's questions ×runs, per strand
        strands = strands_of(self.R, dz["vote"])
        cz = st.setdefault("criteria", {})
        for prof, design, _start in strands:
            pz = cz.setdefault(prof, {"design": design, "runs": []})
            task, schema = criteria_task(self.R, prof, self.R["by_code"][design]["label"])
            while len(pz["runs"]) < self.runs:
                r = len(pz["runs"]) + 1
                try:
                    out, meta = call(task, schema, 1500, "criteria", prof, r, model=CRITERIA_MODEL, effort=CRITERIA_EFFORT)
                except Step as e:
                    self.failed.append(f"{src['slug']} {prof} run {r}: {e}")
                    save()
                    return {"slug": src["slug"], "calls": calls, "error": str(e)}
                for a in out.get("answers", []):
                    a["quote_check"] = check_quote(raw, ntext, a.get("quote", "")) if a.get("quote") else "missing"
                out["meta"] = meta
                pz["runs"].append(out)
                save()

        # 3. passages ×runs, shuffled, ≤12 per call
        ids = sorted(src["passages"])
        if ids:
            qz = st.setdefault("passages", {"runs": []})
            while len(qz["runs"]) < self.runs:
                r = len(qz["runs"]) + 1
                order = ids[:]
                random.Random(seed_for(src["slug"], "passages", r)).shuffle(order)
                got, metas = {}, []
                part = qz.setdefault("partial", {})
                if part.get("run") == r:
                    got = part.get("got", {})
                for i in range(0, len(order), CHUNK):
                    chunk = [e for e in order[i:i + CHUNK] if e not in got]
                    if not chunk:
                        continue
                    keys = {f"p{k + 1}": e for k, e in enumerate(chunk)}
                    items = []
                    for k, e in keys.items():
                        q = self.data["exts"][e]["direct_quote"]
                        cites = CITE_RE.findall(q)
                        items.append((k, q, "; ".join(dict.fromkeys(cites))[:120] if cites else ""))
                    task, schema = passages_task(items)
                    try:
                        out, meta = call(task, schema, 220 * len(chunk) + 300, "passages", r, i)
                    except Step as e:
                        self.failed.append(f"{src['slug']} passages run {r} chunk {i // CHUNK + 1}: {e}")
                        qz["partial"] = {"run": r, "got": got}
                        save()
                        return {"slug": src["slug"], "calls": calls, "error": str(e)}
                    for a in out.get("passages", []):
                        e = keys.get(a.get("key"))
                        if e:
                            got[e] = {"origin": a.get("origin"), "basis": a.get("basis"), "reason": a.get("reason", "")}
                    metas.append(meta)
                    qz["partial"] = {"run": r, "got": got}
                    save()
                qz["runs"].append({"labels": got, "order": order, "meta": metas})
                qz.pop("partial", None)
                save()
        st["seconds_last"] = round(time.time() - t0, 1)
        save()
        return {"slug": src["slug"], "calls": calls, "seconds": round(time.time() - t0, 1)}

    def fits(self, sid: str, name: str) -> bool:
        """Does the paper, as the model reads it, fit this server? Too long for one server, it waits for another."""
        cap = P.context_of(name)
        return not cap or self.data["sources"][sid].get("model_chars", 0) / CHARS_PER_TOKEN + RESERVE_TOKENS <= cap

    def on_done(self, sid, result, name, seconds):
        self.done += 1
        self.calls += result.get("calls", 0)
        flag = f"  ERROR {result['error']}" if result.get("error") else ""
        print(f"  [{self.done:3}] {name:6} {result['slug'][:40]:40} {result.get('calls', 0):3} calls {seconds:6.0f}s{flag}",
              flush=True)


def vote_design(runs: list[dict]) -> dict:
    design = majority([r.get("design") for r in runs])
    second = majority([r.get("second_design") for r in runs]) if design in ("mixed-methods", "grey-report") else "none"
    if design == "mixed-methods" and (not second or second == "none"):
        # a mixed-methods paper needs two strands; without an agreed second, take the first run's
        second = next((r.get("second_design") for r in runs if r.get("design") == "mixed-methods"
                       and r.get("second_design") not in (None, "none")), None)
    sector = majority([r.get("sector") for r in runs])
    cs = collections.Counter(c.strip() for r in runs for c in (r.get("countries") or []) if c.strip())
    countries = sorted(c for c, n in cs.items() if n * 2 > len(runs))
    rep = next((r for r in runs if r.get("design") == design and r.get("quote_check") in QUOTE_OK), None)
    return {"design": design, "second_design": second or "none", "sector": sector, "countries": countries,
            "quote": (rep or {}).get("quote", ""), "reason": (rep or {}).get("reason", ""),
            "runs_agree": len({r.get("design") for r in runs}) == 1}


def vote_strands(runs: list[dict]) -> dict:
    main = majority([r.get("main_design") for r in runs])
    other = majority([r.get("other_design") for r in runs])
    if main and other == main:
        other = majority([r.get("other_design") for r in runs if r.get("other_design") != main]) or None
    return {"main_design": main, "other_design": other, "runs": [[r.get("main_design"), r.get("other_design")] for r in runs]}


def answer_of(a: dict) -> str:
    """A yes or partly without a checked quotation counts as can't tell."""
    lab = a.get("answer")
    if lab in ("yes", "partly") and a.get("quote_check") not in QUOTE_OK:
        return "can't tell"
    return lab


def vote_paper(R: dict, st: dict) -> dict:
    dz = st.get("design") or {}
    dv = dict(dz.get("vote") or vote_design(dz.get("runs", [])))
    if dv.get("design") == "mixed-methods" and (st.get("strands") or {}).get("runs"):
        dv["strands"] = vote_strands(st["strands"]["runs"])
    strands = strands_of(R, dv)
    answers_by_profile, detail = {}, {}
    for prof, design, _ in strands:
        runs = ((st.get("criteria") or {}).get(prof) or {}).get("runs", [])
        votes = {}
        for q in R["profiles"][prof]["questions"]:
            per = [next((answer_of(a) for a in r.get("answers", []) if a.get("id") == q["id"]), None) for r in runs]
            v = majority(per) or "can't tell"
            rep = next((a for r in runs for a in r.get("answers", [])
                        if a.get("id") == q["id"] and answer_of(a) == v), {})
            votes[q["id"]] = v
            detail.setdefault(prof, {})[q["id"]] = {"answer": v, "runs": per, "quote": rep.get("quote", "") if v in ("yes", "partly") else "",
                                                     "reason": rep.get("reason", ""), "dim": q["dim"]}
        answers_by_profile[prof] = votes
    complete = all(len(((st.get("criteria") or {}).get(p) or {}).get("runs", [])) >= RUNS for p, _, _ in strands)
    grade, why = grade_paper(R, strands, answers_by_profile) if strands and complete else (None, ["not rated yet"])
    pv = {}
    pruns = ((st.get("passages") or {}).get("runs")) or []
    if len(pruns) >= RUNS:
        for e in pruns[0]["labels"]:
            o = [r["labels"].get(e, {}).get("origin") for r in pruns]
            b = [r["labels"].get(e, {}).get("basis") for r in pruns]
            vo, vb = majority(o), majority(b)
            reason_o = next((r["labels"][e]["reason"] for r in pruns if r["labels"].get(e, {}).get("origin") == vo), "")
            pv[e] = {"origin": vo, "basis": vb, "origin_runs": o, "basis_runs": b, "reason": reason_o}
    return {"design": dv, "strands": [{"profile": p, "design": d, "start": s} for p, d, s in strands],
            "answers": detail, "grade": grade, "grade_why": why, "passages": pv,
            "setting": setting_of(R, dv), "layout": st.get("layout") or "paper-in-user"}


def parse_clock(s: str | None, after: datetime | None = None) -> datetime | None:
    if not s:
        return None
    h, m = map(int, s.split(":"))
    base = after or datetime.now()
    t = base.replace(hour=h, minute=m, second=0, microsecond=0)
    if t <= base:
        t += timedelta(days=1)
    return t


def cmd_run(args) -> int:
    corpus = Path(args.corpus).expanduser()
    st = load_set(corpus, args.set)
    if args.not_before:
        start = parse_clock(args.not_before)
        if start and start > datetime.now() and (start - datetime.now()).total_seconds() < 20 * 3600:
            print(f"Waiting until {start:%Y-%m-%d %H:%M} to start.", flush=True)
            time.sleep((start - datetime.now()).total_seconds())
    stop = parse_clock(args.stop_at) if args.stop_at else None
    runner = Runner(corpus, args.only, args.runs, stop)
    srcs = runner.data["sources"]
    papers = st["papers"] if args.only != "design" else (st.get("design_papers") or st["papers"])
    todo = []
    for sid in papers:
        s = srcs.get(sid)
        if not s:
            continue
        cur = C.load_json(paper_file(corpus, s["slug"]), {}) or {}
        if paper_done(cur, args.only, args.runs, len(s["passages"]), runner.R):
            continue
        todo.append(sid)
    todo.sort(key=lambda sid: -(srcs[sid].get("chars") or 0))
    if P.CONTEXT:     # each paper's length as the model reads it, so the pool can send it where it fits
        for sid in todo:
            src = srcs[sid]
            src["model_chars"] = len(model_text(Path(src["text_path"]).read_text(encoding="utf-8"), src["container"])[0])
    too_long = [sid for sid in todo if not any(runner.fits(sid, n) for n in P.ENDPOINTS)]
    todo = [sid for sid in todo if sid not in too_long]     # never queued: a re-run couldn't finish them either
    C.counts_header("Appraisal run", [
        ("set", f"{args.set} ({len(papers)} papers)"),
        ("to do", len(todo)),
        ("steps", "design only" if args.only == "design" else "design, criteria, passages"),
        ("runs", args.runs), ("model", f"{MODEL_DESC} at temperature {TEMPERATURE}"),
        ("machines", ", ".join(P.ENDPOINTS)),
        ("stops at", f"{stop:%Y-%m-%d %H:%M}" if stop else "when done"),
        ("prompt version", PROMPT_VERSION),
    ])
    t0 = time.time()
    if too_long:
        print(f"  TOO LONG for every server's context window, left out: {', '.join(srcs[x]['slug'] for x in too_long)}",
              flush=True)
    problems, left = P.run_all(todo, runner.work, runner.on_done, fits=runner.fits)
    C.counts_header("Appraisal run finished", [
        ("papers done", runner.done), ("calls", runner.calls), ("minutes", round((time.time() - t0) / 60, 1)),
        ("left (resume to finish)", len(left)), ("failed steps", len(runner.failed)),
    ], notes=[f"PROBLEM {p}" for p in problems] + [f"FAILED {f}" for f in runner.failed[:20]])
    return PAUSED if left else 0


def paper_done(st: dict, only: str, runs: int, n_passages: int, R: dict | None = None) -> bool:
    if len(((st.get("design") or {}).get("runs")) or []) < runs:
        return False
    dv = (st.get("design") or {}).get("vote") or {}
    if dv.get("design") == "mixed-methods" and len(((st.get("strands") or {}).get("runs")) or []) < runs:
        return False
    if only == "design":
        return True
    R = R or rubric()
    for prof, _, _ in strands_of(R, dv):
        if len((((st.get("criteria") or {}).get(prof)) or {}).get("runs", [])) < runs:
            return False
    if n_passages and len(((st.get("passages") or {}).get("runs")) or []) < runs:
        return False
    return True


def cmd_recheck(args) -> int:
    """Check every stored run's quotations again with the current rules (no model calls).
    Used when the rules change, e.g. elided quotations checked piece by piece (10-05)."""
    corpus = Path(args.corpus).expanduser()
    data = load_corpus(corpus)
    by_slug = {s["slug"]: s for s in data["sources"].values()}
    moved = collections.Counter()
    for f in sorted(state(corpus, "papers").glob("*.json")):
        st = C.load_json(f, {}) or {}
        src = by_slug.get(st.get("slug") or f.stem)
        if not src:
            continue
        raw = Path(src["text_path"]).read_text(encoding="utf-8")
        ntext = norm(raw)
        items = [r for part in ("design", "strands") for r in (st.get(part) or {}).get("runs", [])]
        items += [a for pz in (st.get("criteria") or {}).values() for r in pz.get("runs", []) for a in r.get("answers", [])]
        for it in items:
            if "quote_check" not in it:
                continue
            new = check_quote(raw, ntext, it.get("quote", "")) if it.get("quote") else "missing"
            if new != it["quote_check"]:
                moved[f"{it['quote_check']} → {new}"] += 1
                it["quote_check"] = new
        C.save_json(f, st)
    C.counts_header("Quotations checked again", [(k, n) for k, n in moved.most_common()] or [("changed", 0)])
    return 0


# --- statements ----------------------------------------------------------------------

def statement_items(data: dict, which: str, set_def: dict | None) -> list[tuple[str, str]]:
    """[(synthesis id, claim id)] to check."""
    syns = data["syntheses"]
    is_rev = lambda d: bool(((d.get("ext") or {}).get("upc-site") or {}).get("revision"))  # noqa: E731
    superseded = {d.get("supersedes") for d in syns.values() if d.get("supersedes")}
    if which == "pilot":
        chosen = set_def["syntheses"]
    elif which == "revised":   # the current revisions only (a v2 revision replaced by a grouped one is left out)
        chosen = [s for s, d in syns.items() if is_rev(d) and s not in superseded]
    else:   # all: the overviews and home summary as hosted (not revisions, not support matrices); a revision
        # superseding one doesn't remove it from this set, or a re-run after the rewrite would find nothing
        replaced = {d.get("supersedes") for d in syns.values() if d.get("supersedes") and not is_rev(d)}
        chosen = [s for s, d in syns.items() if d.get("type") in ("thematic", "answer")
                  and not is_rev(d) and s not in replaced]
    return [(s, c["claim_id"]) for s in sorted(chosen) for c in syns[s].get("claims", []) if c.get("evidence_ids")]


def claim_of(data: dict, sid: str, cid: str) -> dict:
    return next(c for c in data["syntheses"][sid]["claims"] if c["claim_id"] == cid)


def stale_check(rec: dict, claim: dict) -> bool:
    """A stored statement check that no longer matches its claim's text or cited passages."""
    return rec.get("text") != claim.get("text") or \
        sorted((rec.get("evidence") or {}).values()) != sorted(claim.get("evidence_ids") or [])


def cmd_statements(args) -> int:
    corpus = Path(args.corpus).expanduser()
    data = load_corpus(corpus)
    set_def = load_set(corpus, "pilot") if args.set == "pilot" else None
    wfile = C.state_dir(corpus, "appraise") / "windows.json"
    if not wfile.exists():
        C.die(f"no windows: run `node {Path(__file__).parent / 'ctx_windows.mjs'} --corpus {corpus} --out {wfile}`")
    windows = json.loads(wfile.read_text(encoding="utf-8"))
    items = statement_items(data, args.set, set_def)
    out_dir = state(corpus, "statements")
    if args.not_before:
        start = parse_clock(args.not_before)
        if start and start > datetime.now() and (start - datetime.now()).total_seconds() < 20 * 3600:
            print(f"Waiting until {start:%Y-%m-%d %H:%M} to start.", flush=True)
            time.sleep((start - datetime.now()).total_seconds())
    stop = parse_clock(args.stop_at) if args.stop_at else None
    lock = threading.Lock()
    results: dict[str, dict] = {}
    for f in out_dir.glob("*.json"):
        results[f.stem] = C.load_json(f, {}) or {}
    # A stored check counts only while the claim still says the same thing and cites the same
    # passages: an overview edited in place can keep its id (claims are outside the id recipe).
    for sid, cid in items:
        rec = (results.get(sid) or {}).get(cid)
        if rec and stale_check(rec, claim_of(data, sid, cid)):
            del results[sid][cid]
    todo = [it for it in items if len(((results.get(it[0]) or {}).get(it[1]) or {}).get("runs", [])) < args.runs]
    counter = {"done": 0, "calls": 0}

    def label(e: str) -> str:
        src = data["sources"].get(data["exts"][e]["source_id"], {})
        return f"{author_year(src)}, “{src.get('title', '')[:90]}”"

    def work(item, name, url):
        if stop and datetime.now() >= stop:
            raise P.Unavailable(f"stop time {stop:%H:%M} reached")
        sid, cid = item
        claim = claim_of(data, sid, cid)
        evid = [e for e in claim.get("evidence_ids", []) if e in data["exts"]]
        keys = {f"e{k + 1}": e for k, e in enumerate(evid)}
        rows = []
        for k, e in keys.items():
            w = windows.get(e) or [data["exts"][e]["direct_quote"], 0, len(data["exts"][e]["direct_quote"])]
            rows.append((k, label(e), w[0][:w[1]] + "«" + w[0][w[1]:w[2]] + "»" + w[0][w[2]:]))
        task, schema = statement_task(claim["text"], rows)
        with lock:
            rec = results.setdefault(sid, {}).setdefault(cid, {"text": claim["text"], "evidence": keys, "runs": []})
        while len(rec["runs"]) < args.runs:
            r = len(rec["runs"]) + 1
            try:
                out, meta = chat_json(url, SYS_STATEMENT, task, schema, 180 * len(rows) + 200, seed=seed_for(sid, cid, r))
            except Step as e:
                return {"error": str(e)}
            meta["machine"] = name
            with lock:
                rec["runs"].append({"passages": {keys.get(a.get("key")): {"verdict": a.get("verdict"), "gap": a.get("gap"),
                                                                       "reason": a.get("reason", "")}
                                                 for a in out.get("passages", []) if keys.get(a.get("key"))},
                                    "meta": meta})
                C.save_json(out_dir / f"{sid}.json", results[sid])
        return {"calls": args.runs}

    def on_done(item, result, name, seconds):
        counter["done"] += 1
        counter["calls"] += result.get("calls", 0)
        if counter["done"] % 25 == 0 or result.get("error"):
            print(f"  [{counter['done']:4}/{len(todo)}] {name:6} {item[0]} {item[1]} {seconds:5.1f}s"
                  f"{'  ERROR ' + result['error'] if result.get('error') else ''}", flush=True)

    C.counts_header("Statement check", [("set", args.set), ("statements", len(items)), ("to do", len(todo)),
                                        ("runs", args.runs), ("stops at", f"{stop:%H:%M}" if stop else "when done")])
    t0 = time.time()
    problems, left = P.run_all(todo, work, on_done)
    C.counts_header("Statement check finished", [("checked", counter["done"]), ("minutes", round((time.time() - t0) / 60, 1)),
                                                 ("left", len(left))], notes=[f"PROBLEM {p}" for p in problems])
    return PAUSED if left else 0


# --- vote -------------------------------------------------------------------------------

def cmd_vote(args) -> int:
    corpus = Path(args.corpus).expanduser()
    R = rubric(corpus)
    data = load_corpus(corpus)
    papers = {}
    for f in sorted(state(corpus, "papers").glob("*.json")):
        st = C.load_json(f, {}) or {}
        if st.get("source_id"):
            papers[st["source_id"]] = vote_paper(R, st)
            if R["places"]:
                papers[st["source_id"]]["places"] = R["places"]["by_source"].get(st["source_id"], [])
    passage_vote = {e: v for p in papers.values() for e, v in p["passages"].items()}
    statements = {}
    # A revision replaced by a later one (a v2 overview by its grouped rewrite) is left out, so the report,
    # the support tables and the Methods page count each theme once. The overviews as hosted stay: they are
    # the "before".
    syns = data["syntheses"]
    replaced = {d.get("supersedes") for d in syns.values() if d.get("supersedes")}
    is_rev = lambda s: bool((((syns.get(s) or {}).get("ext") or {}).get("upc-site") or {}).get("revision"))  # noqa: E731
    for f in sorted(state(corpus, "statements").glob("*.json")):
        if is_rev(f.stem) and f.stem in replaced:
            continue
        recs = C.load_json(f, {}) or {}
        claims = {c["claim_id"]: c for c in (syns.get(f.stem) or {}).get("claims", [])}
        for cid, rec in recs.items():
            if f.stem in syns and (cid not in claims or stale_check(rec, claims[cid])):
                continue       # a claim since removed or edited: its old check no longer applies
            rows = []
            for k, e in rec["evidence"].items():
                verdict = majority([r["passages"].get(e, {}).get("verdict") for r in rec["runs"]])
                gap = majority([r["passages"].get(e, {}).get("gap") for r in rec["runs"]]) or ("none" if verdict else None)
                src_id = data["exts"].get(e, {}).get("source_id")
                pp = papers.get(src_id) or {}
                why = next((r["passages"][e]["reason"] for r in rec["runs"]
                            if r["passages"].get(e, {}).get("verdict") == verdict), "")
                rows.append({"extraction_id": e, "source_id": src_id, "lead": lead_of(data["sources"].get(src_id) or {}, R["lead_rule"]),
                             "verdict": verdict, "gap": gap,
                             "verdict_runs": [r["passages"].get(e, {}).get("verdict") for r in rec["runs"]],
                             "origin": (passage_vote.get(e) or {}).get("origin"),
                             "basis": (passage_vote.get(e) or {}).get("basis"),
                             "grade": pp.get("grade"), "setting": pp.get("setting"), "reason": why})
            conf = confidence(rows)
            statements.setdefault(f.stem, {})[cid] = {"text": rec["text"], "rows": rows, "confidence": conf,
                                                      "plain": plain_of(rows, conf, papers, R["places"])}
    out = {"prompt_version": PROMPT_VERSION, "voted_at": datetime.now().isoformat(timespec="seconds"),
           "papers": papers, "statements": statements}
    C.save_json(state(corpus) / "vote.json", out)
    grades = collections.Counter(p["grade"] for p in papers.values())
    C.counts_header("Vote", [("papers", len(papers)), ("grades", dict(grades)),
                             ("passages", len(passage_vote)), ("statements", sum(len(v) for v in statements.values())),
                             ("written to", str(state(corpus) / "vote.json"))])
    return 0


# --- agreement ----------------------------------------------------------------------------

def fleiss_and_ac1(items: list[list], categories: list) -> tuple[float | None, float | None, float]:
    """Multi-rater Fleiss' κ and Gwet's AC1 over items rated by the same number of raters.
    Returns (kappa, ac1, share of items where every rater agrees)."""
    items = [[v for v in it if v is not None] for it in items]
    items = [it for it in items if len(it) >= 2]
    if not items:
        return None, None, 0.0
    q = max(2, len(categories))
    pa_sum, pi = 0.0, collections.Counter()
    full = 0
    for it in items:
        r = len(it)
        cnt = collections.Counter(it)
        pa_sum += sum(n * (n - 1) for n in cnt.values()) / (r * (r - 1))
        for k, n in cnt.items():
            pi[k] += n / r
        full += len(cnt) == 1
    n = len(items)
    pa = pa_sum / n
    pik = {k: v / n for k, v in pi.items()}
    pe_f = sum(v * v for v in pik.values())
    pe_g = sum(v * (1 - v) for v in pik.values()) / (q - 1)
    kappa = None if pe_f >= 1 else (pa - pe_f) / (1 - pe_f)
    ac1 = None if pe_g >= 1 else (pa - pe_g) / (1 - pe_g)
    return kappa, ac1, full / n


def cohen(pairs: list[tuple]) -> float | None:
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    if not pairs:
        return None
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    la, lb = collections.Counter(a for a, _ in pairs), collections.Counter(b for _, b in pairs)
    pe = sum(la[k] / n * lb[k] / n for k in set(la) | set(lb))
    return None if pe >= 1 else (po - pe) / (1 - pe)


def ac1_pairs(pairs: list[tuple], categories: list) -> float | None:
    return fleiss_and_ac1([list(p) for p in pairs], categories)[1]


def bootstrap(pairs: list[tuple], stat, n: int = 2000, seed: int = 7) -> tuple[float | None, float | None]:
    pairs = [p for p in pairs if p[0] is not None and p[1] is not None]
    if len(pairs) < 5:
        return None, None
    rng = random.Random(seed)
    vals = []
    for _ in range(n):
        s = [pairs[rng.randrange(len(pairs))] for _ in pairs]
        v = stat(s)
        if v is not None and not math.isnan(v):
            vals.append(v)
    if not vals:
        return None, None
    vals.sort()
    return vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]


def fmt(x) -> str:
    return "n/a" if x is None else f"{x:.2f}"


def cmd_report(args) -> int:
    corpus = Path(args.corpus).expanduser()
    R = rubric(corpus)
    vote = C.load_json(state(corpus) / "vote.json")
    if not vote:
        C.die("no vote yet: run `appraise.py vote` first")
    papers_raw = {}
    for f in state(corpus, "papers").glob("*.json"):
        st = C.load_json(f, {}) or {}
        if st.get("source_id"):
            papers_raw[st["source_id"]] = st
    rows = []          # (dimension, items as lists of run labels, categories)

    def add(dim, items, cats):
        rows.append((dim, items, cats))

    add("design", [[r.get("design") for r in st.get("design", {}).get("runs", [])] for st in papers_raw.values()],
        [d["code"] for d in R["designs"]["designs"]])
    add("sector", [[r.get("sector") for r in st.get("design", {}).get("runs", [])] for st in papers_raw.values()],
        R["designs"]["sectors"])
    crit_items = collections.defaultdict(list)
    for st in papers_raw.values():
        for prof, pz in (st.get("criteria") or {}).items():
            if len(pz.get("runs", [])) < 2:
                continue
            for q in R["profiles"][prof]["questions"]:
                crit_items[f"{prof} {q['id']} ({q['dim']})"].append(
                    [next((answer_of(a) for a in r.get("answers", []) if a.get("id") == q["id"]), None) for r in pz["runs"]])
    dims = collections.defaultdict(list)
    for key, items in crit_items.items():
        dims["criteria " + key.split("(")[-1].rstrip(")")].extend(items)
    for key in sorted(dims):
        add(key, dims[key], ANSWERS)
    add("criteria (all questions)", [it for v in crit_items.values() for it in v], ANSWERS)
    # the grade each run alone would give: what the grade chip's stability really is
    per_grade = []
    for st in papers_raw.values():
        pv = vote_paper(R, st)
        strands = [(s_["profile"], s_["design"], s_["start"]) for s_ in pv["strands"]]
        gr = []
        for i in range(RUNS):
            ans = {}
            for prof, _, _ in strands:
                runs = ((st.get("criteria") or {}).get(prof) or {}).get("runs", [])
                if len(runs) > i:
                    ans[prof] = {a.get("id"): answer_of(a) for a in runs[i].get("answers", [])}
            if strands and len(ans) == len(strands):
                gr.append(grade_paper(R, strands, ans)[0])
        if len(gr) == RUNS:
            per_grade.append(gr)
    add("grade (each run alone)", per_grade, LEVELS + [NA])
    po, pb = [], []
    for st in papers_raw.values():
        runs = ((st.get("passages") or {}).get("runs")) or []
        if len(runs) >= 2:
            for e in runs[0]["labels"]:
                po.append([r["labels"].get(e, {}).get("origin") for r in runs])
                pb.append([r["labels"].get(e, {}).get("basis") for r in runs])
    add("claim-origin", po, ORIGINS)
    add("claim-basis", pb, BASES)
    sv = []
    for f in state(corpus, "statements").glob("*.json"):
        for rec in (C.load_json(f, {}) or {}).values():
            for e in rec["evidence"].values():
                sv.append([r["passages"].get(e, {}).get("verdict") for r in rec["runs"]])
    add("statement verdict", sv, VERDICTS)

    print("## Run to run (three runs at temperature 0.3)\n")
    print(f"  {'dimension':34} {'items':>6} {'all agree':>10} {'Fleiss κ':>9} {'AC1':>6}")
    run_rows = {}
    for dim, items, cats in rows:
        items = [it for it in items if sum(v is not None for v in it) >= 2]
        k, a, full = fleiss_and_ac1(items, cats)
        run_rows[dim] = {"items": len(items), "all_agree": full, "kappa": k, "ac1": a}
        print(f"  {dim:34} {len(items):6} {100 * full:9.0f}% {fmt(k):>9} {fmt(a):>6}"
              f"{'  LOW' if items and full < 0.8 else ''}")

    # against the blind second coding
    blind = C.blind_coding(corpus)
    vs = {}
    if blind:
        print(f"\n## The vote against the blind coding by {blind['name']}"
              + (" (a first look; another model, not a person)" if blind["kind"] == "model" else "") + "\n")
        print(f"  {'dimension':34} {'n':>4} {'agree':>6} {'κ':>6} {'95% CI':>14} {'AC1':>6} {'95% CI':>14}")
        pairs = collections.defaultdict(list)
        for sid, b in (blind.get("papers") or {}).items():
            v = (vote["papers"].get(sid) or {})
            dv = v.get("design") or {}
            pairs["design"].append((dv.get("design"), b.get("design")))
            pairs["sector"].append((dv.get("sector"), b.get("sector")))
            gb = b.get("grade")
            if v.get("grade") and gb:
                pairs["grade"].append((v["grade"], gb))
            for prof, ans in (b.get("answers") or {}).items():
                for qid, a in ans.items():
                    mv = ((v.get("answers") or {}).get(prof) or {}).get(qid)
                    if mv:
                        dim = mv["dim"]
                        pairs[f"criteria {dim}"].append((mv["answer"], a["answer"]))
                        pairs["criteria (all questions)"].append((mv["answer"], a["answer"]))
        for e, b in (blind.get("passages") or {}).items():
            mv = None
            for p in vote["papers"].values():
                if e in p["passages"]:
                    mv = p["passages"][e]
                    break
            if mv:
                pairs["claim-origin"].append((mv.get("origin"), b.get("origin")))
                pairs["claim-basis"].append((mv.get("basis"), b.get("basis")))
        cats = {"design": [d["code"] for d in R["designs"]["designs"]], "sector": R["designs"]["sectors"],
                "grade": LEVELS + [NA], "claim-origin": ORIGINS, "claim-basis": BASES}
        for dim in sorted(pairs, key=lambda d: (not d.startswith(("design", "sector", "grade")), d)):
            ps = [p for p in pairs[dim] if p[0] is not None and p[1] is not None]
            c = cats.get(dim, ANSWERS)
            k = cohen(ps)
            a = ac1_pairs(ps, c)
            klo, khi = bootstrap(ps, cohen)
            alo, ahi = bootstrap(ps, lambda s: ac1_pairs(s, c))
            agree = sum(x == y for x, y in ps) / len(ps) if ps else 0
            labs = collections.Counter(v for p in ps for v in p)
            top = max(labs.values()) / sum(labs.values()) if labs else 0
            vs[dim] = {"n": len(ps), "agree": agree, "kappa": k, "kappa_ci": [klo, khi], "ac1": a, "ac1_ci": [alo, ahi],
                       "top_share": top}
            print(f"  {dim:34} {len(ps):4} {100 * agree:5.0f}% {fmt(k):>6} {('[' + fmt(klo) + ', ' + fmt(khi) + ']'):>14}"
                  f" {fmt(a):>6} {('[' + fmt(alo) + ', ' + fmt(ahi) + ']'):>14}"
                  f"{'  LOW' if ((a if top >= SKEWED else k) is not None and (a if top >= SKEWED else k) < 0.4) else ''}"
                  f"{'  (one label is ' + format(top, '.0%') + ' of all: judged by AC1)' if top >= SKEWED else ''}")
    else:
        print("\n(no blind coding ingested yet: spotcheck.py --blind-ingest)")

    # spreads
    print("\n## What the vote says\n")
    grades = collections.Counter(p.get("grade") for p in vote["papers"].values())
    print("  paper grades:      " + ", ".join(f"{g}: {n}" for g, n in grades.most_common()))
    designs = collections.Counter((p.get("design") or {}).get("design") for p in vote["papers"].values())
    print("  designs:           " + ", ".join(f"{g}: {n}" for g, n in designs.most_common()))
    o = collections.Counter(v.get("origin") for p in vote["papers"].values() for v in p["passages"].values())
    b = collections.Counter(v.get("basis") for p in vote["papers"].values() for v in p["passages"].values())
    print("  passage origin:    " + ", ".join(f"{g}: {n}" for g, n in o.most_common()))
    print("  passage basis:     " + ", ".join(f"{g}: {n}" for g, n in b.most_common()))
    conf = collections.Counter(s["confidence"]["label"] for v in vote["statements"].values() for s in v.values())
    print("  statements:        " + ", ".join(f"{g}: {n}" for g, n in conf.most_common()))
    qc = collections.Counter()
    for st in papers_raw.values():
        for pz in (st.get("criteria") or {}).values():
            for r in pz.get("runs", []):
                for a in r.get("answers", []):
                    if a.get("answer") in ("yes", "partly"):
                        qc[a.get("quote_check")] += 1
    if qc:
        tot = sum(qc.values())
        ok = sum(n for k, n in qc.items() if k in QUOTE_OK)
        print(f"  quotations behind yes/partly: {ok} of {tot} found in the paper ({100 * ok / tot:.0f}%); "
              + ", ".join(f"{k}: {n}" for k, n in qc.most_common()))
    C.save_json(state(corpus) / "report.json", {"run_to_run": run_rows, "vs_blind": vs,
                                                "grades": dict(grades), "statements": dict(conf)})
    return 0


# --- plan, table, status --------------------------------------------------------------------

def cmd_plan(args) -> int:
    corpus = Path(args.corpus).expanduser()
    if args.set != "all" and not args.syntheses.strip() and not args.codes.strip():
        # A bare `plan --set pilot` used to write an empty set over the pilot's, and the pilot's later steps
        # (statements, report) then found nothing to do.
        C.die(f"set '{args.set}' needs --syntheses or --codes (to see a set's progress: status)")
    data = load_corpus(corpus)
    srcs = data["sources"]
    if args.set == "all":
        papers = sorted(srcs, key=lambda s: srcs[s]["slug"])
        syns = []
    else:
        syns = [s.strip() for s in args.syntheses.split(",") if s.strip()]
        missing = [s for s in syns if s not in data["syntheses"]]
        if missing:
            C.die(f"no such synthesis: {', '.join(missing)}")
        papers = set()
        for s in syns:
            for c in data["syntheses"][s].get("claims", []):
                papers |= {data["exts"][e]["source_id"] for e in c.get("evidence_ids", []) if e in data["exts"]}
        books = {b["slug"]: b for b in (C.load_json(f) for f in corpus.glob("codebooks/cbk-*.json")) if b}
        want = [tuple(c.split(":", 1)) for c in args.codes.split(",") if c.strip()]
        for f in corpus.glob("codings/*/items.jsonl"):
            for line in f.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                c = json.loads(line)
                if (c.get("status") or "active") != "active" or c["target"]["kind"] != "extraction":
                    continue
                for slug, code in want:
                    if books.get(slug, {}).get("codebook_id") == c["codebook_ref"] and c.get("code") == code \
                            and c["target"]["id"] in data["exts"]:
                        papers.add(data["exts"][c["target"]["id"]]["source_id"])
        papers = sorted(papers, key=lambda s: srcs[s]["slug"])
    chars = sum(srcs[s].get("chars") or 0 for s in papers)
    npass = sum(len(srcs[s]["passages"]) for s in papers)
    claims = sum(len(data["syntheses"][s].get("claims", [])) for s in syns)
    out = {"set": args.set, "papers": papers, "syntheses": syns, "codes": args.codes or "",
           "design_papers": sorted(srcs, key=lambda s: srcs[s]["slug"]),
           "made": datetime.now().isoformat(timespec="seconds")}
    C.save_json(C.state_dir(corpus, "appraise") / "sets" / f"{args.set}.json", out)
    tok = chars / 3.6
    C.counts_header(f"Set '{args.set}'", [
        ("papers", len(papers)), ("passages", npass), ("statements", claims),
        ("paper text", f"{chars / 1e6:.1f} M characters, about {tok / 1e6:.2f} M tokens"),
        # Time goes with the text the model reads, not the number of papers (it was scaled to the corpus's own
        # length, which made every whole corpus 105 min).
        ("estimate, two servers, 3 runs", f"about {round(chars / 16.6e6 * 105)} min, or about {round(chars / 16.6e6 * 202)} with "
         "the checklist on think (measured: 1.75 h and 3.4 h for 16.6 M characters on two servers running a 27B model)"),
        ("written to", str(C.state_dir(corpus, "appraise") / "sets" / f"{args.set}.json")),
    ])
    return 0


def cmd_venues(args) -> int:
    """Where each paper was published, so its name can be kept from the model.
    A corpus whose sources don't record their venue gets it from a source list
    (read only): an .xlsx or .csv with a DOI column and a venue column."""
    corpus = Path(args.corpus).expanduser()
    data = load_corpus(corpus)
    rows = []
    src = Path(args.source).expanduser()
    if src.suffix == ".xlsx":
        import openpyxl  # noqa: PLC0415
        ws = openpyxl.load_workbook(src, read_only=True).worksheets[0]
        it = ws.iter_rows(values_only=True)
        head = [str(h or "") for h in next(it)]
        rows = [dict(zip(head, r)) for r in it]
    else:
        import csv  # noqa: PLC0415
        rows = list(csv.DictReader(open(src, encoding="utf-8-sig")))
    by_doi = {str(r.get(args.doi_col) or "").strip().lower(): str(r.get(args.venue_col) or "").strip()
              for r in rows if r.get(args.doi_col)}
    out = {}
    for sid, s in data["sources"].items():
        doi = str((s["bib"] or {}).get("doi") or "").strip().lower()
        if by_doi.get(doi):
            out[sid] = by_doi[doi]
    C.save_json(C.state_dir(corpus, "appraise") / "venues.json", out)
    print(f"Venues for {len(out)} of {len(data['sources'])} papers, from {src.name} (read only).")
    return 0


def cmd_table(args) -> int:
    corpus = Path(args.corpus).expanduser()
    R = rubric(corpus)
    data = load_corpus(corpus)
    rows = []
    for sid, s in sorted(data["sources"].items(), key=lambda kv: kv[1]["slug"]):
        st = C.load_json(paper_file(corpus, s["slug"]), {}) or {}
        runs = (st.get("design") or {}).get("runs", [])
        v = vote_design(runs) if runs else {}
        if v.get("design") == "mixed-methods" and (st.get("strands") or {}).get("runs"):
            v["strands"] = vote_strands(st["strands"]["runs"])
        d = R["by_code"].get(v.get("design") or "", {})
        strands = strands_of(R, v)
        rows.append((s["slug"], s["title"], v, d, strands, [r.get("design") for r in runs]))
    L = [f"# {short_name(corpus)}: the design and profile the model chose for each paper", "",
         f"Three runs each, `{MODEL}` at temperature {TEMPERATURE}, prompt `{PROMPT_VERSION}`. The design picks the "
         "profile the paper is rated under (rubric.md). **To skim:** the research recommends a person "
         "confirm each paper's profile. Rows where the runs disagreed are marked ⚠.", "",
         "| Paper | Title | Design | Profile(s) | Sector | Countries | Runs |", "|---|---|---|---|---|---|---|"]
    for slug, title, v, d, strands, runs in rows:
        prof = " + ".join(R["profiles"][p]["title"] for p, _, _ in strands) or "—"
        flag = "" if len(set(runs)) <= 1 else "⚠ "
        des = d.get("label", v.get("design") or "no majority")
        if strands and v.get("design") == "mixed-methods":
            des += ": " + " + ".join(R["by_code"][c]["label"] for _, c, _ in strands)
        elif v.get("second_design") not in (None, "none"):
            des += f" + {R['by_code'][v['second_design']]['label']}"
        L.append(f"| {slug} | {title[:80].replace('|', '/')} | {flag}{des} | {prof} | {v.get('sector') or ''} | "
                 f"{', '.join(v.get('countries') or [])} | {', '.join(r or '?' for r in runs)} |")
    designs = collections.Counter(v.get("design") for _, _, v, _, _, _ in rows)
    profs = collections.Counter(p for *_, strands, _ in rows for p, _, _ in strands)
    L += ["", "**Designs:** " + ", ".join(f"{k}: {n}" for k, n in designs.most_common()),
          "", "**Profiles:** " + ", ".join(f"{k}: {n}" for k, n in profs.most_common()),
          "", f"**Runs agreed on the design** for {sum(1 for *_, runs in rows if runs and len(set(runs)) == 1)} "
              f"of {sum(1 for *_, runs in rows if runs)} papers."]
    Path(args.out).write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"Wrote {args.out} ({len(rows)} papers).")
    return 0


def cmd_status(args) -> int:
    corpus = Path(args.corpus).expanduser()
    data = load_corpus(corpus)
    n = collections.Counter()
    for s in data["sources"].values():
        st = C.load_json(paper_file(corpus, s["slug"]), {}) or {}
        n["papers"] += 1
        n["design ×3"] += len(((st.get("design") or {}).get("runs")) or []) >= RUNS
        n["criteria ×3"] += bool(st.get("criteria")) and all(len(p.get("runs", [])) >= RUNS for p in st["criteria"].values())
        n["passages ×3"] += len(((st.get("passages") or {}).get("runs")) or []) >= RUNS or not s["passages"]
    st_files = list(state(corpus, "statements").glob("*.json"))
    checked = sum(1 for f in st_files for r in (C.load_json(f, {}) or {}).values() if len(r.get("runs", [])) >= RUNS)
    C.counts_header("Appraisal status", [*n.items(), ("statements checked ×3", checked),
                                         ("vote", "yes" if (state(corpus) / "vote.json").exists() else "not yet")])
    return 0


# --- store: into the corpus (UPC 1.15.0) -------------------------------------------------

CARD = "Evidence rating (advisory, model-made)"
GRADE_CODE = {"High": "high", "Moderate": "moderate", "Low": "low", "Very low": "very-low", NA: "not-appraisable"}
EV_EXT = {"upc-site": {"group": "evidence"}}
ANSWER_WORD = {"yes": "Yes", "partly": "Partly", "not found": "Not found", "can't tell": "Can't tell"}
ORIGIN_LABEL = {"own-finding": "Own finding", "reported": "Reported from cited work", "theoretical": "Theoretical",
                "interpretation": "Interpretation", "recommendation": "Recommendation", "background": "Background",
                "speculation": "Speculation"}
BASIS_LABEL = {"data": "Data", "case": "Case evidence", "cited-study": "A cited study", "argument": "Argument only",
               "none": "Nothing shown"}


def store_ids(ns: str) -> dict:
    """The ids `store` writes under. The coder's middle part names the model family (config
    "model_tag"), so codings by another model never share a coder id."""
    tag = C.CONFIG.get("model_tag") or "llm"
    return {"namespace": ns, "hidden": f"exs-{ns}-appraise-v1", "codings": f"cds-{ns}-appraise-v1",
            "coder": f"{ns}-{tag}-appraise-v1", "blind": f"cds-{ns}-appraise-blind", "place": f"cds-{ns}-place-v1",
            "place_coder": f"{ns}-place-rule-v1"}


# scheme → (run-to-run dimension, against-the-blind-coding dimension) in report.json
AGREEMENT_KEYS = {"evidence-grade": ("grade (each run alone)", "grade"), "study-design": ("design", "design"),
                  "claim-origin": ("claim-origin", "claim-origin"), "claim-basis": ("claim-basis", "claim-basis")}
SKEWED = 0.7      # one label this common among both raters' labels → judge agreement by AC1, not κ
LOW_NOTE = " Low agreement between runs or with a second rater: shown, but not offered as a filter."


def agreement_of(report: dict, slug: str) -> dict:
    """{"low": bool, …figures}: rubric.md 'How agreement is measured' — under 80% of items with
    all three runs agreeing, or κ under 0.4 against the blind coding (with at least 10 items)."""
    rk, bk = AGREEMENT_KEYS.get(slug, (None, None))
    rr = (report.get("run_to_run") or {}).get(rk) or {}
    vb = (report.get("vs_blind") or {}).get(bk) or {}
    low_runs = rr.get("all_agree") is not None and rr["all_agree"] < 0.8
    # κ collapses when one label covers most items (nearly every paper Moderate): there AC1 is the measure (2026-10-05).
    skewed = (vb.get("top_share") or 0) >= SKEWED
    measure = vb.get("ac1") if skewed else vb.get("kappa")
    low_blind = measure is not None and vb.get("n", 0) >= 10 and measure < 0.4
    return {"low": bool(low_runs or low_blind), "runs_all_agree": rr.get("all_agree"), "blind_kappa": vb.get("kappa"),
            "blind_ac1": vb.get("ac1"), "blind_measure": "AC1" if skewed else "kappa", "blind_n": vb.get("n")}


def evidence_codebooks(R: dict, report: dict | None = None) -> list[dict]:
    """The five schemes `store` codes against, as make_codebooks.py definitions (group "evidence").
    A scheme with low agreement keeps its chips but leaves the filters (`facet: false`)."""
    base = {"ext": EV_EXT, "tool": "appraise.py", "method": "manual"}
    cap = lambda s: s[0].upper() + s[1:] + "."  # noqa: E731
    books = [
        {**base, "slug": "evidence-grade", "title": "Evidence grade", "unit": "source",
         "question": "How well does the paper's own evidence support its own conclusions? Advisory, made by a model "
                     "from a checklist for the paper's kind of research.",
         "codes": [
             {"code": "high", "label": "High", "definition": "Starts at High (an experiment, measured performance or a "
              "systematic review) and loses nothing under the rules: every critical question is met."},
             {"code": "moderate", "label": "Moderate", "definition": "A design that starts at Moderate and loses nothing, "
              "or a High start taken down one level by an unclear critical dimension or two unmet questions."},
             {"code": "low", "label": "Low", "definition": "A critical dimension is unmet (no yes or partly, at least one "
              "not found), or a higher start taken down; commentaries start here."},
             {"code": "very-low", "label": "Very low", "definition": "Two critical dimensions unmet, or a Low taken down "
              "further by an unclear critical dimension or unmet questions."},
             {"code": "not-appraisable", "label": "Not appraisable", "definition": "More than half the checklist's "
              "questions can't be told from the text, or the runs agreed on no design."}]},
        {**base, "slug": "study-design", "title": "Study design", "unit": "source",
         "question": "What kind of study is the paper? This picks the checklist its grade comes from.",
         "codes": [{"code": d["code"], "label": d["label"], "definition": d["definition"]}
                   for d in R["designs"]["designs"]]},
        {**base, "slug": "claim-origin", "title": "Whose claim", "unit": "passage",
         "question": "Is the passage the paper's own finding, or something it reports, theorises, interprets or "
                     "recommends? A reported claim doesn't take its paper's grade.",
         "codes": [{"code": k, "label": ORIGIN_LABEL[k], "definition": cap(ORIGIN_DEF[k])} for k in ORIGINS]},
        {**base, "slug": "claim-basis", "title": "What backs it", "unit": "passage",
         "question": "What does the passage itself rest on: data, cases, a cited study, argument, or nothing shown?",
         "codes": [{"code": k, "label": BASIS_LABEL[k], "definition": cap(BASIS_DEF[k])} for k in BASES]},
        {**base, "slug": "place", "title": "Where it was studied", "unit": "source", "multi_label": True,
         "question": "Where does the paper's own evidence come from? A rule over the countries the design vote "
                     "agreed on (two of three runs), so a paper can be in two places, or in none.",
         "codes": [{"code": k, "label": lab, "definition": d} for k, lab, d in PLACES]},
    ]
    if R.get("places"):         # the corpus's own codebook says where; a `place` scheme here would replace it
        books = [b for b in books if b["slug"] != "place"]
    out = []
    for b in books:
        ag = agreement_of(report or {}, b["slug"])
        site = {"group": "evidence", **({"facet": False} if ag["low"] else {})}
        out.append({**b, "ext": {"upc-site": site, "upc-corpus": {"agreement": ag}},
                    "question": b["question"] + (LOW_NOTE if ag["low"] else "")})
    return out


def prose(s: str) -> str:
    """A model's reason as prose: its double quotes become single, so the quotation
    gate never mistakes a remark for an unmarked quotation."""
    return (s or "").replace('"', "'").replace("“", "‘").replace("”", "’").replace("\n", " ").strip()


def sentence_around(text: str, a: int, b: int) -> tuple[int, int]:
    s = max(text.rfind(". ", 0, a), text.rfind("\n", 0, a))
    s = 0 if s < 0 else s + (2 if text[s] == "." else 1)
    m = re.search(r"[.!?](?=\s|$)|\n", text[b:])
    return s, (b + m.end() if m else len(text))


def widened(text: str, q: str) -> str | None:
    """A quotation the paper repeats, widened to the first of its sentences that occurs once.
    The words are still the paper's own; only the span grows, so the locator is unique."""
    i = text.find(q)
    while i >= 0:
        s, e = sentence_around(text, i, i + len(q))
        cand = text[s:e].strip()
        if cand and q in cand and text.count(cand) == 1 and len(cand) <= 700:
            return cand
        i = text.find(q, i + 1)
    return None


def anchor_quotes(into: Path, rep: str, quotes: list[str], set_id: str, raw: str) -> dict[str, dict]:
    """quote → {id, quote (as stored), how} for every quotation `upc anchor` confirms."""
    got: dict[str, dict] = {}
    quotes = [q for q in dict.fromkeys(quotes) if q]
    if not quotes:
        return got
    args = ["anchor", "--corpus", str(into), "--rep", rep, "--set", set_id, "--hidden", "--normalize",
            "--type", "evidence", "--tool", "appraise.py", "--prompt-version", PROMPT_VERSION]
    res = C.upc_jsonl(*args, records=[{"quote": q} for q in quotes])
    again = {}
    for r in (res or {}).get("results", []):
        q = quotes[r["i"]]
        if r.get("status") in ("anchored", "refound", "exists"):
            got[q] = {"id": r["extraction_id"], "quote": r.get("stored_quote") or q,
                      "how": "normalized" if r.get("stored_quote") else "exact"}
        elif r.get("status") == "ambiguous":
            w = widened(raw, q)
            if w:
                again[w] = q
    if again:
        ws = list(again)
        res = C.upc_jsonl(*args, records=[{"quote": w} for w in ws])
        for r in (res or {}).get("results", []):
            if r.get("status") in ("anchored", "exists"):
                got[again[ws[r["i"]]]] = {"id": r["extraction_id"], "quote": ws[r["i"]], "how": "widened to its sentence"}
    return got


def marker(a: dict) -> str:
    """'"quote" [ext-…]', or a note when the quotation can't sit in a marker (a line break or a double quote).
    An elided quotation is its pieces, each with its own marker, joined by an ellipsis."""
    if a.get("parts"):
        return " … ".join(marker(x) for x in a["parts"])
    q = a["quote"]
    if '"' in q or "\n" in q:
        return "(Its quotation is confirmed in the paper and kept with this rating.)"
    return f'"{q}" [{a["id"]}]'


def rating_markdown(R: dict, src: dict, rec: dict) -> str:
    d = rec["design"]
    lab = R["by_code"].get(d.get("design") or "", {}).get("label", "no agreed design")
    second = d.get("second_design")
    lines = [f"**{rec['grade']}.** {prose('; '.join(rec['grade_why']))}.", ""]
    design_line = f"Design: {lab}"
    if d.get("design") == "mixed-methods" and rec.get("strands"):
        design_line += ": " + " and ".join(R["by_code"][s["design"]]["label"] for s in rec["strands"])
    elif second and second != "none" and second in R["by_code"]:
        design_line += f", with a second strand: {R['by_code'][second]['label']}"
    design_line += "." + ("" if d.get("runs_agree") else " (The three runs didn't all name this design.)")
    words = (R.get("domain") or {}).get("words") or {}
    lines.append(design_line + (" " + words[rec["setting"]] if rec.get("setting") in words else ""))
    for prof, qs in rec["answers"].items():
        P_ = R["profiles"][prof]
        crit = set(P_["critical"])
        lines += ["", f"**{P_['title']}**: the checklist, as most of three runs answered it "
                      f"(★ marks the dimensions that decide the grade)", ""]
        for q in P_["questions"]:
            a = qs.get(q["id"]) or {"answer": "can't tell"}
            star = "★" if q["dim"] in crit else ""
            line = f"- {star}{q['dim']} {prose(q['text'])} **{ANSWER_WORD.get(a['answer'], a['answer'])}.**"
            if a.get("reason"):
                line += f" {prose(a['reason'])}"
            if a.get("anchored"):
                line += f" {marker(a['anchored'])}"
            if a.get("voided"):
                line += " (A run said yes or partly, but its quotation couldn't be confirmed in the paper.)"
            lines.append(line)
    lines += ["", f"Rated by a local model ({MODEL_DESC}, temperature {TEMPERATURE}), three runs and a majority vote, from the "
                  "paper's text without its venue, citation counts or reference list. A yes or partly counts only with a "
                  f"quotation found in the paper. Advisory: not a peer review. Prompt {PROMPT_VERSION}."]
    return "\n".join(lines) + "\n"


def confirm_paper(R: dict, into: Path, src: dict, pv: dict, set_id: str) -> dict:
    """The voted rating with every yes/partly quotation confirmed by `upc anchor`, and the grade
    recomputed: an answer whose quotation isn't confirmed becomes can't tell."""
    raw = Path(src["text_path"]).read_text(encoding="utf-8")
    need = [f for qs in pv["answers"].values() for a in qs.values()
            if a["answer"] in ("yes", "partly") and a.get("quote") for f in fragments(a["quote"])]
    got = anchor_quotes(into, src["text_rep"], need, set_id, raw)
    for qs in pv["answers"].values():
        for a in qs.values():
            frs = fragments(a.get("quote", ""))
            if len(frs) > 1 and a.get("quote") not in got and all(f in got for f in frs):
                got[a["quote"]] = {"id": got[frs[0]]["id"], "ids": [got[f]["id"] for f in frs],
                                   "quote": " … ".join(got[f]["quote"] for f in frs), "how": "elided",
                                   "parts": [got[f] for f in frs]}
            elif len(frs) == 1 and frs[0] != a.get("quote") and frs[0] in got:
                got[a["quote"]] = got[frs[0]]
    answers, by_prof = {}, {}
    for prof, qs in pv["answers"].items():
        for qid, a in qs.items():
            a = dict(a)
            if a["answer"] in ("yes", "partly"):
                if a.get("quote") in got:
                    a["anchored"] = got[a["quote"]]
                else:
                    a["answer"], a["voided"] = "can't tell", True
            answers.setdefault(prof, {})[qid] = a
            by_prof.setdefault(prof, {})[qid] = a["answer"]
    strands = [(s["profile"], s["design"], s["start"]) for s in pv["strands"]]
    grade, why = grade_paper(R, strands, by_prof) if strands else (NA, ["the runs agreed on no design"])
    return {**pv, "answers": answers, "grade": grade, "grade_why": why, "grade_before_anchor": pv["grade"]}


def cmd_store(args) -> int:
    corpus = Path(args.corpus).expanduser()
    into = Path(args.into).expanduser() if args.into else corpus
    R = rubric(corpus)
    vote = C.load_json(state(corpus) / "vote.json")
    if not vote:
        C.die("no vote.json: run `appraise.py vote` first")
    ids = store_ids(C.namespace_of(into, args.namespace))
    data = load_corpus(into)
    papers = {sid: pv for sid, pv in vote["papers"].items() if pv.get("grade") and sid in data["sources"]}
    stmts = {s: v for s, v in vote["statements"].items() if s in data["syntheses"]}
    blind = C.blind_coding(corpus) if args.blind else None
    C.counts_header("Store", [("from", str(corpus)), ("into", str(into)), ("papers rated", len(papers)),
                              ("overviews with checked statements", len(stmts)),
                              ("blind coding", f"{len(blind['papers'])} papers, {len(blind['passages'])} passages" if blind else "no"),
                              ("hidden quotation set", ids["hidden"]), ("coding set", ids["codings"]),
                              ("coder", f"{ids['coder']} (ensemble)")])
    if not args.write:
        print("Planning only; nothing was written. Add --write.")
        return 0
    C.check_compat()

    # 1. the schemes
    sys.path.insert(0, str(Path(__file__).parent))
    import make_codebooks as MC  # noqa: E402
    rows = []
    report = C.load_json(state(corpus) / "report.json") or {}
    if not report:
        print("  NOTE no report.json: run `appraise.py report` first, or every scheme is offered as a filter")
    for b in evidence_codebooks(R, report):
        obj, dest, status, _ = MC.build_codebook(into, b, ids["namespace"])
        prior = C.load_json(dest) or {}
        made_by = ((prior.get("provenance") or {}).get("produced_by") or {}).get("tool")
        if prior and made_by != "appraise.py":
            C.die(f"{dest.name} ({ids['namespace']}/{b['slug']}) is the corpus's own codebook, made by {made_by or 'another tool'}; "
                  f"storing would replace it. If it says where papers were studied, name it in the settings "
                  f'("places_codebook": "{b["slug"]}"); otherwise use another --namespace')
        rows.append((obj, dest, status))
    MC.write_codebooks(into, rows)
    cbk = {o["slug"]: o["codebook_id"] for o, _, _ in rows}

    # 2. per paper: confirm the quotations, write the rating card
    out_dir = state(corpus, "store")
    confirmed, codings, place_rows, voided = {}, [], [], 0
    for n, (sid, pv) in enumerate(sorted(papers.items(), key=lambda x: data["sources"][x[0]]["slug"]), 1):
        src = data["sources"][sid]
        rec = confirm_paper(R, into, src, pv, ids["hidden"])
        confirmed[sid] = rec
        voided += sum(1 for qs in rec["answers"].values() for a in qs.values() if a.get("voided"))
        md = out_dir / f"{src['slug']}.md"
        md.write_text(rating_markdown(R, src, rec), encoding="utf-8")
        appraisal = {"prompt_version": PROMPT_VERSION, "layout": pv.get("layout") or "paper-in-user",
                     "rubric": R["designs"].get("version"), "model": MODEL, "temperature": TEMPERATURE, "runs": RUNS,
                     "grade": rec["grade"], "grade_why": rec["grade_why"], "grade_before_anchor": rec["grade_before_anchor"],
                     "design": rec["design"], "strands": rec["strands"], "setting": rec.get("setting"),
                     "answers": {p: {q: {k: v for k, v in a.items() if k in ("answer", "runs", "dim", "reason", "voided")}
                                     | ({"extraction_id": a["anchored"]["id"]} if a.get("anchored") else {})
                                     | ({"extraction_ids": a["anchored"]["ids"]} if (a.get("anchored") or {}).get("ids") else {})
                                     for q, a in qs.items()} for p, qs in rec["answers"].items()}}
        gen = {"type": "rating", "title": f"Evidence rating: {author_year(src)}", "source_id": sid,
               "ext": {"upc-site": {"card": CARD, "order": 1}, "upc-corpus": {"appraisal": appraisal}},
               "provenance": {"produced_by": {"tool": "appraise.py", "model": MODEL, "method": "model",
                                              "prompt_version": PROMPT_VERSION}}}
        r = C.upc("add", "generation", "--corpus", str(into), "--output", str(md), "--tool", "appraise.py", "--replace",
                  stdin=json.dumps(gen), check=False)
        if not isinstance(r, dict) or r.get("status") not in ("ok", "exists", "replaced"):
            print(f"  REFUSED {src['slug']}: {json.dumps(r)[:300]}")
        dv = rec["design"]
        for k in ([] if R["places"] else places_of(dv.get("countries") or [])):
            place_rows.append({"codebook_ref": cbk["place"], "code": k, "target": {"kind": "source", "id": sid},
                               "coder": ids["place_coder"],
                               "rationale": prose("Countries agreed by the design vote: " + (", ".join(dv.get("countries") or []) or "none"))})
        codings.append({"codebook_ref": cbk["evidence-grade"], "code": GRADE_CODE[rec["grade"]],
                        "target": {"kind": "source", "id": sid}, "coder": ids["coder"],
                        "rationale": prose("; ".join(rec["grade_why"]))})
        if dv.get("design"):
            codings.append({"codebook_ref": cbk["study-design"], "code": dv["design"],
                            "target": {"kind": "source", "id": sid}, "coder": ids["coder"],
                            "confidence": "high" if dv.get("runs_agree") else "medium",
                            "rationale": prose(dv.get("reason", ""))})
        for e, v in (pv.get("passages") or {}).items():
            for key, slug, runs in (("origin", "claim-origin", v.get("origin_runs")), ("basis", "claim-basis", v.get("basis_runs"))):
                if v.get(key):
                    agree = sum(1 for x in runs or [] if x == v[key])
                    codings.append({"codebook_ref": cbk[slug], "code": v[key], "target": {"kind": "extraction", "id": e},
                                    "coder": ids["coder"], "confidence": "high" if agree == len(runs or []) else "medium",
                                    **({"rationale": prose(v.get("reason", ""))} if key == "origin" and v.get("reason") else {})})
        if n % 20 == 0:
            print(f"  {n} papers stored", flush=True)
    C.save_json(out_dir / "confirmed.json", confirmed)

    # 3. the codings, one ensemble coder; its manifest says how the vote was taken
    r = C.upc_jsonl("code", "--corpus", str(into), "--set", ids["codings"], "--coder-kind", "ensemble", "--tool", "appraise.py",
                    "--model", MODEL, "--prompt-version", PROMPT_VERSION, records=codings)
    tally = (r or {}).get("tally", {})
    man_f = into / "codings" / ids["codings"] / "manifest.json"
    man = C.load_json(man_f, {}) or {}
    for c in man.get("coders", []):
        if c.get("coder") == ids["coder"]:
            c["ensemble"] = {"runs": RUNS, "rule": "majority of three; a three-way split is no code", "model": MODEL_DESC,
                             "temperature": TEMPERATURE, "machines": list(P.ENDPOINTS)}
    man.setdefault("ext", {})["upc-corpus"] = {"appraisal": PROMPT_VERSION, "rubric": "references/appraisal/rubric.md"}
    C.save_json(man_f, man)

    # 3b. where each paper was studied: a rule over the voted countries, its own coder (kind rule); a corpus
    # with its own places codebook keeps those (own_places)
    ptally = {}
    if place_rows:
        r = C.upc_jsonl("code", "--corpus", str(into), "--set", ids["place"], "--coder-kind", "rule", "--tool", "appraise.py",
                        "--method", "manual", records=place_rows)
        ptally = (r or {}).get("tally", {})

    # 4. the blind second coding, as its own coder
    btally = {}
    if blind:
        brows = []
        for sid, b in blind["papers"].items():
            if b.get("grade") in GRADE_CODE:
                brows.append({"codebook_ref": cbk["evidence-grade"], "code": GRADE_CODE[b["grade"]],
                              "target": {"kind": "source", "id": sid}, "coder": blind["coder"],
                              "rationale": prose("; ".join(b.get("grade_why") or []))})
            if b.get("design") in R["by_code"]:
                brows.append({"codebook_ref": cbk["study-design"], "code": b["design"],
                              "target": {"kind": "source", "id": sid}, "coder": blind["coder"]})
        for e, b in blind["passages"].items():
            for key, slug in (("origin", "claim-origin"), ("basis", "claim-basis")):
                if b.get(key):
                    brows.append({"codebook_ref": cbk[slug], "code": b[key], "target": {"kind": "extraction", "id": e},
                                  "coder": blind["coder"], **({"rationale": prose(b["reason"])} if key == "origin" and b.get("reason") else {})})
        who = ["--coder-kind", "model", "--model", blind["model"]] if blind["kind"] == "model" else ["--coder-kind", "human"]
        r = C.upc_jsonl("code", "--corpus", str(into), "--set", ids["blind"], *who, "--tool", "spotcheck.py", records=brows)
        btally = (r or {}).get("tally", {})

    # 5. statement support, one matrix per overview. Storing again (the overnight run stores twice) skips a
    # matrix whose claims are unchanged, and supersedes one whose vote changed, so no overview gets two.
    syn_ok = syn_same = 0
    current = {}
    for mid, m in data["syntheses"].items():
        for target in ((m.get("provenance") or {}).get("derived_from") or {}).get("synthesis_ids", []) \
                if m.get("type") == "evidence_matrix" and not m.get("superseded_by") else []:
            cur = current.get(target)
            if not cur or str((m.get("provenance") or {}).get("created_at", "")) > \
                    str((cur[1].get("provenance") or {}).get("created_at", "")):
                current[target] = (mid, m)
    for syn_id, recs in sorted(stmts.items()):
        syn = data["syntheses"][syn_id]
        order = [c["claim_id"] for c in syn.get("claims", [])]
        claims, md = [], [f"# Support for each statement: {prose(syn.get('title') or syn_id)}", "",
                          "Each statement of the overview, checked against the passages it cites. Advisory, made by a "
                          f"local model: three runs and a majority vote (prompt {PROMPT_VERSION}).", ""]
        srcs_all = []
        for cid in sorted(recs, key=lambda c: order.index(c) if c in order else 9999):
            rec = recs[cid]
            conf = rec["confidence"]
            ev = [row["extraction_id"] for row in rec["rows"]]
            sids = list(dict.fromkeys(row["source_id"] for row in rec["rows"] if row.get("source_id")))
            srcs_all += sids
            label = conf.get("label", "")
            ipcc = f"{label} confidence" if label in ("very low", "low", "medium", "high", "very high") else label
            pl = rec.get("plain") or plain_of(rec["rows"], conf, vote["papers"], R["places"])
            claims.append({"claim_id": cid, "text": rec["text"], "evidence_ids": ev, "source_ids": sids,
                           "ext": {"upc-corpus": {"ipcc": ipcc, "evidence": conf.get("evidence"),
                                                  "agreement": conf.get("agreement"), "independent": conf.get("independent"),
                                                  **pl,
                                                  "passages": [{"extraction_id": row["extraction_id"], "verdict": row.get("verdict"),
                                                                "gap": row.get("gap")} for row in rec["rows"]]}}})
            flags = ("; every supporting paper has one lead author" if pl["same_lead"] else "") + \
                    ("; only relayed from other work" if pl["relayed_only"] else "")
            md += [f"## {cid}", "", prose(rec["text"]), "",
                   f"**{pl['support_label']}** ({ipcc}" + (f": {conf['evidence']} evidence, {conf['agreement']} agreement" if conf.get("evidence") else "") +
                   f"). {plural(pl['studies'], 'lead author', 'lead authors')}, {plural(pl['papers'], 'paper', 'papers')}"
                   + (f"; {', '.join(pl['countries'])}" if pl["countries"] else "") + f"{flags}.", ""]
            for row in rec["rows"]:
                who = author_year(data["sources"].get(row.get("source_id"), {}))
                gap = f" ({row['gap']})" if row.get("gap") and row["gap"] != "none" else ""
                md.append(f"- {who}: {row.get('verdict') or 'no majority'}{gap} [{row['extraction_id']}]")
            md.append("")
        md += ["## Sources", ""] + [f"- `{s}`" for s in dict.fromkeys(srcs_all)]
        prior = current.get(syn_id)
        if prior and json.dumps(prior[1].get("claims"), sort_keys=True) == json.dumps(claims, sort_keys=True):
            syn_same += 1
            continue
        f = out_dir / "support" / f"{syn_id}.md"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("\n".join(md) + "\n", encoding="utf-8")
        obj = {"type": "evidence_matrix", "title": f"Support for each statement: {syn.get('title') or syn_id}",
               "question": f"Does each statement of {syn_id} rest on the passages it cites?", "claims": claims,
               "ext": {"upc-corpus": {"support_for": syn_id, "prompt_version": PROMPT_VERSION}},
               "provenance": {"produced_by": {"tool": "appraise.py", "model": MODEL, "method": "model",
                                              "prompt_version": PROMPT_VERSION},
                              "derived_from": {"synthesis_ids": [syn_id]}}}
        r = C.upc("add", "synthesis", "--corpus", str(into), "--output", str(f), "--tool", "appraise.py",
                  *(["--supersedes", prior[0]] if prior else []), stdin=json.dumps(obj), check=False)
        if isinstance(r, dict) and r.get("status") == "ok":
            syn_ok += 1
        else:
            print(f"  REFUSED support for {syn_id}: {json.dumps(r)[:400]}")

    C.upc("regen", str(into))
    rep = C.upc("validate", str(into))
    grades = collections.Counter(r["grade"] for r in confirmed.values())
    moved = sum(1 for r in confirmed.values() if r["grade"] != r["grade_before_anchor"])
    C.counts_header("Stored", [
        ("papers", len(confirmed)), ("grades", dict(grades)),
        ("answers voided (quotation not confirmed)", voided), ("grades changed by that", moved),
        ("codings", dict(tally)), ("place codings (rule)", dict(ptally)), ("blind codings", dict(btally)),
        ("support matrices", f"{syn_ok} written, {syn_same} unchanged, of {len(stmts)}"),
        ("corpus", f"{rep.get('status')} at {rep.get('level')}, {len(rep.get('errors', []))} errors"),
    ], notes=[f"ERROR {e.get('code')}: {str(e.get('detail'))[:120]}" for e in rep.get("errors", [])[:8]])
    return 0 if not rep.get("errors") else 1


# --- overnight: the full run, start to finish, resumable -------------------------------------

def notify(text: str, enabled: bool = True) -> None:
    """One line through the config's "notify" command (a list of arguments; "{text}" is
    replaced by the line), e.g. a chat CLI posting to the channel someone watches. Never raises."""
    cmd = C.CONFIG.get("notify")
    if not enabled or not cmd:
        return
    try:
        import subprocess
        subprocess.run([str(a).replace("{text}", text) for a in cmd], capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"  (couldn't send the notice: {exc})", flush=True)


def short_name(corpus: Path) -> str:
    """What notices and tables call the corpus: settings "short_name", else its title."""
    st = C.corpus_settings(corpus)
    if st.get("short_name"):
        return st["short_name"]
    meta = C.load_json(Path(corpus) / "corpus.json", {}) or {}
    return meta.get("title") or Path(corpus).name


def overnight_steps(corpus: Path, stop: str) -> list[tuple[str, list[str]]]:
    here, co = Path(__file__).parent, str(corpus)
    me, syn, cit, pag = (str(here / f) for f in ("appraise.py", "synthesize.py", "citations.py", "paginate.py"))
    st = ["--stop-at", stop] if stop else []
    return [
        ("ratings for every paper ×3", [me, "run", "--corpus", co, "--set", "all", *st]),
        ("statements of the overviews as hosted ×3", [me, "statements", "--corpus", co, "--set", "all", *st]),
        ("quotations checked again", [me, "recheck", "--corpus", co]),
        ("vote", [me, "vote", "--corpus", co]),
        ("agreement report (decides which schemes are filters)", [me, "report", "--corpus", co]),
        ("store ratings and support", [me, "store", "--corpus", co, "--blind", "--write"]),
        ("page numbers for the rating quotations", [pag, "--corpus", co]),
        ("citation tiers", [cit, "code", "--corpus", co, "--write"]),
        ("overviews from rated evidence", [syn, "--corpus", co, "--v2", "--codes", "all", *st]),
        ("statements of the revised overviews ×3", [me, "statements", "--corpus", co, "--set", "revised", *st]),
        ("vote again", [me, "vote", "--corpus", co]),
        ("agreement report again", [me, "report", "--corpus", co]),
        ("store support for the revisions", [me, "store", "--corpus", co, "--blind", "--write"]),
    ]


def cmd_overnight(args) -> int:
    """Every step of the full run in order, each resumable, so running it again continues."""
    import subprocess
    corpus = Path(args.corpus).expanduser()
    steps = overnight_steps(corpus, args.stop_at)
    log = C.state_dir(corpus, "appraise") / f"overnight-{datetime.now():%Y%m%d-%H%M}.log"
    C.counts_header("Overnight run", [("corpus", str(corpus)), ("starts", args.not_before or "now"),
                                      ("stops at", args.stop_at or "when done"), ("log", str(log)),
                                      ("notify", "yes" if (C.CONFIG.get("notify") and not args.no_notify) else "no")],
                    notes=[f"{i}. {name}" for i, (name, _) in enumerate(steps, 1)])
    if args.dry_run:
        return 0
    if args.not_before:
        start = parse_clock(args.not_before)
        if start and (start - datetime.now()).total_seconds() < 20 * 3600:
            print(f"Waiting until {start:%Y-%m-%d %H:%M}.", flush=True)
            time.sleep(max(0, (start - datetime.now()).total_seconds()))
    stop = parse_clock(args.stop_at) if args.stop_at else None
    t0 = time.time()
    with open(log, "a", encoding="utf-8") as fh:
        for i, (name, argv) in enumerate(steps, 1):
            if stop and datetime.now() >= stop:
                msg = (f"{short_name(corpus)} ratings: stopped at {stop:%H:%M} before step {i} ({name}). "
                       f"Run the same command tomorrow night to continue. Log: {log}")
                print(msg, flush=True)
                notify(msg, not args.no_notify)
                return 0
            fh.write(f"\n===== {datetime.now():%H:%M:%S} step {i}: {name}\n")
            fh.flush()
            print(f"[{datetime.now():%H:%M}] step {i}: {name}", flush=True)
            r = subprocess.run([sys.executable, "-u", *argv], stdout=fh, stderr=subprocess.STDOUT)
            if r.returncode == PAUSED:
                msg = (f"{short_name(corpus)} ratings: paused in step {i} ({name}) at the stop time, work left. Run the same "
                       f"command the next night to continue. Log: {log}")
                print(msg, flush=True)
                notify(msg, not args.no_notify)
                return 0
            if r.returncode != 0:
                msg = f"{short_name(corpus)} ratings: step {i} ({name}) failed (exit {r.returncode}). Log: {log}"
                print(msg, flush=True)
                notify(msg, not args.no_notify)
                return 1
    status = subprocess.run([sys.executable, str(Path(__file__)), "status", "--corpus", str(corpus)],
                            capture_output=True, text=True).stdout
    msg = (f"{short_name(corpus)} ratings finished in {round((time.time() - t0) / 60)} min: ratings, statement "
           f"checks, revised overviews and support stored; ready to build. Log: {log}")
    print(status + "\n" + msg, flush=True)
    notify(msg, not args.no_notify)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "run", "statements", "vote", "report", "table", "status", "venues", "store", "overnight",
                 "recheck"):
        s = sub.add_parser(name)
        s.add_argument("--corpus", required=True)
        if name == "plan":
            s.add_argument("--set", required=True)
            s.add_argument("--syntheses", default="")
            s.add_argument("--codes", default="")
        if name in ("run", "statements"):
            s.add_argument("--set", required=True)
            s.add_argument("--runs", type=int, default=RUNS)
            s.add_argument("--not-before", default="")
            s.add_argument("--stop-at", default="")
        if name == "run":
            s.add_argument("--only", default="", choices=["", "design"])
        if name == "table":
            s.add_argument("--out", required=True)
        if name == "venues":
            s.add_argument("--source", required=True, help="an .xlsx or .csv source list")
            s.add_argument("--doi-col", default="DOI")
            s.add_argument("--venue-col", default="Journal / Source")
        if name == "overnight":
            s.add_argument("--not-before", default=WINDOW[0], help=f"default {WINDOW[0]} (config overnight_window)")
            s.add_argument("--stop-at", default=WINDOW[1], help=f"default {WINDOW[1]} (config overnight_window)")
            s.add_argument("--no-notify", action="store_true", help="don't send the config's notice")
            s.add_argument("--dry-run", action="store_true")
        if name == "store":
            s.add_argument("--into", default="", help="the corpus to write into (default: --corpus); "
                                                       "an APFS clone for a pilot, so nothing reaches the real one")
            s.add_argument("--namespace", default="", help="default: the corpus's own (common.namespace_of)")
            s.add_argument("--blind", action="store_true", help="also store the blind second coding as its own coder")
            s.add_argument("--write", action="store_true")
    args = ap.parse_args()
    return {"plan": cmd_plan, "run": cmd_run, "statements": cmd_statements, "vote": cmd_vote,
            "report": cmd_report, "table": cmd_table, "status": cmd_status, "venues": cmd_venues,
            "store": cmd_store, "overnight": cmd_overnight,
            "recheck": cmd_recheck}[args.cmd](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
