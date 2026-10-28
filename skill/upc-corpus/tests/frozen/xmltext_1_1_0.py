#!/usr/bin/env python3
"""Publisher full-text XML -> a reading copy for quotation, deterministically.

    python3 xmltext.py <file.xml>           print the reading copy
    python3 xmltext.py <file.xml> --info    what was found (format, full text or not, sections, characters)

Some publishers serve the version of record's full text only as XML. Elsevier's Article Retrieval API returns a
whole article as `full-text-retrieval-response` XML to an entitled request (a subscriber's IP, or an insttoken),
while a PDF request from the same place returns only the first page (`X-ELS-Status: WARNING - Response limited to
first page`). So the XML is the stored original (file role "original", media type text/xml) and this module makes
the text a quotation is checked against, the way pdftext.py does for a PDF.

The reading copy keeps the article's own words in reading order: title, abstracts, keywords, sections under their
headings, each table and figure after the paragraph that first points to it, footnotes, acknowledgements,
appendices and references. Markup is dropped, never the text inside it. The XML has no page numbers, so neither
does the reading copy: cite a quotation by its section.

Formats: Elsevier `full-text-retrieval-response` holding a journal article (`ja:article`: head, body, tail) or a book
chapter (`bk:chapter`, its parts directly under it), in ce: elements; or the `xocs:rawtext` that older articles, and
articles with no body of their own, carry instead. A response with none of these is metadata only (the request was not
entitled): `full_text` is False and the text is just the title and abstract, which is never a full text. Nor is an
article of fewer than five paragraphs (an abstract-only record), or a rawtext under 5,000 characters. Rawtext is kept
as Elsevier sends it, mis-decoded characters ("â€“") included.
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET

VERSION = "1.1.0"
_WS = re.compile(r"\s+")
RAW_MIN = 5000
# Elements whose text is not part of the running prose where they sit: floats are placed after their paragraph,
# footnotes are gathered at the end, and the rest carry no reading text.
_AWAY = {"float-anchor", "footnote", "display", "list", "inline-figure", "alt-text", "anchor"}
_BREAK = {"hsp", "vsp", "br"}
# A book chapter's body: what sits under it beside its title, abstract, floats and references.
_BODY = {"sections", "section", "para", "simple-para", "acknowledgment", "appendices", "glossary"}


def has_body(art) -> bool:
    names = {local(c.tag) for c in art}
    return "body" in names or bool(names & _BODY)


def local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def clean(s: str) -> str:
    return _WS.sub(" ", s).strip()


def kids(el, name: str):
    return [c for c in el if local(c.tag) == name]


def first(el, name: str):
    return next((c for c in el.iter() if local(c.tag) == name), None)


def inline(el) -> str:
    """The text of an element as it reads, without the parts that live elsewhere."""
    out = [el.text or ""]
    for c in el:
        n = local(c.tag)
        if n in _BREAK:
            out.append(" ")
        elif n == "math":
            out.append(" " + "".join(c.itertext()) + " ")
        elif n not in _AWAY:
            out.append(inline(c))
        out.append(c.tail or "")
    return "".join(out)


class Reader:
    def __init__(self, root):
        self.root = root
        self.out: list[str] = []
        self.floats = {f.get("id"): f for f in root.iter() if local(f.tag) in ("figure", "table", "textbox")
                       and f.get("id")}
        self.placed: set[str] = set()
        self.notes: list[str] = []
        self.sections = 0
        self.paras = 0

    def emit(self, s: str) -> None:
        s = clean(s)
        if s:
            self.out.append(s)

    # -- blocks ---------------------------------------------------------------------------------------------------
    def para(self, el) -> None:
        self.emit(inline(el))
        self.paras += 1
        for c in el.iter():
            n = local(c.tag)
            if n == "footnote":
                self.footnote(c)
            elif n == "float-anchor" and c.get("refid") in self.floats:
                self.float(self.floats[c.get("refid")])
            elif n in ("display", "list") and c is not el:
                self.block(c)

    def footnote(self, el) -> None:
        label = clean("".join(x.text or "" for x in kids(el, "label")))
        body = " ".join(clean(inline(p)) for p in el if local(p.tag) in ("note-para", "para", "simple-para"))
        if body:
            self.notes.append(f"{label} {body}".strip())

    def float(self, el) -> None:
        fid = el.get("id")
        if fid in self.placed:
            return
        self.placed.add(fid)
        label = clean("".join(inline(x) for x in kids(el, "label")))
        caption = " ".join(clean(inline(p)) for c in kids(el, "caption") for p in c) or \
            " ".join(clean(inline(c)) for c in kids(el, "caption"))
        self.emit(f"{label}. {caption}" if label and caption else label or caption)
        if local(el.tag) == "table":
            for row in (r for r in el.iter() if local(r.tag) == "row"):
                cells = [clean(inline(e)) for e in row if local(e.tag) == "entry"]
                if any(cells):
                    self.emit(" | ".join(cells))
            for leg in (x for x in el.iter() if local(x.tag) in ("legend", "table-footnote")):
                self.emit(inline(leg) if local(leg.tag) == "legend" else
                          " ".join(clean(inline(p)) for p in leg.iter() if local(p.tag) in ("note-para", "simple-para")))
        elif local(el.tag) == "textbox":
            body = first(el, "textbox-body")
            if body is not None:
                self.blocks(body, 3)

    def heading(self, el, depth: int) -> None:
        label = clean("".join(inline(x) for x in kids(el, "label")))
        title = clean("".join(inline(x) for x in kids(el, "section-title")))
        if label or title:
            self.out.append("#" * min(depth, 6) + " " + " ".join(x for x in (label, title) if x))

    def block(self, el, depth: int = 2) -> None:
        n = local(el.tag)
        if n in ("para", "simple-para"):
            self.para(el)
        elif n == "section":
            self.sections += 1
            self.heading(el, depth)
            self.blocks(el, depth + 1)
        elif n in ("display",):
            for c in el:
                if local(c.tag) in ("figure", "table", "textbox"):
                    self.float(c)
                else:
                    self.block(c, depth)
        elif n in ("figure", "table", "textbox"):
            self.float(el)
        elif n == "list":
            for item in kids(el, "list-item"):
                label = clean("".join(inline(x) for x in kids(item, "label")))
                text = " ".join(clean(inline(p)) for p in item if local(p.tag) in ("para", "simple-para"))
                self.emit(f"{label} {text}".strip())
        elif n == "formula":
            self.emit(inline(el))
        elif n in ("label", "section-title", "float-anchor"):
            pass
        else:  # a container: acknowledgment, appendices, conflict-of-interest, data-availability …
            self.blocks(el, depth)

    def blocks(self, el, depth: int) -> None:
        for c in el:
            self.block(c, depth)

    def titled(self, el, default: str, depth: int = 2) -> None:
        """A part of the article with its own heading (an abstract, the acknowledgements)."""
        title = clean("".join(inline(x) for x in kids(el, "section-title"))) or default
        self.out.append("#" * depth + " " + title)
        for c in el:
            if local(c.tag) != "section-title":
                self.block(c, depth + 1)

    def references(self, bib) -> None:
        default = "Further reading" if local(bib.tag) == "further-reading" else "References"
        self.out.append("## " + (clean("".join(inline(x) for x in kids(bib, "section-title"))) or default))
        for ref in (r for r in bib.iter() if local(r.tag) == "bib-reference"):
            label = clean("".join(inline(x) for x in kids(ref, "label")))
            src = first(ref, "source-text")
            other = first(ref, "other-ref")
            if src is not None:
                body = inline(src)
            elif other is not None:
                body = inline(other)
            else:
                body = " ".join(clean(inline(x)) for x in ref if local(x.tag) not in ("label",))
            body = clean(body)
            self.emit(body if label and body.startswith(label) else f"{label} {body}".strip())

    # -- the article ----------------------------------------------------------------------------------------------
    def article(self, art) -> None:
        """A journal article (head, body, tail) or a book chapter, whose parts sit directly under it."""
        head = next((c for c in art if local(c.tag) == "head"), None)
        body = next((c for c in art if local(c.tag) == "body"), None)
        tail = next((c for c in art if local(c.tag) == "tail"), None)
        flat = head is None and body is None
        if flat:
            head = tail = art
        if head is not None:
            t = next((c for c in head if local(c.tag) == "title"), None)
            if t is not None:
                self.out.append("# " + clean(inline(t)))
            for ab in kids(head, "abstract"):
                self.titled(ab, "Abstract")
            for kw in kids(head, "keywords"):
                words = [clean(inline(k)) for k in kw.iter() if local(k.tag) == "keyword"]
                title = clean("".join(inline(x) for x in kids(kw, "section-title"))) or "Keywords"
                if words:
                    self.out.append(f"{title}: " + "; ".join(w for w in words if w))
        if flat:
            for c in art:
                if local(c.tag) in _BODY:
                    self.block(c, 2)
        elif body is not None:
            self.blocks(body, 2)
        for fid, f in self.floats.items():  # a float no paragraph pointed to still belongs to the article
            if fid not in self.placed:
                self.float(f)
        if tail is not None:
            for c in tail:
                if local(c.tag) in ("bibliography", "further-reading"):
                    self.references(c)
                elif not flat:
                    self.block(c, 2)
        if self.notes:
            self.out.append("## Notes")
            self.out.extend(self.notes)


def coredata(root) -> dict:
    cd = next((c for c in root if local(c.tag) == "coredata"), None)
    if cd is None:
        return {}
    get = lambda n: clean("".join(next((c for c in cd if local(c.tag) == n), ET.Element("x")).itertext()))  # noqa: E731
    return {"title": get("title"), "doi": get("doi"), "abstract": get("description"),
            "openaccess": get("openaccess")}


def convert(xml_path: str) -> dict:
    """XML -> {text, format, full_text, sections, paragraphs, chars, pages, title, doi, method}. Deterministic."""
    root = ET.parse(xml_path).getroot()
    if local(root.tag) != "full-text-retrieval-response":
        raise ValueError(f"not a format this reads: <{local(root.tag)}> (Elsevier full-text-retrieval-response only)")
    meta = coredata(root)
    r = Reader(root)
    art = next((e for e in root.iter() if
                (local(e.tag) in ("article", "simple-article", "converted-article")
                 and e.tag.startswith("{http://www.elsevier.com/xml/ja/")) or
                (local(e.tag) in ("chapter", "simple-chapter") and e.tag.startswith("{http://www.elsevier.com/xml/bk/"))),
               None)
    raw = first(root, "rawtext")
    raw_ok = raw is not None and bool(clean(raw.text or ""))
    how = "elsevier-ce"
    # An article with no body of its own (head and references only) carries its text as rawtext.
    if art is not None and (has_body(art) or not raw_ok):
        r.article(art)
    if r.paras == 0 or (art is not None and not has_body(art) and raw_ok):
        if raw_ok:
            how = "elsevier-rawtext"
            r.out = (["# " + meta["title"]] if meta.get("title") else []) + \
                [clean(p) for p in re.split(r"\n\s*\n|\s{3,}", raw.text) if clean(p)]
            r.paras = len(r.out)
        else:
            how = "elsevier-metadata-only"
            r.out = [x for x in ("# " + meta.get("title", ""), meta.get("abstract", "")) if clean(x.strip("# "))]
    text = "\n\n".join(r.out) + "\n"
    # rawtext often has no paragraph breaks at all, so it counts by length (an abstract is ~1,500 characters).
    full = r.paras >= 5 if how == "elsevier-ce" else how == "elsevier-rawtext" and len(text) >= RAW_MIN
    return {"text": text, "format": how, "full_text": full,
            "sections": r.sections, "paragraphs": r.paras, "chars": len(text), "pages": None,
            "title": meta.get("title", ""), "doi": meta.get("doi", ""), "method": f"xmltext {VERSION}"}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    info = convert(argv[0])
    if "--info" in argv:
        print(json.dumps({k: v for k, v in info.items() if k != "text"}, indent=2, ensure_ascii=False))
    else:
        sys.stdout.write(info["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
