"""A project's glossary: the names and terms a speech engine gets wrong, and how.

    glossary.yaml
      revision: 3
      terms:
        - {term: Riverbend Symphony, kind: org, heard: [Riverbed Symphony], note: …, source: …}
        - {term: Hollenbeck Hall, kind: place, heard: [Hollen Beck Hall, Hollenbek Hall]}

`heard` lists misrecognitions that are safe to replace everywhere, whole words only:
`apply` replaces them in a transcript and logs every change. A spelling the engine
invents that is close to a term but not listed (`Hollenbock Hall`) is not replaced: it
is reported by `near_misses`, so a person can add it to `heard` (or not). Kinds:
person, place, org, work, program, term.

The glossary also primes Whisper (`prompt`): an initial prompt with the terms makes it
spell them right more often. Parakeet takes no prompt, which is why `apply` exists.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
from pathlib import Path

KINDS = ("person", "place", "org", "work", "program", "term")
_WORD = re.compile(r"[\w'’-]+")
_SAID = re.compile(r"[\w'’-]+|&")


def load(path: str | Path | None) -> dict:
    """{revision, terms[], digest}. A missing file is an empty glossary, not an error."""
    if not path or not Path(path).exists():
        return {"revision": 0, "terms": [], "digest": None}
    import yaml  # noqa: PLC0415
    d = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    terms = []
    for t in d.get("terms") or []:
        if isinstance(t, str):
            t = {"term": t}
        if not t.get("term"):
            continue
        kind = t.get("kind") or "term"
        if kind not in KINDS:
            raise ValueError(f"glossary term {t['term']!r}: kind {kind!r} is not one of {', '.join(KINDS)}")
        terms.append({"term": str(t["term"]).strip(), "kind": kind,
                      "heard": [str(h).strip() for h in t.get("heard") or [] if str(h).strip()],
                      **({"note": t["note"]} if t.get("note") else {})})
    body = json.dumps([[t["term"], t["heard"]] for t in terms], ensure_ascii=False, sort_keys=True)
    return {"revision": int(d.get("revision") or 1), "terms": terms,
            "digest": "sha256:" + hashlib.sha256(body.encode()).hexdigest()}


def _pattern(variant: str) -> re.Pattern:
    # Whole words, any case, any run of spaces or a hyphen between the words.
    words = [re.escape(w) for w in re.split(r"[\s-]+", variant.strip()) if w]
    return re.compile(r"(?<![\w'’])" + r"[\s-]+".join(words) + r"(?![\w’]|'\w)", re.IGNORECASE)


def rules(g: dict) -> list[tuple[re.Pattern, str, str]]:
    """(pattern, replacement, variant), longest variant first so "Riverbed Symphony
    Orchestra" wins over "Riverbed"."""
    out = []
    for t in g["terms"]:
        for h in t["heard"]:
            if h.lower() != t["term"].lower():
                out.append((_pattern(h), t["term"], h))
        # A name in the wrong case ("music in the parks") takes the glossary's; a plain
        # term (kind `term`) doesn't, since it may be an ordinary word in a sentence.
        if t["kind"] != "term":
            out.append((_pattern(t["term"]), t["term"], t["term"]))
    return sorted(out, key=lambda r: -len(r[2]))


def apply(text: str, g: dict, compiled: list | None = None) -> tuple[str, list[dict]]:
    """(text with every listed misrecognition replaced, [{heard, term, at}]). `at` is the
    character offset in the *original* text."""
    changes = []
    spans: list[tuple[int, int, str, str]] = []
    taken = [False] * (len(text) + 1)
    for pat, term, variant in compiled if compiled is not None else rules(g):
        for m in pat.finditer(text):
            if any(taken[m.start():m.end()]):
                continue
            for i in range(m.start(), m.end()):
                taken[i] = True
            spans.append((m.start(), m.end(), term, m.group(0)))
    if not spans:
        return text, []
    out, last = [], 0
    for a, b, term, was in sorted(spans):
        out.append(text[last:a])
        out.append(term)
        last = b
        if was != term:
            changes.append({"heard": was, "term": term, "at": a})
    out.append(text[last:])
    return "".join(out), changes


def _key(s: str) -> str:
    """A rough sound-alike key: lower case, letters only, doubled letters once, vowels
    after the first letter dropped (Hollenbeck, Hollenbek -> hlnbck, hlnbk)."""
    s = re.sub(r"[^a-z]", "", s.lower())
    if not s:
        return ""
    s = re.sub(r"(.)\1+", r"\1", s)
    return s[0] + re.sub(r"[aeiouyhw]", "", s[1:])


def near_misses(text: str, g: dict, cutoff: float = 0.82, limit: int = 200) -> list[dict]:
    """Spellings in `text` close to a term (same number of words, similar letters or the
    same sound-alike key) that are neither the term nor a listed `heard`. A suggestion for
    a person, never a replacement. [{term, heard, count, first_at}]"""
    def said(x: str) -> list[str]:   # "&" is said "and": "Copper & Kettle" is three words
        return ["and" if w == "&" else w for w in _SAID.findall(x)]

    def words(x: str) -> str:
        return " ".join(said(x)).lower()
    known = {words(t["term"]) for t in g["terms"]} | {words(h) for t in g["terms"] for h in t["heard"]}
    plain = {w.lower() for t in g["terms"] for w in _WORD.findall(t["term"])}
    tokens = [(m.group(0), m.start()) for m in _SAID.finditer(text)]
    # Text already spelled as a term ("Port Royal Symphony") is right: no window that
    # touches it ("Royal Symphony is") is a near-miss of anything.
    right = [False] * (len(text) + 1)
    for t in g["terms"]:
        for m in _pattern(t["term"]).finditer(text):
            for i in range(m.start(), m.end()):
                right[i] = True
    found: dict[tuple[str, str], dict] = {}
    # Longest terms first, and a stretch one of them claims is not tried for a shorter one:
    # "Riverbnd Symphony and Friends" is Riverbend Symphony & Friends, not Riverbend Symphony.
    claimed = [False] * (len(text) + 1)
    for t in sorted(g["terms"], key=lambda t: -len(said(t["term"]))):
        tw = said(t["term"])
        n = len(tw)
        tl, tk = " ".join(tw).lower(), _key(t["term"])
        if len(tl) < 5:   # short words are too easy to confuse with ordinary ones
            continue
        for i in range(len(tokens) - n + 1):
            win = tokens[i:i + n]
            a, b = win[0][1], win[-1][1] + len(win[-1][0])
            if win[0][0] == "&" or any(right[a:b]) or any(claimed[a:b]):
                continue
            cand = " ".join(w for w, _ in win)
            cl = re.sub(r"['’]s$", "", cand.lower())   # "Riverbend Symphony's" is the term, possessive
            cand = cand[:len(cl)] if cl != cand.lower() else cand
            if cl in known or cl == tl:
                continue
            if n == 1 and cl in plain:
                continue
            if n > 1 and not cand[0].isupper():   # a misheard name usually still starts as one
                continue
            ratio = difflib.SequenceMatcher(None, words(cl), tl).ratio()
            if ratio < cutoff and not (_key(cand) == tk and ratio >= 0.6):
                continue
            claimed[a:b] = [True] * (b - a)
            k = (t["term"], cand)
            if k not in found:
                found[k] = {"term": t["term"], "heard": cand, "count": 0, "first_at": a,
                            "similarity": round(ratio, 2)}
            found[k]["count"] += 1
    return sorted(found.values(), key=lambda x: (-x["count"], x["first_at"]))[:limit]


def prompt(g: dict, limit: int = 600) -> str:
    """Whisper's initial prompt: the terms, people and places first, up to `limit` characters
    (Whisper reads about 224 tokens of prompt)."""
    order = {"person": 0, "place": 1, "org": 2, "program": 3, "work": 4, "term": 5}
    out, n = [], 0
    for t in sorted(g["terms"], key=lambda t: order.get(t["kind"], 9)):
        if n + len(t["term"]) + 2 > limit:
            break
        out.append(t["term"])
        n += len(t["term"]) + 2
    return ", ".join(out) + ("." if out else "")
