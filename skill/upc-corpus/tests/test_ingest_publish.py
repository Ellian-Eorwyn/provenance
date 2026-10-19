"""ingest.py attaches a PDF's pdf-harvest sidecar (`<file>.acq.json`) as its source's
`retrieval`; publish.py leaves PDFs over the host's per-file limit out of its bundles.

Three PDFs (one with a sidecar that matches, one with none, one whose sidecar describes
other bytes) are ingested through the real `upc` CLI, ingested again with --force-text
(no twins), then published with a limit every PDF is over. Skipped without the upc CLI,
PyMuPDF or poppler.
"""

import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
HERE = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import ingest  # noqa: E402

try:
    import fitz
except ImportError:
    fitz = None


def upc_ok():
    try:
        C.check_compat()
        return True
    except C.Unavailable:
        return False


BODY = " ".join(["Upgrading a 100 amp panel to 200 amps can add weeks of utility coordination before a heat pump."]
                + [f"Sentence {i} about service capacity, load calculations and circuit sharing." for i in range(20)])


def sidecar(pdf: Path, sha: str) -> dict:
    return {"original_url": f"https://oa.example.org/{pdf.stem}.pdf", "final_url": f"https://oa.example.org/{pdf.stem}.pdf",
            "http_status": 200, "content_type": "application/pdf", "fetched_at": "2026-10-19T20:00:00+00:00",
            "fetch_status": "success", "fetch_method": "http", "sha256": sha, "bytes": pdf.stat().st_size,
            "tool": "pdf-harvest", "route": "open access copy"}


class Sidecar(unittest.TestCase):
    def test_a_sidecar_becomes_retrieval_only_when_it_matches(self):
        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d) / "a.pdf"
            pdf.write_bytes(b"%PDF-1.4 a test\n")
            self.assertEqual(ingest.acquisition(pdf), (None, ""))
            Path(str(pdf) + ".acq.json").write_text(json.dumps(sidecar(pdf, hashlib.sha256(pdf.read_bytes()).hexdigest())))
            (ret, extras), why = ingest.acquisition(pdf)
            self.assertEqual((ret["original_url"], ret["fetch_method"], why), ("https://oa.example.org/a.pdf", "http", ""))
            self.assertTrue(ret["sha256"].startswith("sha256:"))
            self.assertNotIn("canonical_url", ret)  # it would re-address the source (add_acquired.py)
            self.assertEqual(extras["route"], "open access copy")
            Path(str(pdf) + ".acq.json").write_text(json.dumps(sidecar(pdf, "0" * 64)))
            got, why = ingest.acquisition(pdf)
            self.assertIsNone(got)
            self.assertIn("describes other bytes", why)


@unittest.skipUnless(fitz is not None and upc_ok() and shutil.which("pdftotext"), "needs PyMuPDF, poppler and the upc CLI")
class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        pdfs = cls.tmp / "pdfs"
        pdfs.mkdir()
        rows = []
        for n, (rid, side) in enumerate((("s0001", "match"), ("s0002", None), ("s0003", "other")), 1):
            pdf = pdfs / f"{rid}.pdf"
            doc = fitz.open()
            doc.new_page().insert_textbox(fitz.Rect(72, 72, 540, 760), f"Paper {n}. " + BODY, fontsize=10)
            doc.save(str(pdf))
            if side:
                sha = hashlib.sha256(pdf.read_bytes()).hexdigest() if side == "match" else "f" * 64
                Path(str(pdf) + ".acq.json").write_text(json.dumps(sidecar(pdf, sha)))
            rows.append({"id": rid, "title": f"Panels and heat pumps {n}", "authors": "Rivera, A.", "year": "2024",
                         "doi": "", "pdf_filename": pdf.name, "status": "included"})
        manifest = cls.tmp / "manifest.csv"
        with open(manifest, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        cls.corpus = cls.tmp / "corpus"
        cls.cfg = cls.tmp / "ingest.json"
        cls.cfg.write_text(json.dumps({"corpus": str(cls.corpus), "title": "Panels", "manifest": str(manifest),
                                       "pdf_dir": str(pdfs), "namespace": "t"}))
        cls.first = cls.run_ingest()
        cls.sources = {json.loads(f.read_text())["aliases"]["t"]: json.loads(f.read_text())
                       for f in cls.corpus.glob("sources/*/source.json")}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def run_ingest(cls, *extra) -> str:
        p = subprocess.run([sys.executable, str(HERE / "ingest.py"), "--config", str(cls.cfg), *extra],
                           capture_output=True, text=True)
        assert p.returncode == 0, p.stdout + p.stderr
        return p.stdout

    def test_the_fetch_record_is_attached_and_validates(self):
        s1, s2, s3 = (self.sources[k] for k in ("s0001", "s0002", "s0003"))
        self.assertEqual(s1["retrieval"]["original_url"], "https://oa.example.org/s0001.pdf")
        self.assertEqual(s1["ext"]["t"]["acquisition"]["tool"], "pdf-harvest")
        self.assertNotIn("retrieval", s2)
        self.assertNotIn("retrieval", s3)
        self.assertIn("NOTE s0003: s0003.pdf.acq.json describes other bytes", self.first)
        self.assertRegex(self.first, r"with a fetch record \(<pdf>\.acq\.json\)\s+1")
        self.assertEqual(C.upc("validate", str(self.corpus)).get("errors"), [])

    def test_ingesting_again_makes_no_twins(self):
        out = self.run_ingest("--force-text")
        self.assertRegex(out, r"already present\s+3")
        self.assertEqual(len(list(self.corpus.glob("sources/*/source.json"))), 3)

    def test_publish_leaves_out_pdfs_over_the_limit(self):
        out = self.tmp / "handover"
        p = subprocess.run([sys.executable, str(HERE / "publish.py"), "--corpus", str(self.corpus), "--out", str(out),
                            "--name", "Lib", "--pdfs", "--folder-site", "--max-pdf-mib", "0.0001"],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("Left out 3 PDFs over 0.0001 MiB", p.stdout)
        rec = json.loads((out / "Lib-left-out.json").read_text())
        self.assertEqual(sorted(x["file"] for x in rec["files"]), ["s0001.pdf", "s0002.pdf", "s0003.pdf"])
        self.assertEqual(rec["max_bytes"], 104)
        self.assertFalse(list(out.rglob("*.pdf")))
        slug = next(f.parent.name for f in self.corpus.glob("sources/*/source.json") if "s0001" in f.parent.name)
        page = (out / "Lib-site" / "sources" / f"{slug}.html").read_text()
        self.assertIn("is over the", page)
        self.assertNotIn("files/s000", page)
        # under the default limit they travel, and the record of a previous run is gone
        p = subprocess.run([sys.executable, str(HERE / "publish.py"), "--corpus", str(self.corpus), "--out", str(out),
                            "--name", "Lib", "--pdfs", "--folder-site"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertFalse((out / "Lib-left-out.json").exists())
        self.assertEqual(len(list((out / "Lib-site" / "files").glob("*.pdf"))), 3)
        self.assertEqual(len(list((out / "Lib_files").glob("*.pdf"))), 3)


if __name__ == "__main__":
    unittest.main()
