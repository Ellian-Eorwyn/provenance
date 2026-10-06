"""Offline tests for citations.py: tiers, and the check that finds every figure again
in ASR's stored payload. No network. Run with:

    python3 -m unittest discover -s tests -p 'test_citations.py' -v
"""

import hashlib
import os
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import citations as CIT  # noqa: E402


def work(doi, year="2020-03-01", pct=0.96, top1=False, top10=True, cited=79):
    return {"id": "https://openalex.org/W1", "doi": f"https://doi.org/{doi}", "publication_date": year,
            "publication_year": int(year[:4]), "cited_by_count": cited, "fwci": 4.3243, "is_retracted": False,
            "type": "article", "citation_normalized_percentile": {"value": pct, "is_in_top_1_percent": top1,
                                                                   "is_in_top_10_percent": top10},
            "primary_topic": {"subfield": {"display_name": "Pollution"}}}


class TierTests(unittest.TestCase):
    asof = date(2026, 10, 5)

    def test_tiers(self):
        self.assertEqual(CIT.tier_of(work("a", top1=True), self.asof), "top-1")
        self.assertEqual(CIT.tier_of(work("a"), self.asof), "top-10")
        self.assertEqual(CIT.tier_of(work("a", pct=0.7, top10=False), self.asof), "above-median")
        self.assertEqual(CIT.tier_of(work("a", pct=0.3, top10=False), self.asof), "below-median")
        self.assertEqual(CIT.tier_of(None, self.asof), "not-indexed")

    def test_under_24_months_is_too_recent_whatever_its_percentile(self):
        self.assertEqual(CIT.tier_of(work("a", year="2024-10-06", top1=True), self.asof), "too-recent")
        self.assertEqual(CIT.tier_of(work("a", year="2024-10-05", top1=True), self.asof), "top-1")


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.corpus = Path(self.tmp.name)
        (self.corpus / "sources" / "p").mkdir(parents=True)
        (self.corpus / "sources" / "p" / "source.json").write_text(json.dumps(
            {"source_id": "src-000000000001", "bibliographic": {"doi": "10.1/ABC"}}))
        payload = self.corpus / "payload.json"
        payload.write_text(json.dumps({"results": [work("10.1/abc")]}))
        self.sha = hashlib.sha256(payload.read_bytes()).hexdigest()
        self.fetch = {"fetch_id": "fch-000000000001", "sha256": self.sha, "payload": str(payload), "fetched": "2026-10-05"}
        CIT.state(self.corpus).joinpath("fetched.json").write_text(json.dumps(
            {"found": {"10.1/abc": {"fetch_id": "fch-000000000001"}}, "missing": [], "fetches": [self.fetch]}))
        self.payload = payload

    def tearDown(self):
        self.tmp.cleanup()

    def code(self, rationale, code="top-10"):
        d = self.corpus / "codings" / "cds-x"
        d.mkdir(parents=True, exist_ok=True)
        (d / "items.jsonl").write_text(json.dumps({"coder": CIT.CODER, "code": code, "rationale": rationale,
                                                   "target": {"kind": "source", "id": "src-000000000001"}}) + "\n")

    def test_figures_round_trip(self):
        r = CIT.rationale(work("10.1/abc"), self.fetch, "2026-10-05")
        self.assertTrue(CIT.RATIONALE.match(r))
        self.code(r)
        self.assertEqual(CIT.check(self.corpus), (1, []))

    def test_an_edited_figure_is_caught(self):
        self.code(CIT.rationale(work("10.1/abc", cited=80), self.fetch, "2026-10-05"))
        n, problems = CIT.check(self.corpus)
        self.assertEqual(n, 0)
        self.assertIn("figures differ", problems[0])

    def test_a_changed_payload_is_caught(self):
        self.code(CIT.rationale(work("10.1/abc"), self.fetch, "2026-10-05"))
        self.payload.write_text(json.dumps({"results": [work("10.1/abc", cited=1)]}))
        n, problems = CIT.check(self.corpus)
        self.assertIn("no longer has sha256", problems[0])

    def test_a_wrong_tier_is_caught(self):
        self.code(CIT.rationale(work("10.1/abc"), self.fetch, "2026-10-05"), code="top-1")
        self.assertIn("doesn't follow", CIT.check(self.corpus)[1][0])


if __name__ == "__main__":
    unittest.main()
