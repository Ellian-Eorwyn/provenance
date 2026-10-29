#!/usr/bin/env python3
"""Publisher full-text XML -> a reading copy for quotation, deterministically.

    python3 xmltext.py <file.xml>           print the reading copy
    python3 xmltext.py <file.xml> --info    what was found (format, full text or not, sections, characters)
    python3 xmltext.py <file.xml> --blocks  the reading copy's structure map (JSON), as paginate.py stores it

Some publishers serve the version of record's full text only as XML. Elsevier's Article Retrieval API returns a
whole article as `full-text-retrieval-response` XML to an entitled request (a subscriber's IP, or an insttoken),
while a PDF request from the same place returns only the first page (`X-ELS-Status: WARNING - Response limited to
first page`). So the XML is the stored original (file role "original", media type text/xml) and this module makes
the text a quotation is checked against, the way pdftext.py does for a PDF.

The reading copy keeps the article's own words in reading order: title, abstracts, keywords, sections under their
headings, each table and figure after the paragraph that first points to it, footnotes, acknowledgements,
appendices and references. Markup is dropped, never the text inside it. The XML has no page numbers, so neither
does the reading copy: cite a quotation by its section and paragraph ("§3.2 ¶4").

The reading copy's bytes never change between versions: quotations are anchored in them by character range. Each
version writes exactly the text 1.1.0 wrote (tests/frozen/xmltext_1_1_0.py proves it), and what a later version
knows beyond the text goes in its structure map: `structure()` says what each block of the reading copy is
(heading, paragraph, caption, table row, list item, keywords, note, reference…), where it starts and ends in
codepoints, which of the paper's sections holds it and its paragraph number there, all from the same pass over the
XML. Only the map can tell a caption ("Fig. 1. …") from body text that mentions a figure, or a table row from a
sentence. paginate.py stores it beside the reading copy (spec/02, application/vnd.upc.structure+json) and gives each
passage its section and paragraph; `place()` is that step.

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

VERSION = "1.2.0"
STRUCTURE = "application/vnd.upc.structure+json"
_WS = re.compile(r"\s+")
RAW_MIN = 5000
# End matter whose title the reading copy leaves out (1.1.0 dropped it, and the text cannot change now): the map
# still names the section, from the XML, so a passage there cites as "Acknowledgments ¶1".
_NAMED_PARTS = {"acknowledgment", "conflict-of-interest", "data-availability", "nomenclature", "glossary"}
# The blocks a paragraph number counts or follows.
_NUMBERED = {"paragraph", "list_item", "formula"}
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
        self.note_labels: list[str] = []
        self.sections = 0
        self.paras = 0
        # The structure map, kept in lockstep with `out`: what each block is. Nothing here touches the text.
        self.meta: list[dict] = []
        self.secs: list[dict] = []        # every section met, in order
        self.open: list[int] = []         # the sections the reader is inside, innermost last
        self.count: dict = {}             # section -> paragraphs so far
        self.box: list[str] = []          # inside a textbox: its label
        self.tables = 0

    def put(self, s: str, kind: str, **info) -> None:
        """Every block of the reading copy is written here, with what it is."""
        self.out.append(s)
        sec = self.open[-1] if self.open else None
        if kind == "paragraph":
            self.count[sec] = self.count.get(sec, 0) + 1
        self.meta.append({"kind": kind, "s": sec, "p": self.count.get(sec, 0), **info})

    def emit(self, s: str, kind: str = "paragraph", **info) -> None:
        s = clean(s)
        if s:
            self.put(s, kind, **info)

    def enter(self, el, depth: int, heading: bool = True, title: str = "") -> bool:
        """Open a section for the map, when it has a name (an untitled one numbers with its parent)."""
        label = clean("".join(inline(x) for x in kids(el, "label")))
        title = clean("".join(inline(x) for x in kids(el, "section-title"))) or title
        if not (label or title):
            return False
        self.secs.append({"label": label, "title": title, "depth": depth, "heading": heading,
                          "parent": self.open[-1] if self.open else None})
        self.open.append(len(self.secs) - 1)
        return True

    def leave(self, opened: bool) -> None:
        if opened:
            self.open.pop()

    # -- blocks ---------------------------------------------------------------------------------------------------
    def para(self, el) -> None:
        if self.box:
            self.emit(inline(el), "box", **({"label": self.box[-1]} if self.box[-1] else {}))
        else:
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
            self.note_labels.append(label)

    def float(self, el) -> None:
        fid = el.get("id")
        if fid in self.placed:
            return
        self.placed.add(fid)
        label = clean("".join(inline(x) for x in kids(el, "label")))
        caption = " ".join(clean(inline(p)) for c in kids(el, "caption") for p in c) or \
            " ".join(clean(inline(c)) for c in kids(el, "caption"))
        item = {"label": label} if label else {}
        self.emit(f"{label}. {caption}" if label and caption else label or caption, "caption", **item)
        if local(el.tag) == "table":
            t = self.tables
            self.tables += 1
            heads = {r for th in el.iter() if local(th.tag) == "thead" for r in th.iter() if local(r.tag) == "row"}
            for row in (r for r in el.iter() if local(r.tag) == "row"):
                cells = [clean(inline(e)) for e in row if local(e.tag) == "entry"]
                if any(cells):
                    self.emit(" | ".join(cells), "row", t=t, cells=cell_spans(cells), **item,
                              **({"head": True} if row in heads else {}))
            for leg in (x for x in el.iter() if local(x.tag) in ("legend", "table-footnote")):
                self.emit(inline(leg) if local(leg.tag) == "legend" else
                          " ".join(clean(inline(p)) for p in leg.iter() if local(p.tag) in ("note-para", "simple-para")),
                          "table_note", **item)
        elif local(el.tag) == "textbox":
            body = first(el, "textbox-body")
            if body is not None:
                self.box.append(label)
                self.blocks(body, 3)
                self.box.pop()

    def heading(self, el, depth: int) -> None:
        label = clean("".join(inline(x) for x in kids(el, "label")))
        title = clean("".join(inline(x) for x in kids(el, "section-title")))
        if label or title:
            self.put("#" * min(depth, 6) + " " + " ".join(x for x in (label, title) if x), "heading")

    def block(self, el, depth: int = 2) -> None:
        n = local(el.tag)
        if n in ("para", "simple-para"):
            self.para(el)
        elif n == "section":
            self.sections += 1
            opened = self.enter(el, depth)
            self.heading(el, depth)
            self.blocks(el, depth + 1)
            self.leave(opened)
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
                self.emit(f"{label} {text}".strip(), "list_item")
        elif n == "formula":
            self.emit(inline(el), "formula")
        elif n in ("label", "section-title", "float-anchor"):
            pass
        else:  # a container: acknowledgment, appendices, conflict-of-interest, data-availability …
            opened = n in _NAMED_PARTS and self.enter(el, depth, heading=False)
            self.blocks(el, depth)
            self.leave(opened)

    def blocks(self, el, depth: int) -> None:
        for c in el:
            self.block(c, depth)

    def titled(self, el, default: str, depth: int = 2) -> None:
        """A part of the article with its own heading (an abstract, the acknowledgements)."""
        title = clean("".join(inline(x) for x in kids(el, "section-title"))) or default
        self.secs.append({"label": "", "title": title, "depth": depth, "heading": True,
                          "parent": self.open[-1] if self.open else None})
        self.open.append(len(self.secs) - 1)
        self.put("#" * depth + " " + title, "heading")
        for c in el:
            if local(c.tag) != "section-title":
                self.block(c, depth + 1)
        self.open.pop()

    def references(self, bib) -> None:
        default = "Further reading" if local(bib.tag) == "further-reading" else "References"
        title = clean("".join(inline(x) for x in kids(bib, "section-title"))) or default
        self.secs.append({"label": "", "title": title, "depth": 2, "heading": True, "parent": None})
        self.open.append(len(self.secs) - 1)
        self.put("## " + title, "heading")
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
            self.emit(body if label and body.startswith(label) else f"{label} {body}".strip(), "reference",
                      **({"label": label} if label else {}))
        self.open.pop()

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
                self.put("# " + clean(inline(t)), "title")
            for ab in kids(head, "abstract"):
                self.titled(ab, "Abstract")
            for kw in kids(head, "keywords"):
                words = [clean(inline(k)) for k in kw.iter() if local(k.tag) == "keyword"]
                title = clean("".join(inline(x) for x in kids(kw, "section-title"))) or "Keywords"
                if words:
                    self.put(f"{title}: " + "; ".join(w for w in words if w), "keywords", label=title)
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
            self.secs.append({"label": "", "title": "Notes", "depth": 2, "heading": True, "parent": None})
            self.open.append(len(self.secs) - 1)
            self.put("## Notes", "heading")
            for note, label in zip(self.notes, self.note_labels):
                self.put(note, "note", **({"label": label} if label else {}))
            self.open.pop()


def coredata(root) -> dict:
    cd = next((c for c in root if local(c.tag) == "coredata"), None)
    if cd is None:
        return {}
    get = lambda n: clean("".join(next((c for c in cd if local(c.tag) == n), ET.Element("x")).itertext()))  # noqa: E731
    return {"title": get("title"), "doi": get("doi"), "abstract": get("description"),
            "openaccess": get("openaccess")}


def read(xml_path: str) -> tuple[dict, Reader]:
    """XML -> (convert()'s record, the Reader that wrote it). One pass makes both the text and its map."""
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
        r.meta = []  # rawtext has no structure the XML vouches for, and metadata is not a text
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
            "title": meta.get("title", ""), "doi": meta.get("doi", ""), "method": f"xmltext {VERSION}"}, r


def convert(xml_path: str) -> dict:
    """XML -> {text, format, full_text, sections, paragraphs, chars, pages, title, doi, method}. Deterministic."""
    return read(xml_path)[0]


def cell_spans(cells: list[str]) -> list[list[int]]:
    """Where each cell sits in its row as written (clean(" | ".join(cells))), relative to the row's start."""
    row = clean(" | ".join(cells))
    out, at = [], 0
    for c in cells:
        i = row.find(c, at) if c else at
        out.append([i, i + len(c)])
        at = i + len(c)
    return out


def structure(xml_path: str) -> dict | None:
    """The reading copy and its structure map (spec/02, application/vnd.upc.structure+json):
    {"text": …, "map": {upc_structure, made_by, format, chars, sections[], blocks[]}}. The map is None unless the
    XML is a full text in the ce format (a rawtext article's blocks are only where Elsevier put blank lines)."""
    info, r = read(xml_path)
    text = info["text"]
    if info["format"] != "elsevier-ce" or not info["full_text"]:
        return {"text": text, "map": None}
    assert len(r.meta) == len(r.out), "every block has its kind"
    blocks, at = [], 0
    for s, m in zip(r.out, r.meta):
        b = {"kind": m["kind"], "c0": at, "c1": at + len(s)}
        if m["s"] is not None:
            b["s"] = m["s"]
        if m["p"] and m["kind"] not in ("heading", "title", "keywords"):
            b["p"] = m["p"]
        for k in ("label", "t", "head"):
            if k in m and m[k] is not None and m[k] != "" and m[k] is not False:  # a table numbered 0 is still one
                b[k] = m[k]
        if "cells" in m:
            b["cells"] = [[at + a, at + z] for a, z in m["cells"]]
        blocks.append(b)
        at += len(s) + 2
    assert "\n\n".join(text[b["c0"]:b["c1"]] for b in blocks) + "\n" == text, "the blocks tile the text"
    return {"text": text, "map": {"upc_structure": 1, "made_by": info["method"], "format": info["format"],
                                  "chars": len(text), "sections": r.secs, "blocks": blocks}}


def map_bytes(m: dict) -> bytes:
    """The stored form of a map: deterministic, so the same XML always gives the same representation id."""
    return (json.dumps(m, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def place(m: dict, start: int) -> dict | None:
    """The `section` secondary locator (spec/03) for a passage starting at codepoint `start`, without its
    representation_ref: where in the paper it is, by the paper's own section and the paragraph there."""
    blocks = m.get("blocks") or []
    b = next((x for x in blocks if x["c0"] <= start < x["c1"]), None) or \
        next((x for x in blocks if x["c0"] >= start), None)  # a passage starting in the blank line before a block
    if b is None:
        return None
    sec = m["sections"][b["s"]] if b.get("s") is not None else None
    kind = b["kind"]
    if sec:
        value = " ".join(x for x in (sec["label"], sec["title"]) if x)
    elif kind == "title":
        value = "Title"
    else:
        value = b.get("label") or ""
    if not value:
        return None
    loc = {"type": "section", "value": value, "block": kind}
    if sec and sec["label"]:
        loc["label"] = sec["label"]
    if sec and sec["title"]:
        loc["title"] = sec["title"]
    if kind in _NUMBERED and b.get("p"):
        loc["paragraph"] = b["p"]
    if kind not in _NUMBERED and kind not in ("heading", "title") and b.get("label"):
        loc["item"] = b["label"]
    return loc


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if "--blocks" in argv:
        sys.stdout.write(map_bytes(structure(argv[0])["map"]).decode("utf-8"))
        return 0
    info = convert(argv[0])
    if "--info" in argv:
        print(json.dumps({k: v for k, v in info.items() if k != "text"}, indent=2, ensure_ascii=False))
    else:
        sys.stdout.write(info["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
