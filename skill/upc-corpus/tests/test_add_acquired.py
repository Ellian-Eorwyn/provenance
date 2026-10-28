"""add_acquired.py: fetched material (pdf-harvest PDFs with their acquisition
sidecars, page-reader pages with their raw bytes) -> UPC sources that carry
the fetch record, the ASR link and a textual reading copy; then a quotation
anchored into each reaches L1. End to end through the real `upc` CLI; skipped
when it or PyMuPDF is missing. Run with:

    python3 -m unittest discover -s tests -v
"""

import hashlib
import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import common as C  # noqa: E402

try:
    import fitz  # noqa: F401
except ImportError:
    fitz = None


def upc_available():
    try:
        C.check_compat()
        return True
    except C.Unavailable:
        return False


PANEL = ("Upgrading a 100 amp electrical panel to 200 amps can cost several thousand dollars "
         "and add weeks of utility coordination before a heat pump can be installed.")
BODY = " ".join([PANEL] + [f"Sentence {i} about service capacity, load calculations and circuit sharing." for i in range(20)])
WEB_MD = ("# Power-efficient electrification\n\n"
          "A 120 volt heat pump water heater plugs into an existing outlet and avoids a panel upgrade in many homes.\n\n"
          "Smart panels and circuit splitters let two large loads share one circuit.\n")
WEB_RAW = ("<!doctype html><html><head><title>Power-efficient electrification</title></head><body><article>"
           "<h1>Power-efficient electrification</h1><p>A 120 volt heat pump water heater plugs into an existing "
           "outlet and avoids a panel upgrade in many homes.</p></article></body></html>").encode()


@unittest.skipUnless(fitz is not None and upc_available(), "needs PyMuPDF and the upc CLI")
class AddAcquired(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.corpus = self.tmp / "corpus"
        stage = self.tmp / "stage"
        stage.mkdir()

        pdf = stage / "s0001.pdf"
        doc = fitz.open()
        page = doc.new_page()
        page.insert_textbox(fitz.Rect(72, 72, 540, 760), BODY, fontsize=10)
        doc.save(str(pdf))
        pdf_sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        (stage / "s0001.pdf.acq.json").write_text(json.dumps({
            "original_url": "https://oa.example.org/panels.pdf", "final_url": "https://oa.example.org/panels.pdf",
            "http_status": 200, "content_type": "application/pdf", "fetched_at": "2026-09-26T20:00:00+00:00",
            "fetch_status": "success", "fetch_method": "http", "sha256": pdf_sha, "bytes": pdf.stat().st_size,
            "tool": "pdf-harvest", "route": "Unpaywall OA"}))

        raw, md = stage / "w1.html", stage / "w1.md"
        raw.write_bytes(WEB_RAW)
        md.write_text(WEB_MD, encoding="utf-8")
        web_prov = {"original_url": "https://www.example.gov/electrify", "final_url": "https://www.example.gov/electrify",
                    "http_status": 200, "content_type": "text/html; charset=utf-8",
                    "fetched_at": "2026-09-26T20:01:00.000Z", "fetch_status": "success",
                    "fetch_method": "playwright", "extraction_method": "readability",
                    "sha256": hashlib.sha256(WEB_RAW).hexdigest(), "bytes": len(WEB_RAW),
                    "tool": "page-reader", "tool_version": "1.1.0"}

        self.items = stage / "acquired.jsonl"
        self.items.write_text("\n".join(json.dumps(x) for x in [
            {"key": "doi:10.1000/panels", "kind": "pdf", "file": str(pdf), "title": "Panels and heat pumps",
             "doi": "10.1000/panels",
             "bibliographic": {"item_type": "article-journal", "title": "Panels and heat pumps",
                               "authors": [{"family": "Smith", "given": "A."}], "issued": {"date_parts": [[2024]]}},
             "asr": {"registry_id": "scholarly", "source_id": "asc-000000000001", "access_id": "acc-000000000001"},
             "discovery": {"query": "electrical panel capacity heat pump", "discovered_from": "authority:asc-000000000001"}},
            {"key": "url:https://www.example.gov/electrify", "kind": "web", "file": str(raw), "reading_copy": str(md),
             "title": "Power-efficient electrification", "provenance": web_prov, "asr": None,
             "discovery": {"query": "120V heat pump water heater"}, "aliases": {"proj": "r0042"}},
        ]) + "\n")

    def run_script(self, *extra):
        return subprocess.run([sys.executable, str(SCRIPTS / "add_acquired.py"), "--corpus", str(self.corpus),
                               "--items", str(self.items), "--title", "test", *extra],
                              capture_output=True, text=True)

    def sources(self):
        return {json.loads(p.read_text())["title"]: json.loads(p.read_text())
                for p in self.corpus.glob("sources/*/source.json")}

    def test_sources_carry_fetch_record_asr_and_reading_copy(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sources added", r.stdout)
        src = self.sources()
        pdf, web = src["Panels and heat pumps"], src["Power-efficient electrification"]

        # The fetch record is copied, and its hash is the stored original's.
        self.assertEqual(pdf["retrieval"]["original_url"], "https://oa.example.org/panels.pdf")
        self.assertEqual(pdf["retrieval"]["fetch_method"], "http")
        roles = {r["role"]: r for r in pdf["representations"]}
        self.assertEqual(roles["document_pdf"]["sha256"].removeprefix("sha256:"),
                         pdf["retrieval"]["sha256"].removeprefix("sha256:"))
        self.assertEqual(roles["text"]["parent_representation_ref"], roles["document_pdf"]["representation_id"])
        self.assertEqual(pdf["ext"]["authority"]["source_id"], "asc-000000000001")
        self.assertEqual(pdf["aliases"]["hermes"], "doi:10.1000/panels")
        self.assertEqual(pdf["identifiers"], [{"scheme": "doi", "value": "10.1000/panels"}])

        wroles = {r["role"]: r for r in web["representations"]}
        self.assertEqual(set(wroles), {"raw_html", "clean_markdown"})
        self.assertEqual(wroles["raw_html"]["sha256"].removeprefix("sha256:"), web["retrieval"]["sha256"].removeprefix("sha256:"))
        self.assertEqual(web["retrieval"]["extraction_method"], "readability")
        self.assertEqual(web["ext"]["hermes"]["asr"], "unregistered")
        self.assertEqual(web["ext"]["hermes"]["host"], "www.example.gov")
        # A project's own id rides beside the key, so its outputs can name the page as they name a PDF.
        self.assertEqual(web["aliases"], {"proj": "r0042", "hermes": "url:https://www.example.gov/electrify"})
        self.assertNotIn("canonical_url", web["retrieval"])  # add would mint from it; the validator would not

        # Valid, but L0 until something is quoted.
        rep = C.upc("validate", str(self.corpus))
        self.assertEqual(rep["errors"], [], rep["errors"])

        # A second run adds nothing.
        again = self.run_script()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("Nothing to do", again.stdout)
        self.assertEqual(len(self.sources()), 2)

    def test_quotes_anchor_and_the_corpus_reaches_l1(self):
        self.assertEqual(self.run_script().returncode, 0)
        src = self.sources()
        for title, quote in [("Panels and heat pumps", "can cost several thousand dollars"),
                             ("Power-efficient electrification", "plugs into an existing outlet")]:
            reading = C.reading_copy(src[title]["representations"])
            out = C.upc_jsonl("anchor", "--corpus", str(self.corpus), "--rep", reading["representation_id"],
                              records=[{"quote": quote, "type": "quote", "query": "panel upgrade barriers"}])
            self.assertEqual(out["tally"]["anchored"], 1, out)
        rep = C.upc("validate", str(self.corpus))
        self.assertEqual(rep["errors"], [], rep["errors"])
        self.assertEqual(rep["level"], "L1")


if __name__ == "__main__":
    unittest.main()
