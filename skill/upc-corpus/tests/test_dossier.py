"""dossier.py: entries and a cover memo whose every quotation is found in its source,
rendered as a site, a Word file and a spreadsheet, with the project's scope in front.

A synthetic corpus: two web documents and a request note, two profiles, two entries
(one quotation in each that is not in its source), and a brief. No network, no model
server: `write` and `brief --draft` run against a stub.
"""

import copy
import hashlib
import html
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

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
           "aims": ["Find where households can leave gas easily"], "questions": ["Who pays when customers leave?"],
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
    a.audience, a.project, a.title, a.prepared_by = str(aud), str(proj), "Gas transition readings", "Sam Example"
    a.date, a.request_source, a.request_by = "2026-10-19", note_sid, "Robin Example (Agency)"
    a.request_quote = "Here are a couple of things you could look at."
    for k, v in extra.items():
        setattr(a, k, v)
    D.cmd_init(corpus, a)


ENTRY_A = {
    "section": "research", "kind": "report", "author_org": "E. Consultants", "date": "2020-04", "identifier": "REP-2020-01",
    "summary": "A study of what happens to gas rates as customers electrify.",
    "for_us": "The cost argument behind targeted retirement, with a rate figure for 2050.",
    "read_this": "the summary and the rate table",
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
         "bottom_line": "Rates rise for those who stay on gas, and the advocate asks pilots to protect them.",
         "themes": [{"title": "The rate spiral", "text": "Costs fall on those who stay.",
                     "evidence": [{"source": "url:https://ex.org/report",
                                   "quote": "The study finds that gas rates could rise sharply as customers leave the system."},
                                  {"source": "url:https://ex.org/filing",
                                   "quote": "pilots must protect customers who cannot afford new equipment"}]}],
         "tensions": [{"title": "Unsupported", "text": "A tension whose only quotation is not in its source.",
                       "evidence": [{"source": "url:https://ex.org/report", "quote": MISSING}]}],
         "for_project": [{"lens": "households", "text": "Who pays matters for the household lens."}],
         "next_steps": [{"step": "Read the report first", "detail": "The detail of the first step.",
                         "see": "url:https://ex.org/report"}, "Ask the advocate for its data"],
         "reading_order": [{"source": "url:https://ex.org/report", "why": "The argument"}]}
SCOPE = """---
made_by: a scope stage
---
# Scope: PATH

<!-- a note for the owner, never shown -->
PATH studies **household** costs. See [the program](https://ex.org/program) and [a file](file:///tmp/x).

## Goals

1. Find where switching is easy
2. Find where it stalls

3. Say why

## Tasks

- Task 1: Literature
  - 1.1 Review the rate studies
- Task 2: Interviews

## Information needs

| Need | Class | Why |
|---|---|---|
| Rate forecasts | find | Task 1 needs them |
| Interview notes | collect | Not published |

> The scope's own words, quoted.

```
code <b>here</b>
```

A paragraph with <script>alert(1)</script> in it.
"""


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

    def test_documents_are_in_reading_order_then_by_section(self):
        self.assertLess(self.index.index("Read first"), self.index.index("What advocates say"))
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
                         ["index.html", "leads.html", "memo.html", "method.html", "people.html", "terms.html", "timeline.html"])
        self.assertEqual(len([n for n in names if n.startswith("docs/")]), 2)
        for want in ("Gas transition readings", "For Example Lab · PATH", "Routing slip", "Here are a couple of things",
                     "Read first", "The rate spiral", "Written by Claude (test)", 'data-g="policy households"'):
            self.assertIn(want, self.index)
        self.assertNotIn("Unsupported", self.index)
        self.assertIn("prefers-color-scheme:dark", self.index)
        self.assertIn('name="robots" content="noindex', self.index)

    def test_a_document_page_shows_notes_quotes_and_its_suggester(self):
        page = next((self.out / "docs").glob("01-*.html")).read_text()
        self.assertIn("Retail gas in a low-carbon future", page)  # the order: the reading order isn't used, relevance is
        for want in ("Why it is in the file · Robin Example (Agency)", "The retail gas study lays out",
                     "Why it matters for PATH", "Summary · by Claude (test)", "$5.60 per therm", "In this file",
                     "Questions for the team", "What matters for PATH · Claude (test)", "Read: the summary and the rate table"):
            self.assertIn(want, page)
        self.assertNotIn(SECRET, page)

    def test_the_cover_puts_the_point_first(self):
        i = self.index
        order = [i.index(w) for w in ("The bottom line", BRIEF["bottom_line"], "Next steps", "The documents")]
        self.assertEqual(order, sorted(order))
        for want in ("What matters for PATH", ENTRY_A["for_us"], "Read: " + ENTRY_A["read_this"], 'href="memo.html#theme-1"',
                     'data-set="g" data-v="policy"', 'href="memo.html"', "Ask the advocate for its data"):
            self.assertIn(want, i)
        steps = i[i.index("Next steps"):i.index("</aside>", i.index("Next steps"))]
        self.assertIn('href="docs/01-', steps)  # a step that names a document links to it
        self.assertNotIn("The detail of the first step", i)  # the detail is in the memo

    def test_the_memo_has_its_own_page(self):
        memo = (self.out / "memo.html").read_text()
        for want in ('id="theme-1"', 'id="next-steps"', 'id="households"', "In this memo", "Memo · written by Claude (test)",
                     "The detail of the first step.", BRIEF["bottom_line"]):
            self.assertIn(want, memo)
        # each part opens with its own divider, and the contents follow the scroll
        for want in ('<section class="msec k2" id="findings">', 'class="divider"', 'class="card mcard k2" data-item id="theme-1"',
                     '<nav class="toc" aria-label="In this memo" data-spy>', 'id="step-1"'):
            self.assertIn(want, memo)

    def test_lists_are_cards_that_open_a_detail_panel(self):
        for name, want in (("timeline.html", 'class="card ev-card'), ("people.html", "Advocates"),
                           ("terms.html", 'id="letter-S"'), ("leads.html", "In this file")):
            page = (self.out / name).read_text()
            self.assertIn(want, page, name)
            self.assertIn('<details class="card', page, name)
        for f in self.out.rglob("*.html"):
            self.assertIn('<dialog class="drawer" id="drawer"', f.read_text(), f.name)
        timeline, terms = (self.out / "timeline.html").read_text(), (self.out / "terms.html").read_text()
        self.assertIn('href="#y2020"', timeline)  # the ribbon jumps to its year
        self.assertIn('<nav class="ribbon" aria-label="Events per year" data-spy>', timeline)  # and follows the scroll
        self.assertIn('<nav class="az" aria-label="Jump to a letter" data-spy>', terms)
        self.assertIn('<span aria-hidden="true">Z</span>', terms)  # the whole alphabet, a letter with no term faint
        # the script's regular expressions reach the page intact (a "\b" in a plain Python string is a backspace)
        self.assertNotIn("\x08", timeline)
        self.assertIn(r"/\bk\d\b/", timeline)

    def test_two_spellings_of_one_name_are_one_card(self):
        items = [({"name": n}, {"_source_id": s}) for n, s in (
            ("California Energy Commission (CEC)", "s1"), ("CEC", "s2"), ("California Energy Commission", "s3"),
            ("Siva Gunda (Vice Chair, CEC)", "s1"), ("Siva Gunda, CEC Vice Chair", "s2"),
            ("E3, Ava Community Energy and Gridworks", "s2"), ("Energy and Environmental Economics (E3)", "s3"))]
        self.assertEqual(sorted(len(g) for g in D.merged(items, "name")), [1, 1, 2, 3])
        terms = [({"term": t}, {}) for t in ("IEPR (Integrated Energy Policy Report)", "Integrated Energy Policy Report", "iepr")]
        self.assertEqual(len(D.merged(terms, "term", long_paren=True)), 1)
        plurals = [({"term": t}, {}) for t in ("Terminal branch", "terminal branches", "stranded assets", "stranded asset", "gas", "basis")]
        self.assertEqual(sorted(len(g) for g in D.merged(plurals, "term", long_paren=True)), [1, 1, 2, 2])
        self.assertEqual(D.role_group("community choice aggregator", "Ava"), "utilities")
        self.assertEqual(D.role_group("ratepayer advocate", "TURN"), "advocates")
        self.assertEqual(D.role_group("electricity provider", "X"), "utilities")
        self.assertEqual((D.lens_code({"short": "2.1 Transitions", "title": "x"}),
                          D.lens_code({"short": "Households & equity", "title": "x"})), ("2.1", "H&E"))

    def test_the_cover_lines_have_word_limits(self):
        long = " ".join(["word"] * 50)
        with self.assertRaises(SystemExit) as cm:
            D.add_entry(self.corpus, {**ENTRY_B, "source": "url:https://ex.org/filing", "for_us": long}, writer="x", plan=True)
        self.assertIn("for_us: 50 words; at most 45", str(cm.exception))
        for bad, want in (({**BRIEF, "themes": BRIEF["themes"] * 7}, "at most 6"),
                          ({**BRIEF, "next_steps": [long]}, "next_steps[0]: 50 words"),
                          ({**BRIEF, "next_steps": [{"step": "Look", "see": "nowhere"}]}, "'nowhere' is not a page"),
                          ({**BRIEF, "bottom_line": long + " " + long}, "bottom_line: 100 words")):
            with self.assertRaises(SystemExit) as cm:
                D.add_brief(self.corpus, bad, writer="x", plan=True)
            self.assertIn(want, str(cm.exception))

    def test_the_passage_set_keeps_its_namespace_when_the_corpus_moves(self):
        ns = D.load_cfg(self.corpus)["namespace"]
        moved, _ = self.fresh("moved-elsewhere")
        self.assertEqual(D.exs_id(moved), f"exs-{ns}-dossier")

    def test_every_quotation_is_in_the_site_the_word_file_and_the_spreadsheet(self):
        quotes = {q["quote"] for q in D.all_quotes({"docs": D.entries(self.corpus), "brief":
                                                    D.current_brief(self.corpus)["ext"]["upc_corpus"]["dossier_brief"]})}
        self.assertEqual(len(quotes), 9)
        site = "".join(f.read_text() for f in self.out.rglob("*.html"))
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
    def test_a_pooled_write_stores_every_entry_once(self):
        """write --pool: entries drafted on several servers at once, stored one at a time."""
        corpus, _ = self.fresh("write-pool")
        servers = []

        def stub(system, user, url="", **kw):
            servers.append(url)
            title = user.splitlines()[0].removeprefix("Title: ")
            return {"content": json.dumps({"kind": "doc", "summary": f"About {title}.", "why_it_matters": [],
                                           "relevance": {}, "key_points": [], "figures": [], "dates": [],
                                           "actors": [], "terms": [], "cites": [], "questions": []}), "headers": {}}
        three = {"a": "http://a/v1/chat/completions", "b": "http://b/v1/chat/completions"}
        with mock.patch.object(D.C, "llm_chat", stub), mock.patch.object(D.llm_pool, "ENDPOINTS", three), \
                mock.patch.object(D.llm_pool, "relayed", lambda url: False), mock.patch("builtins.print"):
            rc = D.cmd_write(corpus, None, redo=True, plan=False, max_chars=1000, pool=True)
        self.assertEqual(rc, 0)
        self.assertEqual(len(servers), 2, "the two documents (the request note is never an entry)")
        self.assertTrue(set(servers) <= set(three.values()))
        summaries = sorted(e["summary"] for e in D.entries(corpus))
        self.assertEqual(summaries, ["About Comments of a consumer advocate.", "About Retail gas in a low-carbon future."])

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
        self.assertIn("What it aims to do:\n- Find where households can leave gas easily", calls[0][0])
        self.assertIn("What it asks:\n- Who pays when customers leave?", calls[0][0])
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

    def test_the_write_prompt_names_aims_and_questions_only_when_the_profile_has_them(self):
        bare = {k: v for k, v in PROJECT.items() if k not in ("aims", "questions")}
        self.assertNotIn("What it aims to do", D.write_prompt(AUDIENCE, bare))
        self.assertNotIn("What it asks", D.write_prompt(AUDIENCE, bare))
        one = D.write_prompt(AUDIENCE, {**bare, "aims": "Map the transition"})  # the schema allows one aim as text
        self.assertIn("What it aims to do:\n- Map the transition", one)
        self.assertLess(one.index("Map the transition"), one.index("Judge relevance against these lenses"))

    # -- brief --draft: the local model drafts the memo from the stored entries
    def draft_reply(self, corpus):
        _, keys, given = D.draft_material(D.order_docs(D.entries(corpus), D.load_cfg(corpus), D.source_index(corpus)))
        by = {(keys[g["doc"]], g["direct_quote"]): eid for eid, g in given.items()}
        rep_sid = C.corpus_reps(corpus)["url:https://ex.org/report"]["source_id"]
        fil_sid = C.corpus_reps(corpus)["url:https://ex.org/filing"]["source_id"]
        r_kp = by[(rep_sid, ENTRY_A["key_points"][0]["quote"])]
        r_fig = next(e for (sid, q), e in by.items() if sid == rep_sid and "$5.60" in q)
        f_kp = by[(fil_sid, ENTRY_B["key_points"][0]["quote"])]
        reply = {
            "bottom_line": 'Gas rates rise for those who stay, and "the poorest pay the most" unless pilots protect them.',
            "themes": [{"title": "The rate spiral",
                        "text": f'Rates climb as customers leave: "{ENTRY_A["key_points"][0]["quote"]}" [{r_kp}] '
                                f"The advocate asks pilots to protect those who cannot pay [{r_kp}, {f_kp}]."},
                       {"title": "An uncited theme", "text": "Something the model believes [ext-000000000000]."}],
            "tensions": [{"title": "Who bears the cost",
                          "text": f'The study sees "gas rates rising sharply as customers leave" [{r_kp}], while the '
                                  f"advocate asks for protection [{f_kp}]."}],
            "for_project": [{"lens": "households", "headline": "Households carry the risk",
                             "text": f"Remaining customers face higher bills [{r_fig}]."}],
            "next_steps": [{"step": "Read the report first", "detail": "", "see": "D1"},
                           {"step": "List the works it cites", "detail": "Start with the leads.", "see": "leads"}],
            "reading_order": [{"doc": "D1", "why": "The argument."}, {"doc": "D2", "why": "The reply."},
                              {"doc": "D1", "why": "Twice."}]}
        return reply, {"r_kp": r_kp, "r_fig": r_fig, "f_kp": f_kp, "report": rep_sid, "filing": fil_sid}

    @staticmethod
    def stub(replies, calls):
        def llm_chat(system, user, **kw):
            calls.append({"system": system, "user": user, **kw})
            return {"content": json.dumps(replies[min(len(calls), len(replies)) - 1])}
        return llm_chat

    def test_brief_draft_stores_a_model_memo_from_the_entries_through_the_guards(self):
        corpus, _ = self.fresh("draft")
        reply, ids = self.draft_reply(corpus)
        calls = []
        with mock.patch.object(D.C, "llm_chat", self.stub([reply], calls)), \
                mock.patch.object(sys, "argv", ["dossier.py", "brief", "--corpus", str(corpus), "--draft",
                                                "--model", "stub-model"]):
            self.assertEqual(D.main(), 0)
        # One draft, then one fix pass, since the checks removed something from the first.
        self.assertEqual(len(calls), 2)
        self.assertIn("A CHECKER FOUND THESE PROBLEMS", calls[1]["user"])
        self.assertIn("it cites no given passage", calls[1]["user"])
        self.assertEqual(calls[0]["model"], "stub-model")
        self.assertIn("Find where households can leave gas easily", calls[0]["system"])  # the project's aims
        self.assertEqual(calls[0]["schema"]["properties"]["reading_order"]["items"]["properties"]["doc"]["enum"], ["D1", "D2"])
        # The model reads the entries, never the documents: a sentence only in the report's body is not sent.
        self.assertIn(f'"{ENTRY_A["key_points"][0]["quote"]}" [{ids["r_kp"]}]', calls[0]["user"])
        self.assertNotIn(SECRET, calls[0]["user"])
        self.assertNotIn(MISSING, calls[0]["user"])  # a quotation the gate dropped is not offered either

        syn = D.current_brief(corpus)
        b = syn["ext"]["upc_corpus"]["dossier_brief"]
        self.assertEqual(syn["provenance"]["produced_by"]["model"], "stub-model")
        self.assertEqual(syn["provenance"]["produced_by"]["prompt_version"], D.DRAFT_PROMPT)
        self.assertEqual((b["writer"], b["drafted"]["model"], b["drafted"]["fix_pass"]),
                         ("the assistant (stub-model)", "stub-model", True))
        self.assertEqual([t["title"] for t in b["themes"]], ["The rate spiral"])  # the uncited theme is left out
        self.assertEqual([e["extraction_id"] for e in b["themes"][0]["evidence"]], [ids["r_kp"], ids["f_kp"]])
        self.assertIn(f'"{ENTRY_A["key_points"][0]["quote"]}"', b["themes"][0]["text"])  # a real quotation stays one
        for text in (b["bottom_line"], b["themes"][0]["text"], b["tensions"][0]["text"], b["for_project"][0]["text"]):
            self.assertNotIn("[ext-", text)  # the markers became evidence
        self.assertIn("the poorest pay the most unless", b["bottom_line"])  # quoted words in no passage: marks gone
        self.assertIn("The study sees gas rates rising sharply as customers leave, while", b["tensions"][0]["text"])
        self.assertEqual([e["extraction_id"] for e in b["for_project"][0]["evidence"]], [ids["r_fig"]])
        self.assertEqual([r["source_id"] for r in b["reading_order"]], [ids["report"], ids["filing"]])
        self.assertEqual(b["next_steps"][0], {"step": "Read the report first", "see": ids["report"]})
        self.assertTrue(any("ext-000000000000" in r for r in b["drafted"]["removed"]))
        self.assertEqual(D.validate(corpus).get("errors") or [], [])
        self.assertEqual(D.cmd_check(corpus), 0)

        out = self.root / "draft-site"
        D.build(corpus, out, docx=False, xlsx=False)
        self.assertIn("Memo · drafted by the assistant (stub-model)", (out / "memo.html").read_text())
        self.assertIn("Drafted by the assistant (stub-model)", (out / "index.html").read_text())

    def test_a_draft_that_is_working_notes_is_refused_and_nothing_is_stored(self):
        corpus, _ = self.fresh("draft-notes")
        reply, _ = self.draft_reply(corpus)
        before = D.current_brief(corpus)["synthesis_id"]
        calls = []
        notes = {**reply, "bottom_line": "The user wants a short memo for the lab. Rates rise for those who stay."}
        with mock.patch.object(D.C, "llm_chat", self.stub([notes], calls)):
            self.assertEqual(D.cmd_draft(corpus, "stub-model", None, plan=False), 1)
        self.assertEqual(len(calls), 2)  # it was asked to fix it once
        self.assertEqual(D.current_brief(corpus)["synthesis_id"], before)

    def test_a_fix_pass_that_cannot_reach_the_model_keeps_the_first_draft(self):
        corpus, _ = self.fresh("draft-down")
        reply, _ = self.draft_reply(corpus)
        calls = []

        def flaky(system, user, **kw):
            calls.append(user)
            if len(calls) > 1:
                raise C.Unavailable("the model server stopped answering")
            return {"content": json.dumps(reply)}
        with mock.patch.object(D.C, "llm_chat", flaky):
            self.assertEqual(D.cmd_draft(corpus, "stub-model", None, plan=False), 0)
        b = D.current_brief(corpus)["ext"]["upc_corpus"]["dossier_brief"]
        self.assertEqual(([t["title"] for t in b["themes"]], len(calls)), (["The rate spiral"], 2))

    def test_the_draft_guards_refuse_talk_about_the_input_and_accept_marker_lists(self):
        corpus, _ = self.fresh("draft-meta")
        reply, ids = self.draft_reply(corpus)
        cfg = D.load_cfg(corpus)
        _, keys, given = D.draft_material(D.order_docs(D.entries(corpus), cfg, D.source_index(corpus)))
        proj, idx = D.load_profile(cfg["project"], "project"), D.source_index(corpus)
        meta = {**reply, "tensions": [{"title": "Costs",
                                       "text": f"Costs fall on those who stay, as the passages provided show [{ids['r_kp']}]."}]}
        refuse = D.settle_draft(meta, given, keys, proj, idx)[1]
        self.assertTrue(any("talks about what the model was given" in r for r in refuse), refuse)
        brief, refuse, _ = D.settle_draft({**reply, "themes": reply["themes"][:1]}, given, keys, proj, idx)
        self.assertEqual(refuse, [])
        self.assertEqual(len(brief["themes"][0]["evidence"]), 2)  # "[ext-a, ext-b]" is two markers
        none = {**reply, "themes": [{"title": "Uncited", "text": "No marker here."}]}
        self.assertIn("themes: none rests on a given passage", D.settle_draft(none, given, keys, proj, idx)[1])

    def test_brief_draft_plan_asks_no_model_and_brief_from_still_needs_a_writer(self):
        corpus, _ = self.fresh("draft-plan")

        def no_model(*a, **k):
            raise AssertionError("--plan called the model")
        with mock.patch.object(D.C, "llm_chat", no_model):
            self.assertEqual(D.cmd_draft(corpus, "stub-model", None, plan=True), 0)
        src = self.root / "brief.json"
        src.write_text(json.dumps(BRIEF))
        with mock.patch.object(sys, "argv", ["dossier.py", "brief", "--corpus", str(corpus), "--from", str(src)]):
            with self.assertRaises(SystemExit) as cm:
                D.main()
        self.assertIn("needs --writer", str(cm.exception))
        with mock.patch.object(sys, "argv", ["dossier.py", "brief", "--corpus", str(corpus), "--from", str(src),
                                             "--writer", "Claude (test)", "--plan"]):
            self.assertEqual(D.main(), 0)

    # -- the project in front (build --scope, or the profile's scope:)
    def test_a_scope_file_is_read_as_plain_markdown(self):
        blocks = D.scope_blocks(SCOPE)
        self.assertEqual([b["t"] for b in blocks], ["h", "p", "h", "ol", "h", "ul", "h", "table", "quote", "code", "p"])
        self.assertEqual(blocks[3]["items"], [(0, "Find where switching is easy"), (0, "Find where it stalls"), (0, "Say why")])
        self.assertEqual([lv for lv, _ in blocks[5]["items"]], [0, 1, 0])
        page = D.scope_html(blocks)
        for want in ("<h2>Scope: PATH</h2>", "<b>household</b>",
                     '<a href="https://ex.org/program" target="_blank" rel="noopener">the program</a>',
                     "<ol><li>Find where switching is easy</li><li>Find where it stalls</li><li>Say why</li></ol>",
                     "<ul><li>Task 1: Literature<ul><li>1.1 Review the rate studies</li></ul></li><li>Task 2: Interviews</li></ul>",
                     "<th>Need</th>", "<td>collect</td>", "<blockquote>The scope", "<pre><code>code &lt;b&gt;here&lt;/b&gt;</code></pre>",
                     "&lt;script&gt;"):
            self.assertIn(want, page)
        for never in ("made_by", "a note for the owner", "file://", "<script>"):
            self.assertNotIn(never, page)
        self.assertIn("a file", page)  # a link that isn't http(s) or mailto keeps its words only
        md = "\n".join(D.scope_markdown(blocks))
        for want in ("## Scope\\: PATH", "1. Find where switching is easy", "    - 1\\.1 Review the rate studies",
                     "[the program](<https://ex.org/program>)", "| Need | Class | Why |"):
            self.assertIn(want, md)
        rows = D.scope_rows(blocks)
        self.assertEqual(rows[0], ["Scope: PATH", "heading", "Scope: PATH"])
        self.assertIn(["Scope: PATH › Information needs", "table row", "Need: Rate forecasts; Class: find; Why: Task 1 needs them"], rows)
        self.assertIn(["Scope: PATH › Tasks", "item", "  1.1 Review the rate studies"], rows)

    def test_build_puts_the_project_in_front_of_the_site_the_word_file_and_the_spreadsheet(self):
        corpus, cfg = self.fresh("scope")
        scope = self.root / "scope.md"
        scope.write_text(SCOPE)
        out = self.root / "scope-site"
        res = D.build(corpus, out, docx=HAVE_PANDOC, scope=scope)
        self.assertEqual(res["scope"], str(scope.resolve()))
        page = (out / "project.html").read_text()
        for want in ("<h1>The project</h1>", "not checked against the documents", "<td>Rate forecasts</td>",
                     'class="here">The project</a>'):
            self.assertIn(want, page)
        index = (out / "index.html").read_text()
        self.assertIn('<a class="btn" href="project.html">The project</a>', index)
        self.assertLess(index.index('href="project.html"'), index.index('href="memo.html"'))  # the tab after the cover
        self.assertIn("scope file as written", (out / "method.html").read_text())
        from openpyxl import load_workbook
        wb = load_workbook(next(out.glob("*.xlsx")))
        self.assertEqual(wb.sheetnames[:2], ["The project", "Documents"])
        if HAVE_PANDOC:
            words = " ".join(D.docx_text(next(out.glob("*.docx"))).split())
            self.assertLess(words.index("The project"), words.index("At a glance"))
            for want in ("Find where switching is easy", "1.1 Review the rate studies", "Rate forecasts"):
                self.assertIn(want, words)
        rec = json.loads((out.parent / "scope-site.build.json").read_text())
        self.assertEqual(rec["scope"]["sha256"], hashlib.sha256(SCOPE.encode()).hexdigest())

        # The project profile's scope: does the same, relative to the profile; a missing file refuses the build.
        prof = self.root / "profile-with-scope"
        prof.mkdir()
        (prof / "scope.md").write_text(SCOPE)
        (prof / "project.json").write_text(json.dumps({**PROJECT, "scope": "scope.md"}))
        D.cfg_path(corpus).write_text(json.dumps({**cfg, "project": str(prof / "project.json")}))
        out2 = self.root / "scope-site-2"
        D.build(corpus, out2, docx=False, xlsx=False)
        self.assertIn("Find where switching is easy", (out2 / "project.html").read_text())
        with self.assertRaises(SystemExit) as cm:
            D.build(corpus, out2, docx=False, xlsx=False, scope=self.root / "no-such-scope.md")
        self.assertIn("no scope file", str(cm.exception))
        # Without a scope there is no project page, and an earlier build's is removed.
        D.cfg_path(corpus).write_text(json.dumps(cfg))
        D.build(corpus, out2, docx=False, xlsx=False)
        self.assertFalse((out2 / "project.html").exists())
        self.assertNotIn("project.html", (out2 / "index.html").read_text())

    def test_a_local_path_in_the_scope_refuses_the_build(self):
        corpus, _ = self.fresh("scope-local")
        scope = self.root / "scope-local.md"
        scope.write_text("# Scope\n\nThe files are in /Users/someone/Documents/Project.\n")
        with self.assertRaises(SystemExit) as cm:
            D.build(corpus, self.root / "scope-local-site", docx=False, xlsx=False, scope=scope)
        self.assertIn("local path", str(cm.exception))

    def test_check_finds_every_quotation_again(self):
        self.assertEqual(D.cmd_check(self.corpus), 0)

    # -- how it reads
    def test_every_page_has_a_light_and_dark_switch(self):
        for f in self.out.rglob("*.html"):
            html = f.read_text()
            self.assertIn('<button class="theme" type="button" hidden>', html, f.name)
            self.assertLess(html.index("upc-dossier-theme"), html.index("<style>"), f.name)  # applied before paint
        self.assertIn(":root[data-theme=dark]", self.index)

    def test_a_writer_label_shows_on_the_pages_and_the_method_names_the_real_writer(self):
        corpus, _ = self.fresh("label")
        with mock.patch.object(sys, "argv", ["dossier.py", "init", "--corpus", str(corpus),
                                             "--show-writer-as", "Claude (test)=Hermes"]):
            self.assertEqual(D.main(), 0)
        self.assertEqual(D.load_cfg(corpus)["writer_labels"], {"Claude (test)": "Hermes"})
        out = self.root / "label-site"
        D.build(corpus, out, docx=HAVE_PANDOC)
        for f in out.rglob("*.html"):
            html = f.read_text()
            if f.name == "method.html":
                self.assertEqual(html.count("Claude (test)"), 1)
                self.assertIn("The writer here: Hermes, using Claude (test).", html)
            else:
                self.assertNotIn("Claude (test)", html, f.name)
        self.assertIn("— Hermes", (out / "index.html").read_text())
        from openpyxl import load_workbook
        cells = [str(c) for ws in load_workbook(next(out.glob("*.xlsx"))) for row in ws.iter_rows(values_only=True)
                 for c in row if c is not None]
        self.assertIn("Hermes", cells)
        self.assertFalse([c for c in cells if "Claude (test)" in c])
        if HAVE_PANDOC:
            words = " ".join(D.docx_text(next(out.glob("*.docx"))).split())
            self.assertEqual(words.count("Claude (test)"), 1)
            self.assertIn("Hermes, using Claude (test)", words)
        self.assertEqual({e["writer"] for e in D.entries(corpus)}, {"Claude (test)"})  # the records keep the writer
        with mock.patch.object(sys, "argv", ["dossier.py", "init", "--corpus", str(corpus),
                                             "--show-writer-as", "Claude (test)="]):
            D.main()
        self.assertEqual(D.load_cfg(corpus)["writer_labels"], {})


if __name__ == "__main__":
    unittest.main()
