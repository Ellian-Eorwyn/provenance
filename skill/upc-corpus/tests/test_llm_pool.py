"""Offline tests for llm_pool.py: which server takes what, items handed back, gates, relays,
ordered results, the config, and one chat call against local fake servers. No model is called.
Run with:

    python3 -m unittest discover -s tests -p 'test_llm_pool.py' -v

`PoolContract` takes the module under test from `self.M`, so a copy of the pool elsewhere (Hermes's
local_llm_pool.py) can run the same contract.
"""

import importlib.util
import json
import os
import sys
import threading
import time
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ["UPC_CORPUS_CONFIG"] = str(Path(__file__).with_name("no-such-config.json"))  # never this machine's config
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import llm_pool  # noqa: E402

THREE = {"a": "http://a.test/v1/chat/completions", "b": "http://b.test/v1/chat/completions",
         "c": "http://c.test/v1/chat/completions"}
QUICK = {"probe": lambda url: False, "gate": lambda name: True, "relay_rest": 0.2, "gate_wait": 0.05}


class PoolContract:
    """The pool's promises, for any module with llm_pool's interface (self.M)."""

    M = llm_pool

    def pool(self, items, work, endpoints=THREE, **options):
        done, lock = [], threading.Lock()

        def on_done(item, result, name, seconds):
            with lock:
                done.append((item, name))

        problems, left = self.M.run_all(list(items), work, on_done, endpoints, **{**QUICK, **options})
        return done, problems, left

    def test_a_lone_item_goes_to_the_first_server(self):
        for _ in range(5):
            done, problems, left = self.pool([1], lambda item, name, url: item)
            self.assertEqual(done, [(1, "a")])
            self.assertEqual((problems, left), ([], []))

    def test_every_server_takes_work_when_there_is_enough(self):
        done, _, left = self.pool(range(30), lambda item, name, url: time.sleep(0.02))
        self.assertEqual(left, [])
        self.assertEqual(sorted(item for item, _ in done), list(range(30)))
        self.assertEqual({name for _, name in done}, {"a", "b", "c"})

    def test_an_item_handed_back_after_the_others_went_idle_still_runs(self):
        def work(item, name, url):
            if name == "a":
                time.sleep(0.3)              # b and c finish everything else and wait meanwhile
                raise self.M.Relayed(url)
            return item

        done, problems, left = self.pool(range(4), work, relay_rest=5)
        self.assertEqual(left, [])
        self.assertEqual(sorted(item for item, _ in done), [0, 1, 2, 3])
        self.assertNotIn("a", {name for _, name in done})
        self.assertEqual(len(problems), 1)

    def test_a_relayed_server_rests_then_comes_back(self):
        relayed = {"once": False}

        def work(item, name, url):
            if name == "a" and not relayed["once"]:
                relayed["once"] = True
                raise self.M.Relayed(url)
            time.sleep(0.05)
            return item

        done, problems, left = self.pool(range(30), work, endpoints={"a": THREE["a"], "b": THREE["b"]})
        self.assertEqual(left, [])
        self.assertEqual(len(done), 30)
        self.assertIn("a", {name for _, name in done})
        self.assertEqual(len(problems), 1)

    def test_a_down_server_stops_and_the_others_finish(self):
        def work(item, name, url):
            if name == "b":
                raise self.M.Unavailable(f"{url} didn't answer")
            time.sleep(0.01)
            return item

        done, problems, left = self.pool(range(10), work)
        self.assertEqual((len(done), left), (10, []))
        self.assertTrue(any(p.startswith("b:") and p.endswith("the rest ran on the other servers only")
                            for p in problems))

    def test_a_shut_gate_takes_nothing_and_its_worker_joins_when_it_opens(self):
        opened, started = threading.Event(), {}

        def gate(name):
            return name != "c" or opened.is_set()

        def work(item, name, url):
            started.setdefault(name, time.monotonic())
            time.sleep(0.1)
            return item

        threading.Timer(0.4, opened.set).start()
        t0 = time.monotonic()
        done, _, left = self.pool(range(12), work, endpoints={"a": THREE["a"], "c": THREE["c"]}, gate=gate)
        self.assertEqual((len(done), left), (12, []))
        self.assertIn("c", started)
        self.assertGreaterEqual(started["c"] - t0, 0.35)

    def test_a_gate_that_never_opens_leaves_the_items(self):
        def work(item, name, url):
            raise self.M.Unavailable("paused")

        done, problems, left = self.pool([1, 2], work, endpoints={"a": THREE["a"], "c": THREE["c"]},
                                        gate=lambda name: name != "c", patience=0.3)
        self.assertEqual(done, [])
        self.assertEqual(sorted(left), [1, 2])
        self.assertTrue(any(p.startswith("c: waited") for p in problems))

    def test_not_now_hands_the_item_back_and_keeps_the_worker(self):
        refused = {"n": 0}

        def work(item, name, url):
            if name == "a" and refused["n"] < 2:
                refused["n"] += 1
                raise self.M.NotNow()
            time.sleep(0.01)
            return item

        done, problems, left = self.pool(range(6), work, endpoints={"a": THREE["a"], "b": THREE["b"]})
        self.assertEqual((len(done), left, problems), (6, [], []))

    def test_fits_and_a_hand_back(self):
        tries = {"n": 0}

        def work(item, name, url):
            if item == 50 and tries["n"] == 0:
                tries["n"] += 1
                raise self.M.Relayed(url)
            return item

        done, _, left = self.pool([5, 50], work, endpoints={"a": THREE["a"], "b": THREE["b"]},
                                 fits=lambda item, name: name == "b" or item < 10)
        self.assertEqual(left, [])
        self.assertIn((50, "b"), done)

    def test_an_item_no_server_fits_is_left(self):
        done, _, left = self.pool([5, 500], lambda item, name, url: item, fits=lambda item, name: item < 10)
        self.assertEqual((done, left), ([(5, "a")], [500]))

    def test_a_failing_item_neither_vanishes_nor_stops_its_worker(self):
        def work(item, name, url):
            if item == 3:
                raise ValueError("bad item")
            return item

        pool = self.M.Pool(work, lambda *a: None, {"a": THREE["a"]}, **QUICK)
        pool.add(*range(6))
        problems = pool.join()
        self.assertEqual([item for item, _ in pool.failed], [3])
        self.assertEqual(pool.left, [])
        self.assertTrue(any("bad item" in p for p in problems))

    def test_on_done_never_runs_twice_at_once(self):
        inside, most, lock = [0], [0], threading.Lock()

        def on_done(item, result, name, seconds):
            with lock:
                inside[0] += 1
                most[0] = max(most[0], inside[0])
            time.sleep(0.005)
            with lock:
                inside[0] -= 1

        self.M.run_all(list(range(40)), lambda item, name, url: item, on_done, THREE, **QUICK)
        self.assertEqual(most[0], 1)

    def test_map_ordered_keeps_input_order(self):
        def fn(item, name, url):
            time.sleep(0.05 if item % 2 else 0.01)
            return item * 10

        results, problems, left = self.M.map_ordered(list(range(9)), fn, THREE, **QUICK)
        self.assertEqual(results, [i * 10 for i in range(9)])
        self.assertEqual((problems, left), ([], []))

    def test_map_ordered_raises_the_first_error_in_input_order(self):
        def fn(item, name, url):
            if item in (2, 5):
                time.sleep(0.05 if item == 2 else 0)
                raise ValueError(f"item {item}")
            return item

        with self.assertRaisesRegex(ValueError, "item 2"):
            self.M.map_ordered(list(range(8)), fn, THREE, **QUICK)


class ProvenancePool(PoolContract, unittest.TestCase):
    M = llm_pool


def load_with_config(config: dict):
    """A fresh llm_pool reading `config` (common stubbed), so the module-level tables can be checked."""
    stub = types.ModuleType("common")
    stub.CONFIG, stub.CHAT_URL = config, "http://chat.test/v1/chat/completions"
    saved = sys.modules.get("common")
    sys.modules["common"] = stub
    try:
        spec = importlib.util.spec_from_file_location("llm_pool_config_test", SCRIPTS / "llm_pool.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if saved is not None:
            sys.modules["common"] = saved


CONFIG = {"pool": {"a": THREE["a"], "b": THREE["b"], "c": THREE["c"]},
          "relay": {"header": "X-Served-By", "value": "fallback", "to": "c"},
          "same_as": {"b": ["http://b.test:8007/v1/chat/completions"]},
          "gate": {"c": ["false"]}}


class ConfigTests(unittest.TestCase):
    def test_three_servers_a_relay_target_and_another_address(self):
        m = load_with_config(CONFIG)
        self.assertEqual(list(m.ENDPOINTS), ["a", "b", "c"])
        self.assertEqual(m.RELAY_TO, {"a": "c", "b": "c"})
        self.assertEqual(m.server_of("http://b.test:8007/v1/chat/completions"), "b")
        self.assertEqual(m.server_of("http://elsewhere.test/v1"), "")
        self.assertEqual(m.relay_target(THREE["c"]), "")
        self.assertEqual(m.relay_target(THREE["a"]), "c")
        self.assertEqual(m.model_for(THREE["a"], "task"), "chat")
        self.assertEqual(m.model_for("http://b.test:8007/v1/chat/completions", "task"), "task")
        self.assertFalse(m.gate_open("c"))
        self.assertTrue(m.gate_open("a"))

    def test_relay_targets_per_server(self):
        m = load_with_config({**CONFIG, "relay": {"header": "X-Served-By", "value": "fallback",
                                                  "to": {"a": "c", "c": "a"}}})
        self.assertEqual(m.RELAY_TO, {"a": "c", "c": "a"})
        self.assertEqual(m.relay_target(THREE["b"]), "")
        self.assertEqual(m.relay_target(THREE["c"]), "a")


class FakeServer(BaseHTTPRequestHandler):
    """Answers like a chat server: `relay` sends the fallback header, `missing` a 404."""
    seen: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeServer.seen.append((self.server.kind, body["model"]))
        if self.server.kind == "missing":
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if self.server.kind == "relay":
            self.send_header("X-Served-By", "fallback")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class HttpTests(unittest.TestCase):
    """One chat call each against three local fake servers."""

    def setUp(self):
        self.servers = {}
        for kind in ("plain", "relay", "missing"):
            server = ThreadingHTTPServer(("127.0.0.1", 0), FakeServer)
            server.kind = kind
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.servers[kind] = server
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        url = {kind: f"http://127.0.0.1:{s.server_address[1]}/v1/chat/completions" for kind, s in self.servers.items()}
        self.url = url
        self.m = load_with_config({"pool": {"plain": url["plain"], "relay": url["relay"], "missing": url["missing"]},
                                   "relay": {"header": "X-Served-By", "value": "fallback", "to": "plain"}})
        FakeServer.seen = []

    def test_a_plain_reply_and_task_sent_as_chat(self):
        self.assertEqual(self.m.chat(self.url["plain"], "s", "u", 10, model="task"), "ok")
        self.assertEqual(FakeServer.seen, [("plain", "chat")])

    def test_a_relayed_reply_raises_relayed(self):
        with self.assertRaises(self.m.Relayed):
            self.m.chat(self.url["relay"], "s", "u", 10)
        self.assertTrue(self.m.relayed(self.url["relay"]))
        self.assertFalse(self.m.relayed(self.url["plain"]))

    def test_a_404_is_unavailable(self):
        with self.assertRaises(self.m.Unavailable):
            self.m.chat(self.url["missing"], "s", "u", 10)


if __name__ == "__main__":
    unittest.main()
