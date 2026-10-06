#!/usr/bin/env python3
"""Compare a freshly built site with the copy already published.

    compare_site.py <built site folder> <published site folder>
    compare_site.py --content <old> <new> [--approved corrections.json] [--all] [--json out.json]
    compare_site.py --calibrate <site folder or single .html file>

Nothing is ever written to either site.

**Files** (the default): are the two folders identical, file for file? Use it
before replacing a hosted site with a rebuild that should change nothing. File
names are compared in Unicode NFC, because macOS keeps some accented names
decomposed (Käsbohrer as a + combining diaeresis) and a plain `diff -r` then
reports the same PDF as missing on one side and extra on the other. Exit 0 when
identical, 1 when they differ, 2 on a usage error.

**Content** (`--content OLD NEW`): does NEW still show everything OLD shows, in
the same places? Use it when a new build is meant to add things (a feature, a
new layer of codes) without changing anything already published. OLD and NEW
are two site folders, or two single-file sites (.html). It compares:

- the passages, papers, schemes, overviews and home summary in the data the
  pages are drawn from (`data/browse.js`, or the single file's `upc-data`), by
  id: a passage's quote, page, paper and chips (as a set), and so on;
- each page's visible words in order: text, tooltips and link targets, with
  every passage card compared on its own, so a card that moves is a change;
- the papers' files (PDFs) and full texts, byte for byte.

A word, field or file that NEW has and OLD hadn't is ADDED. One that OLD had and
NEW lacks or shows differently is CHANGED, unless the --approved file says so
(see APPROVED below). The source text shown around a quotation in the
no-JavaScript view is reported apart: it is a window onto the paper's text,
which is compared in full on the paper's own page. Two things are not content
and are only listed: code and style (`assets/`), and the 320 characters of
context the payloads carried but never showed (fields x and y). Exit 0 when
nothing CHANGED (additions are fine), 1 when something did, 2 on a usage error.

APPROVED corrections, a JSON file the corpus's owner has agreed to:

    {"rewrites": [{"find": "page (\\\\d+) ↗", "replace": "See in original, p. \\\\1 ↗",
                   "where": "*.html", "why": "the new link label"}],
     "passages": {"ext-0123456789ab": {"pg": [2, 3], "why": "page offsets fixed"}}}

A rewrite is a regular expression over a page's words (joined by single spaces,
matched at word boundaries), applied to OLD before the comparison; `where`
matches the page's path (default every page). A passage correction approves that
field's change in the data, and for `pg` also the page number in that passage's
cards ("page 2"/"p. 2", "#page=2", "2nd page").

**Calibration** (`--calibrate SITE`): copies the site to a scratch folder, puts
three known changes into the copy (a word on a page, a passage's page number, a
new chip) and runs the content comparison on the two. It must report exactly
those three: exit 0 when it does, 1 when it doesn't.
"""

from __future__ import annotations

import argparse
import collections
import difflib
import fnmatch
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from html.parser import HTMLParser
from pathlib import Path

IGNORED = {".DS_Store"}


# --------------------------------------------------------------------------- files

def files(root: Path) -> dict[str, Path]:
    out = {}
    for p in root.rglob("*"):
        if p.is_file() and p.name not in IGNORED:
            out[unicodedata.normalize("NFC", p.relative_to(root).as_posix())] = p
    return out


def digest(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def same_bytes(a: Path, b: Path) -> bool:
    return a.stat().st_size == b.stat().st_size and digest(a) == digest(b)


def compare(built: Path, published: Path) -> dict:
    a, b = files(built), files(published)
    both = sorted(set(a) & set(b))
    differ = [k for k in both if not same_bytes(a[k], b[k])]
    return {"built": len(a), "published": len(b), "same": len(both) - len(differ), "differ": differ,
            "only_built": sorted(set(a) - set(b)), "only_published": sorted(set(b) - set(a))}


# --------------------------------------------------------------------------- page words

INLINE = frozenset("a abbr b bdi bdo cite code data dfn em i kbd mark q s samp small span strong "
                   "sub sup time u var wbr".split())
ATTR_WORDS = ("title", "aria-label", "alt", "placeholder")
PASSAGE_ID = re.compile(r"ext-[0-9a-f]{6,}$")
CARD_DATA = ("data-code", "data-coder", "data-source", "data-year")


class PageWords(HTMLParser):
    """What a reader can see on a page, as words: text, tooltips and link targets.

    Each passage card (<article id="ext-…">) becomes its own block, keyed by the
    passage id, and leaves a placeholder (§ext-…) among the page's own words, so a
    card that moves or goes is a change in the page. Inside a card, the source text
    shown around the quotation (<blockquote class="ctx">, outside <mark>) is kept
    apart in `context`. Inline tags (a, span, mark…) don't split words; others do.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.main: list[str] = []
        self.blocks: dict[str, list[str]] = {}
        self.context: dict[str, list[str]] = {}
        self._buf: list[str] = []
        self._block = None   # key of the passage card being read
        self._depth = 0      # <article> nesting inside it
        self._skip = None    # inside <script> or <style>
        self._ctx = 0        # inside <blockquote class="ctx">
        self._mark = 0       # inside <mark> within that blockquote
        self._seen = collections.Counter()

    def _target(self) -> list[str]:
        if self._block is None:
            return self.main
        if self._ctx and not self._mark:
            return self.context.setdefault(self._block, [])
        return self.blocks[self._block]

    def _flush(self):
        if self._buf:
            self._target().extend("".join(self._buf).split())
            self._buf = []

    def handle_starttag(self, tag, attrs):
        if self._skip:
            return
        a = {k: v or "" for k, v in attrs}
        if tag in ("script", "style"):
            self._flush()
            self._skip = tag
            return
        if tag == "article":
            if self._block is not None:
                self._depth += 1
            elif PASSAGE_ID.match(a.get("id", "")):
                self._flush()
                pid = a["id"]
                self._seen[pid] += 1
                key = pid if self._seen[pid] == 1 else f"{pid}#{self._seen[pid]}"
                self.main.append("§" + key)
                self.blocks[key] = [f"@{name[5:]}={v}" for name in CARD_DATA
                                    for v in a.get(name, "").split("|") if v]
                self._block, self._depth = key, 1
                return
        if self._block is not None:
            if tag == "blockquote" and "ctx" in a.get("class", "").split():
                self._flush()
                self._ctx += 1
            elif tag == "mark" and self._ctx:
                self._flush()
                self._mark += 1
        if tag not in INLINE:
            self._buf.append(" ")
        tokens = []
        for name in ATTR_WORDS:
            if a.get(name, "").strip():
                tokens += ["@" + name] + a[name].split()
        if tag == "a" and "href" in a:
            tokens.append("@href=" + "%20".join(a["href"].split()))
        elif tag == "img" and a.get("src"):
            tokens.append("@src=" + "%20".join(a["src"].split()))
        if tokens:
            self._buf.append(" " + " ".join(tokens) + " ")

    def handle_endtag(self, tag):
        if self._skip:
            if tag == self._skip:
                self._skip = None
            return
        if self._block is not None:
            if tag == "article":
                self._depth -= 1
                if self._depth == 0:
                    self._flush()
                    self._block, self._ctx, self._mark = None, 0, 0
                    return
            elif tag == "mark" and self._mark:
                self._flush()
                self._mark -= 1
            elif tag == "blockquote" and self._ctx:
                self._flush()
                self._ctx -= 1
        if tag not in INLINE:
            self._buf.append(" ")

    def handle_data(self, data):
        if not self._skip:
            self._buf.append(data)

    def close(self):
        super().close()
        self._flush()


def page_words(html: str) -> PageWords:
    pw = PageWords()
    pw.feed(html)
    pw.close()
    return pw


# --------------------------------------------------------------------------- approvals

def ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


class Approved:
    """Corrections the owner has agreed to: rewrites of OLD's words, and passage field changes."""

    def __init__(self, path: str | None = None):
        self.path = path
        self.rules: list[tuple[re.Pattern, str, str, str]] = []
        self.passages: dict[str, dict] = {}
        self.used = collections.Counter()
        if path:
            d = json.loads(Path(path).read_text(encoding="utf-8"))
            for r in d.get("rewrites", []):
                pat = re.compile(r"(?<!\S)(?:" + r["find"] + r")(?!\S)")
                self.rules.append((pat, r["replace"], r.get("where", "*"), r.get("why") or r["find"]))
            self.passages = d.get("passages", {})

    def _page_rules(self, pid: str):
        fix = (self.passages.get(pid) or {}).get("pg")
        if not fix or None in fix:
            return []
        a, b = fix
        why = self.passages[pid].get("why") or "page corrected"
        return [(re.compile(rf"(?<!\S)(page|p\.) {a}(?!\S)"), rf"\g<1> {b}", why),
                (re.compile(rf"(?<!\S)(@href=\S*#page=){a}(?!\S)"), rf"\g<1>{b}", why),
                (re.compile(rf"(?<!\S){ordinal(a)}(?!\S)"), ordinal(b), why)]

    @staticmethod
    def _replacement(template: str):
        """A replacement that may say {ordinal:N}: group N as 1st, 2nd, 3rd…"""
        if "{ordinal:" not in template:
            return template
        return lambda m: m.expand(re.sub(r"\{ordinal:(\d+)\}",
                                         lambda k: ordinal(int(m.group(int(k.group(1))))), template))

    def rewrite(self, tokens: list[str], where: str, passage: str | None = None) -> list[str]:
        rules = [(p, self._replacement(r), why) for p, r, w, why in self.rules if fnmatch.fnmatch(where, w)]
        if passage:
            rules += self._page_rules(passage)
        if not rules or not tokens:
            return tokens
        text = " ".join(tokens)
        for pat, rep, why in rules:
            text, n = pat.subn(rep, text)
            self.used[why] += n
        return text.split()

    def field(self, pid: str, name: str, old, new) -> str | None:
        """The reason, when this passage field change is approved."""
        fix = self.passages.get(pid) or {}
        if name in fix and list(fix[name]) == [old, new]:
            return fix.get("why") or f"{name} corrected"
        return None


# --------------------------------------------------------------------------- findings

def short(v, n: int = 90) -> str:
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


class Findings:
    def __init__(self):
        self.items: list[dict] = []
        self.counts: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
        self.notes: list[str] = []
        self.context = collections.Counter()   # page -> cards whose shown context changed
        self.code_style: list[str] = []

    def add(self, kind: str, area: str, where: str, what: str, old=None, new=None):
        self.items.append({"kind": kind, "area": area, "where": where, "what": what,
                           "old": old, "new": new})

    def changed(self, area, where, what, old=None, new=None):
        self.add("changed", area, where, what, old, new)

    def added(self, area, where, what, new=None):
        self.add("added", area, where, what, None, new)

    def approved(self, area, where, what, why, old=None, new=None):
        self.add("approved", area, where, what + f" ({why})", old, new)

    def of(self, kind):
        return [i for i in self.items if i["kind"] == kind]


def diff_words(old: list[str], new: list[str]):
    """Yield ("added" | "changed", old words, new words) for each difference."""
    if old == new:
        return
    sm = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            yield ("added" if tag == "insert" else "changed"), old[i1:i2], new[j1:j2]


def compare_page(where: str, old_html: str, new_html: str, approved: Approved, out: Findings) -> str:
    """Compare one page's words; returns "same", "corrected" (only approved
    corrections) or "changed"."""
    o, n = page_words(old_html), page_words(new_html)
    used = sum(approved.used.values())
    changed = False
    gone, came = [], []
    for kind, a, b in diff_words(approved.rewrite(o.main, where), n.main):
        gone += [t[1:] for t in a if t.startswith("§")]
        came += [t[1:] for t in b if t.startswith("§")]
        words_a = [t for t in a if not t.startswith("§")]
        words_b = [t for t in b if not t.startswith("§")]
        if kind == "added" or not words_a:
            if words_b:
                out.added("page", where, "words", new=" ".join(words_b))
        else:
            changed = True
            out.changed("page", where, "words", " ".join(words_a), " ".join(words_b))
    for c in gone:
        changed = True
        out.changed("page", where, f"passage card {c} " + ("moved" if c in came else "gone"))
    for c in came:
        if c not in gone:
            out.added("page", where, f"passage card {c}")
    for key, old_tokens in o.blocks.items():
        if key not in n.blocks:
            continue   # reported above, from the placeholders
        here = f"{where} · {key}"
        for kind, a, b in diff_words(approved.rewrite(old_tokens, where, key.split("#")[0]), n.blocks[key]):
            if kind == "added":
                out.added("page", here, "words", new=" ".join(b))
            else:
                changed = True
                out.changed("page", here, "words", " ".join(a), " ".join(b))
        if o.context.get(key) != n.context.get(key):
            out.context[where] += 1
    if changed:
        return "changed"
    return "corrected" if sum(approved.used.values()) > used else "same"


# --------------------------------------------------------------------------- data payloads

HIDDEN = {"x", "y"}         # context the payloads carried and no page ever showed
POSITIONAL = {"i"}          # a paper's index in the list; the order is checked on its own
CHIP_KEY = 3                # a chip is [scheme, code, coder, confidence, why]


def read_payload(site: Path) -> tuple[dict, dict[str, str], str]:
    """The data a site's pages are drawn from, its papers' full texts (single file
    only) by slug, and the HTML around them (single file only)."""
    if site.is_dir():
        raw = (site / "data" / "browse.js").read_text(encoding="utf-8")
        m = re.match(r"\s*window\.__UPCB_DATA\s*=\s*(.*?);?\s*$", raw, re.S)
        if not m:
            raise ValueError(f"{site}/data/browse.js is not a browse payload")
        return json.loads(m.group(1)), {}, ""
    html = site.read_text(encoding="utf-8")
    m = re.search(r'<script type="application/json" id="upc-data">(.*?)</script>', html, re.S)
    if not m:
        raise ValueError(f"{site} has no upc-data block: not a single-file site")
    data = json.loads(m.group(1))
    slugs = [s.get("sl") for s in data.get("sources", [])]
    texts = {}
    for idx, body in re.findall(r'<script type="application/json" id="upc-t(\d+)">(.*?)</script>', html, re.S):
        i = int(idx)
        texts[slugs[i] if i < len(slugs) else f"#{i}"] = json.loads(body)
    shell = re.sub(r'<script type="application/json" id="upc-[^"]*">.*?</script>', "", html, flags=re.S)
    return data, texts, shell


def chips(rows) -> dict[tuple, tuple]:
    return {tuple(r[:CHIP_KEY]): tuple(r[CHIP_KEY:]) for r in rows or []}


def chip_label(k: tuple) -> str:
    return f"{k[0]}:{k[1]} by {k[2]}" if len(k) >= 3 else ":".join(map(str, k))


def check_order(area: str, old_keys: list, new_keys: list, out: Findings):
    in_old, in_new = set(old_keys), set(new_keys)
    a = [k for k in old_keys if k in in_new]
    b = [k for k in new_keys if k in in_old]
    if a != b:
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        kept = sum(m.size for m in sm.get_matching_blocks())
        out.changed(area, "order", f"{len(a) - kept} of {len(a)} in a different order")


def worst(*states: str) -> str:
    return "changed" if "changed" in states else "corrected" if "corrected" in states else "same"


def compare_record(area: str, key: str, a: dict, b: dict, out: Findings, approved: Approved,
                   skip=frozenset(), label: str = "") -> str:
    """Fields of one record; returns "same", "corrected" or "changed"."""
    where = f"{key} ({label})" if label else key
    state = "same"
    for f, v in a.items():
        if f in skip or f in POSITIONAL:
            continue
        if f in HIDDEN:
            if f not in b:
                out.counts[area][f"{f} (never shown) dropped from"] += 1
            continue
        if f not in b:
            out.changed(area, where, f"{f} removed", v)
            state = "changed"
        elif f == "g":
            ca, cb = chips(v), chips(b[f])
            for ck, cv in ca.items():
                if ck not in cb:
                    out.changed(area, where, f"chip gone: {chip_label(ck)}")
                    state = "changed"
                elif cb[ck] != cv:
                    out.changed(area, where, f"chip {chip_label(ck)}", list(cv), list(cb[ck]))
                    state = "changed"
            for ck in cb:
                if ck not in ca:
                    out.added(area, where, f"chip {chip_label(ck)}")
        elif b[f] != v:
            why = approved.field(key, f, v, b[f])
            if why:
                out.approved(area, where, f, why, v, b[f])
                state = worst(state, "corrected")
            else:
                out.changed(area, where, f, v, b[f])
                state = "changed"
    for f in b:
        if f not in a and f not in skip:
            out.counts[area][f"new field {f} on"] += 1
    return state


def tally() -> collections.Counter:
    return collections.Counter({"same": 0, "corrected": 0, "changed": 0, "new": 0})


def compare_keyed(area: str, old_list: list, new_list: list, key: str, out: Findings,
                  each) -> collections.Counter:
    """Records matched by `key`, each compared by `each(key, old, new)`."""
    o = {r.get(key): r for r in old_list}
    n = {r.get(key): r for r in new_list}
    t = tally()
    for k, r in o.items():
        if k not in n:
            out.changed(area, str(k), "gone")
            t["changed"] += 1
        else:
            t[each(k, r, n[k])] += 1
    for k in n:
        if k not in o:
            out.added(area, str(k), "new")
            t["new"] += 1
    check_order(area, list(o), list(n), out)
    return t


def compare_html_field(area: str, where: str, a: str, b: str, approved: Approved, out: Findings) -> str:
    used = sum(approved.used.values())
    state = "same"
    for kind, x, y in diff_words(approved.rewrite(page_words(a or "").main, where), page_words(b or "").main):
        if kind == "added" or not x:
            out.added(area, where, "words", new=" ".join(y))
        else:
            out.changed(area, where, "words", " ".join(x), " ".join(y))
            state = "changed"
    return worst(state, "corrected" if sum(approved.used.values()) > used else "same")


def compare_payload(old: dict, new: dict, approved: Approved, out: Findings) -> dict:
    counts = {}
    slug_old = [s.get("sl") for s in old.get("sources", [])]
    slug_new = [s.get("sl") for s in new.get("sources", [])]
    keys = {s.get("sl"): s.get("k") or "" for s in old.get("sources", [])}

    counts["papers"] = compare_keyed(
        "paper", old.get("sources", []), new.get("sources", []), "sl", out,
        lambda k, a, b: compare_record("paper", k, a, b, out, approved, label=a.get("k", "")))

    def slug(rec, slugs):
        s = rec.get("s")
        return slugs[s] if isinstance(s, int) and 0 <= s < len(slugs) else s

    def passage(k, a, b):
        sa, sb = slug(a, slug_old), slug(b, slug_new)
        state = "same"
        if sa != sb:
            out.changed("passage", f"{k} ({keys.get(sa, '')})", "paper", sa, sb)
            state = "changed"
        return worst(state, compare_record("passage", k, a, b, out, approved, skip={"s"}, label=keys.get(sa, "")))

    counts["passages"] = compare_keyed("passage", old.get("passages", []), new.get("passages", []),
                                       "id", out, passage)

    def scheme(k, a, b):
        state = compare_record("scheme", k, a, b, out, approved, skip={"codes"})
        ca = {c.get("code"): c for c in a.get("codes", [])}
        cb = {c.get("code"): c for c in b.get("codes", [])}
        for code, c in ca.items():
            if code not in cb:
                out.changed("scheme", k, f"code gone: {code}")
                state = "changed"
            else:
                state = worst(state, compare_record("scheme", f"{k}:{code}", c, cb[code], out, approved))
        for code in cb:
            if code not in ca:
                out.added("scheme", k, f"code {code}")
        check_order("scheme", [f"{k}:{c}" for c in ca], [f"{k}:{c}" for c in cb], out)
        return state

    counts["schemes"] = compare_keyed("scheme", old.get("codebooks", []), new.get("codebooks", []),
                                      "slug", out, scheme)

    def overview(k, a, b):
        where = f"{k} ({a.get('t', '')})"
        return worst(compare_record("overview", k, a, b, out, approved, skip={"h"}, label=a.get("t", "")),
                     compare_html_field("overview", where, a.get("h"), b.get("h"), approved, out))

    if "overviews" in old or "overviews" in new:
        counts["overviews"] = compare_keyed("overview", old.get("overviews") or [], new.get("overviews") or [],
                                            "id", out, overview)
    if "home" in old or "home" in new:
        a, b = old.get("home") or {}, new.get("home") or {}
        t = tally()
        t[worst(compare_record("home", "home summary", a, b, out, approved, skip={"h"}),
                compare_html_field("home", "home summary", a.get("h"), b.get("h"), approved, out))] += 1
        counts["home summary"] = t

    done = {"sources", "passages", "codebooks", "overviews", "home"}
    for k, v in old.items():
        if k in done:
            continue
        if k not in new:
            out.changed("data", k, "gone", v)
        elif isinstance(v, dict) and isinstance(new[k], dict):
            for kk, vv in v.items():
                if kk not in new[k]:
                    out.changed("data", f"{k}.{kk}", "gone", vv)
                elif new[k][kk] != vv:
                    out.changed("data", f"{k}.{kk}", "value", vv, new[k][kk])
            for kk in new[k]:
                if kk not in v:
                    out.added("data", f"{k}.{kk}", "new", new[k][kk])
        elif new[k] != v:
            out.changed("data", k, "value", v, new[k])
    for k in new:
        if k not in old:
            out.added("data", k, "new")
    return counts


# --------------------------------------------------------------------------- content

def describe(site: Path, data: dict, pages: int | None) -> str:
    kind = "folder site" if site.is_dir() else "single file"
    bits = [f"{pages} pages"] if pages is not None else []
    bits += [f"{len(data.get('sources', []))} papers", f"{len(data.get('passages', []))} passages",
             f"{len(data.get('codebooks', []))} schemes"]
    return f"{kind}: " + " · ".join(bits)


def compare_content(old: Path, new: Path, approved: Approved | None = None) -> dict:
    approved = approved or Approved()
    out = Findings()
    od, otexts, oshell = read_payload(old)
    nd, ntexts, nshell = read_payload(new)
    counts = compare_payload(od, nd, approved, out)
    pages = None
    if old.is_dir():
        fo, fn = files(old), files(new)
        counts["pages"], counts["files"] = tally(), tally()
        for rel in sorted(set(fo) | set(fn)):
            a, b = fo.get(rel), fn.get(rel)
            if rel == "data/browse.js":
                continue
            if rel.startswith("assets/"):
                if a is None or b is None or not same_bytes(a, b):
                    out.code_style.append(rel + (" (new)" if a is None else " (gone)" if b is None else ""))
                continue
            if rel.endswith(".html"):
                t = counts["pages"]
                if a is None:
                    out.added("page", rel, f"new page ({len(page_words(b.read_text(encoding='utf-8')).main):,} words)")
                    t["new"] += 1
                elif b is None:
                    out.changed("page", rel, "page gone")
                    t["changed"] += 1
                elif same_bytes(a, b):
                    t["same"] += 1
                else:
                    t[compare_page(rel, a.read_text(encoding="utf-8"), b.read_text(encoding="utf-8"),
                                   approved, out)] += 1
                continue
            t = counts["files"]
            if a is None:
                out.added("file", rel, "new file")
                t["new"] += 1
            elif b is None:
                out.changed("file", rel, "file gone")
                t["changed"] += 1
            elif same_bytes(a, b):
                t["same"] += 1
            else:
                out.changed("file", rel, "bytes differ")
                t["changed"] += 1
        pages = sum(1 for r in fo if r.endswith(".html"))
    else:
        counts["page"] = tally()
        counts["page"][compare_page(old.name, oshell, nshell, approved, out)] += 1
        if otexts or ntexts:
            t = counts["full texts"] = tally()
            for slug in sorted(set(otexts) | set(ntexts)):
                if slug not in ntexts:
                    out.changed("full text", slug, "gone")
                    t["changed"] += 1
                elif slug not in otexts:
                    out.added("full text", slug, "new")
                    t["new"] += 1
                elif otexts[slug] != ntexts[slug]:
                    out.changed("full text", slug, "text differs")
                    t["changed"] += 1
                else:
                    t["same"] += 1
    new_pages = sum(1 for r in files(new) if r.endswith(".html")) if new.is_dir() else None
    return {"old": str(old), "new": str(new), "old_desc": describe(old, od, pages),
            "new_desc": describe(new, nd, new_pages), "tally": counts, "findings": out, "approved": approved}


def plural(n: int, one: str, many: str) -> str:
    return f"{n:,} {one if n == 1 else many}"


def print_content(r: dict, show_all: bool = False) -> int:
    out: Findings = r["findings"]
    approved: Approved = r["approved"]
    limit = None if show_all else 40
    print("## Content comparison\n")
    print(f"  old   {r['old']}\n        ({r['old_desc']})")
    print(f"  new   {r['new']}\n        ({r['new_desc']})")
    if approved.path:
        print(f"  approved corrections  {approved.path}\n        ({plural(len(approved.rules), 'rewrite', 'rewrites')}, "
              f"{plural(len(approved.passages), 'passage correction', 'passage corrections')})")
    print()
    for name, t in r["tally"].items():
        line = f"  {name:14} {t['same']:>6,} unchanged · "
        if t["corrected"]:
            line += f"{t['corrected']:,} corrected as approved · "
        print(line + f"{t['changed']:,} changed · {t['new']:,} new")
    for area, c in out.counts.items():
        for what, n in sorted(c.items()):
            print(f"  {area:14} {what} {plural(n, area, area + 's')}")
    print()

    def show(title, items):
        print(f"{title} ({len(items):,})")
        for it in items[:limit]:
            print("  " + fmt(it))
        if limit is not None and len(items) > limit:
            print(f"  … and {len(items) - limit:,} more (--all lists them)")
        print()

    def fmt(it):
        s = f"{it['area']:9} {it['where']}  {it['what']}"
        if it["kind"] == "added":
            return s + (f"  “{short(it['new'])}”" if it["new"] is not None else "")
        if it["old"] is not None or it["new"] is not None:
            s += f"  “{short(it['old'] if it['old'] is not None else '')}” → “{short(it['new'] if it['new'] is not None else '')}”"
        return s

    changed, added = out.of("changed"), out.of("added")
    show("CHANGED", changed)
    show("ADDED", added)
    used = [(why, n) for why, n in approved.used.most_common() if n]
    field_ok = out.of("approved")
    if used or field_ok:
        print(f"APPROVED ({sum(n for _, n in used) + len(field_ok):,})")
        for why, n in used:
            print(f"  {n:>6,} × {why} (on the pages)")
        for it in field_ok[:limit]:
            print("  " + fmt(it))
        print()
    if out.context:
        n = sum(out.context.values())
        print(f"CONTEXT ({plural(n, 'card', 'cards')} on {plural(len(out.context), 'page', 'pages')}): the source text "
              "shown around the quotation in the no-JavaScript view differs. The quotations are compared "
              "above, and each paper's full text on its own page.\n")
    if out.code_style:
        print("NOT COMPARED (code and style): " + ", ".join(out.code_style) + "\n")
    if changed:
        print(f"CHANGED: {plural(len(changed), 'thing', 'things')} a reader of the old site would find different "
              "(listed above).")
        return 1
    print(f"SAME CONTENT: everything the old site shows is unchanged and in place; "
          f"{plural(len(added), 'addition', 'additions')}.")
    return 0


def findings_json(r: dict) -> dict:
    out: Findings = r["findings"]
    return {"old": r["old"], "new": r["new"], "tally": r["tally"], "items": out.items,
            "counts": {k: dict(v) for k, v in out.counts.items()}, "context": dict(out.context),
            "code_style": out.code_style, "approved": dict(r["approved"].used)}


# --------------------------------------------------------------------------- calibration

def _swap_word(html: str, start: int = 0) -> tuple[str, str]:
    """Replace the first visible word of six letters or more after `start`."""
    for m in re.finditer(r">([^<>]+)<", html[start:]):
        w = re.search(r"\b[A-Za-z]{6,}\b", m.group(1))
        if w:
            at = start + m.start(1) + w.start()
            return html[:at] + "Calibrated" + html[at + len(w.group()):], w.group()
    raise ValueError("no word to change")


def _inject_payload(data: dict) -> list[tuple]:
    ps = data["passages"]
    p0, p1 = ps[0], ps[1]
    p0["pg"] = (p0.get("pg") or 0) + 1
    p1.setdefault("g", []).append(["calibration", "injected", "calibration-check", "high", ""])
    return [("changed", "passage", p0["id"], "pg"),
            ("added", "passage", p1["id"], "chip calibration:injected by calibration-check")]


def calibrate(site: Path) -> tuple[bool, list[str]]:
    with tempfile.TemporaryDirectory(prefix="compare-site-") as tmp:
        tmp = Path(tmp)
        if site.is_dir():
            copy = tmp / site.name
            for p in site.rglob("*"):
                dest = copy / p.relative_to(site)
                if p.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                if p.relative_to(site).parts[0] == "files":
                    try:
                        os.link(p, dest)
                        continue
                    except OSError:
                        pass
                shutil.copy2(p, dest)
            pages = sorted(p for p in (copy / "overviews").glob("*.html") if p.name != "index.html") \
                or [copy / "index.html"]
            page = pages[0]
            html = page.read_text(encoding="utf-8")
            html, word = _swap_word(html, max(0, html.find("<main")))
            page.write_text(html, encoding="utf-8")
            rel = page.relative_to(copy).as_posix()
            expected = [("changed", "page", rel, "words")]
            browse = copy / "data" / "browse.js"
            data, _, _ = read_payload(copy)
            expected += _inject_payload(data)
            browse.write_text("window.__UPCB_DATA=" + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
        else:
            copy = tmp / site.name
            html = site.read_text(encoding="utf-8")
            m = re.search(r'(<script type="application/json" id="upc-data">)(.*?)(</script>)', html, re.S)
            data = json.loads(m.group(2))
            if data.get("overviews"):
                target, area, where = data["overviews"][0], "overview", data["overviews"][0]["id"]
            else:
                target, area, where = data["home"], "home", "home summary"
            target["h"], word = _swap_word(target["h"])
            expected = [("changed", area, where, "words")]
            expected += _inject_payload(data)
            body = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
            copy.write_text(html[: m.start(2)] + body + html[m.end(2):], encoding="utf-8")
        r = compare_content(site, copy)
    out: Findings = r["findings"]
    found = out.of("changed") + out.of("added")
    lines = [f"injected: “{word}” → “Calibrated” on {expected[0][2]}; "
             f"passage {expected[1][2]} page +1; a chip on passage {expected[2][2]}"]
    ok = len(found) == 3
    for kind, area, where, what in expected:
        hit = [f for f in found if f["kind"] == kind and f["area"] == area
               and f["where"].split(" ")[0] == where.split(" ")[0] and f["what"].startswith(what)]
        lines.append(f"  {'found' if hit else 'MISSED':6} {kind} {area} {where} {what}")
        ok = ok and bool(hit)
    for f in found:
        lines.append(f"  reported: {f['kind']} {f['area']} {f['where']} {f['what']}")
    return ok, lines


# --------------------------------------------------------------------------- command line

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="built and published folders; OLD and NEW with --content; "
                                             "one site with --calibrate")
    ap.add_argument("--content", action="store_true", help="compare what the two sites show, not their bytes")
    ap.add_argument("--calibrate", action="store_true", help="check the content comparison on a copy with three known changes")
    ap.add_argument("--approved", help="JSON file of approved corrections (--content)")
    ap.add_argument("--all", action="store_true", help="list every finding, not the first 40 of each kind")
    ap.add_argument("--json", dest="json_out", help="also write every finding to this JSON file")
    args = ap.parse_args()
    paths = [Path(p).expanduser() for p in args.paths]

    if args.calibrate:
        if len(paths) != 1 or not paths[0].exists():
            print("--calibrate takes one site folder or single-file site", file=sys.stderr)
            return 2
        ok, lines = calibrate(paths[0])
        print("## Content comparison calibration\n")
        print("\n".join(lines))
        print("\nCALIBRATED: the comparison found exactly the three injected changes." if ok
              else "\nNOT CALIBRATED: the comparison did not find exactly the three injected changes.")
        return 0 if ok else 1

    if len(paths) != 2:
        print("give two sites: built and published (or OLD and NEW with --content)", file=sys.stderr)
        return 2
    if args.content:
        a, b = paths
        if not ((a.is_dir() and b.is_dir()) or (a.is_file() and b.is_file())):
            print("--content compares two site folders or two single-file sites", file=sys.stderr)
            return 2
        try:
            r = compare_content(a, b, Approved(args.approved))
        except (ValueError, OSError, json.JSONDecodeError) as e:
            print(f"cannot compare: {e}", file=sys.stderr)
            return 2
        if args.json_out:
            Path(args.json_out).write_text(json.dumps(findings_json(r), ensure_ascii=False, indent=1), encoding="utf-8")
        return print_content(r, args.all)

    built, published = paths
    for p in (built, published):
        if not p.is_dir():
            print(f"not a folder: {p}", file=sys.stderr)
            return 2
    r = compare(built, published)
    print("## Site comparison\n")
    print(f"  built       {built}  ({r['built']} files)")
    print(f"  published   {published}  ({r['published']} files)")
    print(f"  identical   {r['same']}")
    print(f"  differ      {len(r['differ'])}")
    print(f"  only built  {len(r['only_built'])}")
    print(f"  only published {len(r['only_published'])}\n")
    for label, names in (("differs", r["differ"]), ("new", r["only_built"]), ("gone", r["only_published"])):
        for name in names[:20]:
            print(f"  {label:8} {name}")
        if len(names) > 20:
            print(f"  {label:8} … and {len(names) - 20} more")
    if not (r["differ"] or r["only_built"] or r["only_published"]):
        print("IDENTICAL: publishing this build would change nothing.")
        return 0
    print("DIFFERENT: publishing this build would change the files listed above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
