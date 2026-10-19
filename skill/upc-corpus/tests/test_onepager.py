"""onepager.py: one printable page for one audience, where every number is a figure whose passage is
stored in the corpus, judged for its readers by codings, checked by a person, and found again at build.

A synthetic corpus: a trial report, two readers' readings of a chart, an interview and a reviewer's
reply; two audiences on one project. No network, no model server: `code` and `write` run against a
stub. The PDF tests need a Playwright (PLAYWRIGHT_DIR) and are skipped without one.
"""

import copy
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
from unittest import mock

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
HERE = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import onepager as O  # noqa: E402


def upc_ok():
    try:
        v = C.upc("version", "--json")
        return tuple(int(x) for x in str(v.get("spec_version", "0.0")).split(".")[:2]) >= (1, 15)
    except Exception:  # noqa: BLE001
        return False


def add_web(corpus: Path, stage: Path, key: str, url: str, text: str, title: str) -> dict:
    """A web document saved the way the acquire step saves one (as test_dossier.py does)."""
    raw = stage / (hashlib.sha256(key.encode()).hexdigest()[:8] + ".html")
    raw.write_text(f"<html><body>{text}</body></html>")
    md = raw.with_suffix(".md")
    md.write_text(text)
    prov = {"original_url": url, "final_url": url, "http_status": 200, "content_type": "text/html",
            "fetched_at": "2026-10-19T17:00:00Z", "fetch_status": "success", "fetch_method": "playwright",
            "extraction_method": "readability", "sha256": hashlib.sha256(raw.read_bytes()).hexdigest()}
    items = stage / "items.jsonl"
    items.write_text(json.dumps({"key": key, "kind": "web", "file": str(raw), "reading_copy": str(md),
                                 "provenance": prov, "title": title, "asr": None}) + "\n")
    subprocess.run([sys.executable, str(HERE / "add_acquired.py"), "--corpus", str(corpus), "--items", str(items)],
                   check=True, capture_output=True)
    return C.corpus_reps(corpus)[key]


HAVE_PANDOC = bool(shutil.which("pandoc"))
PW = os.environ.get("PLAYWRIGHT_DIR")
HAVE_PW = bool(PW and (Path(PW) / "node_modules" / "playwright").is_dir() and shutil.which("node"))

SECRET = "The pilot plant is at the Example Creamery on Route 9."
TRIAL = ("# A gentler pasteurization trial\n\n"
         "In the trial, the treated samples kept below the spoilage limit for 7 days, while the control spoiled sooner. "
         "The treatment achieved a 5-log reduction at 55 °C in every run. "
         "Heat use per batch fell from 900 kWh to 600 kWh with the recovered heat. "
         "A separate test found a 4-log reduction after a shorter hold. "
         "National beverage plants use about 120 TBtu of process heat a year.\n\n" + SECRET + "\n\n" + "Method. " * 40)
READ_A = ("# Chart readings, reader A\n\nDay 14, treated: 2.76 log CFU/mL. Day 14, control: 4.10 log CFU/mL.\n\n"
          "| Day | Treated |\n|---|---|\n| Day 21 | 3.10 ± 0.15 |\n\n" + "Note. " * 20)
READ_B = "# Chart readings, reader B\n\nDay 14, treated: 2.80 log CFU/mL. Day 14, control: 4.40 log CFU/mL.\n\n" + "Note. " * 20
INTERVIEW = ("# Interview 3 (pseudonymized)\n\n"
             "We lose half a shift every time the line goes down for cleaning, and that is what I would pay to fix. "
             "The chlorine smell gets into everything.\n\n" + "Talk. " * 30)
REPLY = "# Reply from the lab lead\n\nI checked the shelf-life and log-reduction numbers against our lab book; they stand.\n\n" + "Thanks. " * 40

AUD_A = {"id": "processors", "kind": "audience", "name": "Beverage processors",
         "readers": [{"name": "Plant owner", "role": "Owner of a small juice plant"}],
         "wants": ["Shelf life and costs"], "decides": ["Whether to host a pilot"],
         "numbers": {"prefer": ["days of shelf life", "kWh per batch"], "avoid": ["national TBtu totals"]},
         "objections": [{"objection": "Will it change the taste?", "answer_hint": "sensory tests are next"}],
         "one_pager": {"layout": "technical", "tag": "For beverage processors", "cta": "Host a pilot run",
                       "distribution": "internal", "banned_words": ["revolutionary"]},
         "never_publish": ["Example Creamery"]}
AUD_B = {"id": "policy", "kind": "audience", "name": "State energy staff",
         "readers": [{"name": "Program analyst", "role": "State energy office"}],
         "wants": ["Statewide energy and emissions"], "one_pager": {"layout": "policy", "distribution": "partner"}}
PROJECT = {"id": "heat", "kind": "project", "name": "Low Heat", "full_name": "Low-temperature pasteurization with recovered heat",
           "lenses": [{"slug": "quality", "title": "Shelf life and quality", "description": "What the product gains."}],
           "never_publish": ["Route 9"],
           "one_pager": {"brand": {"palette": {"brand": "#123456", "accent": "#FFCC00", "heat": "#EE7700"},
                                   "org_line": "Example University", "funder_line": "Example Agency",
                                   "award_line": "Award EX-0001", "result_class": "Laboratory batch-scale results"},
                         "reviewers": [{"handle": "lab-lead", "name": "The lab lead", "checks": "food science"}],
                         "allow_numbers": ["55 °C"]}}

T, RA, RB, IV, RP = ("url:https://ex.org/trial", "url:https://ex.org/read-a", "url:https://ex.org/read-b",
                     "url:https://ex.org/interview", "url:https://ex.org/reply")
FIGURES = [
    {"id": "shelf-days", "label": "Shelf life, treated", "value": "7 days", "display": ["7+ days", "7+"], "source": T,
     "quote": "the treated samples kept below the spoilage limit for 7 days"},
    {"id": "log-kill", "label": "Log reduction", "value": "5-log", "source": T,
     "quote": "The treatment achieved a 5-log reduction at 55 °C in every run."},
    {"id": "heat-before", "label": "Heat per batch, before", "value": "900 kWh", "source": T,
     "quote": "Heat use per batch fell from 900 kWh"},
    {"id": "heat-after", "label": "Heat per batch, after", "value": "600 kWh", "source": T,
     "quote": "to 600 kWh with the recovered heat"},
    {"id": "heat-cut", "label": "Less heat per batch", "value": "33%", "display": ["⅓ less", "33%"],
     "derived": {"from": ["heat-before", "heat-after"], "rule": "(900 - 600) / 900, rounded down"}},
    {"id": "day14-treated", "label": "Day 14, treated", "value": "2.76", "unit": "log CFU/mL", "tolerance": 0.06,
     "source": RA, "quote": "Day 14, treated: 2.76 log CFU/mL.",
     "readings": [{"source": RB, "quote": "Day 14, treated: 2.80 log CFU/mL.", "value": "2.80"}]},
    {"id": "day14-control", "label": "Day 14, control", "value": "4.10", "unit": "log CFU/mL", "tolerance": 0.06,
     "source": RA, "quote": "Day 14, control: 4.10 log CFU/mL.",
     "readings": [{"source": RB, "quote": "Day 14, control: 4.40 log CFU/mL.", "value": "4.40"}]},
    {"id": "gap-14", "label": "Day 14 gap", "value": "1.34", "derived": {"from": ["day14-treated", "day14-control"],
                                                                        "rule": "4.10 - 2.76", "margin": 0.05}},
    {"id": "tbtu", "label": "National process heat", "value": "120 TBtu", "source": T,
     "quote": "National beverage plants use about 120 TBtu of process heat a year."},
]
PAGE = {
    "headline": "Gentler pasteurization, longer shelf life.",
    "subhead": "Treated juice kept for a week at a lower temperature, with heat a plant already throws away.",
    "hero": {"chart": {"type": "bars", "title": "Heat per batch", "sub": "kWh", "groups": ["Before", "After"],
                       "series": [{"label": "Heat used", "tone": "cool", "points": ["heat-before", "heat-after"]}]}},
    "tiles": [{"figure": "shelf-days", "big": "7+", "unit": "days", "line": "Kept below the spoilage limit in the lab.",
               "source_line": "Lab trial"},
              {"figure": "log-kill", "big": "5-log", "line": "Reduction at 55 °C, in every run.", "source_line": "Lab trial"},
              {"figure": "heat-cut", "big": "⅓ less", "line": "Heat per batch with recovered heat.", "source_line": "Lab trial"}],
    "how": {"title": "Heat a plant already has, put to work.",
            "steps": [{"title": "Recover the heat", "text": "A heat exchanger takes heat from the boiler exhaust.", "figures": []},
                      {"title": "Treat at lower heat", "text": "Food-grade compounds do the work at 55 °C.", "figures": ["log-kill"]},
                      {"title": "Keep it longer", "text": "Treated juice lasts longer on the shelf.", "figures": ["shelf-days"]}]},
    "status": {"shown": "Lab batches kept well.", "underway": "Pilot-scale runs.", "next": "A plant trial.", "figures": []},
    "cta": {"ask": "Host a pilot run.", "detail": "Share one product line and a week of plant data."},
    "about": {"items": ["Laboratory batch-scale results from a single trial series."]},
    "limits": ["No sensory tests yet."],
    "questions": ["Does the 7-day figure hold at plant scale?"],
}


def args(**kw):
    base = {k: None for k in ("slug", "audience", "project", "title", "date", "layout", "distribution", "show_writer_as")}
    return type("A", (), {**base, **kw})()


@unittest.skipUnless(upc_ok(), "needs the upc CLI 1.15+")
class OnePager(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = root = Path(tempfile.mkdtemp())
        cls.corpus, stage = root / "onepager", root / "stage"
        stage.mkdir()
        for key, text, title in ((T, TRIAL, "A gentler pasteurization trial"), (RA, READ_A, "Chart readings, reader A"),
                                 (RB, READ_B, "Chart readings, reader B"), (IV, INTERVIEW, "Interview 3"),
                                 (RP, REPLY, "Reply from the lab lead")):
            add_web(cls.corpus, stage, key, key.removeprefix("url:"), text, title)
        for name, obj in (("aud-a.json", AUD_A), ("aud-b.json", AUD_B), ("project.json", PROJECT)):
            (root / name).write_text(json.dumps(obj))
        O.cmd_init(cls.corpus, args(slug="proc", audience=str(root / "aud-a.json"), project=str(root / "project.json"),
                                    date="2026-10-19", show_writer_as=["Claude (test)=Hermes"]))
        O.cmd_init(cls.corpus, args(slug="pol", audience=str(root / "aud-b.json"), project=str(root / "project.json"),
                                    date="2026-10-19"))
        cls.add_rc = O.cmd_figures_add(cls.corpus, copy.deepcopy(FIGURES), by="test", replace=False, plan=False)
        cls.reg = O.load_reg(cls.corpus)
        figs = sorted(cls.reg)
        recs = [{"figure": f, "book": O.rel_slug("processors"), "code": "lead", "rationale": "model says lead"} for f in figs]
        recs += [{"figure": "tbtu", "book": O.rel_slug("processors"), "code": "avoid", "rationale": "national scale"}]
        O.write_codes(cls.corpus, cls.reg, recs[:-1], coder=O.MODEL_CODER, kind="model", model="stub")
        O.write_codes(cls.corpus, cls.reg, recs[-1:], coder=O.MODEL_CODER, kind="model", model="stub")
        O.write_codes(cls.corpus, cls.reg, [{"figure": f, "book": O.rel_slug("policy"), "code": "background"} for f in figs],
                      coder=O.MODEL_CODER, kind="model", model="stub")
        cls.page = O.add_page(cls.corpus, "proc", copy.deepcopy(PAGE), writer="Claude (test)", model="claude-test")
        cls.out = root / "out"
        cls.draft = O.build(cls.corpus, "proc", cls.out, draft=True, pdf=False, docx=HAVE_PANDOC)
        cls.html = (cls.out / "index.html").read_text()
        cls.note = (cls.out / "proc-figures.md").read_text()

    def fresh(self, name):
        dest = self.root / name
        shutil.copytree(self.corpus, dest)
        return dest

    def signoff_all(self, corpus, clearance=None):
        reg = O.load_reg(corpus)
        O.cmd_signoff(corpus, sorted(reg), "lab-lead", "confirmed", None, RP, None)
        O.write_codes(corpus, reg, [{"figure": f, "book": O.BOOKS["class"][0], "code": "measured"} for f in sorted(reg)
                                    if not reg[f].get("derived")], coder="ellie", kind="human")
        if clearance:
            O.cmd_signoff(corpus, sorted(reg), "clearer", None, clearance, None, "for partners")

    # -- figures
    def test_figures_are_anchored_data_points(self):
        self.assertEqual(self.add_rc, 0)
        self.assertEqual(len(self.reg), len(FIGURES))
        exts = O.extractions(self.corpus)
        for fid, f in self.reg.items():
            if f.get("extraction_id"):
                e = exts[f["extraction_id"]]
                self.assertEqual(e["type"], "data_point", fid)
                self.assertIn(f["value"], e["direct_quote"])
        self.assertNotIn("extraction_id", self.reg["heat-cut"])
        self.assertEqual(O.validate(self.corpus).get("errors") or [], [])

    def test_a_value_not_in_its_quote_is_refused_and_nothing_stored(self):
        bad = [{"id": "wrong", "label": "Wrong", "value": "8 days", "source": T,
                "quote": "the treated samples kept below the spoilage limit for 7 days"}]
        with self.assertRaises(SystemExit) as cm:
            O.cmd_figures_add(self.corpus, bad, by="test", replace=False, plan=True)
        self.assertIn("not in its quote", str(cm.exception))
        self.assertNotIn("wrong", O.load_reg(self.corpus))

    def test_a_figure_can_be_anchored_in_another_text_copy_of_its_source(self):
        c = self.fresh("rep")
        src = O.D.source_index(c)[T]
        bad = [{"id": "kill-rep", "label": "Kill", "value": "5-log", "source": T, "rep": "rep-000000000000",
                "quote": "The treatment achieved a 5-log reduction"}]
        with self.assertRaises(SystemExit) as cm:
            O.cmd_figures_add(c, bad, by="test", replace=False, plan=True)
        self.assertIn("no representation", str(cm.exception))
        ok = [{**bad[0], "rep": src["text_rep"]}]
        self.assertEqual(O.cmd_figures_add(c, ok, by="test", replace=False, plan=False), 0)
        self.assertEqual(O.load_reg(c)["kill-rep"]["rep"], src["text_rep"])

    def test_two_figures_cannot_share_one_passage(self):
        c = self.fresh("shared")
        twin = [{"id": "shelf-twin", "label": "Twin", "value": "7 days", "source": T,
                 "quote": "the treated samples kept below the spoilage limit for 7 days"}]
        rc = O.cmd_figures_add(c, twin, by="test", replace=False, plan=False)
        self.assertEqual(rc, 1)
        self.assertNotIn("shelf-twin", O.load_reg(c))

    def test_readers_who_disagree_beyond_the_tolerance_are_flagged(self):
        self.assertEqual([r["agrees"] for r in self.reg["day14-treated"]["readings"]], [True])
        self.assertEqual([r["agrees"] for r in self.reg["day14-control"]["readings"]], [False])
        J = O.judgements(self.corpus, self.reg)
        _, final = O.gate("day14-control", self.reg, J, "processors", "internal")
        self.assertTrue(any("readings disagree" in w for w in final))

    def test_a_thin_derived_margin_and_a_rounded_display_are_flagged(self):
        self.assertIn("thin", self.reg["gap-14"])
        self.assertEqual(self.reg["heat-cut"]["rounded"], ["⅓ less"])
        self.assertNotIn("rounded", self.reg["shelf-days"])

    def test_re_adding_the_same_figures_changes_nothing_and_a_change_needs_replace(self):
        c = self.fresh("readd")
        before = O.load_reg(c)
        self.assertEqual(O.cmd_figures_add(c, copy.deepcopy(FIGURES[:2]), by="test", replace=False, plan=False), 0)
        self.assertEqual(O.load_reg(c), before)
        changed = [{**FIGURES[0], "display": ["a week"]}]
        with self.assertRaises(SystemExit) as cm:
            O.cmd_figures_add(c, changed, by="test", replace=False, plan=False)
        self.assertIn("--replace", str(cm.exception))

    # -- codings
    def test_coding_one_audience_leaves_the_others_codes_active(self):
        J = O.judgements(self.corpus, self.reg)
        self.assertEqual(O.resolve(J[("shelf-days", O.rel_slug("processors"))])[0], "lead")
        self.assertEqual(O.resolve(J[("shelf-days", O.rel_slug("policy"))])[0], "background")
        self.assertEqual(O.resolve(J[("tbtu", O.rel_slug("processors"))]), ("avoid", False))  # superseded its own lead
        self.assertEqual(len(J[("tbtu", O.rel_slug("processors"))]), 1)

    def test_a_person_outranks_the_model_and_the_disagreement_stays_visible(self):
        c = self.fresh("outrank")
        reg = O.load_reg(c)
        O.write_codes(c, reg, [{"figure": "shelf-days", "book": O.rel_slug("processors"), "code": "support"},
                               {"figure": "heat-cut", "book": O.rel_slug("processors"), "code": "background"}],
                      coder="ellie", kind="human")
        J = O.judgements(c, O.load_reg(c))
        self.assertEqual(O.resolve(J[("shelf-days", O.rel_slug("processors"))]), ("support", True))
        self.assertEqual(O.resolve(J[("heat-cut", O.rel_slug("processors"))]), ("background", True))  # derived: in the register
        self.assertEqual(O.validate(c).get("errors") or [], [])

    def test_a_person_going_back_to_an_earlier_answer_is_the_answer_that_counts(self):
        c = self.fresh("goback")
        book = O.rel_slug("processors")
        for code in ("support", "avoid", "support"):
            O.write_codes(c, O.load_reg(c), [{"figure": "log-kill", "book": book, "code": code}], coder="ellie", kind="human")
        mine = [a for a in O.judgements(c, O.load_reg(c))[("log-kill", book)] if a["coder"] == "ellie"]
        self.assertEqual([a["code"] for a in mine], ["support"])

    def test_the_review_sheet_round_trips_and_refuses_unknown_codes(self):
        c = self.fresh("review")
        sheet = self.root / "review.csv"
        O.cmd_review_out(c, "proc", sheet)
        rows = list(csv.reader(sheet.open()))
        self.assertEqual(rows[0], O.REVIEW_COLS)
        for r in rows[1:]:
            if r[0] == "tbtu":
                r[5] = "support"
                self.assertIn(O.MODEL_CODER, r[7])
        with sheet.open("w", newline="") as fh:
            csv.writer(fh).writerows(rows)
        O.cmd_review_apply(c, "proc", sheet, "ellie")
        J = O.judgements(c, O.load_reg(c))
        self.assertEqual(O.resolve(J[("tbtu", O.rel_slug("processors"))])[0], "support")
        rows[1][5] = "maybe"
        with sheet.open("w", newline="") as fh:
            csv.writer(fh).writerows(rows)
        with self.assertRaises(SystemExit) as cm:
            O.cmd_review_apply(c, "proc", sheet, "ellie")
        self.assertIn("maybe", str(cm.exception))
        with self.assertRaises(SystemExit):
            O.cmd_review_apply(c, "proc", sheet, O.MODEL_CODER)

    def test_code_judges_with_the_model_and_writes_its_angle(self):
        c = self.fresh("code")
        seen = {}

        def stub(system, user, *, schema, **kw):
            seen["schema"], seen["system"] = schema, system
            ids = schema["properties"]["judgements"]["items"]["properties"]["figure"]["enum"]
            return {"content": json.dumps({"judgements": [
                {"figure": f, "code": "support", "kind": "measured", "rationale": "Useful.", "angle": "days on the shelf"}
                for f in ids]})}
        with mock.patch.object(C, "llm_chat", stub):
            rc = O.cmd_code(c, "pol", None, False, False, coder="model-two")
        self.assertEqual(rc, 0)
        self.assertIn("State energy staff", seen["system"])
        J = O.judgements(c, O.load_reg(c))
        ans = [a for a in J[("shelf-days", O.rel_slug("policy"))] if a["coder"] == "model-two"]
        self.assertEqual(ans[0]["code"], "support")
        self.assertIn("Angle: days on the shelf", ans[0]["rationale"])

    def test_a_reviewers_reply_is_saved_as_a_source_and_cited(self):
        c = self.fresh("reply")
        note = self.root / "reply-note.md"
        note.write_text("The 5-log figure is right, and so is the shelf life. " * 4)
        sid = O.cmd_reply(c, note, "lab-lead", "Reply from the lab lead about two figures", "2026-10-19", False)
        self.assertTrue(sid.startswith("src-"))
        O.cmd_signoff(c, ["log-kill"], "lab-lead", "confirmed", None, sid, None)
        J = O.judgements(c, O.load_reg(c))
        self.assertIn(sid, J[("log-kill", O.BOOKS["check"][0])][0]["rationale"])
        self.assertEqual(O.validate(c).get("errors") or [], [])
        with self.assertRaises(SystemExit):
            O.cmd_reply(c, self.root / "reply-note.pdf", "lab-lead", None, None, True)

    # -- the page
    def test_the_page_is_a_one_pager_synthesis_that_validates(self):
        self.assertEqual(self.page["status"], "ok")
        syn = O.current_page(self.corpus, "proc")
        self.assertEqual(syn["type"], O.PAGE)
        self.assertTrue(syn["claims"])
        op = syn["ext"]["upc_corpus"]["one_pager"]
        self.assertEqual(op["revision"], 1)
        self.assertEqual(set(op["figures"]), {"shelf-days", "log-kill", "heat-cut", "heat-before", "heat-after"})
        self.assertEqual(O.validate(self.corpus).get("errors") or [], [])

    def test_a_number_that_is_not_a_figure_is_refused(self):
        bad = copy.deepcopy(PAGE)
        bad["subhead"] = "Treated juice kept for 9 days."
        with self.assertRaises(SystemExit) as cm:
            O.add_page(self.corpus, "proc", bad, writer="x", plan=True)
        self.assertIn("9", str(cm.exception))
        self.assertIn("subhead", str(cm.exception))
        bad = copy.deepcopy(PAGE)
        bad["tiles"][0]["big"] = "5-log"
        with self.assertRaises(SystemExit) as cm:
            O.add_page(self.corpus, "proc", bad, writer="x", plan=True)
        self.assertIn("tiles[0].big", str(cm.exception))
        ok = copy.deepcopy(PAGE)
        ok["subhead"] = "Treated juice kept for a week, in 3 steps."
        ok["plain_numbers"] = [{"text": "3 steps", "why": "the count of steps below"}]
        self.assertEqual(O.add_page(self.corpus, "proc", ok, writer="x", plan=True)["status"], "plan")

    def test_a_chart_point_must_be_a_figure(self):
        bad = copy.deepcopy(PAGE)
        bad["hero"]["chart"]["series"][0]["points"] = ["heat-before", "nowhere"]
        with self.assertRaises(SystemExit) as cm:
            O.add_page(self.corpus, "proc", bad, writer="x", plan=True)
        self.assertIn("nowhere", str(cm.exception))
        self.assertIn("900 kWh", self.html)  # bars are labelled with their figures' values
        self.assertIn("Heat used: 900 kWh, 600 kWh", self.html)

    def test_rewording_supersedes_and_lists_the_changes(self):
        c = self.fresh("reword")
        first = O.current_page(c, "proc")
        p = copy.deepcopy(PAGE)
        p["headline"] = "A week more on the shelf."
        rep = O.add_page(c, "proc", p, writer="Ellie")
        self.assertEqual((rep["revision"], rep["changes"]), (2, 1))
        now = O.current_page(c, "proc")
        self.assertNotEqual(now["synthesis_id"], first["synthesis_id"])
        old = json.loads((c / "syntheses" / first["synthesis_id"] / "synthesis.json").read_text())
        self.assertEqual(old.get("superseded_by"), now["synthesis_id"])
        self.assertEqual(now["ext"]["upc_corpus"]["one_pager"]["changes"][0]["where"], "headline")

    def test_write_offers_only_eligible_figures(self):
        c = self.fresh("write")
        seen = {}

        def stub(system, user, *, schema, **kw):
            seen["enum"] = schema["properties"]["tiles"]["items"]["properties"]["figure"]["enum"]
            seen["system"] = system
            return {"content": json.dumps({**PAGE, "hero": {}})}
        with mock.patch.object(C, "llm_chat", stub):
            rc = O.cmd_write(c, "proc", False)
        self.assertEqual(rc, 0)
        self.assertNotIn("tbtu", seen["enum"])
        self.assertIn("shelf-days", seen["enum"])
        self.assertIn("55 °C", seen["system"])
        self.assertTrue((O.sdir(c, "pages") / "proc.draft.json").exists())

    def test_a_withheld_figure_blocks_even_a_draft(self):
        c = self.fresh("withheld")
        O.cmd_signoff(c, ["log-kill"], "clearer", None, "withheld", None, "not yet")
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "withheld-out", draft=True, pdf=False, docx=False)
        self.assertIn("withheld", str(cm.exception))
        with self.assertRaises(SystemExit):
            O.add_page(c, "proc", copy.deepcopy(PAGE), writer="x", plan=True)

    # -- build
    def test_a_draft_is_stamped_and_its_note_lists_what_is_open(self):
        self.assertTrue(self.draft["draft"])
        self.assertIn(O.DRAFT_STAMP, self.html)
        self.assertIn("log-kill", self.draft["open"])
        self.assertEqual(O.open_groups({"a": ["x", "y"], "b": ["x"]}), [("x", ["a", "b"]), ("y", ["a"])])
        self.assertIn("Not confirmed by a reviewer (not checked yet) (", self.note)
        self.assertIn("Before this goes outside the team", self.note)
        self.assertIn("> The treatment achieved a 5-log reduction at 55 °C in every run.", self.note)
        self.assertIn("Words by Hermes, using Claude (test).", self.note)
        self.assertNotIn("Claude", self.html)
        self.assertIn("revolutionary", O.opt(AUD_A)["banned_words"])

    def test_a_final_page_needs_every_figure_confirmed(self):
        c = self.fresh("final")
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "final-out", pdf=False, docx=False)
        self.assertIn("not confirmed", str(cm.exception))
        self.signoff_all(c)
        rec = O.build(c, "proc", self.root / "final-out", pdf=False, docx=False)
        self.assertFalse(rec["draft"])
        html = (self.root / "final-out" / "index.html").read_text()
        self.assertIn(O.DRAFT_STAMP, html)  # internal distribution keeps the stamp
        note = (self.root / "final-out" / "proc-figures.md").read_text()
        self.assertIn("confirmed (lab-lead", note)
        self.assertIn("Reply from the lab lead", note)

    def test_a_partner_page_needs_every_figure_cleared(self):
        c = self.fresh("partner")
        cfg = O.load_cfg(c, "proc")
        cfg["distribution"] = "partner"
        C.save_json(O.page_path(c, "proc"), cfg)
        self.signoff_all(c)
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "partner-out", pdf=False, docx=False)
        self.assertIn("not cleared", str(cm.exception))
        O.cmd_signoff(c, sorted(O.load_reg(c)), "clearer", None, "cleared", None, "for partners")
        O.build(c, "proc", self.root / "partner-out", pdf=False, docx=False)
        self.assertNotIn(O.DRAFT_STAMP, (self.root / "partner-out" / "index.html").read_text())

    def test_a_quotation_from_an_interview_needs_recorded_consent(self):
        c = self.fresh("voice")
        p = copy.deepcopy(PAGE)
        p["voice"] = {"source": IV, "quote": "We lose half a shift every time the line goes down for cleaning",
                      "attribution": "A plant manager (pseudonymized interview)"}
        O.add_page(c, "proc", p, writer="Ellie")
        self.signoff_all(c)
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "voice-out", pdf=False, docx=False)
        self.assertIn("consent", str(cm.exception))
        O.build(c, "proc", self.root / "voice-out", draft=True, pdf=False, docx=False)
        self.assertIn("half a shift", (self.root / "voice-out" / "index.html").read_text())
        p["voice"]["quote"] = "We lose a whole day every time"
        with self.assertRaises(SystemExit):
            O.add_page(c, "proc", p, writer="Ellie", plan=True)

    def test_a_never_publish_phrase_or_a_local_path_is_refused(self):
        c = self.fresh("leak")
        p = copy.deepcopy(PAGE)
        p["cta"]["detail"] = "Ask for the Example Creamery results."
        O.add_page(c, "proc", p, writer="Ellie")
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "leak-out", draft=True, pdf=False, docx=False)
        self.assertIn("never-publish", str(cm.exception))
        c = self.fresh("leak-path")  # a fresh copy: the note lists the last revision's words, and they held the phrase
        p["cta"]["detail"] = f"See {c}/notes.md for the data."
        p["plain_numbers"] = [{"text": p["cta"]["detail"], "why": "the digits are the folder's, not a statistic"}]
        O.add_page(c, "proc", p, writer="Ellie")
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "leak-out", draft=True, pdf=False, docx=False)
        self.assertIn("local path", str(cm.exception))

    def test_a_changed_figure_makes_the_page_stale(self):
        c = self.fresh("stale")
        O.cmd_figures_add(c, [{**FIGURES[0], "display": ["a week", "7+"]}], by="test", replace=True, plan=False)
        O.build(c, "proc", self.root / "stale-ok", draft=True, pdf=False, docx=False)  # same value and passage: fine
        O.cmd_figures_add(c, [{**FIGURES[0], "value": "7", "quote": "the spoilage limit for 7 days"}], by="test",
                          replace=True, plan=False)
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "stale-out", draft=True, pdf=False, docx=False)
        self.assertIn("shelf-days", str(cm.exception))

    def test_an_unchanged_page_rebuilds_byte_for_byte(self):
        out2 = self.root / "out2"
        rec = O.build(self.corpus, "proc", out2, draft=True, pdf=False, docx=HAVE_PANDOC)
        self.assertEqual(rec["files"], self.draft["files"])

    def test_a_build_touches_only_its_own_files(self):
        other = self.root / "someone-elses"
        other.mkdir()
        (other / "index.html").write_text("Ellie's own page")
        with self.assertRaises(SystemExit) as cm:
            O.build(self.corpus, "proc", other, draft=True, pdf=False, docx=False)
        self.assertIn("holds files no one-pager build made", str(cm.exception))
        self.assertEqual((other / "index.html").read_text(), "Ellie's own page")
        mine = self.root / "mine"
        O.build(self.corpus, "proc", mine, draft=True, pdf=False, docx=HAVE_PANDOC)
        (mine / "notes.txt").write_text("kept")
        O.build(self.corpus, "proc", mine, draft=True, pdf=False, docx=False)
        self.assertEqual(sorted(f.name for f in mine.iterdir()), ["index.html", "notes.txt", "proc-figures.md"])

    def test_the_layout_orders_the_blocks(self):
        tiles, how, status = (self.html.index('data-block="the numbers"'), self.html.index('data-block="how it works"'),
                              self.html.index('data-block="where it stands"'))
        self.assertLess(tiles, how)
        self.assertLess(how, status)

    def test_a_profile_that_breaks_the_overlay_fails_clearly(self):
        bad = {**AUD_B, "one_pager": {"layout": "glossy"}}
        p = self.root / "aud-bad.json"
        p.write_text(json.dumps(bad))
        with self.assertRaises(SystemExit) as cm:
            O.cmd_init(self.fresh("badprof"), args(slug="bad", audience=str(p), project=str(self.root / "project.json")))
        self.assertIn("layout", str(cm.exception))

    @unittest.skipUnless(HAVE_PANDOC, "needs pandoc")
    def test_a_table_row_passage_survives_into_the_word_note(self):
        c = self.fresh("tablerow")
        O.cmd_figures_add(c, [{"id": "d21", "label": "Day 21, treated", "value": "3.10", "source": RA,
                               "quote": "| Day 21 | 3.10 ± 0.15"}], by="test", replace=False, plan=False)
        p = copy.deepcopy(PAGE)
        p["figures"] = ["d21"]
        O.add_page(c, "proc", p, writer="Ellie")
        out = self.root / "tablerow-out"
        O.build(c, "proc", out, draft=True, pdf=False, docx=True)
        self.assertIn("| Day 21 | 3.10 ± 0.15", O.D.docx_text(out / "proc-figures.docx"))
        self.assertIn("> | Day 21 | 3.10 ± 0.15", (out / "proc-figures.md").read_text())

    @unittest.skipUnless(HAVE_PANDOC, "needs pandoc")
    def test_the_figures_note_has_a_word_copy_with_every_passage(self):
        words = O.D.docx_text(self.out / "proc-figures.docx")
        self.assertIn("5-log reduction at 55 °C", words)

    # -- the printed page
    @unittest.skipUnless(HAVE_PW, "needs PLAYWRIGHT_DIR with node_modules/playwright, and node")
    def test_the_pdf_is_one_page_and_rebuilds_identically(self):
        a, b = self.root / "pdf-a", self.root / "pdf-b"
        ra = O.build(self.corpus, "proc", a, draft=True, docx=False, pw=PW)
        rb = O.build(self.corpus, "proc", b, draft=True, docx=False, pw=PW)
        self.assertEqual(ra["render"]["pages"], 1)
        self.assertEqual(ra["files"]["proc.pdf"], rb["files"]["proc.pdf"])

    @unittest.skipUnless(HAVE_PW, "needs PLAYWRIGHT_DIR with node_modules/playwright, and node")
    def test_a_page_that_runs_to_two_sheets_is_refused(self):
        c = self.fresh("long")
        p = copy.deepcopy(PAGE)
        p["status"] = {k: "Lab batches kept well and the team is planning the next round of tests. " * 14
                       for k in ("shown", "underway", "next")}
        O.add_page(c, "proc", p, writer="Ellie")
        with self.assertRaises(SystemExit) as cm:
            O.build(c, "proc", self.root / "long-out", draft=True, docx=False, pw=PW)
        self.assertIn("pages, not one", str(cm.exception))
        self.assertIn("where it stands", str(cm.exception))

    @unittest.skipUnless(HAVE_PW, "needs PLAYWRIGHT_DIR with node_modules/playwright, and node")
    def test_the_renderer_reports_sideways_scroll_on_a_phone(self):
        page = self.root / "wide.html"
        page.write_text('<!doctype html><meta name="viewport" content="width=device-width"><div style="width:1200px">x</div>')
        p = subprocess.run(["node", str(O.RENDER), str(page), str(self.root / "wide.pdf"), PW], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertGreater(json.loads(p.stdout)["phone_overflow_px"], 700)


class Numbers(unittest.TestCase):
    def test_numbers_inside_words_are_not_numbers(self):
        self.assertEqual(O.num_tokens("CO2 and DE-EE0011216 but 1,200 kWh, 7+ days and ⅓ less, 2.76"),
                         ["1200", "7", "⅓", "2.76"])

    def test_a_figure_value_reads_as_a_number(self):
        self.assertEqual(O.number_of("5-log"), 5.0)
        self.assertAlmostEqual(O.number_of("⅓ less"), 1 / 3)
        self.assertIsNone(O.number_of("a week"))

    def test_pdf_dates_are_replaced_at_the_same_length(self):
        raw = b"<< /CreationDate (D:20261019123456+00'00') /ModDate (D:20261019123456+00'00') >>"
        out = O.steady_pdf(raw, "2026-10-19")
        self.assertEqual(len(out), len(raw))
        self.assertIn(b"D:20261019000000Z", out)
        self.assertEqual(O.steady_pdf(raw, "2026-10-19"), out)


if __name__ == "__main__":
    unittest.main()
