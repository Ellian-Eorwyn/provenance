"""xmltext.py: Elsevier full-text XML -> a reading copy, and add_acquired.py's `xml` items: the XML is kept as the
original, the reading copy carries the article's words in reading order, a quotation anchors into it, and a
metadata-only response (an unentitled request) is refused. The end-to-end half runs the real `upc` CLI and is
skipped when it is missing.

The reading copy's bytes never change: quotations are anchored in them. `SameText` proves that this version writes
exactly what 1.1.0 wrote (tests/frozen/xmltext_1_1_0.py, verbatim from dc73377) on every fixture, and on every real
file in $UPC_XML_SAMPLES when it is set (publisher XML never enters this repository). Run with:

    python3 -m unittest discover -s tests -v
    UPC_XML_SAMPLES=~/pdf_scrape/forge-2.2 python3 -m unittest tests.test_xmltext
"""

import glob
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import common as C  # noqa: E402
import xmltext  # noqa: E402

_spec = importlib.util.spec_from_file_location("xmltext_1_1_0", Path(__file__).with_name("frozen") / "xmltext_1_1_0.py")
frozen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(frozen)

NS = ('xmlns="http://www.elsevier.com/xml/svapi/article/dtd" xmlns:ce="http://www.elsevier.com/xml/common/dtd" '
      'xmlns:ja="http://www.elsevier.com/xml/ja/dtd" xmlns:xocs="http://www.elsevier.com/xml/xocs/dtd" '
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"')
CORE = ("<coredata><prism:doi>10.1016/j.test.2024.000001</prism:doi><dc:title>Panels and heat pumps</dc:title>"
        "<dc:description>Abstract text.</dc:description><openaccess>0</openaccess></coredata>")
PARAS = "".join(f"<ce:para>Paragraph {i} on service capacity and load calculations.</ce:para>" for i in range(5))
FULL = f"""<full-text-retrieval-response {NS}>{CORE}<originalText><xocs:doc><xocs:serial-item><ja:article>
<ja:floats><ce:table id="tbl1"><ce:label>Table 1</ce:label><ce:caption><ce:simple-para>Panel sizes in the sample.</ce:simple-para></ce:caption>
<tgroup><thead><row><entry>Panel</entry><entry>Homes</entry></row></thead><tbody><row><entry>100 A</entry><entry>41</entry></row></tbody></tgroup></ce:table></ja:floats>
<ja:head><ce:title>Panels and heat pumps</ce:title><ce:abstract><ce:section-title>Abstract</ce:section-title><ce:abstract-sec>
<ce:simple-para>We study <ce:italic>panel</ce:italic> upgrades.</ce:simple-para></ce:abstract-sec></ce:abstract></ja:head>
<ja:body><ce:sections><ce:section><ce:label>1</ce:label><ce:section-title>Introduction</ce:section-title>
<ce:para>Upgrading a 100 amp panel to 200 amps can cost several thousand dollars<ce:footnote id="fn1"><ce:label>1</ce:label><ce:note-para>In 2024 dollars.</ce:note-para></ce:footnote> and add weeks of coordination <ce:cross-ref refid="b1">[1]</ce:cross-ref>.<ce:float-anchor refid="tbl1"/></ce:para>
{PARAS}</ce:section></ce:sections></ja:body>
<ja:tail><ce:bibliography><ce:section-title>References</ce:section-title><ce:bibliography-sec><ce:bib-reference id="b1"><ce:label>[1]</ce:label>
<ce:source-text>[1] A. Smith, Panels, Energy Policy 1 (2024) 1-2.</ce:source-text></ce:bib-reference></ce:bibliography-sec></ce:bibliography></ja:tail>
</ja:article></xocs:serial-item></xocs:doc></originalText></full-text-retrieval-response>"""
META_ONLY = f"<full-text-retrieval-response {NS}>{CORE}</full-text-retrieval-response>"
BK = 'xmlns:bk="http://www.elsevier.com/xml/bk/dtd"'
CHAPTER = f"""<full-text-retrieval-response {NS} {BK}>{CORE}<originalText><xocs:doc><xocs:nonserial-item><bk:chapter>
<ce:floats><ce:table id="t1"><ce:label>Table 1</ce:label><ce:caption><ce:simple-para>Fuels.</ce:simple-para></ce:caption></ce:table></ce:floats>
<ce:label>3</ce:label><ce:title>Energy security</ce:title><ce:abstract><ce:abstract-sec><ce:simple-para>A chapter on supply.</ce:simple-para></ce:abstract-sec></ce:abstract>
<ce:sections><ce:section><ce:section-title>History</ce:section-title>{PARAS}</ce:section></ce:sections>
<ce:bibliography><ce:bibliography-sec><ce:bib-reference id="r1"><ce:label>1</ce:label><ce:other-ref><ce:textref>IEA, 2020.</ce:textref></ce:other-ref></ce:bib-reference></ce:bibliography-sec></ce:bibliography>
</bk:chapter></xocs:nonserial-item></xocs:doc></originalText></full-text-retrieval-response>"""
RAW = "1. Introduction The energy trilemma remains a pivotal challenge. " * 120
NO_BODY = f"""<full-text-retrieval-response {NS}>{CORE}<originalText><xocs:doc><xocs:rawtext>{RAW}</xocs:rawtext>
<xocs:serial-item><ja:article><ja:head><ce:title>Coalfields</ce:title><ce:abstract><ce:abstract-sec><ce:simple-para>Short.</ce:simple-para>
</ce:abstract-sec></ce:abstract></ja:head><ja:tail><ce:bibliography/></ja:tail></ja:article></xocs:serial-item></xocs:doc></originalText>
</full-text-retrieval-response>"""


# Every kind of block the structure map knows, and the places where the text and its sections part ways: an
# end-matter title the reading copy leaves out, a paragraph after a subsection, a caption beside body text that
# names the same figure, a table cell that holds " | ".
KITCHEN = f"""<full-text-retrieval-response {NS} xmlns:mml="http://www.w3.org/1998/Math/MathML">{CORE}<originalText><xocs:doc><xocs:serial-item><ja:article>
<ja:floats>
<ce:table id="t1"><ce:label>Table 1</ce:label><ce:caption><ce:simple-para>Upgrade costs.</ce:simple-para></ce:caption>
<ce:legend><ce:simple-para>Costs in 2024 dollars.</ce:simple-para></ce:legend>
<tgroup><thead><row><entry>Panel</entry><entry>Cost</entry><entry>Note</entry></row></thead>
<tbody><row><entry>100 A</entry><entry>$2,000</entry><entry/></row><row><entry>200 A | split</entry><entry>$4,500</entry><entry>rare</entry></row></tbody></tgroup>
<ce:table-footnote><ce:label>a</ce:label><ce:note-para>Median of 41 homes.</ce:note-para></ce:table-footnote></ce:table>
<ce:figure id="f1"><ce:label>Fig. 1</ce:label><ce:caption><ce:simple-para>Homes by panel size.</ce:simple-para></ce:caption></ce:figure>
<ce:figure id="f2"><ce:label>Fig. 2</ce:label><ce:caption><ce:simple-para>A figure no paragraph cites.</ce:simple-para></ce:caption></ce:figure>
<ce:textbox id="b1"><ce:label>Box 1</ce:label><ce:caption><ce:simple-para>What a panel is.</ce:simple-para></ce:caption>
<ce:textbox-body><ce:para>A panel distributes power.</ce:para><ce:para>It has a rating in amps.</ce:para></ce:textbox-body></ce:textbox>
</ja:floats>
<ja:head><ce:title>Panels everywhere</ce:title>
<ce:abstract class="author-highlights"><ce:section-title>Highlights</ce:section-title><ce:abstract-sec><ce:simple-para><ce:list>
<ce:list-item><ce:label>•</ce:label><ce:para>Panels limit heat pumps.</ce:para></ce:list-item></ce:list></ce:simple-para></ce:abstract-sec></ce:abstract>
<ce:abstract class="author"><ce:section-title>Abstract</ce:section-title><ce:abstract-sec><ce:simple-para>We study panels.</ce:simple-para>
<ce:simple-para>And what they cost.</ce:simple-para></ce:abstract-sec></ce:abstract>
<ce:keywords><ce:section-title>Keywords</ce:section-title><ce:keyword><ce:text>Panels</ce:text></ce:keyword><ce:keyword><ce:text>Heat pumps</ce:text></ce:keyword></ce:keywords>
</ja:head>
<ja:body><ce:sections>
<ce:section><ce:label>1</ce:label><ce:section-title>Introduction</ce:section-title>
<ce:para>Fig. 1 shows the homes in the sample<ce:float-anchor refid="f1"/>.</ce:para>
<ce:para>Costs vary<ce:footnote id="fn1"><ce:label>1</ce:label><ce:note-para>See the survey.</ce:note-para></ce:footnote> by size<ce:float-anchor refid="t1"/>:<ce:list>
<ce:list-item><ce:label>(a)</ce:label><ce:para>labour;</ce:para></ce:list-item><ce:list-item><ce:label>(b)</ce:label><ce:para>parts.</ce:para></ce:list-item></ce:list></ce:para>
<ce:section><ce:label>1.1</ce:label><ce:section-title>Load</ce:section-title>
<ce:para>The load is<ce:display><ce:formula id="e1"><ce:label>(1)</ce:label><mml:math><mml:mi>L</mml:mi><mml:mo>=</mml:mo><mml:mi>P</mml:mi></mml:math></ce:formula></ce:display> summed.</ce:para>
<ce:para>A box explains the parts<ce:float-anchor refid="b1"/>.</ce:para></ce:section>
<ce:para>After the subsection, the introduction goes on.</ce:para>
</ce:section>
<ce:section><ce:section-title>Methods</ce:section-title><ce:para>We surveyed the homes.</ce:para><ce:para>Then we priced the upgrades.</ce:para></ce:section>
</ce:sections>
<ce:acknowledgment><ce:section-title>Acknowledgments</ce:section-title><ce:para>We thank the homeowners.</ce:para></ce:acknowledgment>
<ce:conflict-of-interest><ce:section-title>Declaration of competing interest</ce:section-title><ce:para>None declared.</ce:para></ce:conflict-of-interest>
<ce:appendices><ce:section><ce:label>Appendix A</ce:label><ce:section-title>Survey</ce:section-title><ce:para>The questions we asked.</ce:para></ce:section></ce:appendices>
</ja:body>
<ja:tail><ce:bibliography><ce:section-title>References</ce:section-title><ce:bibliography-sec><ce:bib-reference id="r1"><ce:label>[1]</ce:label>
<ce:source-text>[1] A. Smith, Panels, Energy Policy 1 (2024) 1-2.</ce:source-text></ce:bib-reference></ce:bibliography-sec></ce:bibliography>
<ce:further-reading><ce:section-title>Further reading</ce:section-title><ce:further-reading-sec><ce:bib-reference id="fr1"><ce:label>[F1]</ce:label>
<ce:other-ref><ce:textref>More panels, 2020.</ce:textref></ce:other-ref></ce:bib-reference></ce:further-reading-sec></ce:further-reading></ja:tail>
</ja:article></xocs:serial-item></xocs:doc></originalText></full-text-retrieval-response>"""
FIXTURES = {"full": FULL, "meta": META_ONLY, "chapter": CHAPTER, "nobody": NO_BODY, "kitchen": KITCHEN}


class SameText(unittest.TestCase):
    """This version writes exactly the reading copy 1.1.0 wrote: the bytes passages are anchored in."""

    def test_every_fixture(self):
        tmp = Path(tempfile.mkdtemp())
        for name, body in FIXTURES.items():
            p = tmp / f"{name}.xml"
            p.write_text(body, encoding="utf-8")
            want = frozen.convert(str(p))["text"].encode("utf-8")
            self.assertEqual(xmltext.convert(str(p))["text"].encode("utf-8"), want, name)
            self.assertEqual(xmltext.structure(str(p))["text"].encode("utf-8"), want, name)

    @unittest.skipUnless(os.environ.get("UPC_XML_SAMPLES"), "set UPC_XML_SAMPLES to a folder of real full-text XML")
    def test_every_real_file(self):
        files = sorted(glob.glob(str(Path(os.environ["UPC_XML_SAMPLES"]).expanduser() / "*.xml")))
        self.assertTrue(files, "no .xml files in UPC_XML_SAMPLES")
        differ = [f for f in files if xmltext.convert(f)["text"] != frozen.convert(f)["text"]]
        self.assertEqual(differ, [], f"{len(differ)} of {len(files)} differ from 1.1.0")


class Structure(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        p = self.tmp / "kitchen.xml"
        p.write_text(KITCHEN, encoding="utf-8")
        s = xmltext.structure(str(p))
        self.text, self.map = s["text"], s["map"]
        self.blocks = self.map["blocks"]

    def at(self, words: str) -> dict:
        i = self.text.index(words)
        return next(b for b in self.blocks if b["c0"] <= i < b["c1"])

    def where(self, words: str) -> dict:
        return xmltext.place(self.map, self.text.index(words))

    def test_the_blocks_are_the_text(self):
        self.assertEqual("\n\n".join(self.text[b["c0"]:b["c1"]] for b in self.blocks) + "\n", self.text)
        self.assertEqual(self.map["chars"], len(self.text))
        self.assertEqual((self.map["upc_structure"], self.map["made_by"]), (1, f"xmltext {xmltext.VERSION}"))

    def test_kinds(self):
        self.assertEqual(self.at("# Panels everywhere")["kind"], "title")
        self.assertEqual(self.at("## 1 Introduction")["kind"], "heading")
        self.assertEqual(self.at("Keywords: Panels")["kind"], "keywords")
        # A caption and a sentence about the same figure: only the map tells them apart.
        self.assertEqual((self.at("Fig. 1. Homes by panel size.")["kind"], self.at("Fig. 1. Homes")["label"]),
                         ("caption", "Fig. 1"))
        self.assertEqual(self.at("Fig. 1 shows the homes")["kind"], "paragraph")
        self.assertEqual(self.at("(a) labour;")["kind"], "list_item")
        self.assertEqual(self.at("(1) L=P")["kind"], "formula")
        self.assertEqual((self.at("A panel distributes power.")["kind"], self.at("A panel distributes")["label"]),
                         ("box", "Box 1"))
        self.assertEqual(self.at("Costs in 2024 dollars.")["kind"], "table_note")
        self.assertEqual(self.at("Median of 41 homes.")["kind"], "table_note")
        self.assertEqual((self.at("1 See the survey.")["kind"], self.at("1 See the survey.")["label"]), ("note", "1"))
        self.assertEqual(self.at("[1] A. Smith")["kind"], "reference")
        self.assertEqual(self.at("[F1] More panels")["kind"], "reference")

    def test_table_rows_and_cells(self):
        rows = [b for b in self.blocks if b["kind"] == "row"]
        self.assertEqual([b.get("head", False) for b in rows], [True, False, False])
        self.assertEqual({(b["t"], b["label"]) for b in rows}, {(0, "Table 1")})
        cells = [[self.text[a:z] for a, z in b["cells"]] for b in rows]
        self.assertEqual(cells, [["Panel", "Cost", "Note"], ["100 A", "$2,000", ""], ["200 A | split", "$4,500", "rare"]])

    def test_sections_and_paragraph_numbers(self):
        self.assertEqual(self.where("We study panels."), {"type": "section", "value": "Abstract", "block": "paragraph",
                                                          "title": "Abstract", "paragraph": 1})
        self.assertEqual(self.where("And what they cost.")["paragraph"], 2)
        self.assertEqual(self.where("Costs vary")["paragraph"], 2)
        self.assertEqual(self.where("(b) parts.")["paragraph"], 2)          # a list item is cited by its paragraph
        self.assertEqual(self.where("The load is")["value"], "1.1 Load")
        # Not "1.1 Load": the paragraph after the subsection is the introduction's third.
        self.assertEqual({k: self.where("After the subsection")[k] for k in ("label", "paragraph")},
                         {"label": "1", "paragraph": 3})
        self.assertEqual(self.where("Then we priced")["value"], "Methods")
        self.assertNotIn("Acknowledgments", self.text)  # 1.1.0 leaves the title out, so only the map can name it
        self.assertEqual(self.where("We thank the homeowners.")["value"], "Acknowledgments")
        self.assertEqual(self.where("None declared.")["value"], "Declaration of competing interest")
        self.assertEqual(self.where("The questions we asked.")["label"], "Appendix A")
        self.assertNotIn("paragraph", self.where("Panels limit heat pumps."))  # a highlight, not a paragraph
        self.assertEqual(self.where("200 A | split")["item"], "Table 1")
        self.assertEqual(self.where("Fig. 2. A figure no paragraph cites.")["value"], "Fig. 2")
        self.assertEqual(self.where("1 See the survey.")["item"], "1")

    def test_cites(self):
        cite = lambda w: C.section_cite(self.where(w))  # noqa: E731
        self.assertEqual([cite(w) for w in ("We study panels.", "Costs vary", "After the subsection", "The load is",
                                            "Then we priced", "We thank", "200 A | split", "1 See the survey.",
                                            "The questions we asked.")],
                         ["Abstract ¶1", "§1 ¶2", "§1 ¶3", "§1.1 ¶1", "Methods ¶2", "Acknowledgments ¶1", "Table 1",
                          "n. 1", "Appendix A ¶1"])

    def test_a_passage_starting_in_a_blank_line_takes_the_next_block(self):
        i = self.text.index("\n\n## 1 Introduction") + 1
        self.assertEqual(xmltext.place(self.map, i)["block"], "heading")

    def test_the_stored_form_is_deterministic(self):
        p = self.tmp / "kitchen.xml"
        self.assertEqual(xmltext.map_bytes(xmltext.structure(str(p))["map"]), xmltext.map_bytes(self.map))
        self.assertEqual(json.loads(xmltext.map_bytes(self.map)), self.map)

    def test_no_map_without_a_ce_full_text(self):
        for name in ("nobody", "meta"):
            p = self.tmp / f"{name}.xml"
            p.write_text(FIXTURES[name], encoding="utf-8")
            self.assertIsNone(xmltext.structure(str(p))["map"], name)


class Cites(unittest.TestCase):
    """common.place_of reads like upc_common.mjs placeOf: both pass tests/section-cites.json."""

    def test_the_shared_cases(self):
        cases = json.loads((Path(__file__).resolve().parents[3] / "tests" / "section-cites.json").read_text())["cases"]
        for c in cases:
            self.assertEqual(C.place_of({"secondary_locators": c["locators"]}), c["cite"], c)


def upc_available():
    try:
        C.check_compat()
        return True
    except C.Unavailable:
        return False


class Convert(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "full.xml").write_text(FULL, encoding="utf-8")
        (self.tmp / "meta.xml").write_text(META_ONLY, encoding="utf-8")

    def test_reading_order_and_parts(self):
        info = xmltext.convert(str(self.tmp / "full.xml"))
        t = info["text"]
        self.assertTrue(info["full_text"])
        self.assertEqual((info["format"], info["doi"], info["pages"]), ("elsevier-ce", "10.1016/j.test.2024.000001", None))
        # The sentence reads whole: the footnote and the float anchor are not spliced into it.
        self.assertIn("can cost several thousand dollars and add weeks of coordination [1].", t)
        self.assertIn("We study panel upgrades.", t)
        self.assertIn("## 1 Introduction", t)
        # The table follows the paragraph that points to it, then the later paragraphs.
        self.assertLess(t.index("coordination [1]"), t.index("Table 1. Panel sizes in the sample."))
        self.assertLess(t.index("Table 1."), t.index("Paragraph 0"))
        self.assertIn("100 A | 41", t)
        self.assertIn("## Notes\n\n1 In 2024 dollars.", t)
        # A reference whose text already carries its label is not labelled twice.
        self.assertIn("[1] A. Smith, Panels", t)
        self.assertNotIn("[1] [1]", t)
        self.assertEqual(t, xmltext.convert(str(self.tmp / "full.xml"))["text"])  # deterministic

    def test_a_book_chapter_reads_like_an_article(self):
        p = self.tmp / "chapter.xml"
        p.write_text(CHAPTER, encoding="utf-8")
        info = xmltext.convert(str(p))
        t = info["text"]
        self.assertTrue(info["full_text"])
        self.assertTrue(t.startswith("# Energy security\n\n## Abstract\n\nA chapter on supply."))
        self.assertLess(t.index("## History"), t.index("Table 1. Fuels."))  # floats after the text, not before it
        self.assertIn("## References\n\n1 IEA, 2020.", t)

    def test_an_article_without_a_body_reads_its_rawtext(self):
        p = self.tmp / "nobody.xml"
        p.write_text(NO_BODY, encoding="utf-8")
        info = xmltext.convert(str(p))
        self.assertEqual(info["format"], "elsevier-rawtext")
        self.assertTrue(info["full_text"])  # by length: rawtext often has no paragraph breaks
        self.assertIn("The energy trilemma remains a pivotal challenge.", info["text"])

    def test_metadata_only_is_not_a_full_text(self):
        info = xmltext.convert(str(self.tmp / "meta.xml"))
        self.assertFalse(info["full_text"])
        self.assertEqual(info["format"], "elsevier-metadata-only")

    def test_other_xml_is_refused(self):
        p = self.tmp / "other.xml"
        p.write_text("<article/>", encoding="utf-8")
        with self.assertRaises(ValueError):
            xmltext.convert(str(p))


@unittest.skipUnless(upc_available(), "needs the upc CLI")
class AddAcquiredXml(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.corpus = self.tmp / "corpus"
        rows = []
        for name, body in (("full", FULL), ("meta", META_ONLY)):
            f = self.tmp / f"{name}.xml"
            f.write_text(body, encoding="utf-8")
            (self.tmp / f"{name}.xml.acq.json").write_text(json.dumps({
                "original_url": f"https://api.elsevier.com/content/article/pii/S0000{name}?view=FULL",
                "http_status": 200, "content_type": "text/xml", "fetched_at": "2026-10-28T20:00:00+00:00",
                "fetch_status": "success", "fetch_method": "http", "bytes": f.stat().st_size,
                "sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "tool": "pdf-harvest",
                "route": "Elsevier article-api"}))
            rows.append({"key": f"doi:10.1016/{name}", "kind": "xml", "file": str(f), "title": f"Panels {name}",
                         "asr": None})
        self.items = self.tmp / "acquired.jsonl"
        self.items.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    def test_xml_source_keeps_the_original_and_quotes_anchor(self):
        r = subprocess.run([sys.executable, str(SCRIPTS / "add_acquired.py"), "--corpus", str(self.corpus),
                            "--items", str(self.items), "--title", "test"], capture_output=True, text=True)
        out = r.stdout + r.stderr
        self.assertIn("not a full text", out)  # the metadata-only response is refused
        srcs = [json.loads(p.read_text()) for p in self.corpus.glob("sources/*/source.json")]
        self.assertEqual([s["title"] for s in srcs], ["Panels full"])
        src = srcs[0]
        roles = {x["role"]: x for x in src["representations"]}
        self.assertEqual(roles["original"]["media_type"], "text/xml")
        self.assertEqual(roles["original"]["sha256"].removeprefix("sha256:"),
                         src["retrieval"]["sha256"].removeprefix("sha256:"))
        self.assertEqual(roles["text"]["parent_representation_ref"], roles["original"]["representation_id"])
        reading = C.reading_copy(src["representations"])
        got = C.upc_jsonl("anchor", "--corpus", str(self.corpus), "--rep", reading["representation_id"],
                          records=[{"quote": "can cost several thousand dollars and add weeks of coordination",
                                    "type": "quote", "query": "panel upgrade cost"}])
        self.assertEqual(got["tally"]["anchored"], 1, got)
        rep = C.upc("validate", str(self.corpus))
        self.assertEqual(rep["errors"], [], rep["errors"])


if __name__ == "__main__":
    unittest.main()
