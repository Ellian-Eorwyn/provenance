"""Offline tests for check_codes.py: the fixed reason check, reading the checker's answer, and what a
verdict turns into. No model is called. Run with:

    python3 -m unittest discover -s tests -p 'test_check_codes.py' -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import check_codes as K  # noqa: E402

BOOK = {"codebook_id": "cbk-000000000001", "slug": "technology", "title": "Technology",
        "codes": [{"code": "space-heat-pump", "label": "Space-heating heat pump", "definition": "A heat pump for space heat."},
                  {"code": "other-electric", "label": "Other electric", "definition": "Any other electric equipment."}]}
CODING = {"coding_id": "cod-000000000001", "codebook_ref": BOOK["codebook_id"], "code": "space-heat-pump",
          "target": {"kind": "extraction", "id": "ext-000000000001"}, "coder": "m-27b",
          "rationale": "Quantifies neighbor effect on solar adoption."}


class FlagTests(unittest.TestCase):
    """The four FORGE 2.2 reasons of 10-28 that were the coder thinking aloud, and plain ones."""

    def test_thinking_aloud_is_flagged(self):
        solar = ("Quantifies neighbor effect on solar adoption (note: text says solar PV, code space-heat-pump is "
                 "closest fit for 'solar' in tech list? No, solar is not listed. Wait, technology list has 'other-electric")
        self.assertEqual(K.rationale_flags(solar), ["question", "deliberation", "code-list"])
        mandate = ("Mentions eligibility rules but no mandate code fits perfectly; actually 'none' for enabler? No, "
                   "it's about program design. Let's use barrier: program-design.")
        self.assertIn("deliberation", K.rationale_flags(mandate))
        self.assertIn("think-tag", K.rationale_flags("<think>hmm</think> Cost."))

    def test_plain_reasons_pass(self):
        for t in ("Contractor scarcity creates long wait times for installation.",
                  "Describes mandatory building codes requiring solar installation.",
                  "Phase I enrolled ten homeowners in single-family homes.",
                  'Households asked "why would I switch?" in interviews.'):
            self.assertEqual(K.rationale_flags(t), [], t)


class ParseTests(unittest.TestCase):
    ids = {"c1": (CODING, BOOK), "c2": (dict(CODING, coding_id="cod-000000000002"), BOOK)}

    def test_answers_map_to_codings(self):
        got = K.parse_checks(json.dumps({"checks": [
            {"id": "c1", "fits": "no", "better": "other-electric", "reason_ok": True, "why": "The passage is about solar PV."},
            {"id": "c2", "fits": "yes", "better": "", "reason_ok": False, "why": "It names heat pumps."}]}), self.ids)
        self.assertEqual(got["cod-000000000001"]["better"], "other-electric")
        self.assertEqual(K.kind_of(dict(got["cod-000000000001"], flags=[])), "wrong")
        self.assertEqual(K.kind_of(dict(got["cod-000000000002"], flags=[])), "reason")

    def test_no_code_fits_means_withdraw(self):
        got = K.parse_checks('{"checks":[{"id":"c1","fits":"no","better":"none","reason_ok":true,"why":"Solar only."}]}', self.ids)
        self.assertEqual(K.kind_of(dict(got["cod-000000000001"], flags=[])), "none")

    def test_malformed_answers_are_asked_again(self):
        got = K.parse_checks(json.dumps({"checks": [
            {"id": "c1", "fits": "no", "better": "made-up-code", "why": "x"},   # not in the codebook
            {"id": "c2", "fits": "maybe", "why": "x"},                          # not an answer
            {"id": "c9", "fits": "yes", "why": "x"}]}), self.ids)              # not a code we asked about
        self.assertEqual(got, {})

    def test_a_fitting_code_with_a_flagged_reason_is_restated(self):
        v = {"fits": "yes", "better": "", "reason_ok": True, "why": "Names heat pumps.", "flags": ["question"]}
        self.assertEqual(K.kind_of(v), "reason")
        self.assertEqual(K.kind_of(dict(v, flags=[])), "")


class ChangeTests(unittest.TestCase):
    def test_verdicts_become_recode_lines(self):
        v = {"cod-1": {"fits": "no", "better": "other-electric", "reason_ok": True, "why": "Solar PV.", "flags": [], "code": "space-heat-pump"},
             "cod-2": {"fits": "no", "better": "none", "reason_ok": True, "why": "Off topic.", "flags": [], "code": "x"},
             "cod-3": {"fits": "yes", "better": "", "reason_ok": False, "why": "Names a heat pump.", "flags": [], "why_flags": [], "code": "space-heat-pump"},
             "cod-4": {"fits": "yes", "better": "", "reason_ok": False, "why": "Wait, is it?", "flags": [], "why_flags": ["question"], "code": "x"}}
        ch = K.changes_from([{"coding_id": k} for k in ("cod-1", "cod-2", "cod-3", "cod-4", "cod-gone")], v, "chk", "ellian")
        self.assertEqual(ch[0], {"coding_id": "cod-1", "to": "other-electric", "coder": "chk",
                                 "why": "Solar PV. (checked by chk; approved by ellian)"})
        self.assertEqual(ch[1]["retract"], True)
        self.assertEqual((ch[2]["to"], ch[2]["rationale"]), ("space-heat-pump", "Names a heat pump."))
        self.assertEqual(len(ch), 3, "a restatement whose own reason is flagged is not applied; a gone verdict is skipped")


class RunTests(unittest.TestCase):
    def test_a_run_stores_one_verdict_per_coding_and_resumes(self):
        with tempfile.TemporaryDirectory() as d:
            corpus = Path(d)
            (corpus / "codebooks").mkdir()
            (corpus / "codebooks" / f"{BOOK['codebook_id']}.json").write_text(json.dumps(BOOK))
            src = corpus / "sources" / "s1"
            src.mkdir(parents=True)
            (src / "source.json").write_text(json.dumps({"source_id": "src-1", "title": "A solar paper"}))
            (src / "extractions.jsonl").write_text(json.dumps({"extraction_id": "ext-000000000001", "source_id": "src-1",
                                                               "direct_quote": "Neighbours' panels raise adoption."}) + "\n")
            (corpus / "codings" / "cds-1").mkdir(parents=True)
            (corpus / "codings" / "cds-1" / "items.jsonl").write_text(
                json.dumps(CODING) + "\n" + json.dumps(dict(CODING, coding_id="cod-000000000009", status="retracted")) + "\n")
            calls = []

            def fake(system, user, **kw):
                calls.append(user)
                return {"content": '{"checks":[{"id":"c1","fits":"no","better":"other-electric","reason_ok":true,'
                                   '"why":"The passage is about rooftop solar."}]}'}
            real, K.C.llm_chat = K.C.llm_chat, fake
            try:
                a = SimpleNamespace(corpus=d, set="cds-1", codebook="", batch=10, checker="chk", model="chat",
                                    url="http://x", context="", sample=0, papers=0, seed=1, limit=0)
                self.assertEqual(K.cmd_run(a), 0)
                self.assertEqual(K.cmd_run(a), 0)  # resumes: nothing left to ask
            finally:
                K.C.llm_chat = real
            self.assertEqual(len(calls), 1, "only the active coding is asked about, once")
            self.assertIn("Coder's reason: Quantifies neighbor effect", calls[0])
            got = K.done_ids(K.state_file(corpus, "chk", "cds-1"))
            self.assertEqual(list(got), ["cod-000000000001"])
            self.assertEqual((got["cod-000000000001"]["kind"], got["cod-000000000001"]["better"]), ("wrong", "other-electric"))
            self.assertFalse((corpus / "provenance").exists(), "a run writes nothing to the corpus")


if __name__ == "__main__":
    unittest.main()
