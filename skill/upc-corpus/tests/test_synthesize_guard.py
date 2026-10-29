"""Offline tests for what synthesize.py refuses to store, and what a retry supersedes.
No model is called. Run with:

    python3 -m unittest discover -s tests -p 'test_synthesize_guard.py' -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import synthesize as S  # noqa: E402

CLAIM = [{"claim_id": "cl-0001", "text": "x", "evidence_ids": ["ext-0123456789ab"]}]


def got(prose, cited=("ext-0123456789ab",), claims=CLAIM):
    return {"prose": prose, "cited": list(cited), "claims": list(claims)}


class NotAnOverviewTests(unittest.TestCase):
    """The four FORGE 2.2 overviews of 10-28 that were the model's notes, and real ones."""

    def test_the_user_wants(self):
        self.assertIn("working notes", S.not_an_overview(got(
            "The user wants a 350-700 word sober overview of what the academic literature says.")))

    def test_notes_partway_down(self):
        prose = ("Panel limits recur across the studies [ext-0123456789ab].\n\n"
                 "Let me organize the passages by theme:\n\n- ext-0123456789ab: cost")
        self.assertIn("working notes", S.not_an_overview(got(prose)))

    def test_nothing_cited(self):
        self.assertEqual(S.not_an_overview(got("A fine sentence.", cited=(), claims=())), "it cites no passage")

    def test_a_real_overview_passes(self):
        prose = ("Electrical capacity is among the most cited barriers [ext-0123456789ab]. Several "
                 "evaluations let households use 120-volt equipment instead, and the user experience "
                 "of those programs is mixed.")
        self.assertEqual(S.not_an_overview(got(prose)), "")

    def test_let_me_inside_a_quotation_passes(self):
        # Only a line that starts with the model's own "let me draft" counts.
        prose = 'One installer said "let me check the panel first" [ext-0123456789ab].'
        self.assertEqual(S.not_an_overview(got(prose)), "")


class CurrentOverviewTests(unittest.TestCase):
    def test_the_newest_unsuperseded_one_per_code(self):
        with tempfile.TemporaryDirectory() as d:
            corpus = Path(d)

            def put(sid, title, slug, at, supersedes=None):
                f = corpus / "syntheses" / sid / "synthesis.json"
                f.parent.mkdir(parents=True)
                o = {"synthesis_id": sid, "title": title, "ext": {"upc-corpus": {"codebook": slug}},
                     "provenance": {"created_at": at}}
                if supersedes:
                    o["supersedes"] = supersedes
                f.write_text(json.dumps(o), encoding="utf-8")

            put("syn-a", "Electrical capacity", "barrier", "2026-10-28T02:00:00Z")
            put("syn-b", "Electrical capacity", "barrier", "2026-10-28T03:00:00Z", supersedes="syn-a")
            put("syn-c", "Upfront cost", "barrier", "2026-10-28T02:00:00Z")
            put("syn-d", "Upfront cost", "enabler", "2026-10-28T02:00:00Z")
            got_ = S.current_overviews(corpus)
            self.assertEqual(got_[("barrier", "Electrical capacity")], "syn-b")
            self.assertEqual(got_[("barrier", "Upfront cost")], "syn-c")
            self.assertEqual(got_[("enabler", "Upfront cost")], "syn-d")


if __name__ == "__main__":
    unittest.main()
