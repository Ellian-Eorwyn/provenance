"""dossier.py: entries and a cover memo whose every quotation is found in its source,
rendered as a site, a Word file and a spreadsheet.

A synthetic corpus: two web documents and a request note, two profiles, two entries
(one quotation in each that is not in its source), and a brief. No network, no model
server: `write` runs against a stub.
"""

import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
HERE = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import dossier as D  # noqa: E402


def upc_ok():
    try:
        v = C.upc("version", "--json")
        return tuple(int(x) for x in str(v.get("spec_version", "0.0")).split(".")[:2]) >= (1, 15)
    except Exception:  # noqa: BLE001
        return False


HAVE_PANDOC = bool(shutil.which("pandoc"))
SECRET = "This sentence is only in the report body and must never be published."
REPORT = ("# Retail gas in a low-carbon future\n\n"
          "The study finds that gas rates could rise sharply as customers leave the system. "
          "In the high electrification scenario, the average residential gas rate rises to $5.60 per therm by 2050. "
          "The Commission opened a rulemaking on the future of gas in January 2020. "
          "Consumer advocates warn that the customers who remain will bear the costs. "
          "Strategic decommissioning is the planned retirement of segments of the gas system. "
          "This report builds on Smith and Jones (2018), Gas futures for the state.\n\n"
          + SECRET + "\n\n" + "Context. " * 60)
FILING = ("# Comments of a consumer advocate\n\n"
          "The advocate argues that pilots must protect customers who cannot afford new equipment. " + "More. " * 60)
NOTE = ("Here are a couple of things you could look at.\n\n"
        "* The retail gas study lays out the normal argument we hear now.\n"
        "* The comments include some of the concerns we've heard.\n\n" + "With thanks. " * 20)
MISSING = "This sentence does not appear anywhere in the report."

AUDIENCE = {"id": "lab", "kind": "audience", "name": "Example Lab", "organization": "Example University",
            "readers": [{"name": "Dana Example", "role": "Director"}], "wants": ["What each document claims"],
            "knows": ["Transitions theory"], "style": ["Plain language"], "never_publish": ["Dana's medical leave"]}
PROJECT = {"id": "path", "kind": "project", "name": "PATH", "full_name": "Pathways",
           "lenses": [{"slug": "policy", "title": "The policy landscape", "short": "Policy", "description": "Laws and proceedings."},
                      {"slug": "households", "title": "Households and equity", "short": "Households", "description": "Costs to households."}]}


def add_web(corpus: Path, stage: Path, key: str, url: str, text: str, title: str) -> dict:
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


def init(corpus: Path, root: Path, note_sid: str, **extra):
    aud, proj = root / "audience.json", root / "project.json"
    aud.write_text(json.dumps(AUDIENCE))
    proj.write_text(json.dumps(PROJECT))
    a = type("A", (), {k: None for k in ("subtitle", "prepared_for", "date", "stamp", "file_no", "file_name", "order",
                                          "request_date", "suppress")})()
    secs = root / "sections.json"
    secs.write_text(json.dumps([{"slug": "research", "title": "The research case", "description": "Studies and reports."},
                                {"slug": "advocates", "title": "What advocates say", "description": ""}]))
    a.sections = str(secs)
    a.audience, a.project, a.title, a.prepared_by = str(aud), str(proj), "Gas transition readings", "Ellie Example"
    a.date, a.request_source, a.request_by = "2026-10-19", note_sid, "Mithra Example (Agency)"
    a.request_quote = "Here are a couple of things you could look at."
    for k, v in extra.items():
        setattr(a, k, v)
    D.cmd_init(corpus, a)


ENTRY_A = {
    "section": "research", "kind": "report", "author_org": "E. Consultants", "date": "2020-04", "identifier": "REP-2020-01",
    "summary": "A study of what happens to gas rates as customers electrify.",
    "why_it_matters": [{"lens": "policy", "text": "It is the cost argument behind targeted retirement."}],
    "relevance": {"policy": 3, "households": 2},
    "key_points": [{"text": "Rates rise as customers leave.", "lens": "policy",
                    "quote": "The study finds that gas rates could rise sharply as customers leave the system."},
                   {"text": "A point with a made-up quotation.", "quote": MISSING}],
    "figures": [{"label": "Residential gas rate, 2050", "value": "$5.60/therm",
                 "quote": "the average residential gas rate rises to $5.60 per therm by 2050"}],
    "dates": [{"date": "2020-01", "event": "Rulemaking opened",
               "quote": "The Commission opened a rulemaking on the future of gas in January 2020."}],
    "actors": [{"name": "Consumer advocates", "type": "advocates", "stance": "Worried about remaining customers",
                "quote": "Consumer advocates warn that the customers who remain will bear the costs."}],
    "terms": [{"term": "Strategic decommissioning", "definition": "Planned retirement of parts of the gas system",
               "quote": "Strategic decommissioning is the planned retirement of segments of the gas system."}],
    "cites": [{"ref": "Smith and Jones 2018", "note": "Earlier scenarios", "in_corpus": "url:https://ex.org/filing",
               "quote": "This report builds on Smith and Jones (2018), Gas futures for the state."}],
    "questions": ["Do the rate figures hold under the newer forecasts?"],
    "exhibits": [{"page": 1, "caption": "Not a PDF, so this is refused"}],
    "suggested_by": {"quote": "The retail gas study lays out the normal argument we hear now."},
}
ENTRY_B = {"section": "advocates", "kind": "comments", "author_org": "An advocate", "date": "2025",
           "summary": "Comments asking that pilots protect customers.", "relevance": {"households": 3},
           "key_points": [{"text": "Protect those who cannot pay.", "lens": "households",
                           "quote": "pilots must protect customers who cannot afford new equipment"}],
           "suggested_by": {"quote": "The comments include some of the concerns we've heard."}}
BRIEF = {"title": "At a glance", "lede": "Two documents, one argument and its critics.",
         "themes": [{"title": "The rate spiral", "text": "Costs fall on those who stay.",
                     "evidence": [{"source": "url:https://ex.org/report",
                                   "quote": "The study finds that gas rates could rise sharply as customers leave the system."},
                                  {"source": "url:https://ex.org/filing",
                                   "quote": "pilots must protect customers who cannot afford new equipment"}]}],
         "tensions": [{"title": "Unsupported", "text": "A tension whose only quotation is not in its source.",
                       "evidence": [{"source": "url:https://ex.org/report", "quote": MISSING}]}],
         "for_project": [{"lens": "households", "text": "Who pays matters for the household lens."}],
         "next_steps": ["Read the report first"],
         "reading_order": [{"source": "url:https://ex.org/report", "why": "The argument"}]}


@unittest.skipUnless(upc_ok(), "needs the upc CLI 1.15+")
class Dossier(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = root = Path(tempfile.mkdtemp())
        cls.corpus, stage = root / "dossier", root / "stage"
        stage.mkdir()
        add_web(cls.corpus, stage, "url:https://ex.org/report", "https://ex.org/report", REPORT, "Retail gas in a low-carbon future")
        add_web(cls.corpus, stage, "url:https://ex.org/filing", "https://ex.org/filing", FILING, "Comments of a consumer advocate")
        note = add_web(cls.corpus, stage, "url:https://ex.org/note", "https://ex.org/note", NOTE, "A note listing readings")
        init(cls.corpus, root, note["source_id"])
        cls.rep_a = D.add_entry(cls.corpus, {**ENTRY_A, "source": "url:https://ex.org/report"}, writer="Claude (test)",
                                model="claude-test")
        cls.rep_b = D.add_entry(cls.corpus, {**ENTRY_B, "source": "url:https://ex.org/filing"}, writer="Claude (test)")
        cls.brief = D.add_brief(cls.corpus, BRIEF, writer="Claude (test)")
        C.upc("regen", str(cls.corpus), check=False)
        cls.out = root / "site"
        cls.res = D.build(cls.corpus, cls.out, docx=HAVE_PANDOC)
        cls.index = (cls.out / "index.html").read_text()

    def fresh(self, name):
        dest = self.root / name
        shutil.copytree(self.corpus, dest)
        cfg = json.loads(D.cfg_path(dest).read_text())
        return dest, cfg

    # -- the gate
    def test_a_quotation_not_in_the_source_is_dropped_and_reported(self):
        self.assertEqual(self.rep_a["kept"]["key_points"], 1)
        self.assertEqual([(r["section"], r["item"]) for r in self.rep_a["refused"]],
                         [("key_points", 1), ("exhibits", 0)])
        self.assertTrue(self.rep_a["suggested_by"])
        e = next(x for x in D.entries(self.corpus) if x["title"].startswith("Retail"))
        self.assertEqual([k["text"] for k in e["key_points"]], ["Rates rise as customers leave."])
        for f in self.out.rglob("*.html"):
            self.assertNotIn("made-up quotation", f.read_text())

    def test_the_entry_is_a_upc_generation_that_validates(self):
        self.assertEqual(D.validate(self.corpus).get("errors") or [], [])
        gens = D.generations(self.corpus, D.ENTRY)
        self.assertEqual(len(gens), 2)
        self.assertIn("[ext-", gens[0]["_text"])  # the quotations are markers hop C checks

    def test_a_brief_theme_without_a_found_quotation_is_left_out(self):
        self.assertEqual((self.brief["themes"], self.brief["tensions"], self.brief["for_project"]), (1, 0, 1))
        b = D.current_brief(self.corpus)
        self.assertEqual(b["type"], D.BRIEF)
        self.assertEqual(len(b["claims"]), 1)

    def test_documents_are_grouped_by_section(self):
        self.assertLess(self.index.index("The research case"), self.index.index("What advocates say"))
        self.assertLess(self.index.index("Retail gas in a low-carbon future"), self.index.index("Comments of a consumer advocate"))
        with self.assertRaises(SystemExit) as cm:
            D.add_entry(self.corpus, {**ENTRY_B, "source": "url:https://ex.org/filing", "section": "nowhere"}, writer="x", plan=True)
        self.assertIn("nowhere", str(cm.exception))

    def test_an_unknown_lens_refuses_the_entry(self):
        with self.assertRaises(SystemExit) as cm:
            D.add_entry(self.corpus, {**ENTRY_B, "source": "url:https://ex.org/filing", "relevance": {"transport": 2}},
                        writer="x", plan=True)
        self.assertIn("transport", str(cm.exception))

    def test_a_profile_missing_a_field_fails_clearly(self):
        p = self.root / "bad-project.json"
        p.write_text(json.dumps({k: v for k, v in PROJECT.items() if k != "lenses"}))
        with self.assertRaises(SystemExit) as cm:
            D.load_profile(p, "project")
        self.assertIn("lenses: missing", str(cm.exception))
        p.write_text(json.dumps({**AUDIENCE, "never_publish": ["hip"]}))
        with self.assertRaises(SystemExit) as cm:
            D.load_profile(p, "audience")
        self.assertIn("shorter than 6", str(cm.exception))

    @unittest.skipUnless(__import__("importlib").util.find_spec("yaml"), "needs PyYAML")
    def test_the_example_profiles_fit_their_schemas(self):
        ex = HERE.parent / "references" / "profiles" / "examples"
        self.assertEqual(D.load_profile(ex / "audience.example.yaml", "audience")["updated"], "2026-10-01")
        self.assertEqual(len(D.load_profile(ex / "project.example.yaml", "project")["lenses"]), 2)

    # -- the site
    def test_the_site_has_its_pages(self):
        names = sorted(f.relative_to(self.out).as_posix() for f in self.out.rglob("*.html"))
        self.assertEqual([n for n in names if not n.startswith("docs/")],
                         ["index.html", "leads.html", "method.html", "people.html", "terms.html", "timeline.html"])
        self.assertEqual(len([n for n in names if n.startswith("docs/")]), 2)
        for want in ("Gas transition readings", "For Example Lab · PATH", "Routing slip", "Here are a couple of things",
                     "Start here", "The rate spiral", "Memo · written by Claude (test)", 'data-lenses="policy households"'):
            self.assertIn(want, self.index)
        self.assertNotIn("Unsupported", self.index)
        self.assertIn("prefers-color-scheme:dark", self.index)
        self.assertIn('name="robots" content="noindex', self.index)

    def test_a_document_page_shows_notes_quotes_and_its_suggester(self):
        page = next((self.out / "docs").glob("01-*.html")).read_text()
        self.assertIn("Retail gas in a low-carbon future", page)  # the order: the reading order isn't used, relevance is
        for want in ("Why it is in the file · Mithra Example (Agency)", "The retail gas study lays out",
                     "Why it matters for PATH", "Summary · by Claude (test)", "$5.60 per therm", "in this dossier",
                     "Questions for the team"):
            self.assertIn(want, page)
        self.assertNotIn(SECRET, page)

    def test_every_quotation_is_in_the_site_the_word_file_and_the_spreadsheet(self):
        quotes = {q["quote"] for q in D.all_quotes({"docs": D.entries(self.corpus), "brief":
                                                    D.current_brief(self.corpus)["ext"]["upc_corpus"]["dossier_brief"]})}
        self.assertEqual(len(quotes), 9)
        site = "".join(f.read_text() for f in self.out.rglob("*.html"))
        import html
        for q in quotes:
            self.assertIn(html.escape(q, quote=True), site, q)
        name = "gas-transition-readings"
        from openpyxl import load_workbook
        wb = load_workbook(self.out / f"{name}.xlsx")
        cells = " ".join(str(c.value) for ws in wb for row in ws.iter_rows() for c in row if c.value is not None)
        self.assertEqual(wb.sheetnames[:3], ["Documents", "Key points", "Numbers"])
        for q in quotes - {D.load_cfg(self.corpus)["request"]["quote"]}:
            if "lays out" in q or "concerns" in q:
                continue  # the suggester's words are on the Documents sheet
            self.assertIn(q, cells, q)
        if HAVE_PANDOC:
            words = " ".join(D.docx_text(self.out / f"{name}.docx").split())
            for q in quotes - {D.load_cfg(self.corpus)["request"]["quote"]}:
                self.assertIn(" ".join(q.split()), words, q)

    def test_the_build_record_is_beside_the_site_and_nothing_local_is_published(self):
        rec = json.loads((self.out.parent / "site.build.json").read_text())
        self.assertEqual(len(rec["documents"]), 2)
        for f in self.out.rglob("*"):
            if f.is_file() and f.suffix in (".html", ".css", ".js", ".json"):
                self.assertNotIn(str(self.root), f.read_text(errors="replace"), f.name)
        if HAVE_PANDOC:
            with zipfile.ZipFile(next(self.out.glob("*.docx"))) as z:
                self.assertNotIn(str(self.root), z.read("word/document.xml").decode())

    def test_an_unchanged_dossier_rebuilds_identically(self):
        before = {f.relative_to(self.out).as_posix(): f.read_bytes() for f in self.out.rglob("*.html")}
        D.build(self.corpus, self.out, docx=HAVE_PANDOC)
        after = {f.relative_to(self.out).as_posix(): f.read_bytes() for f in self.out.rglob("*.html")}
        self.assertEqual(before, after)

    # -- refusals
    def test_a_never_publish_phrase_refuses_the_build(self):
        corpus, cfg = self.fresh("never")
        cfg["suppress"] = ["Consumer  ADVOCATES warn"]
        D.cfg_path(corpus).write_text(json.dumps(cfg))
        out = self.root / "never-site"
        with self.assertRaises(SystemExit) as cm:
            D.build(corpus, out, docx=False)
        self.assertIn("never-publish", str(cm.exception))
        self.assertFalse((out / "index.html").exists())

    def test_a_local_path_refuses_the_build(self):
        corpus, _ = self.fresh("local")
        D.add_entry(corpus, {**ENTRY_B, "source": "url:https://ex.org/filing",
                             "summary": "Saved at /Users/someone/Documents/comments.pdf."}, writer="Claude (test)",
                    replace=True)  # the same passages as the stored entry: a rewrite
        with self.assertRaises(SystemExit) as cm:
            D.build(corpus, self.root / "local-site", docx=False, xlsx=False)
        self.assertIn("local path", str(cm.exception))

    def test_a_stored_quotation_that_differs_from_its_passage_refuses(self):
        corpus, _ = self.fresh("tampered")
        gj = next(g for g in corpus.glob("sources/*/generated/gen-*.json") if "Retail" in g.read_text())
        g = json.loads(gj.read_text())
        g["ext"]["upc_corpus"]["dossier_entry"]["figures"][0]["quote"] = "the average residential gas rate rises to $9 per therm"
        gj.write_text(json.dumps(g))
        with self.assertRaises(SystemExit) as cm:
            D.build(corpus, self.root / "tampered-site", docx=False, xlsx=False)
        self.assertIn("differs", str(cm.exception))

    # -- the local model
    def test_write_runs_the_same_gate_on_a_model_entry(self):
        corpus, _ = self.fresh("write")
        reply = {"kind": "comments", "author_org": "An advocate", "date": "2025", "summary": "A model's summary.",
                 "why_it_matters": [], "relevance": {"policy": 1, "households": 3},
                 "key_points": [{"text": "Protect customers.", "lens": "households",
                                 "quote": "pilots must protect customers who cannot afford new equipment"},
                                {"text": "Invented.", "lens": "policy", "quote": MISSING}],
                 "figures": [], "dates": [], "actors": [], "terms": [], "cites": [], "questions": []}
        calls = []

        def stub(system, user, **kw):
            calls.append((system, kw.get("schema")))
            return {"content": json.dumps(reply)}
        real = D.C.llm_chat
        D.C.llm_chat = stub
        try:
            rc = D.cmd_write(corpus, "url:https://ex.org/filing", redo=True, plan=False, max_chars=1000)
        finally:
            D.C.llm_chat = real
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn("Example Lab", calls[0][0])
        self.assertIn("households", json.dumps(calls[0][1]))
        e = next(x for x in D.entries(corpus) if x["_source_id"] == C.corpus_reps(corpus)["url:https://ex.org/filing"]["source_id"])
        self.assertEqual(e["summary"], "A model's summary.")
        self.assertEqual(len(e["key_points"]), 1)
        self.assertEqual(e["read_chars"], e["total_chars"])  # a short document is read whole

    def test_a_document_saved_twice_keeps_each_entry_on_its_own_copy(self):
        # Two saves of one filing (different page bytes, the same reading copy) share a text
        # representation. Each copy's entry must quote its own source, whichever loads last.
        dest, _cfg = self.fresh("twin")
        stage = self.root / "twin-stage"
        stage.mkdir()
        raw = stage / "twin.html"
        raw.write_text(f"<html><body><!-- the agency's copy -->{FILING}</body></html>")
        md = stage / "twin.md"
        md.write_text(FILING)
        prov = {"original_url": "https://agency.example/filing", "final_url": "https://agency.example/filing",
                "http_status": 200, "content_type": "text/html", "fetched_at": "2026-10-19T17:00:00Z",
                "fetch_status": "success", "fetch_method": "playwright", "extraction_method": "readability",
                "sha256": hashlib.sha256(raw.read_bytes()).hexdigest()}
        items = stage / "items.jsonl"
        items.write_text(json.dumps({"key": "url:https://agency.example/filing", "kind": "web", "file": str(raw),
                                     "reading_copy": str(md), "provenance": prov, "title": "Comments (agency copy)",
                                     "asr": None}) + "\n")
        subprocess.run([sys.executable, str(HERE / "add_acquired.py"), "--corpus", str(dest), "--items", str(items)],
                       check=True, capture_output=True)
        reps = C.corpus_reps(dest)
        first, twin = reps["url:https://ex.org/filing"], reps["url:https://agency.example/filing"]
        self.assertNotEqual(first["source_id"], twin["source_id"])
        self.assertEqual(first["text_rep"], twin["text_rep"])
        for key in ("url:https://ex.org/filing", "url:https://agency.example/filing"):
            rep = D.add_entry(dest, {**ENTRY_B, "source": key}, writer="Claude (test)", replace=True)
            self.assertEqual(rep["kept"]["key_points"], 1, key)
        self.assertEqual(D.validate(dest).get("errors") or [], [])
        by_source = {e["_source_id"] for e in D.entries(dest)}
        self.assertTrue({first["source_id"], twin["source_id"]} <= by_source)

    def test_check_finds_every_quotation_again(self):
        self.assertEqual(D.cmd_check(self.corpus), 0)


if __name__ == "__main__":
    unittest.main()
