#!/usr/bin/env python3
"""Write an overview per code, from the passages that carry it.

    python3 synthesize.py --corpus <dir> --codebook theory [--limit-codes 3]
    python3 synthesize.py --corpus <dir> --matrix theory:analytical-dimension
    python3 synthesize.py --corpus <dir> --v2 --codes domain:heat-pump-adoption,… [--plan]
        (revise the current overviews from the rated evidence: references/criteria-v2.md)

The model is given the coded passages **exactly as `upc quote` prints them**,
markers and all, and told that a quotation may only be one of those lines copied
whole. Then `upc add synthesis` re-checks every quotation in what came back
against the corpus and refuses to write prose that misquotes its sources. So an
overview either quotes correctly or does not exist.

A paraphrase is fine and expected — it just carries a bare `[ext-…]` and is never
dressed up in quotation marks.
"""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402

MARKER = re.compile(r"\[(ext-[0-9a-f]{12})\]")
# A thinking model sometimes writes its planning into the answer itself, with no
# think tags for the server to strip: "The user wants a 350-700 word overview…",
# "Let me organize the passages…", then the overview. Such prose is refused, never
# stored (FORGE 2.2, 10-28: 4 of 38; none of FORGE 2.1's 51 overviews matches).
NOTES_START = re.compile(r"\s*(the user\b|i need to\b|i must\b|i should\b|i'll\b|i will\b|let me\b|okay\b|ok,|"
                         r"alright\b|we need to\b|first, i\b)", re.I)
NOTES_LINE = re.compile(r"^\s*(?:now )?let me (?:draft|write|organi[sz]e|structure|plan|check|re-?read|count|verify|"
                        r"go through|look)\b", re.I | re.M)
# ...or talks about its own input, which means nothing to a reader: "The passages before me
# describe…", "…is not reconciled in the passages provided" (2 of FORGE 2.2's 65; none of 2.1's),
# "…in the passages available here", "Across the sampled passages" (2 more).
NOTES_META = re.compile(r"\b(?:the|these) passages (?:before me|provided|given|supplied|i (?:was|have been) given|"
                        r"shown to me|you (?:gave|provided)|available (?:here|to me))\b|\bsampled passages\b|"
                        r"\bas an ai\b|\bword count\b|\b(?:my|this) draft\b", re.I)


def not_an_overview(got: dict) -> str:
    """Why this output must not be stored as an overview, or ''."""
    if not got["cited"] and not any(c.get("evidence_ids") for c in got["claims"]):
        return "it cites no passage"
    if NOTES_START.match(got["prose"]) or NOTES_LINE.search(got["prose"]):
        return "it is the model's working notes, not an overview"
    if NOTES_META.search(got["prose"]):
        return "it talks about the passages it was given, not to a reader"
    return ""


def remove_overview(corpus: Path, sid: str, why: str) -> None:
    """Take a stored overview out of the corpus and journal it, as place_summary.mjs --replace does."""
    import shutil
    shutil.rmtree(corpus / "syntheses" / sid, ignore_errors=True)
    C.upc("event", "--corpus", str(corpus), check=False, stdin=json.dumps({
        "activity_type": "remove", "tool": "upc-corpus", "status": "success",
        "inputs": {"synthesis_ids": [sid]}, "notes": why}))


def current_overviews(corpus: Path) -> dict[tuple[str, str], str]:
    """(codebook slug, title) -> the id of the stored overview no other one supersedes."""
    objs = [C.load_json(f) for f in sorted(corpus.glob("syntheses/*/synthesis.json"))]
    objs = [o for o in objs if o]
    replaced = {o.get("supersedes") for o in objs}
    out = {}
    for o in sorted(objs, key=lambda o: str((o.get("provenance") or {}).get("created_at", ""))):
        if o["synthesis_id"] in replaced:
            continue
        slug = ((o.get("ext") or {}).get("upc-corpus") or {}).get("codebook", "")
        out[(slug, o.get("title", ""))] = o["synthesis_id"]
    return out


def load_books(corpus: Path) -> dict[str, dict]:
    return {b["slug"]: b for b in
            (C.load_json(f) for f in sorted((corpus / "codebooks").glob("cbk-*.json"))) if b}


def load_coded(corpus: Path) -> tuple[dict, dict]:
    """(extraction_id -> extraction, (cbk_id, code) -> [extraction_id])."""
    exts = {}
    for f in list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                o = json.loads(line)
                if o.get("direct_quote"):
                    exts[o["extraction_id"]] = o
    by_code: dict[tuple, list] = {}
    for f in corpus.glob("codings/*/items.jsonl"):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            c = json.loads(line)
            if (c.get("status") or "active") != "active":
                continue
            t = c.get("target", {})
            if t.get("kind") != "extraction" or t["id"] not in exts:
                continue
            by_code.setdefault((c["codebook_ref"], c.get("code", c.get("value"))), []).append(t["id"])
    return exts, by_code


def spread(ids: list[str], exts: dict) -> list[str]:
    """Passages taken a paper at a time: each paper's first, then each one's second, …

    Until 2026-10-05 this sorted on "already seen this paper?" against a set that
    was only filled after sorting, so it was always empty and the order was simply
    by passage id (a hash): each overview saw an arbitrary 26 passages, and 92% of
    its statements rested on one paper."""
    by_src: dict[str, list[str]] = {}
    for i in sorted(ids):
        by_src.setdefault(exts[i]["source_id"], []).append(i)
    out, rnd = [], 0
    while len(out) < len(ids):
        for sid in sorted(by_src):
            if rnd < len(by_src[sid]):
                out.append(by_src[sid][rnd])
        rnd += 1
    return out


def evidence_lines(corpus: Path, ids: list[str], sources: dict, exts: dict, cap: int) -> list[str]:
    """One line per passage, in the exact citation grammar the gate expects."""
    by_sid = {s["source_id"]: (a, s) for a, s in sources.items()}
    lines = []
    # Spread the evidence across papers rather than quoting one paper ten times.
    for eid in spread(ids, exts)[:cap]:
        e = exts[eid]
        alias, s = by_sid.get(e["source_id"], ("?", {}))
        bib = s.get("title", "")
        lines.append(f'"{e["direct_quote"]}" [{eid}] — {bib[:70]}')
    return lines


SYS = """You are writing a short, sober overview of what a body of academic literature says about one theme, for a research team.

You are given a numbered set of passages, each already checked against its source. Use them and nothing else.

RULES:
1. A quotation may ONLY be one of the given lines, copied whole INCLUDING its [ext-...] marker, inside double quotes.
2. To make any other point, write it in your own words and end the sentence with the bare marker [ext-...] of the passage it rests on. Never put quotation marks around your own words.
3. Do not invent, merge, trim or tidy a quotation. If you cannot quote it exactly, paraphrase it instead.
4. 350 to 700 words. No preamble, no conclusion about the state of research in general.
5. Say where the literature disagrees, and say when the evidence is thin.
6. Then a "## Claims" section: a JSON array of {"text": "...", "evidence_ids": ["ext-..."]}, one entry per substantive claim you made.
"""


def write_one(corpus: Path, title: str, question: str, lines: list[str], syn_type: str,
              model: str, url: str, tool_query: str) -> dict:
    user = (f"THEME: {title}\n\nDEFINITION: {question}\n\n"
            f"PASSAGES ({len(lines)}):\n\n" + "\n\n".join(lines))
    res = C.llm_chat(SYS, user, url=url, model=model, max_tokens=2600, temperature=0.3)
    body = res["content"].strip()

    # Split the prose from the claims block.
    claims, prose = [], body
    m = re.search(r"##\s*Claims\s*(.*)$", body, re.S | re.I)
    if m:
        prose = body[:m.start()].rstrip()
        blob = m.group(1).strip()
        blob = re.sub(r"^```(?:json)?|```$", "", blob, flags=re.M).strip()
        try:
            parsed = json.loads(blob)
            for i, c in enumerate(parsed if isinstance(parsed, list) else [], 1):
                ids = [e for e in (c.get("evidence_ids") or []) if MARKER.fullmatch(f"[{e}]")]
                if c.get("text") and ids:
                    claims.append({"claim_id": f"cl-{i:04d}", "text": c["text"][:600], "evidence_ids": ids})
        except json.JSONDecodeError:
            pass
    if not claims:
        # No usable claim block: fall back to one claim per cited passage, so the
        # register still records what the prose leans on.
        for i, eid in enumerate(dict.fromkeys(MARKER.findall(prose)), 1):
            claims.append({"claim_id": f"cl-{i:04d}", "text": f"The overview draws on this passage.",
                           "evidence_ids": [eid]})

    cited = list(dict.fromkeys(MARKER.findall(prose)))
    return {"prose": prose, "claims": claims, "cited": cited, "seconds": res["seconds"]}


QUOTED = re.compile(r'"([^"\n]{10,600})"\s*(\[ext-[0-9a-f]{12}\])')


def unquote_misquotes(prose: str, exts: dict) -> tuple[str, int]:
    """Strip the quotation marks from anything that is not a real quotation.

    A model writing an overview will occasionally reproduce a passage almost, but
    not exactly — a dropped comma, a joined clause. Refusing the whole overview
    over that loses 600 words of decent analysis; printing it as a quotation would
    be a lie. So the quotation marks come off and the citation stays: the sentence
    becomes the model's own words about a real passage, which is what it actually
    is. The count is reported, because a high one means the prompt is not landing.
    """
    n = 0

    def fix(m):
        nonlocal n
        text, marker = m.group(1), m.group(2)
        eid = marker[1:-1]
        e = exts.get(eid)
        if e and e.get("direct_quote") == text:
            return m.group(0)          # a real quotation: leave it alone
        n += 1
        return f"{text} {marker}"

    return QUOTED.sub(fix, prose), n


# --- v2: overviews rebuilt from the rated evidence (references/criteria-v2.md) -------------

GRADE_RANK = {"High": 4, "Moderate": 3, "Low": 2, "Very low": 1}
ORIGIN_RANK = {"own-finding": 3, "interpretation": 2, "theoretical": 1, "recommendation": 1,
               "speculation": 0, "reported": 0, "background": 0}
BASIS_RANK = {"data": 2, "case": 2, "cited-study": 1, "argument": 1, "none": 0}
RELAYED = {"reported", "background"}
REVISION = "Revised from rated evidence"
CRITERIA = "criteria-v2.1"        # v2 plus claim groups (claim_groups.py); "criteria-v2" without them
GROUP_SHARE = 2 / 3               # at most this share of the passages given come in groups; the rest stand alone
MAX_IN_GROUP = 6                  # a group's strongest papers are shown; its heading says how many make the claim

SYS_V2 = """You are rewriting a short overview of what a body of research says about one theme, for {audience}. This time every passage comes with what is known about its evidence.

Each passage has a header line: its paper (author, year), the paper's design, the paper's evidence grade (High, Moderate, Low or Very low: how well that paper's own evidence supports its own conclusions), where the paper studied (countries and sector{own_setting}), whose claim the passage makes, and what backs it. Below the header is the passage itself, already checked word for word against its paper.

RULES
1. A quotation may ONLY be one of the given passage lines, copied whole INCLUDING its [ext-...] marker, inside double quotes. Otherwise write in your own words and end the sentence with the bare marker(s) [ext-...] of the passage(s) it rests on. Never put quotation marks around your own words.
2. EVERY sentence cites at least one passage, including the first sentence of a paragraph: no uncited topic sentences, open with the evidence.
3. A general statement ("research shows", "installers tend to") needs passages from at least two different papers that make the claim themselves (whose claim: own finding or interpretation). Otherwise attribute it to its paper: "One UK case study (Author Year) found ...", "Author (Year) argue ...".
4. A passage whose claim is "reported from cited work" or "background" tells you what that paper says OTHER work found. Say so ("..., citing earlier studies") and never count it as a second paper agreeing.
5. When evidence from elsewhere is applied to US homes, say where it comes from ("in the UK", "for district heating").
6. Lead with the strongest evidence. When a point rests on one paper, or on Low or Very low evidence, say so plainly.
7. Say where papers disagree.
8. 400 to 650 words, in paragraphs. No preamble, no headings, no general conclusion about the state of research.
9. The header's labels are for you, not the reader: never copy them into the text (no "near-target", "as background", "own finding", "evidence grade"). Say it in plain words: "in the UK", "a modelling study", "citing earlier studies".
10. Only say papers agree ("corroborated", "similarly", "likewise") when their passages make the same claim; otherwise present them side by side.
11. Some passages may come in GROUPS: passages from different papers that a reader judged to make the same claim. For each group, write ONE statement that cites every passage in it that really makes the claim, and say how many papers found it and where ("Three studies, in the UK, the Netherlands and the US, found ..."). Put all those markers in that claim's evidence_ids. Leave out of the statement any passage of the group that doesn't make the claim. If a heading says more papers make the claim than are shown, you may write "many studies, including ...", but give a number only for the papers you cite. Ungrouped passages are written about as before.
12. Then a "## Claims" section: a JSON array of {"text": "...", "evidence_ids": ["ext-..."]}, one entry per substantive claim, listing every passage it rests on.
"""


def sys_v2(corpus: Path) -> str:
    """SYS_V2 for this corpus: who the overview is for (settings "audience") and the team's
    own setting (its appraisal domain's "team_setting"), when the corpus names them."""
    import appraise as A  # noqa: E402
    audience = C.corpus_settings(corpus).get("audience") or "a research team"
    dom = A.load_domain(corpus) or {}
    own = f"; the team's own setting is {dom['team_setting']}" if dom.get("team_setting") else ""
    return SYS_V2.replace("{audience}", audience).replace("{own_setting}", own)

SENT_SPLIT = re.compile(r"(?<=[.!?\]])\s+(?=[A-Z“\"(])")


def load_ratings(corpus: Path) -> tuple[dict, str]:
    """Paper ratings (sid → grade, design, setting, passages{eid → origin, basis}): the stored
    ones, whose quotations `upc anchor` confirmed, else the vote."""
    import appraise as A  # noqa: E402  (its state folder follows the model settings)
    base = A.state(corpus)
    for f, what in ((base / "store" / "confirmed.json", "confirmed by store"), (base / "vote.json", "the vote")):
        d = C.load_json(f)
        if d:
            return d.get("papers", d), what
    C.die("no ratings: run appraise.py vote (and store) first")


def rank_v2(ids: list[str], exts: dict, ratings: dict, cap: int, per_paper: int) -> list[str]:
    """Strongest first, spread across papers: grade, then whose claim, then what backs it."""
    def score(e):
        sid = exts[e]["source_id"]
        r = ratings.get(sid) or {}
        pv = (r.get("passages") or {}).get(e) or {}
        return (GRADE_RANK.get(r.get("grade"), 0), ORIGIN_RANK.get(pv.get("origin"), 1), BASIS_RANK.get(pv.get("basis"), 1))
    by_src: dict[str, list[str]] = {}
    for e in sorted(ids):
        by_src.setdefault(exts[e]["source_id"], []).append(e)
    for v in by_src.values():
        v.sort(key=lambda e: tuple(-x for x in score(e)))
    order = sorted(by_src, key=lambda s: (tuple(-x for x in score(by_src[s][0])), s))
    out = []
    for rnd in range(per_paper):
        for s in order:
            if rnd < len(by_src[s]):
                out.append(by_src[s][rnd])
    return out[:cap]


def choose_grouped(groups: list[dict], ranked: list[str], exts: dict, cap: int, per_paper: int) -> tuple[list[dict], list[str]]:
    """Groups first (most papers first), each cut to its MAX_IN_GROUP strongest papers and
    to the room left in GROUP_SHARE of the cap, then the strongest single passages; never
    more than per_paper passages from one paper. A large group is cut, not dropped: before
    10-05 a 24-paper group (niches as protected spaces) didn't fit and was lost."""
    per: dict[str, int] = {}
    chosen: list[str] = []
    used: list[dict] = []
    pos = {e: i for i, e in enumerate(ranked)}

    def fits(e):
        return e not in chosen and per.get(exts[e]["source_id"], 0) < per_paper

    for g in groups:
        es: list[str] = []
        for e in sorted((e for e in g["passages"] if e in exts), key=lambda e: pos.get(e, len(pos))):
            if fits(e) and e not in es and exts[e]["source_id"] not in {exts[x]["source_id"] for x in es}:
                es.append(e)
        es = es[:min(MAX_IN_GROUP, int(cap * GROUP_SHARE) - len(chosen))]
        if len({exts[e]["source_id"] for e in es}) < 2:
            continue
        for e in es:
            chosen.append(e)
            per[exts[e]["source_id"]] = per.get(exts[e]["source_id"], 0) + 1
        used.append({**g, "passages": es, "papers_total": max(g.get("papers", 0), len(es))})
    for e in ranked:
        if len(chosen) >= cap:
            break
        if fits(e):
            chosen.append(e)
            per[exts[e]["source_id"]] = per.get(exts[e]["source_id"], 0) + 1
    return used, chosen


def grouped_lines(lines: list[str], chosen: list[str], used: list[dict]) -> list[str]:
    """The passage blocks rearranged: each group under its heading, then the rest."""
    by_e = dict(zip(chosen, lines))
    out, done = [], set()
    for n, g in enumerate(used, 1):
        shown, total = len(g["passages"]), g.get("papers_total", len(g["passages"]))
        more = f", the strongest of {total} that make it" if total > shown else ""
        out.append(f"GROUP G{n} · {shown} papers{more} · a reader judged these to make the same claim: "
                   f"{g['claim']}")
        out += [by_e[e] for e in g["passages"]]
        done.update(g["passages"])
    rest = [by_e[e] for e in chosen if e not in done]
    if used and rest:
        out.append("OTHER PASSAGES, strongest evidence first:")
    return out + rest


def v2_lines(ids: list[str], exts: dict, ratings: dict, papers: dict, R: dict) -> tuple[list[str], dict]:
    """Each passage with its header; and eid → (author year, origin, paper) for the checks."""
    import appraise as A  # noqa: E402  (the rubric's labels)
    lines, info = [], {}
    # Two papers by the same author in the same year read as one: Sovacool 2020a, 2020b.
    names = {}
    for sid in dict.fromkeys(exts[e]["source_id"] for e in ids):
        names.setdefault(A.author_year(papers.get(sid, {})), []).append(sid)
    label = {sid: who + ("abcdefghij"[i] if len(sids) > 1 else "")
             for who, sids in names.items() for i, sid in enumerate(sorted(sids))}
    for k, e in enumerate(ids, 1):
        x = exts[e]
        sid = x["source_id"]
        r = ratings.get(sid) or {}
        pv = (r.get("passages") or {}).get(e) or {}
        d = (r.get("design") or {}).get("design")
        who = label[sid]
        cs = (r.get("design") or {}).get("countries") or []
        where = (", ".join(cs[:4]) + (f" and {len(cs) - 4} more" if len(cs) > 4 else "")) or "country not stated"
        sector = (r.get("design") or {}).get("sector") or "sector not stated"
        head = (f"[P{k}] {who} · {R['by_code'].get(d, {}).get('label', 'design not agreed').lower()} · "
                f"evidence {r.get('grade') or 'not rated'} · studied: {where}; {sector} · "
                f"whose claim: {A.ORIGIN_LABEL.get(pv.get('origin'), 'no agreed label').lower()} · "
                f"backed by: {A.BASIS_LABEL.get(pv.get('basis'), 'no agreed label').lower()}")
        lines.append(f'{head}\n"{x["direct_quote"]}" [{e}]')
        info[e] = {"who": who, "origin": pv.get("origin"), "source_id": sid}
    return lines, info


ATTRIB = re.compile(r"\b(one|a|another|single|this)\s+(\w+\s+){0,3}(study|studies|paper|survey|case|analysis|review|"
                    r"report|model|trial|experiment|interview)|\b(found|finds|argue[sd]?|report[sed]*|suggest[sed]*|"
                    r"show[sed]*|note[sd]?|observe[sd]?)\b", re.I)


RELAY_WORDS = re.compile(r"\bcit(?:e|es|ed|ing)\b|\baccording to (?:earlier|other|previous|prior)|\breview(?:s|ed)? of\b|"
                         r"\bearlier (?:work|studies|research)\b|\bother (?:studies|work|research)\b|\breports? that\b", re.I)


ABBREV = re.compile(r"(?:\bet al|\be\.g|\bi\.e|\bcf|\bFig|\bNo|\bvs)\.$")


def split_sentences(text: str) -> list[str]:
    """Sentences, without breaking after 'et al.', 'e.g.' and the like."""
    out: list[str] = []
    for piece in SENT_SPLIT.split(text):
        if out and ABBREV.search(out[-1]):
            out[-1] += " " + piece
        elif piece.strip():
            out.append(piece)
    return out


def sentences(prose: str) -> list[str]:
    body = "\n".join(ln for ln in prose.splitlines() if not ln.lstrip().startswith("#"))
    return split_sentences(" ".join(body.split()))


def cut_uncited(prose: str) -> tuple[str, list[str]]:
    """Drop every sentence that cites no passage (criteria-v2 rule 2: cite it or cut it). The
    model is asked twice; what it still leaves, code cuts. Only removes words, never adds."""
    cut, paras = [], []
    for para in prose.split("\n\n"):
        if para.lstrip().startswith("#"):
            paras.append(para)
            continue
        keep = []
        for sent in split_sentences(" ".join(para.split())):
            if not MARKER.search(sent) and len(sent) > 25:
                cut.append(sent)
            else:
                keep.append(sent)
        if keep:
            paras.append(" ".join(keep))
    return "\n\n".join(paras), cut


def v2_checks(prose: str, claims: list[dict], info: dict) -> list[str]:
    """What criteria-v2 asks that code can see, sentence by sentence. Each line is a fix
    the model is asked to make; what's left after the fix pass is recorded."""
    probs = []
    for sent in sentences(prose):
        ids = [e for e in dict.fromkeys(MARKER.findall(sent))]
        short = sent[:150]
        if not ids:
            if len(sent) > 25:
                probs.append(f"This sentence cites no passage; end it with the marker of the passage it rests on, "
                             f"or cut it: {short!r}")
            continue
        unknown = [e for e in ids if e not in info]
        if unknown:
            probs.append(f"{', '.join(unknown)} is not one of the given passages; remove it: {short!r}")
        known = [e for e in ids if e in info]
        if not known:
            continue
        own = {info[e]["source_id"] for e in known if info[e]["origin"] not in RELAYED}
        if not own:
            if not RELAY_WORDS.search(sent):
                probs.append(f"This sentence rests only on passages that report other work; say so (for example "
                             f"'..., citing earlier studies'): {short!r}")
        elif len(own) == 1 and not QUOTED.search(sent):
            names = {info[e]["who"].split()[0] for e in known if info[e]["source_id"] in own}
            if not ATTRIB.search(sent) and not any(n and n in sent for n in names):
                probs.append(f"This sentence rests on one paper ({', '.join(sorted({info[e]['who'] for e in known}))}) "
                             f"but reads as general; attribute it to that paper: {short!r}")
    words = len(re.sub(r"\[ext-[0-9a-f]{12}\]", "", " ".join(sentences(prose))).split())
    if words < 350 or words > 720:
        probs.append(f"The text is {words} words; keep it between 400 and 650.")
    if not claims:
        probs.append("The ## Claims section is missing or isn't a JSON array of {text, evidence_ids}.")
    return probs


def chat_text(url: str, system: str, user: str, max_tokens: int, model: str, seed: int) -> tuple[str, float]:
    """One plain-text call; a relayed answer stops this worker (the pool puts the item back)."""
    import urllib.error
    import urllib.request
    import appraise as A  # noqa: E402  (the pool and its relay check)
    body = {"model": model, "max_tokens": max_tokens + (C.THINK_HEADROOM if model in ("think", "code") else 0),
            "temperature": 0.3, "cache_prompt": True, "seed": seed,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            relayed = A.P.is_relayed(r.headers, url)
            payload = json.load(r)
    except urllib.error.HTTPError as exc:
        raise A.P.Unavailable(f"{url} answered HTTP {exc.code}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise A.P.Unavailable(f"{url} didn't answer ({exc})")
    if relayed:
        raise A.P.Relayed(url)
    content = ((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip(), round(time.time() - t0, 1)


def split_claims(body: str) -> tuple[str, list[dict]]:
    claims, prose = [], body
    m = re.search(r"##\s*Claims\s*(.*)$", body, re.S | re.I)
    if m:
        prose = body[:m.start()].rstrip()
        blob = re.sub(r"^```(?:json)?|```$", "", m.group(1).strip(), flags=re.M).strip()
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            parsed = C.parse_json_loose(blob) or []
        for i, c in enumerate(parsed if isinstance(parsed, list) else [], 1):
            if not isinstance(c, dict):
                continue
            ids = [e for e in (c.get("evidence_ids") or []) if isinstance(e, str) and MARKER.fullmatch(f"[{e}]")]
            if c.get("text") and ids:
                claims.append({"claim_id": f"cl-{i:04d}", "text": str(c["text"])[:600], "evidence_ids": ids})
    return prose, claims


def write_v2(job: dict, url: str, model: str) -> dict:
    """Draft, check, one fix pass with the checker's list, check again."""
    user = (f"THEME: {job['title']}\n\nDEFINITION: {job['question']}\n\n"
            f"PASSAGES ({len(job['chosen'])}), strongest evidence first:\n\n" + "\n\n".join(job["lines"]))
    seed = int(hashlib.sha256(job["title"].encode()).hexdigest()[:8], 16)
    body, secs = chat_text(url, job["system"], user, 2600, model, seed)
    raw = {"draft": body}
    prose, claims = split_claims(body)
    prose, _ = unquote_misquotes(prose, job["exts"])
    first = v2_checks(prose, claims, job["info"])
    left = first
    if first:
        fix = (user + "\n\nYOUR DRAFT:\n\n" + body + "\n\nA CHECKER FOUND THESE PROBLEMS:\n- " + "\n- ".join(first) +
               "\n\nRewrite the whole overview, prose and ## Claims section, fixing every problem and keeping every rule.")
        body2, s2 = chat_text(url, job["system"], fix, 2800, model, seed + 1)
        raw["fix"] = body2
        secs += s2
        p2, c2 = split_claims(body2)
        p2, _ = unquote_misquotes(p2, job["exts"])
        left2 = v2_checks(p2, c2, job["info"])
        raw["fix_left"] = left2
        if c2 and len(left2) <= len(first):
            prose, claims, left = p2, c2, left2
    prose, cut = cut_uncited(prose)
    if cut:
        left = v2_checks(prose, claims, job["info"])
    if not claims:
        for i, eid in enumerate(dict.fromkeys(MARKER.findall(prose)), 1):
            claims.append({"claim_id": f"cl-{i:04d}", "text": "The overview draws on this passage.", "evidence_ids": [eid]})
    return {"prose": prose, "claims": claims, "first": first, "left": left, "cut": cut, "seconds": round(secs, 1),
            "raw": raw}


def find_current(corpus: Path, slug: str, label: str) -> dict | None:
    """The theme's overview as shown now: same scheme and title, not superseded."""
    found = []
    for f in corpus.glob("syntheses/*/synthesis.json"):
        d = C.load_json(f, {}) or {}
        declared = ((d.get("ext") or {}).get("upc-corpus") or {}).get("codebook")
        # Overviews written before 2026-10 name no scheme; the site places them by title.
        if d.get("type") == "thematic" and d.get("title") == label and not d.get("superseded_by") \
                and declared in (slug, None):
            found.append(d)
    return found[0] if len(found) == 1 else None


def main_v2(args) -> int:
    import appraise as A  # noqa: E402
    corpus = Path(args.corpus).expanduser()
    C.check_compat()
    R = A.rubric(corpus)
    system = sys_v2(corpus)
    books = load_books(corpus)
    exts, by_code = load_coded(corpus)
    data = A.load_corpus(corpus)
    exts = {e: o for e, o in exts.items() if e in data["exts"]}      # listed passages only, never a hidden set
    ratings, rated_from = load_ratings(corpus)
    if args.codes == "all":
        # every theme with exactly one current overview
        codes = [(b["slug"], c["code"]) for b in books.values() for c in b.get("codes", [])
                 if find_current(corpus, b["slug"], c.get("label", c["code"]))]
    elif args.codes:
        codes = [c.split(":", 1) for c in args.codes.split(",") if c]
    elif args.codebook in books:
        codes = [(args.codebook, c["code"]) for c in books[args.codebook]["codes"]]
    else:
        C.die("give --codes slug:code,… or --codebook <slug>")
    jobs = []
    for slug, code in codes:
        b = books.get(slug) or {}
        c = next((x for x in b.get("codes", []) if x["code"] == code), None)
        if not c:
            C.die(f"no code {slug}:{code}")
        label = c.get("label", code)
        old = find_current(corpus, slug, label)
        if not old:
            print(f"  SKIP {slug}:{code}: no single current overview titled {label!r}")
            continue
        if any(j["old"]["synthesis_id"] == old["synthesis_id"] for j in jobs):
            continue
        target = "criteria-v2" if args.no_groups else CRITERIA
        if ((old.get("ext") or {}).get("upc-corpus") or {}).get("criteria") == target and not args.redo:
            print(f"  DONE {label}: its current overview is already {target}")
            continue
        ids = [e for e in by_code.get((b["codebook_id"], code), []) if e in exts]
        rated = [e for e in ids if (ratings.get(exts[e]["source_id"]) or {}).get("grade")]
        ranked = rank_v2(rated, exts, ratings, len(rated), args.per_paper)
        chosen = ranked[:args.max_passages]
        lines, info = v2_lines(chosen, exts, ratings, data["sources"], R)
        jobs.append({"slug": slug, "code": code, "title": label, "question": c.get("definition", ""), "old": old,
                     "candidates": len(ids), "rated": len(rated), "rated_ids": rated, "ranked": ranked,
                     "chosen": chosen, "lines": lines, "info": info, "groups": [], "criteria": target, "system": system,
                     "papers": len({exts[e]["source_id"] for e in chosen}), "exts": exts})
    C.counts_header("Overviews to revise (criteria-v2)", [
        ("overviews", len(jobs)), ("ratings", rated_from), ("model", args.model),
        ("passages per overview", f"at most {args.max_passages}, at most {args.per_paper} per paper")])
    for j in jobs:
        print(f"  {j['title'][:40]:42} {j['candidates']:4} candidates, {j['rated']:4} in rated papers → "
              f"{len(j['chosen'])} passages from {j['papers']} papers")
    if args.plan or not jobs:
        print("\nPlanning only; nothing was written." if args.plan else "Nothing to revise.")
        return 0

    out_dir = C.state_dir(corpus, "syntheses-v2")
    today = time.strftime("%Y-%m-%d")
    results = {}

    stop = None
    if args.stop_at:
        import appraise as A2  # noqa: E402
        stop = A2.parse_clock(args.stop_at)

    def work(job, name, url):
        if stop and datetime.now() >= stop:
            raise A.P.Unavailable(f"stop time {stop:%H:%M} reached")
        if job["criteria"] == CRITERIA:
            import claim_groups as CG  # noqa: E402
            strength = {e: -i for i, e in enumerate(job["ranked"])}
            rec = CG.groups_for(corpus, f"{job['slug']}:{job['code']}", job["rated_ids"], exts, ratings,
                                data["sources"], url, strength)
            used, chosen = choose_grouped(rec.get("groups", []), job["ranked"], exts, args.max_passages, args.per_paper)
            lines, info = v2_lines(chosen, exts, ratings, data["sources"], R)
            job.update({"chosen": chosen, "lines": grouped_lines(lines, chosen, used), "info": info, "groups": used,
                        "group_sets": rec.get("sets", 0), "papers": len({exts[e]["source_id"] for e in chosen})})
        got = write_v2(job, url, args.model)
        got["machine"] = name
        return got

    def done(job, got, name, seconds):
        results[job["title"]] = (job, got)

    problems, left = A.P.run_all(jobs, work, done)
    for p in problems:
        print(f"  PROBLEM {p}")

    wrote = 0
    for title, (job, got) in sorted(results.items()):
        cited_ids = list(dict.fromkeys(MARKER.findall(got["prose"]) + [e for c in got["claims"] for e in c["evidence_ids"]]))
        by_source: dict[str, list[str]] = {}
        for e in cited_ids:
            if e in exts:
                by_source.setdefault(exts[e]["source_id"], []).append(e)
        refs = ["", "## Passages this draws on", ""]
        for sid, es in by_source.items():
            s = data["sources"].get(sid, {})
            refs.append(f"- {A.author_year(s)}, {s.get('bib', {}).get('title') or sid} · `{sid}` · " + " ".join(f"[{e}]" for e in es))
        md = out_dir / (re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") + ".md")
        md.write_text(f"# {title}\n\n{got['prose']}\n" + "\n".join(refs) + "\n", encoding="utf-8")
        C.save_json(md.with_suffix(".json"), {k: v for k, v in got.items()} | {"chosen": job["chosen"], "lines": job["lines"]})
        obj = {"type": "thematic", "title": title, "question": job["question"], "claims": got["claims"],
               "ext": {"upc-corpus": {"codebook": job["slug"], "criteria": job["criteria"], "ratings": A.STATE_NAME,
                                      "claim_groups": [{"claim": g["claim"], "passages": g["passages"],
                                                       "papers": g.get("papers_total", len(g["passages"]))}
                                                      for g in job["groups"]],
                                      "passages_given": len(job["chosen"]), "papers_given": job["papers"],
                                      "candidates": job["candidates"], "candidates_in_rated_papers": job["rated"],
                                      "checks_first": got["first"], "checks_left": got["left"],
                                      "sentences_cut": got.get("cut", [])},
                       "upc-site": {"revision": {"label": REVISION, "date": today,
                                                 "note": "Rewritten from passages ranked by the rated evidence; "
                                                         "each statement's support can be shown beside it."}}},
               "provenance": {"produced_by": {"tool": "synthesize.py", "model": args.model, "method": "model",
                                              "prompt_version": "synthesize.v2"}}}
        res = C.upc("add", "synthesis", "--corpus", str(corpus), "--output", str(md), "--tool", "synthesize.py",
                    "--supersedes", job["old"]["synthesis_id"], stdin=json.dumps(obj), check=False)
        if isinstance(res, dict) and res.get("status") == "ok":
            wrote += 1
            cut = f" ({len(got['cut'])} uncited sentences cut)" if got.get("cut") else ""
            grp = f" · {len(job['groups'])} claim groups" if job["criteria"] == CRITERIA else ""
            print(f"  wrote {title[:40]:42} {len(got['claims']):3} claims · {len(by_source):2} papers cited{grp} · "
                  f"checks {len(got['first'])} → {len(got['left'])}{cut} · {got['seconds']}s on {got['machine']}")
        else:
            print(f"  REFUSED {title}: {json.dumps(res)[:300]}")
        for p in got["left"][:6]:
            print(f"      left: {p[:150]}")
    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    C.counts_header("Revised overviews", [("written", f"{wrote} of {len(jobs)}"), ("not reached", len(left)),
                                          ("corpus", f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors")])
    if left:
        return 3                                   # stopped at --stop-at; run again to continue
    return 0 if wrote == len(jobs) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--codebook", default="", help="write one overview per code in this codebook")
    ap.add_argument("--matrix", default="", help="slugA:slugB — a cross-tabulated overview")
    ap.add_argument("--model", default=C.DEFAULT_MODEL)
    ap.add_argument("--url", default=C.CHAT_URL)
    ap.add_argument("--min-passages", type=int, default=4)
    ap.add_argument("--max-passages", type=int, default=26)
    ap.add_argument("--limit-codes", type=int, default=0)
    ap.add_argument("--only", default="",
                    help="with --codebook: only these codes (code,code), e.g. to retry an overview that was refused. "
                         "If one of them is stored already, say --replace or --supersede")
    ap.add_argument("--replace", action="store_true",
                    help="with --only: the new overview takes the stored one's place, which is removed (journaled, "
                         "no label): for an overview nobody has relied on yet")
    ap.add_argument("--supersede", action="store_true",
                    help="with --only: the stored overview stays as the previous version and the new one says Revised: "
                         "for a published overview")
    ap.add_argument("--why", default="",
                    help="with --supersede: the reason, shown under the Revised label")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--v2", action="store_true", help="revise the current overviews from the rated evidence (criteria-v2)")
    ap.add_argument("--codes", default="", help="v2: slug:code,… (default: every code of --codebook)")
    ap.add_argument("--per-paper", type=int, default=3, help="v2: at most this many passages from one paper")
    ap.add_argument("--stop-at", default="", help="v2: HH:MM; no new overview starts after it")
    ap.add_argument("--no-groups", action="store_true", help="v2 without claim groups (criteria-v2)")
    ap.add_argument("--redo", action="store_true", help="v2: rewrite the --codes themes even if already at the target")
    args = ap.parse_args()
    if args.v2:
        if args.max_passages == 26:
            args.max_passages = 30
        if args.model == C.DEFAULT_MODEL:
            args.model = "chat"
        return main_v2(args)

    corpus = Path(args.corpus).expanduser()
    try:
        C.check_compat()
    except C.Unavailable as e:
        C.die(str(e))
    books = load_books(corpus)
    if args.codebook and args.codebook not in books:
        C.die(f"no codebook '{args.codebook}' (have: {', '.join(sorted(books))})")
    exts, by_code = load_coded(corpus)
    sources = C.corpus_reps(corpus)
    by_sid = {s["source_id"]: (a, s) for a, s in sources.items()}

    jobs = []
    if args.codebook:
        b = books[args.codebook]
        only = {x.strip() for x in args.only.split(",") if x.strip()}
        unknown = only - {c["code"] for c in b["codes"]}
        if unknown:
            C.die(f"--only: no code {', '.join(sorted(unknown))} in '{args.codebook}'")
        for c in b["codes"]:
            if only and c["code"] not in only:
                continue
            ids = by_code.get((b["codebook_id"], c["code"]), [])
            if len(ids) >= args.min_passages:
                jobs.append((f"{c.get('label', c['code'])}", c.get("definition", ""), ids, "thematic"))
        jobs.sort(key=lambda j: -len(j[2]))
    elif args.matrix:
        sa, sb = args.matrix.split(":", 1)
        if sa not in books or sb not in books:
            C.die(f"--matrix needs two codebook slugs; have: {', '.join(sorted(books))}")
        A, B = books[sa], books[sb]
        for ca in A["codes"]:
            ida = set(by_code.get((A["codebook_id"], ca["code"]), []))
            if len(ida) < args.min_passages:
                continue
            rows = []
            for cb in B["codes"]:
                both = ida & set(by_code.get((B["codebook_id"], cb["code"]), []))
                if both:
                    rows.append((cb.get("label", cb["code"]), sorted(both)))
            if rows:
                jobs.append((f"{ca.get('label', ca['code'])} — by {B['title'].lower()}",
                             ca.get("definition", ""),
                             [i for _, ids in rows for i in ids], "evidence_matrix"))
    else:
        C.die("give --codebook <slug> or --matrix <a>:<b>")
    if args.limit_codes:
        jobs = jobs[:args.limit_codes]

    C.counts_header("Overviews to write", [
        ("overviews", len(jobs)),
        ("passages available", sum(len(j[2]) for j in jobs)),
        ("model", f"{args.model} at {args.url}"),
        ("minimum passages per overview", args.min_passages),
    ])
    for title, _, ids, _ in jobs:
        print(f"  {title[:44]:46} {len(ids):4} passages")
    if args.plan:
        print("\nPlanning only; nothing was written.")
        return 0
    if not jobs:
        print("No code has enough passages yet.")
        return 0

    scheme_slug = args.codebook or (args.matrix.split(":", 1)[0] if args.matrix else "")
    out_dir = C.state_dir(corpus, "syntheses")
    stored = current_overviews(corpus) if args.only else {}
    if args.replace and args.supersede:
        C.die("--replace or --supersede, not both")
    clash = [t for t, *_ in jobs if (scheme_slug, t) in stored]
    if clash and not (args.replace or args.supersede):
        C.die(f"already stored: {', '.join(clash)}. --replace swaps an overview out (journaled, no label); "
              "--supersede keeps it as the previous version and labels the new one Revised")
    wrote, refused, unquoted_total, t0 = 0, 0, 0, time.time()
    for title, definition, ids, syn_type in jobs:
        lines = evidence_lines(corpus, ids, sources, exts, args.max_passages)
        try:
            got = write_one(corpus, title, definition, lines, syn_type, args.model, args.url, "")
        except C.Unavailable as e:
            print(f"  UNAVAILABLE {title}: {e}")
            continue

        prose, unquoted = unquote_misquotes(got["prose"], exts)
        got["prose"] = prose
        got["cited"] = list(dict.fromkeys(MARKER.findall(prose)))
        why = not_an_overview(got)
        if why:
            refused += 1
            print(f"  REFUSED {title[:44]:44} — {why}; nothing was written")
            continue

        # Rule 2.4: the prose must name every source its claims rely on. A
        # reference list is what a reader wants anyway, so build one.
        # The reference list must cover every passage the CLAIMS rest on, not just
        # the ones the prose happens to mention: a claim may cite a passage the
        # sentence paraphrased without a marker, and rule 2.4 checks the claims.
        cited_ids = list(dict.fromkeys(
            got["cited"] + [e for c in got["claims"] for e in c.get("evidence_ids", [])]))
        cited_sources = list(dict.fromkeys(
            exts[e]["source_id"] for e in cited_ids if e in exts))
        # Rule 2.4 asks the output to cite every id its claims rest on, passages
        # included — so the reference list names the passages under their paper,
        # which is what a reader wants to follow anyway.
        by_source: dict[str, list[str]] = {}
        for e in cited_ids:
            if e in exts:
                by_source.setdefault(exts[e]["source_id"], []).append(e)
        refs = ["", "## Passages this draws on", ""]
        for sid in cited_sources:
            alias, s = by_sid.get(sid, ("?", {}))
            marks = " ".join(f"[{e}]" for e in by_source.get(sid, []))
            refs.append(f"- {s.get('title', sid)} · `{sid}` · {marks}")
        md_path = out_dir / (re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") + ".md")
        md_path.write_text(f"# {title}\n\n{got['prose']}\n" + "\n".join(refs) + "\n", encoding="utf-8")

        old = stored.get((scheme_slug, title))
        ext = {"upc-corpus": {"codebook": scheme_slug}}
        if old and args.supersede:
            ext["upc-site"] = {"revision": {"label": "Revised", "date": datetime.now().date().isoformat(),
                                            "note": args.why}}
        res = C.upc("add", "synthesis", "--corpus", str(corpus), "--output", str(md_path),
                    "--tool", "upc-corpus", *(["--supersedes", old] if old and args.supersede else []), check=False,
                    stdin=json.dumps({"type": syn_type, "title": title,
                                      "question": definition, "claims": got["claims"],
                                      # Say which scheme this overview belongs to, so a
                                      # reader's index can group them without guessing.
                                      "ext": ext}))
        if isinstance(res, dict) and res.get("status") == "ok":
            wrote += 1
            unquoted_total += unquoted
            done = ""
            if old and args.replace and res.get("synthesis_id") != old:
                remove_overview(corpus, old, f"overview replaced by {res.get('synthesis_id')} (synthesize.py --replace)")
                done = f" (replaces {old}, removed)"
            elif old and args.supersede:
                done = f" (supersedes {old})"
            print(f"  wrote {title[:44]:46} {len(got['claims']):3} claims, "
                  f"{len(got['cited']):3} passages cited"
                  f"{f', {unquoted} unquoted' if unquoted else ''}, {got['seconds']}s{done}")
        else:
            refused += 1
            fails = (res or {}).get("failures", [])
            print(f"  REFUSED {title[:44]:44} — {(res or {}).get('detail', 'unknown')[:70]}")
            for f in fails[:3]:
                print(f"      {f.get('marker')}: {f.get('reason')}")

    C.upc("regen", str(corpus))
    rep = C.upc("validate", str(corpus))
    state = (f"{rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors"
             if isinstance(rep, dict) else "UNAVAILABLE: validate did not return a report")
    C.counts_header("Overviews", [
        ("written", wrote),
        ("refused (misquoted, uncited or notes)", refused),
        ("near-quotations unquoted", unquoted_total),
        ("corpus", state),
        ("minutes", round((time.time() - t0) / 60, 1)),
    ])
    if unquoted_total:
        print("  A near-quotation is printed as the model's own words citing the passage,")
        print("  never as a quotation. A high count means the prompt is not landing.")
    print("Synthesis finished.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as exc:
        C.die(str(exc))
