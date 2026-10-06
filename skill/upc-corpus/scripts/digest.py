#!/usr/bin/env python3
"""A browsable reading digest built from a UPC corpus: a projection for people.

    python3 digest.py build --corpus <dir> --site <config.json> --out <dir> [--about <profile corpus>]

`upc export --format site` is the reader's site for researchers (codes,
passages, overviews). This is for an organization's audience and staff: one
card per article, grouped by section, each with a thumbnail, what it is, who
wrote it, how long it takes to read, a two-sentence summary in the agent's words
and one pull quote, and a link to read it where it was published.

It follows UPC's projection rule (spec/09): it adds no claim without a source,
and it builds only from a corpus that `upc validate` passes, which re-runs the
hop-C gate over every card, so every pull quote on the page matches the stored
source byte for byte. It never republishes an article: the saved copies stay
in the corpus, and the page carries only links, the checked pull quotes and
the agent's summaries (labelled as such; the config's "agent_name").

Cards are UPC generations (`upc add generation`) whose `ext.hermes.digest_card` (the key
the first digests were written under, kept so they read the same)
holds the card's facts (sections, kind, site name, author, date, image,
reading minutes). The site config says what the corpus cannot:

    {"title": "…", "subtitle": "…", "organization": "…", "request": "…",
     "sections": [{"slug": "…", "title": "…", "description": "…"}],
     "overview": {"slug": "…", "title": "…", "description": "…", "min_sections": 5},
     "about": true, "method_page": true, "suppress": ["…"]}

`about: false` leaves the About page out even when --about is given, and
`method_page: false` leaves out the Sources & method page (the footer still
says how the page was checked). `suppress` lists strings that must appear
nowhere on the site, in any case or spacing (a name an organization has asked
to drop, an outdated title): the build refuses when one does.

The build manifest (cards, generations, image credits) is written beside the
output folder as `<out>.build.json`, never inside it, so nothing local (paths
on this machine) is published.

Each card appears once: in its first section, or, when it belongs to at least
`overview.min_sections` sections (default: all but one; a concert page, a
season announcement), in the overview section at the top. Its other sections are named on the card.

An optional --about corpus contributes its x-organization-profile synthesis
(deep-research kind `profile`) as an About page: every fact with its quote.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
import common as C  # noqa: E402
from corpus_view import (KIND_LABEL, KIND_ORDER, MARKER, cards, clean_title, esc, extractions,  # noqa: E402,F401
                         fmt_date, meta_content, page_facts, read_jsonl, sources, suppressed_in, thumbnail, validate)

TOOL = {"tool": "upc-corpus/digest", "tool_version": "1.0.0"}


# ------------------------------------------------------------------ reading the corpus
def profile_facts(corpus: Path) -> dict | None:
    """The About page: an x-organization-profile synthesis, claim by claim with its quote."""
    srcs, exts = sources(corpus), extractions(corpus)
    for sj in corpus.glob("syntheses/*/synthesis.json"):
        y = C.load_json(sj, {})
        if y.get("type") != "x-organization-profile":
            continue
        facts = []
        for c in y.get("claims", []):
            label, _, value = c["text"].partition(": ")
            eid = (c.get("evidence_ids") or [None])[0]
            e = exts.get(eid, {})
            s = srcs.get((c.get("source_ids") or [None])[0], {})
            ret = s.get("retrieval") or {}
            facts.append({"label": label, "value": value, "quote": e.get("direct_quote"), "extraction_id": eid,
                          "source": s.get("title"), "url": ret.get("final_url") or ret.get("original_url"),
                          "official": c.get("confidence") == "high"})
        text = (corpus / y["output"]["path"]).read_text(encoding="utf-8")
        missing = re.findall(r"^- (.+)$", text.split("## Not found in any source")[1], flags=re.M) \
            if "## Not found in any source" in text else []
        return {"title": y.get("title"), "facts": facts, "not_found": missing,
                "org": ((y.get("ext") or {}).get("hermes") or {}).get("org", {})}
    return None


# ------------------------------------------------------------------ pages
CSS = """
:root{--bg:#faf7f1;--paper:#fffdf8;--ink:#1f1c17;--muted:#6b6358;--rule:#e6dfd2;--accent:#8a2f2b;--accent-soft:#f3e4dc;
--chip:#efe8db;--shadow:0 1px 2px rgba(40,30,20,.06),0 8px 24px rgba(40,30,20,.06)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#15130f;--paper:#1d1a15;--ink:#ede6da;--muted:#a79d8e;
--rule:#34302a;--accent:#e3a06b;--accent-soft:#3a2a20;--chip:#2a261f;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25)}}
:root[data-theme=dark]{--bg:#15130f;--paper:#1d1a15;--ink:#ede6da;--muted:#a79d8e;--rule:#34302a;--accent:#e3a06b;
--accent-soft:#3a2a20;--chip:#2a261f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.serif,h1,h2,h3{font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;font-weight:600}
a{color:var(--accent)}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
header.hero{padding:56px 0 28px;border-bottom:1px solid var(--rule)}
.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.74rem;color:var(--muted);margin:0 0 10px}
h1{font-size:clamp(2rem,4.6vw,3.3rem);line-height:1.08;margin:0 0 14px;letter-spacing:-.01em}
.lede{font-size:1.08rem;color:var(--muted);max-width:60ch;margin:0}
nav.top{display:flex;gap:18px;padding:14px 0;font-size:.92rem;border-bottom:1px solid var(--rule)}
nav.top a{text-decoration:none;color:var(--muted)} nav.top a.here{color:var(--ink);font-weight:600}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 4px}
.toc a{background:var(--chip);color:var(--ink);text-decoration:none;padding:6px 12px;border-radius:999px;font-size:.88rem}
.toc a span{color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0}
.filters button{font:inherit;font-size:.82rem;border:1px solid var(--rule);background:transparent;color:var(--muted);
padding:4px 11px;border-radius:999px;cursor:pointer} .filters button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
section.sec{padding:40px 0 8px}
section.sec h2{font-size:1.75rem;margin:0 0 4px} section.sec .desc{color:var(--muted);margin:0 0 20px;max-width:70ch}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:22px}
article.card{background:var(--paper);border:1px solid var(--rule);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.thumb{aspect-ratio:16/9;background:var(--accent-soft);display:block;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb.ph{aspect-ratio:3/1;display:flex;align-items:flex-end;padding:14px;font-family:"Iowan Old Style",Palatino,Georgia,serif;
font-size:1.35rem;color:var(--accent);line-height:1.15}
.body{padding:16px 18px 18px;display:flex;flex-direction:column;gap:9px;flex:1}
.kind{align-self:flex-start;font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);background:var(--accent-soft);
padding:3px 8px;border-radius:6px;font-weight:600}
.card h3{font-size:1.18rem;line-height:1.25;margin:0} .card h3 a{color:var(--ink);text-decoration:none} .card h3 a:hover{color:var(--accent)}
.byline{font-size:.83rem;color:var(--muted)}
.also{font-size:.78rem;color:var(--muted)}
.summary{margin:0;font-size:.95rem}
.summary small{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
blockquote{margin:2px 0 0;padding:2px 0 2px 12px;border-left:3px solid var(--accent);font-family:"Iowan Old Style",Palatino,Georgia,serif;
font-style:italic;font-size:1rem;color:var(--ink)}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:.82rem;padding-top:6px;border-top:1px solid var(--rule)}
.foot a.read{font-weight:600;text-decoration:none} .foot .saved{color:var(--muted)} .foot .saved a{color:var(--muted)}
footer.site{margin:56px 0 0;padding:28px 0 48px;border-top:1px solid var(--rule);color:var(--muted);font-size:.85rem}
table{width:100%;border-collapse:collapse;font-size:.88rem} th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--muted);font-weight:600} td code{font-size:.8rem;word-break:break-all}
.facts dt{font-weight:600;margin-top:18px} .facts dd{margin:4px 0 0} .facts .src{color:var(--muted);font-size:.84rem}
.pill{font-size:.7rem;border:1px solid var(--rule);border-radius:6px;padding:1px 6px;color:var(--muted)}
.hide{display:none!important}
@media (max-width:600px){header.hero{padding:36px 0 20px}.wrap{padding:0 16px}}
"""

FILTER_JS = """
document.querySelectorAll('.filters button').forEach(function(b){b.addEventListener('click',function(){
var k=b.dataset.kind;document.querySelectorAll('.filters button').forEach(function(x){x.setAttribute('aria-pressed',x===b)});
document.querySelectorAll('article.card').forEach(function(c){c.classList.toggle('hide',k!=='all'&&c.dataset.kind!==k)});
document.querySelectorAll('section.sec').forEach(function(s){var n=s.querySelectorAll('article.card:not(.hide)').length;s.classList.toggle('hide',n===0)});});});
"""


def page(title: str, body: str, cfg: dict, here: str, has_about: bool, build: str, has_method: bool = True) -> str:
    nav = [("index.html", "Readings"), *([("about.html", "About")] if has_about else []),
           *([("sources.html", "Sources & method")] if has_method else [])]
    links = "".join(f'<a href="{h}" class="{"here" if h == here else ""}">{esc(t)}</a>' for h, t in nav) if len(nav) > 1 else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="build" content="{esc(build)}"><title>{esc(title)}</title><style>{CSS}</style></head><body>
<div class="wrap">{f'<nav class="top">{links}</nav>' if links else ''}{body}
<footer class="site">{esc(cfg.get('organization') or '')} · Gathered and checked by {esc(C.AGENT_NAME)}, {esc(build[:10])}.
Summaries are {esc(C.AGENT_NAME)}'s own words; every quotation matches the saved copy of its source, byte for byte.
Each reading links to where it was published, and each preview image is that page's own.
{'<a href="sources.html">Sources &amp; method</a>' if has_method else ''}</footer></div>
<script>{FILTER_JS}</script></body></html>
"""


def card_html(c: dict, img: str | None, section_title: str, also: list[str] = (), has_method: bool = True) -> str:
    kind = c.get("kind") or "other"
    host = urlparse(c.get("url") or "").netloc.removeprefix("www.")
    site = c.get("site_name") or host
    by = " · ".join(x for x in [esc(site), esc(c.get("author")), esc(fmt_date(c.get("published"))),
                                f"{c.get('reading_minutes')} min read" if c.get("reading_minutes") else ""] if x)
    thumb = (f'<a class="thumb" href="{esc(c["url"])}" target="_blank" rel="noopener"><img src="{esc(img)}" alt="" loading="lazy"></a>'
             if img else f'<div class="thumb ph" aria-hidden="true">{esc(section_title)}</div>')
    quote = f'<blockquote>“{esc(c["quote"]["text"])}”</blockquote>' if c.get("quote") else ""
    return f"""<article class="card" data-kind="{esc(kind)}">{thumb}<div class="body">
<span class="kind">{esc(KIND_LABEL.get(kind, kind))}</span>
<h3 class="serif"><a href="{esc(c['url'])}" target="_blank" rel="noopener">{esc(clean_title(c['title'], c.get('site_name'), host))}</a></h3>
<div class="byline">{by}</div>
<p class="summary"><small>Summary by {esc(C.AGENT_NAME)}</small>{esc(c['summary'])}</p>{quote}
{f'<div class="also">Also about: {esc(", ".join(also))}</div>' if also else ''}
<div class="foot"><a class="read" href="{esc(c['url'])}" target="_blank" rel="noopener">Read at {esc(site)} →</a>
<span class="saved">{f'<a href="sources.html#{esc(c["source_id"])}">saved {esc(fmt_date(c.get("fetched_at")))}</a>' if has_method else f'saved {esc(fmt_date(c.get("fetched_at")))}'}</span></div>
</div></article>"""


GENERATED = ("index.html", "about.html", "sources.html", "digest.json")  # digest.json: where older builds put the manifest


def manifest_path(out: Path) -> Path:
    """The build record lives beside the site, not in it: it names local paths."""
    return out.parent / f"{out.name}.build.json"


def build(corpus: Path, cfg: dict, out: Path, about: Path | None = None, fetch_images: bool = True) -> dict:
    rep = validate(corpus)
    if rep.get("errors"):
        raise SystemExit("the corpus does not validate; the digest is built only from one that does:\n  "
                         + "\n  ".join(f"{e.get('code')}: {str(e.get('detail'))[:120]}" for e in rep["errors"][:8]))
    cs = cards(corpus)
    if not cs:
        raise SystemExit("no digest cards in this corpus (deep-research `summarize` writes them)")
    prof = None
    has_method = cfg.get("method_page", True) is not False
    if about and cfg.get("about", True) is not False:
        arep = validate(about)
        if arep.get("errors"):
            raise SystemExit(f"the --about corpus does not validate ({len(arep['errors'])} errors)")
        prof = profile_facts(about)
    out.mkdir(parents=True, exist_ok=True)
    build_id = datetime.now(timezone.utc).isoformat(timespec="seconds")
    img_log: list = []
    manifest = manifest_path(out)
    known = {i["file"]: i for i in C.load_json(manifest, {}).get("images", []) if i.get("file")}
    images = {c["generation_id"]: (thumbnail(c.get("image"), out, img_log, known) if fetch_images else None) for c in cs}

    sections = cfg.get("sections") or [{"slug": "other", "title": "Readings", "description": ""}]
    known = {s["slug"] for s in sections}
    title_of = {s["slug"]: s["title"] for s in sections}
    ov = cfg.get("overview")
    if ov:
        sections = [ov] + sections
    by_sec: dict[str, list] = {s["slug"]: [] for s in sections}
    also: dict[str, list] = {}
    for c in cs:
        secs = [s for s in c.get("sections", []) if s in known] or [sections[-1]["slug"]]
        if ov and len(secs) >= (ov.get("min_sections") or max(3, len(known) - 1)):
            by_sec[ov["slug"]].append(c)
            also[c["generation_id"]] = []
        else:
            by_sec[secs[0]].append(c)
            also[c["generation_id"]] = [title_of[s] for s in secs[1:3]]
    for v in by_sec.values():
        v.sort(key=lambda c: (KIND_ORDER.index(c.get("kind")) if c.get("kind") in KIND_ORDER else 99,
                              c.get("reading_minutes") or 99))
    kinds = [k for k in KIND_ORDER if any(c.get("kind") == k for c in cs)]
    toc = "".join(f'<a href="#{esc(s["slug"])}">{esc(s["title"])} <span>{len(by_sec[s["slug"]])}</span></a>'
                  for s in sections if by_sec[s["slug"]])
    filters = ('<div class="filters"><button data-kind="all" aria-pressed="true">All</button>'
               + "".join(f'<button data-kind="{k}" aria-pressed="false">{esc(KIND_LABEL[k])}</button>' for k in kinds) + "</div>")
    body = [f"""<header class="hero"><p class="eyebrow">{esc(cfg.get('organization') or 'Readings')}</p>
<h1>{esc(cfg.get('title'))}</h1><p class="lede">{esc(cfg.get('subtitle') or '')}
{len(cs)} free readings, each linked to where it was published.</p>
<div class="toc">{toc}</div>{filters}</header>"""]
    for s in sections:
        if not by_sec[s["slug"]]:
            continue
        body.append(f'<section class="sec" id="{esc(s["slug"])}"><h2>{esc(s["title"])}</h2>'
                    f'<p class="desc">{esc(s.get("description"))}</p><div class="grid">'
                    + "".join(card_html(c, images[c["generation_id"]], s["title"], also[c["generation_id"]], has_method)
                              for c in by_sec[s["slug"]])
                    + "</div></section>")
    has_about = bool(prof and prof["facts"])
    pages = {"index.html": page(cfg.get("title") or "Readings", "".join(body), cfg, "index.html", has_about, build_id, has_method)}

    if has_about:
        groups: dict[str, list] = {}
        for f in prof["facts"]:
            groups.setdefault(f["label"], []).append(f)
        cap = int(cfg.get("about_max_per_field", 5))
        money = re.compile(r"revenue|expenses|contributions|salaries|net assets", re.I)

        def shown(label, v):
            return f"${int(v):,}" if money.search(label) and str(v).isdigit() else v

        def more(fs):
            return (f"<dd class='src'>…and {len(fs) - cap} more in the saved record.</dd>" if len(fs) > cap else "")
        dl = "".join(
            f"<dt>{esc(label)}</dt>" + "".join(
                f"<dd>{esc(shown(label, f['value']))}"
                + (f" <span class='pill'>official</span>" if f["official"] else "")
                + (f"<blockquote>“{esc(f['quote'])}”</blockquote>" if f.get("quote") else "")
                + f"<div class='src'>{esc(f['source'])}" + (f" · <a href='{esc(f['url'])}' target='_blank' rel='noopener'>source</a>" if f.get("url") else "")
                + "</div></dd>" for f in sorted(fs, key=lambda f: not f["official"])[:cap]) + more(fs)
            for label, fs in groups.items())
        nf = ("<h2>Not found in any source</h2><ul>" + "".join(f"<li>{esc(x)}</li>" for x in prof["not_found"]) + "</ul>") \
            if prof["not_found"] else ""
        about_body = (f'<header class="hero"><p class="eyebrow">About</p><h1>{esc(prof["org"].get("name") or cfg.get("organization"))}</h1>'
                      f'<p class="lede">Facts from public sources, each quoted from the source that states it. Official records '
                      f'(its own site and IRS filings) are marked. Figures are as filed, for the tax period shown.</p></header>'
                      f'<dl class="facts">{dl}</dl>{nf}')
        pages["about.html"] = page(f"About · {cfg.get('title')}", about_body, cfg, "about.html", True, build_id, has_method)

    rows = "".join(
        f"<tr id='{esc(c['source_id'])}'><td>{esc(c['title'])}<br><a href='{esc(c['url'])}' target='_blank' rel='noopener'>{esc(c['url'])}</a></td>"
        f"<td>{esc(fmt_date(c.get('fetched_at')))}</td><td><code>{esc((c.get('sha256') or '').removeprefix('sha256:')[:16])}…</code></td>"
        f"<td>{'yes' if c.get('registered') else 'no'}</td><td><code>{esc((c.get('quote') or {}).get('extraction_id') or '—')}</code></td></tr>"
        for c in sorted(cs, key=lambda c: c["title"] or ""))
    imgs = "".join(f"<li><code>{esc(i.get('file', ''))}</code> ← <a href='{esc(i['url'])}'>{esc(i['url'][:90])}</a> ({esc(i['status'])})</li>"
                   for i in img_log)
    method = f"""<header class="hero"><p class="eyebrow">Sources &amp; method</p><h1>Where every reading came from</h1>
<p class="lede">Each reading was found by {esc(C.AGENT_NAME)}, read, and saved as it was served (the exact bytes and their SHA-256 hash),
together with when and from where. The saved copies are kept privately, not republished; this page lists them.</p></header>
<section class="sec"><h2>How this was made</h2><p class="desc">{esc(cfg.get('request') or '')}</p>
<ul><li>{esc(cfg.get('registries') or "Searches ran on the web and on the sources listed in the research profile's registries.")}
“Registered” below says whether a reading's site is in one of them.</li>
<li>A local model screened each result, drafted each card's summary and chose a pull quote. The summary is labelled as {esc(C.AGENT_NAME)}'s words;
the pull quote was then checked against the saved copy, character for character, and is shown only if it matched.</li>
<li>Fixity is not authenticity: a matching hash shows which bytes were read, not that the article is right.</li></ul></section>
<section class="sec"><h2>Readings</h2><table><tr><th>Reading</th><th>Saved</th><th>SHA-256</th><th>Registered</th><th>Pull quote</th></tr>{rows}</table></section>
{"<section class='sec'><h2>Preview images</h2><p class='desc'>Each card's image is the page's own preview image, credited by the card's link.</p><ul>" + imgs + "</ul></section>" if imgs else ""}"""
    if has_method:
        pages["sources.html"] = page(f"Sources · {cfg.get('title')}", method, cfg, "sources.html", has_about, build_id)
    hits = suppressed_in(pages, cfg.get("suppress") or [])
    if hits:
        raise SystemExit("refusing to build: a suppressed string would be published:\n  "
                         + "\n  ".join(f"{name}: {word!r}" for name, word in hits))
    for name in GENERATED:  # a page this build no longer makes must not linger from an earlier one
        if name not in pages:
            (out / name).unlink(missing_ok=True)
    for name, text in pages.items():
        (out / name).write_text(text, encoding="utf-8")
    C.save_json(manifest, {"built": build_id, **TOOL, "corpus": str(corpus),
                           "about": str(about) if has_about else None, "pages": sorted(pages),
                           "cards": len(cs), "images": img_log, "generations": [c["generation_id"] for c in cs]})
    C.upc("event", "--corpus", str(corpus), check=False, stdin=json.dumps({
        "activity_type": "export", "tool": TOOL["tool"], "started_at": build_id, "status": "success",
        "inputs": {"generation_ids": [c["generation_id"] for c in cs]},
        "notes": f"digest site: {len(cs)} cards -> {out}"}))
    return {"cards": len(cs), "sections": sum(bool(v) for v in by_sec.values()), "images": sum(bool(v) for v in images.values()),
            "about_facts": len(prof["facts"]) if has_about else 0, "pages": sorted(pages), "out": str(out)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["build"])
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--site", required=True, help="site config JSON (title, subtitle, organization, request, sections)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--about", help="a profile corpus with an x-organization-profile synthesis")
    ap.add_argument("--no-images", action="store_true", help="skip fetching preview images")
    a = ap.parse_args()
    t0 = time.time()
    res = build(Path(a.corpus).expanduser(), C.load_json(a.site, {}), Path(a.out).expanduser(),
                Path(a.about).expanduser() if a.about else None, fetch_images=not a.no_images)
    C.counts_header("Digest", [("cards", res["cards"]), ("sections", res["sections"]), ("preview images", res["images"]),
                               ("about facts", res["about_facts"]), ("site", res["out"]),
                               ("seconds", round(time.time() - t0, 1))])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except C.Unavailable as e:
        C.die(str(e))
