"""Offline tests for screen.py: a pooled screen writes what a serial one does. No model or upc CLI is called.

    python3 -m unittest discover -s tests -p 'test_screen.py' -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import screen  # noqa: E402

BOOK = {"codebook_id": "cbk-000000000007", "slug": "study-type", "unit": "source", "title": "Study type",
        "codes": [{"code": "empirical", "label": "Empirical"}, {"code": "review", "label": "Review"}]}
THREE = {"a": "http://a/v1/chat/completions", "b": "http://b/v1/chat/completions",
         "c": "http://c/v1/chat/completions"}


def corpus_of(d: str) -> tuple[Path, dict]:
    corpus = Path(d)
    (corpus / "codebooks").mkdir()
    (corpus / "codebooks" / f"{BOOK['codebook_id']}.json").write_text(json.dumps(BOOK))
    reps = {}
    for i in range(1, 7):
        text = corpus / f"p{i}.md"
        text.write_text(f"Paper {i}. " + ("A review of studies." if i % 2 else "We surveyed 400 homes."))
        reps[f"p{i}"] = {"source_id": f"src-{i}", "title": f"Paper {i}", "text_path": str(text)}
    return corpus, reps


def fake_chat(calls):
    def chat(system, user, url="", model="", **kw):
        calls.append((url, model))
        code = "review" if "review of studies" in user else "empirical"
        return {"content": json.dumps({"judgements": [{"scheme": "study-type", "code": code, "why": "Says so.",
                                                       "confidence": "high"}]}),
                "seconds": 0.1, "headers": {}}
    return chat


class PooledScreen(unittest.TestCase):
    def screen(self, d: str, *extra: str) -> tuple[list, list]:
        corpus, reps = corpus_of(d)
        calls, written = [], []

        def upc_jsonl(*args, records):
            written.append((args[args.index("--model") + 1], records))
            return {"tally": {"coded": len(records)}}

        with mock.patch.object(screen.C, "check_compat", lambda: "upc test"), \
                mock.patch.object(screen.C, "corpus_reps", lambda c: reps), \
                mock.patch.object(screen.C, "llm_chat", fake_chat(calls)), \
                mock.patch.object(screen.C, "upc_jsonl", upc_jsonl), \
                mock.patch.object(screen.C, "upc", lambda *a, **k: {"status": "ok", "level": "L1", "errors": []}), \
                mock.patch.object(screen.llm_pool, "ENDPOINTS", THREE), \
                mock.patch.object(screen.llm_pool, "relayed", lambda url: False), \
                mock.patch.object(sys, "argv", ["screen.py", "--corpus", d, "--coder", "t-screen-v1", *extra]), \
                mock.patch("builtins.print"):
            self.assertEqual(screen.main(), 0)
        return calls, written

    def test_pooled_writes_the_same_judgements(self):
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d3:
            serial_calls, serial = self.screen(d1, "--url", "http://task/v1/chat/completions")
            pooled_calls, pooled = self.screen(d3, "--pool")
        self.assertEqual({u for u, _m in serial_calls}, {"http://task/v1/chat/completions"})
        self.assertGreater(len({u for u, _m in pooled_calls}), 1, "more than one server screened")
        self.assertEqual({m for _u, m in pooled_calls}, {"chat"}, "task goes to a pool server as chat")
        self.assertEqual({m for m, _r in serial}, {"task"})
        key = lambda batch: sorted(json.dumps(r, sort_keys=True) for _m, rs in batch for r in rs)  # noqa: E731
        self.assertEqual(key(serial), key(pooled))
        self.assertEqual(len(key(pooled)), 6)


if __name__ == "__main__":
    unittest.main()
