"""xmltext.py: Elsevier full-text XML -> a reading copy, and add_acquired.py's `xml` items: the XML is kept as the
original, the reading copy carries the article's words in reading order, a quotation anchors into it, and a
metadata-only response (an unentitled request) is refused. The end-to-end half runs the real `upc` CLI and is
skipped when it is missing. Run with:

    python3 -m unittest discover -s tests -v
"""

import hashlib
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
