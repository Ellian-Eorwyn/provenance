"""Offline tests for the upc-corpus skill's own logic, plus one end-to-end
import through the real `upc` CLI (skipped when it is not installed). No model
is called. Run with:

    python3 -m unittest discover -s tests -v
"""

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

import code_pass  # noqa: E402
import common as C  # noqa: E402
import import_bundle as IB  # noqa: E402


def upc_available():
    try:
        C.check_compat()
        return True
    except C.Unavailable:
        return False


class CommonTests(unittest.TestCase):
    def test_alias_of_prefers_the_corpus_namespace_then_any(self):
        src = {"source_id": "src-1", "aliases": {"x": "y", "lib": "s0001"}}
        self.assertEqual(C.alias_of(src, "lib"), "s0001")
        self.assertEqual(C.alias_of(src), "y")
        self.assertEqual(C.alias_of({"source_id": "src-1"}), "src-1")

    def test_namespace_from_settings_codebooks_or_aliases(self):
        with tempfile.TemporaryDirectory() as tmp:
            co = Path(tmp)
            (co / "sources" / "a").mkdir(parents=True)
            (co / "sources" / "a" / "source.json").write_text(json.dumps({"aliases": {"lib": "s0001"}}))
            self.assertEqual(C.namespace_of(co), "lib")                 # before any codebook
            (co / "codebooks").mkdir()
            (co / "codebooks" / "cbk-1.json").write_text(json.dumps({"namespace": "proj", "slug": "x"}))
            self.assertEqual(C.namespace_of(co), "proj")                # the codebooks say
            (co / ".upc" / "upc-corpus").mkdir(parents=True)
            (co / ".upc" / "upc-corpus" / "settings.json").write_text(json.dumps({"namespace": "set"}))
            self.assertEqual(C.namespace_of(co), "set")                 # the settings say
            self.assertEqual(C.namespace_of(co, "given"), "given")      # --namespace wins
        self.assertEqual(C.alias_of({"source_id": "src-1", "aliases": {"literature": "d1"}}), "d1")
        self.assertEqual(C.alias_of({"source_id": "src-1"}), "src-1")

    def test_reading_copy_is_the_conversion(self):
        original = {"representation_id": "rep-a", "media_type": "text/markdown", "produced_by": "import"}
        copy = {"representation_id": "rep-b", "media_type": "text/plain", "produced_by": "conversion"}
        pdf = {"representation_id": "rep-c", "media_type": "application/pdf", "produced_by": "import"}
        self.assertIs(C.reading_copy([original, copy]), copy)
        self.assertIs(C.reading_copy([pdf, copy]), copy)
        self.assertIs(C.reading_copy([original]), original)
        self.assertIsNone(C.reading_copy([pdf]))

    def test_widen_to_unique_stays_on_its_line(self):
        text = "- Character: a person. System: a means of resolution.\n\n- System: a means of resolution.\n"
        self.assertEqual(C.occurrences(text, "System: a means of resolution."), 2)
        self.assertEqual(C.widen_to_unique(text, "System: a means of resolution."), "- System: a means of resolution.")
        self.assertIsNone(C.widen_to_unique("same line\nsame line\n", "same line"))


class CodePassTests(unittest.TestCase):
    def test_long_documents_are_read_in_parts_not_cut_off(self):
        text = "\n\n".join(f"Paragraph {n} " + "word " * 300 for n in range(40))
        parts = code_pass.split_for_model(text, 20000)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(part) <= 20000 for part in parts))
        self.assertEqual("".join(parts).rstrip("\n"), text)
        self.assertEqual(code_pass.split_for_model("short", 20000), ["short"])

    def test_prompt_no_longer_assumes_an_academic_paper(self):
        prompt = code_pass.system_prompt([{"slug": "b", "question": "q", "codes": [{"code": "c", "definition": "d"}]}])
        self.assertIn("one document", prompt)
        self.assertNotIn("academic paper", prompt)


class ImportMappingTests(unittest.TestCase):
    def test_types_codes_and_locators(self):
        self.assertEqual((IB.upc_type("claim"), IB.upc_type("quoted_evidence"), IB.upc_type("design_intent")),
                         ("claim", "quote", "evidence"))
        self.assertEqual(IB.type_code("community_norm"), "community-norm")
        entry = {"pages": [[0, "1"], [100, "iv"], [200, "3"]], "sections": [[0, "Intro"], [150, "  "]]}
        self.assertEqual(IB.locators_for(entry, "rep-x", 50), [
            {"type": "page", "representation_ref": "rep-x", "value": 1, "unit": "page"},
            {"type": "section", "representation_ref": "rep-x", "value": "Intro"}])
        self.assertEqual(IB.locators_for(entry, "rep-x", 120), [
            {"type": "section", "representation_ref": "rep-x", "value": "Intro"}])  # "iv" is no page number
        self.assertEqual(IB.locators_for(entry, "rep-x", 250)[0]["value"], 3)

    def test_source_record(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "Kankainen - 2024 - Curating.md"
            original.write_text("---\ntitle: x\n---\nbody\n", encoding="utf-8")
            entry = {"documentId": "d1", "title": "Curating", "authors": [{"family": "Kankainen"}], "authorsFrom": "file name",
                     "year": 2024, "yearFrom": "file name", "yearNote": "the YAML header says 2006", "url": "https://x.org/a",
                     "sourceType": "pdf document", "originalPath": str(original), "originalMediaType": "text/markdown",
                     "text": "text/00001-d1.txt"}
            record, note = IB.source_record(entry, Path(directory), "literature", {"name": "b"}, "2026-01-01T00:00:00Z")
            self.assertIsNone(note)
            self.assertEqual([f["role"] for f in record["files"]], ["text", "markdown"])
            self.assertEqual(record["files"][0]["parent"], 1)
            self.assertNotIn("url", record)  # a top-level url would set the source's identity
            self.assertEqual(record["bibliographic"]["url"], "https://x.org/a")
            self.assertEqual(record["field_evidence"]["year"]["origin"], "filename")
            self.assertIn("2006", record["field_evidence"]["year"]["evidence"])
            original.unlink()
            record, note = IB.source_record(entry, Path(directory), "literature", {"name": "b"}, "2026-01-01T00:00:00Z")
            self.assertEqual(len(record["files"]), 1)
            self.assertIn("missing", note)


@unittest.skipUnless(upc_available(), "the upc CLI is not installed")
class ImportEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.bundle = root / "bundle"
        (self.bundle / "text").mkdir(parents=True)
        originals = root / "originals"
        originals.mkdir()
        docs = {
            "d1": "Players negotiate the rules of the table.\nA quiet year ends with winter.\n",
            "d2": "- A. Design shapes play. Rules reward choices.\n\n- Rules reward choices.\n",
        }
        sources, items = [], []
        for n, (doc_id, text) in enumerate(docs.items(), 1):
            (self.bundle / "text" / f"{n:05d}-{doc_id}.txt").write_text(text, encoding="utf-8")
            (originals / f"{doc_id}.md").write_text(f"---\ntitle: {doc_id}\n---\n{text}", encoding="utf-8")
            sources.append({"documentId": doc_id, "title": f"Document {doc_id}", "authors": [], "year": 2020,
                            "yearFrom": "YAML header", "url": None, "sourceType": "forum post",
                            "originalPath": str(originals / f"{doc_id}.md"), "originalMediaType": "text/markdown",
                            "text": f"text/{n:05d}-{doc_id}.txt",
                            "textSha256": __import__("hashlib").sha256(text.encode()).hexdigest(),
                            "pages": [], "sections": [], "status": "success", "items": 2, "model": "chat"})

        def item(item_id, doc_id, span, occurrences=1, why=None, item_type="claim"):
            return {"itemId": item_id, "documentId": doc_id, "itemType": item_type, "text": f"paraphrase of {item_id}",
                    "directQuotes": span, "interpretation": "explicit", "confidence": "high", "locator": None,
                    "notes": None, "span": span, "spanStart": docs[doc_id].find(span) if span else None,
                    "occurrences": occurrences, "widenedBy": 0, "notResolved": why}

        items = [item("i000001", "d1", "Players negotiate the rules of the table."),
                 item("i000002", "d1", "A quiet year ends with winter.", item_type="design_intent"),
                 item("i000003", "d2", "Rules reward choices.", 2, "quote occurs more than once in the document"),
                 item("i000004", "d2", "Design shapes play.")]
        (self.bundle / "bundle.json").write_text(json.dumps({
            "format": IB.BUNDLE_FORMAT, "name": "tiny", "sourcesOnly": False,
            "run": {"itemTypes": [{"type": "claim", "definition": "an assertion the source argues for or asserts"},
                                  {"type": "design_intent", "definition": "a stated goal or rationale behind a rule"}],
                    "promptVersion": "literature-extraction/test"}}), encoding="utf-8")
        (self.bundle / "sources.jsonl").write_text("".join(json.dumps(s) + "\n" for s in sources), encoding="utf-8")
        (self.bundle / "items.jsonl").write_text("".join(json.dumps(i) + "\n" for i in items), encoding="utf-8")
        self.corpus = root / "corpus"

    def tearDown(self):
        self.directory.cleanup()

    def run_import(self):
        return subprocess.run([sys.executable, str(SCRIPTS / "import_bundle.py"), "--bundle", str(self.bundle),
                               "--corpus", str(self.corpus)], capture_output=True, text=True, timeout=300)

    def test_import_validates_and_is_idempotent(self):
        first = self.run_import()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("passages anchored                 3", first.stdout)
        self.assertIn("items left in the run only        1", first.stdout)
        report = json.loads(subprocess.run(C.UPC_CLI + ["validate", str(self.corpus)], capture_output=True, text=True).stdout)
        self.assertEqual((report["status"], len(report["errors"])), ("passed", 0))
        state_file = self.corpus / ".upc" / "upc-corpus" / "imports" / "tiny" / "state.json"
        self.assertIn("Nothing to do", self.run_import().stdout)
        snapshot = {p: p.read_bytes() for p in self.corpus.rglob("*.jsonl") if ".upc" not in p.parts and p.name != "events.jsonl"}
        state_file.unlink()  # forget the ledger: upc itself must recognise everything
        again = self.run_import()
        self.assertIn("passages exists", again.stdout)
        self.assertIn("item-type codings unchanged       3", again.stdout)
        self.assertEqual(snapshot, {p: p.read_bytes() for p in snapshot})
        mapping = [json.loads(line) for line in (state_file.parent / "item_map.jsonl").read_text().splitlines()]
        self.assertTrue(all(row["extractionId"].startswith("ext-") for row in mapping))


if __name__ == "__main__":
    unittest.main()
