"""Reading a UPC corpus for a projection: the read-only helpers the digest and
the nonprofit site share.

Nothing here writes to a corpus or mints an id (the `upc` CLI does that). It
reads sources, extractions and generations, re-checks every quotation against
the stored bytes, fetches a page's own preview image, and checks a rendered
page for strings that must not be published.

    cards(corpus)              digest cards (summary generations), each pull quote re-checked
    generations(corpus, type)  every generation of a type, with its output text
    check_extraction(corpus, extraction_id)
                               the extraction's quote, found again at its locator in the
                               stored representation (raises when it is not)
    suppressed_in(pages, words)
                               where a suppressed string would appear
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import subprocess
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import common as C

# A polite crawler names itself and a contact (the config's "agent_name" and "contact").
UA = f"{C.CONFIG.get('agent_name') or 'upc-corpus'} digest" + (f" (+mailto:{C.CONFIG['contact']})" if C.CONFIG.get("contact") else "")
KIND_LABEL = {"program-note": "Program note", "liner-note": "Liner note", "essay": "Essay", "musicology": "Musicology",
              "review": "Review", "interview": "Interview", "news": "News", "reference": "Reference",
              "biography": "Biography", "other": "Reading"}
KIND_ORDER = list(KIND_LABEL)
MARKER = re.compile(r'"([^"\n]+)"\s?\[(ext-[0-9a-f]{12})\]')
EXT_ID = re.compile(r"\[(ext-[0-9a-f]{12})\]")


def esc(x) -> str:
    return html.escape(str(x or ""), quote=True)

def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()] if p.exists() else []

def extractions(corpus: Path) -> dict[str, dict]:
    out = {}
    for p in list(corpus.glob("sources/*/extractions.jsonl")) + list(corpus.glob("extractions/*/items.jsonl")):
        for e in read_jsonl(p):
            out[e["extraction_id"]] = e
    return out

def sources(corpus: Path) -> dict[str, dict]:
    out = {}
    for sj in corpus.glob("sources/*/source.json"):
        s = C.load_json(sj, {})
        if s.get("source_id"):
            out[s["source_id"]] = {**s, "_dir": sj.parent}
    return out

def meta_content(h: str, *names: str) -> str | None:
    """A <meta> tag's content (same rule as deep-research's page_meta)."""
    for n in names:
        for pat in (rf'<meta\s[^>]*?(?:property|name)=["\']{re.escape(n)}["\'][^>]*?content=(?:"([^"]*)"|\'([^\']*)\')',
                    rf'<meta\s[^>]*?content=(?:"([^"]*)"|\'([^\']*)\')[^>]*?(?:property|name)=["\']{re.escape(n)}["\']'):
            m = re.search(pat, h, re.I)
            if m and (m.group(1) or m.group(2)):
                return html.unescape(m.group(1) or m.group(2)).strip()
    return None

def clean_author(a: str | None) -> str | None:
    """An author meta value a reader can use: not a web address or a profile link, not a
    paragraph. None otherwise."""
    a = re.sub(r"\s+", " ", (a or "")).strip().strip(",")
    if not a or re.search(r"https?://|www\.|\.com\b|@", a) or len(a) > 80:
        return None
    if re.fullmatch(r"[\w.-]+", a) and re.search(r"\d|_", a):  # a username or a CMS slug ("staging_hzx76o")
        return None
    return a


def clean_site(s: str | None) -> str | None:
    """A site name without the separator a title template leaves behind ("Runyan Program Notes -")."""
    s = re.sub(r"\s+", " ", (s or "")).strip().rstrip("-–—|·:").strip()
    return s or None


def page_facts(s: dict) -> dict:
    """What a saved page says about itself: re-read from its stored raw HTML."""
    raw = next((r for r in s.get("representations", []) if r.get("role") == "raw_html"), None)
    if not raw or not s.get("_dir"):
        return {}
    f = Path(s["_dir"]).parents[1] / raw["path"]
    if not f.exists():
        return {}
    h = f.read_text(encoding="utf-8", errors="replace")[:400_000]
    out = {"title": meta_content(h, "og:title", "twitter:title"), "site_name": clean_site(meta_content(h, "og:site_name")),
           "author": clean_author(meta_content(h, "author", "article:author", "parsely-author"))}
    return {k: v for k, v in out.items() if v}

def cards(corpus: Path) -> list[dict]:
    """Every digest card: the generation, its summary and pull quote, its source."""
    srcs, exts = sources(corpus), extractions(corpus)
    out = []
    for gj in corpus.glob("sources/*/generated/gen-*.json"):
        g = C.load_json(gj, {})
        meta = ((g.get("ext") or {}).get("hermes") or {}).get("digest_card")
        if not meta or not (g.get("output") or {}).get("path"):
            continue
        text = (corpus / g["output"]["path"]).read_text(encoding="utf-8")
        m = MARKER.search(text)
        summary = MARKER.sub("", text).replace("> ", "").strip()
        sid = g["provenance"]["derived_from"]["source_ids"][0]
        s = srcs.get(sid, {})
        ret = s.get("retrieval") or {}
        quote = None
        if m:
            e = exts.get(m.group(2))
            if not e or e.get("direct_quote") != m.group(1):
                raise SystemExit(f"card {g['generation_id']}: pull quote does not match {m.group(2)}")
            quote = {"text": m.group(1), "extraction_id": m.group(2)}
        fresh = page_facts(s)
        out.append({"generation_id": g["generation_id"], "source_id": sid,
                    "title": fresh.get("title") or g.get("title") or s.get("title"),
                    "_created": (g.get("provenance") or {}).get("created_at") or "",
                    "summary": summary, "quote": quote, "url": meta.get("url") or ret.get("final_url") or ret.get("original_url"),
                    "fetched_at": ret.get("fetched_at") or meta.get("fetched_at"), "sha256": ret.get("sha256"),
                    "registered": bool((s.get("ext") or {}).get("authority")),
                    **{k: v for k, v in meta.items() if k not in ("url", "title")},
                    **{k: v for k, v in fresh.items() if k != "title"}})
        out[-1]["author"] = clean_author(out[-1].get("author"))
    # One card per article: a card rewritten with a different pull quote is a new
    # generation (its inputs differ), and the older one stays in the corpus as history.
    latest: dict[str, dict] = {}
    for c in sorted(out, key=lambda c: c["_created"]):
        latest[c["source_id"]] = c
    return list(latest.values())

def validate(corpus: Path) -> dict:
    rep = C.upc("validate", str(corpus), check=False)
    return rep if isinstance(rep, dict) else {"status": "failed", "errors": [{"code": "unreadable", "detail": str(rep)[:200]}]}


def generations(corpus: Path, gtype: str | None = None) -> list[dict]:
    """Every generation (of one type, when given), newest last, each with its
    output text (`_text`, when the output is a file) and its source id."""
    out = []
    for gj in corpus.glob("sources/*/generated/gen-*.json"):
        g = C.load_json(gj, {})
        if not g or (gtype and g.get("type") != gtype):
            continue
        path = (g.get("output") or {}).get("path")
        g["_text"] = (corpus / path).read_text(encoding="utf-8") if path and (corpus / path).exists() else None
        g["_source_id"] = (((g.get("provenance") or {}).get("derived_from") or {}).get("source_ids") or [None])[0]
        g["_created"] = (g.get("provenance") or {}).get("created_at") or ""
        out.append(g)
    return sorted(out, key=lambda g: g["_created"])


def latest_per_source(gens: list[dict]) -> list[dict]:
    """One generation per source: the newest (a rewrite is a new generation; the
    older one stays in the corpus as history)."""
    latest: dict[str, dict] = {}
    for g in gens:
        latest[g["_source_id"]] = g
    return list(latest.values())


_REP_TEXT: dict[tuple[str, str], str] = {}


def rep_text(corpus: Path, rep_ref: str) -> str | None:
    """A representation's stored text (the reading copy the quotes were anchored in)."""
    key = (str(corpus), rep_ref)
    if key not in _REP_TEXT:
        text = None
        for sj in corpus.glob("sources/*/source.json"):
            s = C.load_json(sj, {})
            r = next((r for r in s.get("representations", []) if r.get("representation_id") == rep_ref), None)
            if r and r.get("path") and (corpus / r["path"]).exists():
                text = (corpus / r["path"]).read_text(encoding="utf-8")
                break
        _REP_TEXT[key] = text
    return _REP_TEXT[key]


def check_extraction(corpus: Path, extraction_id: str, exts: dict | None = None) -> dict:
    """The extraction, after finding its quote again, character for character, at
    its locator in the stored representation. Raises SystemExit when it is not
    there: a projection shows nothing it cannot find in the saved source."""
    e = (exts if exts is not None else extractions(corpus)).get(extraction_id)
    if not e or not e.get("direct_quote"):
        raise SystemExit(f"{extraction_id}: no such extraction with a quote")
    text = rep_text(corpus, e.get("representation_ref") or (e.get("locator") or {}).get("representation_ref") or "")
    loc = ((e.get("locator") or {}).get("value") or {})
    if text is None:
        raise SystemExit(f"{extraction_id}: its representation is not in the corpus")
    at = text[loc["start"]:loc["end"]] if isinstance(loc.get("start"), int) and isinstance(loc.get("end"), int) else None
    if at != e["direct_quote"] and e["direct_quote"] not in text:
        raise SystemExit(f"{extraction_id}: the quote is not in the stored source")
    return e


def thumbnail(url: str | None, out_dir: Path, log: list, known: dict | None = None) -> str | None:
    """The page's own preview image, fetched once, shrunk to 640 px (sips), stored
    beside the site with where it came from. None when it cannot be had. An image
    already in the folder keeps the credit recorded when it was fetched (`known`:
    the last manifest's entries by file)."""
    if not url or not url.startswith(("http://", "https://")):
        return None
    key = hashlib.sha256(url.encode()).hexdigest()[:16]
    dest = out_dir / "img" / f"{key}.jpg"
    if dest.exists():
        log.append((known or {}).get(f"img/{key}.jpg") or {"url": url, "status": "saved earlier", "file": f"img/{key}.jpg"})
        return f"img/{key}.jpg"
    import requests  # noqa: PLC0415
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=30)
        ctype = r.headers.get("content-type", "")
        if r.status_code != 200 or not ctype.startswith("image/") or len(r.content) > 15_000_000:
            log.append({"url": url, "status": f"skipped (HTTP {r.status_code}, {ctype})"})
            return None
    except Exception as e:  # noqa: BLE001
        log.append({"url": url, "status": f"skipped ({type(e).__name__})"})
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    raw = dest.with_suffix(".src")
    raw.write_bytes(r.content)
    p = subprocess.run(["sips", "-s", "format", "jpeg", "-Z", "640", str(raw), "--out", str(dest)],
                       capture_output=True, text=True)
    raw.unlink(missing_ok=True)
    if p.returncode != 0 or not dest.exists():
        log.append({"url": url, "status": "skipped (could not convert)"})
        return None
    log.append({"url": url, "status": "saved", "file": f"img/{key}.jpg", "sha256_served": hashlib.sha256(r.content).hexdigest(),
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return f"img/{key}.jpg"


def fmt_date(s: str | None) -> str:
    """A date as a reader would say it, in this machine's local time (a page saved
    in a Pacific-time evening is not saved 'tomorrow')."""
    if not s:
        return ""
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return (d.astimezone() if d.tzinfo else d).strftime("%-d %b %Y")
    except ValueError:
        return s[:10]


def clean_title(title: str, site: str | None, host: str) -> str:
    """Drop a trailing ' | Site', ' - Site' or ' — Site' that repeats the byline."""
    t = (title or "").strip()
    names = {n.lower() for n in (site, host, *[x for x in host.split(".")[:-1] if len(x) > 3]) if n}
    for sep in (" | ", " – ", " — ", " - ", " · "):
        if sep in t:
            head, tail = t.rsplit(sep, 1)
            if tail.strip().lower() in names or any(n and n in tail.strip().lower() for n in names if len(n) > 5):
                return head.strip()
    return t


def _plain(text: str, strip_tags: bool) -> str:
    t = re.sub(r"<[^>]+>", " ", text) if strip_tags else text
    return re.sub(r"\s+", " ", html.unescape(t).replace("\u00a0", " ")).lower()


def suppressed_in(pages: dict[str, str], words: list[str]) -> list[tuple[str, str]]:
    """Every (page, string) where a suppressed string would appear: in the text a
    reader sees (tags stripped, so "Joseph <b>Young</b>" counts) or anywhere in
    the markup (an alt text, a title attribute); any case, any spacing."""
    want = [(w, _plain(w, False).strip()) for w in words if w and w.strip()]
    hits = []
    for name, text in pages.items():
        seen, raw = _plain(text, True), _plain(text, False)
        hits += [(name, w) for w, n in want if n in seen or n in raw]
    return hits


# ------------------------------------------------------------------ values and the quotes that state them
_FOLD = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-", "\u00a0": " ", "*": "", "_": ""})


def norm(s: str | None) -> str:
    """Text as a reader compares it: case, emphasis marks, curly quotes, dashes and spacing ignored."""
    t = unicodedata.normalize("NFKC", str(s or "")).translate(_FOLD)
    return re.sub(r"\s+", " ", t).strip().lower()

def value_in(value: str | None, quote: str | None) -> bool:
    v = norm(value)
    return bool(v) and v in norm(quote)

def _folded(quote: str) -> tuple[str, list[int]]:
    """norm(quote), with each folded character's position in the original."""
    out, idx, space = [], [], False
    for i, ch in enumerate(quote):
        f = unicodedata.normalize("NFKC", ch).translate(_FOLD).lower()
        for c in f:
            if c.isspace():
                if out and not space:
                    out.append(" ")
                    idx.append(i)
                space = True
            else:
                out.append(c)
                idx.append(i)
                space = False
    while out and out[-1] == " ":
        out.pop()
        idx.pop()
    return "".join(out), idx

def find_span(value: str | None, text: str) -> str | None:
    """The document's own characters for a value or quote that differs from them only in
    case, emphasis marks, curly quotes, dashes or spacing ('Preliminary Round application
    deadline: April 30, 2026' -> '**Preliminary Round application deadline:** April 30, 2026').
    None when it is not in the text."""
    v = norm(value)
    if not v:
        return None
    folded, idx = _folded(text)
    at = folded.find(v)
    if at < 0:
        return None
    return text[idx[at]: idx[at + len(v) - 1] + 1]


MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def exact(value: str | None, quote: str | None) -> str | None:
    """The value as the page writes it: the span of the quote that matches it
    (curly apostrophes and all), without emphasis marks or link syntax. None
    when the value is not in the quote."""
    v = norm(value)
    folded, idx = _folded(quote or "")
    at = folded.find(v) if v else -1
    if at < 0:
        return None
    span = quote[idx[at]: idx[at + len(v) - 1] + 1]
    span = MD_LINK.sub(r"\1", span).replace("**", "").strip(" *_")
    return re.sub(r"\s+", " ", span).strip()
