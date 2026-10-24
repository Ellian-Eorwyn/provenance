#!/usr/bin/env python3
"""Code interviews by the guide's questions: each answer found, briefed, quoted.

    python3 interview_pass.py --corpus <dir> [--only <slug>] [--redo] [--plan]

For each interview transcript (transcribe.py saved it, timings and all) not coded yet:

  1. **Which question is being asked.** The model reads the interviewer's turns and
     the guide (each question's words, follow-ups and the phrasings an interviewer
     might use) and labels each turn: a guide question (by meaning: paraphrased, out
     of order, two at once, all fine), a follow-up within the current one, or
     something else (small talk, logistics, thanks).
  2. **The answers** are cut deterministically from those labels: everything from the
     interviewee's first words after a question to the next question or the next
     "something else". An answer is an extraction (type `x-answer`) of exactly those
     characters, coded with its question(s) in the `questions` codebook.
  3. **A brief and the key words.** Per answer the model writes one or two sentences
     (an open `summary` coding: the assistant's words, labelled as such wherever shown)
     and picks one to three passages verbatim. Those go through `upc anchor` like any
     other quotation: a pick the transcript doesn't contain is dropped, never
     repaired. A pick that answers a different question is coded with that one too.
  4. **Names.** Every person, place, organization, work or program mentioned, anchored
     where it is said (type `entity`, the name as written in the glossary when it is
     there); a person the interviewee suggests talking to is marked as a referral.
  5. **Times.** timecode.py gives every new passage its time and speakers.

A question the interviewer never asked simply has no answer; the site lists it as
"not asked, or no answer found". Nothing is invented to fill a gap. A person's later
recode of an answer (`upc code` by a human coder) supersedes nothing of the model's
and is shown beside it (spec/12).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common as C      # noqa: E402
import glossary as G    # noqa: E402
import timecode         # noqa: E402

TOOL = "upc-corpus/interview_pass"
PROMPT_VERSION = "interview-v1"
SETS = {"answers": "exs-interview-answers", "highlights": "exs-interview-highlights", "names": "exs-interview-names"}
TIMINGS = "application/vnd.upc.timings+json"
MODEL = (C.CONFIG.get("transcribe") or {}).get("code_model") or "chat"

LABEL_SYSTEM = """You are coding an interview transcript against its interview guide.

You get the guide's questions (id, words, follow-ups, phrasings an interviewer might use)
and, in order, every turn by the interviewer. Interviewers are volunteers: they paraphrase,
skip questions, ask them out of order, ask two at once, and chat. Label each interviewer
turn by what it does:

- "question": it asks one or more guide questions (match by meaning, not wording). List
  their ids in `questions`.
- "follow_up": it follows up or probes within the question already being answered (no
  new guide question). `questions` is [].
- "other": small talk, logistics, consent, thanks, the interviewer's own story, or a
  question not in the guide. `questions` is [].

A turn that only says "mm-hm", "great" or "thank you" is "other" unless it also asks
something. Reply with JSON: {"turns": [{"id": <id>, "kind": ..., "questions": [...]}]}
with every id."""

LABEL_SCHEMA = {"type": "object", "properties": {"turns": {"type": "array", "items": {"type": "object", "properties": {
    "id": {"type": "integer"}, "kind": {"type": "string", "enum": ["question", "follow_up", "other"]},
    "questions": {"type": "array", "items": {"type": "string"}}}, "required": ["id", "kind", "questions"]}}},
    "required": ["turns"]}

ANSWER_SYSTEM = """You read one answer from a stakeholder interview{about} and the question it
answers. Return JSON:

- "brief": one or two plain sentences, in your own words, of what {who} said: their point,
  not a description of the conversation ("Values the orchestra's risk-taking: …", not
  "The interviewee talked about …"). No quotation marks, no judgement of your own.
  Refer to {who} by name or as "they": never "he" or "she", which a name does not tell you.
- "highlights": one to three passages that carry the answer best, each copied EXACTLY
  from {who}'s words in the answer (same spelling, punctuation and fillers), 8 to 45
  words, each from a single turn. Never join two stretches, never fix grammar.
- "also": for any OTHER guide question this answer also speaks to clearly, its id and one
  exact passage (same rules). Usually empty.

Guide questions: {questions}"""

ANSWER_SCHEMA = {"type": "object", "properties": {
    "brief": {"type": "string"},
    "highlights": {"type": "array", "items": {"type": "string"}},
    "also": {"type": "array", "items": {"type": "object", "properties": {
        "question": {"type": "string"}, "quote": {"type": "string"}}, "required": ["question", "quote"]}}},
    "required": ["brief", "highlights", "also"]}

NAMES_SYSTEM = """List every proper name mentioned in this interview transcript{about}: people,
places, organizations, works (pieces of music, books), and named programs. For each give:

- "name": the name as it should be spelled (use the glossary's spelling when it is there),
- "as_said": the name EXACTLY as the transcript writes it, even when misspelled there,
- "kind": person, place, org, work or program,
- "quote": the EXACT words of the transcript where it is first mentioned (5 to 25 words,
  copied character for character, from one turn),
- "referral": true only for a person or group the interviewee suggests the team should
  talk to or hear from.

Skip the interviewer and interviewee themselves, and the organization the interviews are
about. Reply with JSON: {{"names": [...]}}.

Glossary: {glossary}"""

NAMES_SCHEMA = {"type": "object", "properties": {"names": {"type": "array", "items": {"type": "object", "properties": {
    "name": {"type": "string"}, "as_said": {"type": "string"},
    "kind": {"type": "string", "enum": ["person", "place", "org", "work", "program"]},
    "quote": {"type": "string"}, "referral": {"type": "boolean"}}, "required": ["name", "as_said", "kind", "quote", "referral"]}}},
    "required": ["names"]}


def guide_books(corpus: Path) -> tuple[dict | None, dict | None]:
    qs = sm = None
    for f in sorted((corpus / "codebooks").glob("*.json")):
        d = C.load_json(f, {})
        role = ((d.get("ext") or {}).get("upc-interview") or {}).get("role")
        if role == "questions":
            qs = d
        elif role == "summary":
            sm = d
    return qs, sm


def interviews(corpus: Path) -> list[dict]:
    """Live interview sources: {source, transcript rep, text, rows}."""
    out = []
    for sj in sorted(corpus.glob("sources/*/source.json")):
        d = C.load_json(sj, {})
        iv = (d.get("ext") or {}).get("upc-interview")
        if not iv or iv.get("superseded_by"):
            continue
        reps = d.get("representations") or []
        tm = next((r for r in reps if r.get("media_type") == TIMINGS), None)
        tr = next((r for r in reps if tm and r["representation_id"] == tm.get("parent_representation_ref")), None)
        if not tm or not tr:
            continue
        out.append({"source": d, "iv": iv, "rep": tr["representation_id"],
                    "text": (corpus / tr["path"]).read_text(encoding="utf-8"),
                    "rows": C.load_json(corpus / tm["path"], {}).get("segments") or []})
    return out


def turns_of(x: dict) -> list[dict]:
    """Consecutive segments by one speaker (asides and left-out stretches don't break or join a turn)."""
    out = []
    for r in x["rows"]:
        if r.get("left_out"):
            out.append({"speaker": None, "c0": r["c0"], "c1": r["c1"], "start": r["start"], "end": r["end"], "gap": True})
            continue
        if r.get("aside"):
            continue
        if out and out[-1]["speaker"] == r["speaker"] and not out[-1].get("gap"):
            out[-1]["c1"], out[-1]["end"] = r["c1"], r["end"]
        else:
            out.append({"speaker": r["speaker"], "c0": r["c0"], "c1": r["c1"], "start": r["start"], "end": r["end"]})
    for i, t in enumerate(out):
        t["i"] = i
        t["text"] = x["text"][t["c0"]:t["c1"]]
    return out


def interviewer_of(x: dict, turns: list[dict]) -> str | None:
    want = str(x["iv"].get("interviewer") or "")
    names = {t["speaker"] for t in turns if t["speaker"]}
    if want in names:
        return want
    first = want.split(" ")[0].lower()
    hit = next((n for n in names if first and n.lower().split(" ")[0] == first), None)
    if hit:
        return hit
    asks: dict[str, int] = {}
    for t in turns:
        if t["speaker"]:
            asks[t["speaker"]] = asks.get(t["speaker"], 0) + t["text"].count("?")
    return max(asks, key=asks.get) if asks else None


def label_turns(turns: list[dict], who: str, qs: dict, about: str) -> dict[int, dict]:
    guide = [{"id": c["code"], "question": c.get("definition", ""), **(c.get("ext") or {}).get("upc-interview", {})}
             for c in qs["codes"] if not c.get("deprecated")]
    mine = [{"id": t["i"], "at": round(t["start"]), "text": t["text"][:700]} for t in turns if t["speaker"] == who]
    out: dict[int, dict] = {}
    for k in range(0, len(mine), 40):
        user = json.dumps({"about": about, "guide": guide, "interviewer_turns": mine[k:k + 40]}, ensure_ascii=False)
        r = C.llm_chat(LABEL_SYSTEM, user, model=MODEL, max_tokens=4000, temperature=0.0, schema=LABEL_SCHEMA)
        valid = {g["id"] for g in guide}
        for t in (C.parse_json_loose(r["content"]) or {}).get("turns") or []:
            qids = [q.lower() for q in t.get("questions") or [] if q.lower() in valid]
            kind = t.get("kind") if t.get("kind") in ("question", "follow_up", "other") else "other"
            if kind == "question" and not qids:
                kind = "other"
            out[int(t["id"])] = {"kind": kind, "questions": qids}
    return out


def cut_answers(turns: list[dict], who: str, labels: dict[int, dict]) -> list[dict]:
    """[{questions, c0, c1, start, end, asked_at}] from the labelled turns."""
    out, cur = [], None

    def close():
        if cur and cur["parts"]:
            out.append({"questions": cur["questions"], "asked_at": cur["asked_at"],
                        "c0": cur["parts"][0]["c0"], "c1": cur["parts"][-1]["c1"],
                        "start": cur["parts"][0]["start"], "end": cur["parts"][-1]["end"]})
    for t in turns:
        if t.get("gap"):
            close()
            cur = None
            continue
        if t["speaker"] == who:
            lab = labels.get(t["i"], {"kind": "other", "questions": []})
            if lab["kind"] == "question":
                close()
                cur = {"questions": lab["questions"], "asked_at": t["start"], "parts": []}
            elif lab["kind"] == "other":
                close()
                cur = None
            continue
        if cur is not None:
            cur["parts"].append(t)
    close()
    return out


def anchor(corpus: Path, rep: str, set_id: str, recs: list[dict], typ: str) -> list[dict]:
    if not recs:
        return []
    res = C.upc_jsonl("anchor", "--corpus", str(corpus), "--rep", rep, "--set", set_id, "--type", typ, "--normalize",
                      "--tool", TOOL, "--prompt-version", PROMPT_VERSION, records=recs)
    return res.get("results") or []


def unique(text: str, quote: str) -> str | None:
    """The quote as it occurs exactly once, widened by whole words if it repeats."""
    q = quote.strip().strip('"“”')
    n = C.occurrences(text, q)
    if n == 1:
        return q
    if n > 1:
        return C.widen_to_unique(text, q)
    return q   # not found exactly: anchor --normalize may still find it


def first_mention(text: str, words: str, near: str = "") -> str | None:
    """A name's own words where it is first said (inside `near`, the model's quotation, when
    that is found), widened a word at a time until they occur exactly once.

    A name is anchored on its own words, not on the sentence around it: a passage's id is
    its span (spec/03), so a name on a sentence another set already quotes would be that
    passage again, and the name would be lost."""
    words = words.strip()
    if not words:
        return None
    lo = text.find(near) if near and C.occurrences(text, near) == 1 else 0
    i = text.find(words, max(lo, 0))
    if i < 0:
        i = text.lower().find(words.lower())
    if i < 0:
        return None
    a, b = i, i + len(words)
    line0 = text.rfind("\n", 0, i) + 1
    line1 = text.find("\n", b)
    line1 = len(text) if line1 < 0 else line1
    grow_left = False
    while C.occurrences(text, text[a:b]) != 1:
        if grow_left and a > line0:
            k = text.rfind(" ", line0, a - 1)
            a = line0 if k < 0 else k + 1
        elif b < line1:
            k = text.find(" ", b + 1, line1)
            b = line1 if k < 0 else k
        elif a > line0:
            k = text.rfind(" ", line0, a - 1)
            a = line0 if k < 0 else k + 1
        else:
            return None
        grow_left = not grow_left
    return text[a:b]


def code_pass(corpus: Path, x: dict, qs: dict, sm: dict, coder: str, about: str, gl: dict, plan: bool) -> dict:
    turns = turns_of(x)
    who = interviewer_of(x, turns)
    interviewee = x["iv"].get("interviewee") or "the interviewee"
    labels = label_turns(turns, who, qs, about)
    answers = cut_answers(turns, who, labels)
    stats = {"interviewer_turns": sum(1 for t in turns if t["speaker"] == who), "answers": len(answers),
             "questions_asked": sorted({q for a in answers for q in a["questions"]}), "highlights": 0, "dropped": 0,
             "names": 0, "referrals": 0}
    if plan or not answers:
        return stats
    text = x["text"]
    # Answers: exactly their characters, so each is unique by construction (or nearly; widen if not).
    recs = []
    for a in answers:
        q = text[a["c0"]:a["c1"]]
        recs.append({"quote": unique(text, q) or q})
    res = anchor(corpus, x["rep"], SETS["answers"], recs, "x-answer")
    stats["ids"] = {r["extraction_id"] for r in res if r.get("extraction_id")}
    codings, hl_recs, hl_meta = [], [], []
    guide_txt = "; ".join(f"{c['code']}: {c.get('definition', '')}" for c in qs["codes"] if not c.get("deprecated"))
    valid = {c["code"] for c in qs["codes"]}
    for a, r in zip(answers, res):
        if r.get("status") not in ("anchored", "exists", "refound"):
            stats["dropped"] += 1
            continue
        eid = r["extraction_id"]
        for q in a["questions"]:
            codings.append({"codebook_ref": qs["codebook_id"], "code": q, "target": {"kind": "extraction", "id": eid}, "coder": coder})
        qtext = " / ".join(next((c.get("definition", "") for c in qs["codes"] if c["code"] == q), q) for q in a["questions"])
        system = ANSWER_SYSTEM.replace("{about}", about).replace("{who}", interviewee).replace("{questions}", guide_txt)
        user = json.dumps({"question": qtext, "answer": text[a["c0"]:a["c1"]]}, ensure_ascii=False)
        try:
            out = C.parse_json_loose(C.llm_chat(system, user, model=MODEL, max_tokens=2500, temperature=0.1,
                                                schema=ANSWER_SCHEMA)["content"]) or {}
        except C.Unavailable as e:
            print(f"  UNAVAILABLE for one answer: {e}")
            continue
        brief = re.sub(r"\s+", " ", str(out.get("brief") or "")).strip()
        if brief:
            codings.append({"codebook_ref": sm["codebook_id"], "value": brief[:600], "target": {"kind": "extraction", "id": eid},
                            "coder": coder})
        for h in (out.get("highlights") or [])[:3]:
            u = unique(text, h)
            if u:
                hl_recs.append({"quote": u})
                hl_meta.append(a["questions"])
        for al in out.get("also") or []:
            q = str(al.get("question", "")).lower()
            u = unique(text, al.get("quote", ""))
            if q in valid and q not in a["questions"] and u:
                hl_recs.append({"quote": u})
                hl_meta.append([q])
    for r, qids in zip(anchor(corpus, x["rep"], SETS["highlights"], hl_recs, "quote"), hl_meta):
        if r.get("extraction_id"):
            stats["ids"].add(r["extraction_id"])
        if r.get("status") in ("anchored", "exists", "refound"):
            stats["highlights"] += 1
            for q in qids:
                codings.append({"codebook_ref": qs["codebook_id"], "code": q, "target": {"kind": "extraction", "id": r["extraction_id"]},
                                "coder": coder})
        else:
            stats["dropped"] += 1
    # Names, each anchored where it is first said.
    try:
        system = NAMES_SYSTEM.replace("{about}", about).replace("{{", "{").replace("}}", "}") \
            .replace("{glossary}", ", ".join(t["term"] for t in gl["terms"][:300]))
        out = C.parse_json_loose(C.llm_chat(system, text[:120000], model=MODEL, max_tokens=6000, temperature=0.0,
                                            schema=NAMES_SCHEMA)["content"]) or {}
        # Two names in one sentence share its words, and a passage's id is its words (spec/03),
        # so the names ride together on one passage rather than one overwriting the other.
        by_quote: dict[str, list] = {}
        for n in out.get("names") or []:
            q = str(n.get("quote") or "").strip().strip('"“”')
            u = first_mention(text, n.get("as_said") or "", q) or first_mention(text, n.get("name") or "", q)
            if u and n.get("name"):
                by_quote.setdefault(u, []).append({"name": n["name"].strip(), "kind": n.get("kind"),
                                                   "referral": bool(n.get("referral"))})
        names = [{"quote": u, "text": "; ".join(x["name"] for x in group), "ext": {"upc-interview": {"names": group}}}
                 for u, group in by_quote.items()]
        for r, n in zip(anchor(corpus, x["rep"], SETS["names"], names, "entity"), names):
            if r.get("extraction_id"):
                stats["ids"].add(r["extraction_id"])
            if r.get("status") in ("anchored", "exists", "refound"):
                stats["names"] += len(n["ext"]["upc-interview"]["names"])
                stats["referrals"] += sum(1 for y in n["ext"]["upc-interview"]["names"] if y["referral"])
            else:
                stats["dropped"] += 1
    except C.Unavailable as e:
        print(f"  UNAVAILABLE for names: {e}")
    if codings:
        res = C.upc_jsonl("code", "--corpus", str(corpus), "--set", f"cds-{coder}", "--coder-kind", "model",
                          "--model", MODEL, "--tool", TOOL, "--prompt-version", PROMPT_VERSION, records=codings)
        bad = [r for r in res.get("results") or [] if r.get("status") not in ("coded", "unchanged")]
        if bad:
            print(f"  {len(bad)} codings refused, e.g. {bad[0]}")
    return stats


def retire(corpus: Path, source_id: str, keep: set[str], coder: str) -> int:
    """After --redo: the earlier pass's passages for this interview that this one didn't
    find again step aside (status superseded), and so do this coder's codings on them.
    Nothing is deleted; a person's codings are left alone."""
    gone = set()
    # Names are left as they are: a name heard is still heard, whatever a later pass lists.
    for set_id in (SETS["answers"], SETS["highlights"]):
        f = corpus / "extractions" / set_id / "items.jsonl"
        if not f.exists():
            continue
        rows = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        for o in rows:
            if o.get("source_id") == source_id and (o.get("status") or "active") == "active" and o["extraction_id"] not in keep:
                o["status"] = "superseded"
                o.setdefault("ext", {}).setdefault("upc-interview", {})["retired_by"] = f"{TOOL} --redo"
                gone.add(o["extraction_id"])
        f.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in rows), encoding="utf-8")
    items = corpus / "codings" / f"cds-{coder}" / "items.jsonl"
    if gone and items.exists():
        rows = [json.loads(l) for l in items.read_text(encoding="utf-8").splitlines() if l.strip()]
        for c in rows:
            if (c.get("target") or {}).get("id") in gone and c.get("coder") == coder and (c.get("status") or "active") == "active":
                c["status"] = "superseded"
        items.write_text("".join(json.dumps(c, ensure_ascii=False) + "\n" for c in rows), encoding="utf-8")
    return len(gone)


def coded(corpus: Path, source_id: str) -> bool:
    f = corpus / "extractions" / SETS["answers"] / "items.jsonl"
    if not f.exists():
        return False
    return any(json.loads(l).get("source_id") == source_id for l in f.read_text(encoding="utf-8").splitlines() if l.strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--only", help="one interview, by its slug")
    ap.add_argument("--redo", action="store_true", help="code an interview again (identical judgements stay one)")
    ap.add_argument("--plan", action="store_true", help="label the questions and report the answers found; write nothing")
    ap.add_argument("--coder", help="default: settings coders.interview, else <namespace>-<model_tag>-interview-v1")
    a = ap.parse_args()
    corpus = Path(a.corpus).expanduser().resolve()
    try:
        C.check_compat()
        qs, sm = guide_books(corpus)
        if not qs or not sm:
            C.die("no interview guide codebooks: run `make_codebooks.py --corpus <dir> --guide guide.yaml` first")
        st = C.corpus_settings(corpus)
        ivs_set = st.get("interviews") or {}
        about = f" about {ivs_set['about']}" if ivs_set.get("about") else ""
        gpath = ivs_set.get("glossary")
        gl = G.load(corpus / gpath if gpath and not Path(gpath).is_absolute() else gpath)
        coder = a.coder or (st.get("coders") or {}).get("interview") or \
            f"{C.namespace_of(corpus)}-{C.CONFIG.get('model_tag') or 'llm'}-interview-v1"
        todo = [x for x in interviews(corpus) if (not a.only or x["iv"].get("slug") == a.only)
                and (a.redo or not coded(corpus, x["source"]["source_id"]))]
        rows = []
        for x in todo:
            s = code_pass(corpus, x, qs, sm, coder, about, gl, a.plan)
            if a.redo and not a.plan and s.get("ids"):
                s["retired"] = retire(corpus, x["source"]["source_id"], s["ids"], coder)
            rows.append((x["iv"].get("slug"), s))
            print(f"  {x['iv'].get('slug')}: {s['answers']} answers to {', '.join(s['questions_asked']) or 'no guide question'}; "
                  f"{s['highlights']} highlights, {s['names']} names ({s['referrals']} referrals)"
                  + (f"; {s['dropped']} picks not found in the transcript, dropped" if s["dropped"] else "")
                  + (f"; {s['retired']} passages from the earlier pass retired" if s.get("retired") else ""))
        if not a.plan and rows:
            timecode.run(corpus, quiet=True)
            C.upc("regen", str(corpus))
            rep = C.upc("validate", str(corpus))
            print(f"Corpus: {rep.get('status')} {rep.get('level')}, {len(rep.get('errors', []))} errors")
        C.counts_header("Interview coding" + (" (planned)" if a.plan else ""), [
            ("interviews coded", len(rows)), ("answers", sum(s["answers"] for _, s in rows)),
            ("highlights", sum(s["highlights"] for _, s in rows)), ("names", sum(s["names"] for _, s in rows)),
            ("coder", coder)])
    except C.Unavailable as e:
        C.die(str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
