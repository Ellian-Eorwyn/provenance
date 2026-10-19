"""Several model servers side by side: one queue, one worker per server.

A local model server usually answers one request at a time, so a batch of model
calls runs fastest with one worker per server pulling from a shared queue. The
first server in the list takes the first item, so a lone job leaves the others free.

Some setups put a proxy in front of a server that, when its own model is down,
relays to another server in the pool and says so in a response header. A worker
that gets a relayed reply puts its item back and stops, so the other server isn't
asked to do two things at once; the pool says so once.

The machine's config (common.CONFIG) describes the pool:

    "pool": {"gpu-box": "http://gpu-box:8012/v1/chat/completions",
             "desk":    "http://127.0.0.1:8012/v1/chat/completions"},
    "relay": {"header": "X-LLM-Served-By", "value": "fallback", "to": "desk"}

Without "pool", the one chat server (common.CHAT_URL) is the pool. Without
"relay", no reply counts as relayed.

    chat(url, system, user, ...)   one chat call -> text
    Pool(work, on_done)            add() items, close(), join() -> problems
    run_all(items, work, on_done)  -> (problems, items no server could take)
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

import common as C

ENDPOINTS: dict[str, str] = dict(C.CONFIG.get("pool") or {"chat": C.CHAT_URL})
_RELAY = C.CONFIG.get("relay") or {}
RELAY_HEADER = _RELAY.get("header") or ""
RELAY_VALUE = _RELAY.get("value") or ""
# The server relayed replies come from: a reply relayed to it is only a problem for the others.
HOME = ENDPOINTS.get(_RELAY.get("to") or "", "")
THINK_HEADROOM = 8000            # thinking spends tokens before the answer starts


class Unavailable(RuntimeError):
    """The server didn't answer."""


class Relayed(RuntimeError):
    """A proxy answered from another server in the pool."""


class TooLong(RuntimeError):
    """The reply used its whole token budget."""


def is_relayed(headers, url: str) -> bool:
    """Was this reply relayed to the pool's home server by a proxy that isn't the home server?"""
    return bool(RELAY_HEADER and HOME and url != HOME and headers.get(RELAY_HEADER) == RELAY_VALUE)


def chat(url: str, system: str, user: str, max_tokens: int, model: str = "chat",
         effort: str = "", temperature: float | None = 0, timeout: int = 900,
         schema: dict | None = None) -> str:
    """One chat call. Raises Relayed for a relayed reply, TooLong when the reply hit
    max_tokens, Unavailable when nothing answered. `schema` asks the server to hold
    the answer to that JSON shape (as common.llm_chat does)."""
    if model in ("think", "code"):
        max_tokens += THINK_HEADROOM
    body: dict[str, Any] = {"model": model, "max_tokens": max_tokens,
                            "messages": [{"role": "system", "content": system},
                                         {"role": "user", "content": user}]}
    if temperature is not None:
        body["temperature"] = temperature
    if effort:
        body["reasoning_effort"] = effort
    if schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "schema": schema}}
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            relayed_reply = is_relayed(response.headers, url)
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        raise Unavailable(f"{url} answered HTTP {exc.code}: {exc.read()[:200]!r}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise Unavailable(f"{url} didn't answer ({exc})")
    if relayed_reply:
        raise Relayed(url)
    choice = (payload.get("choices") or [{}])[0]
    if choice.get("finish_reason") == "length":
        raise TooLong(f"the {model} reply used all {max_tokens} tokens")
    content = (choice.get("message") or {}).get("content") or ""
    return re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()


def relayed(url: str) -> bool:
    """A one-token call: is this server's proxy relaying right now? Checked before a
    worker takes its first item, so a relayed worker doesn't queue a whole item behind
    the home server's own work and then throw the answer away."""
    if not (RELAY_HEADER and HOME) or url == HOME:
        return False
    body = json.dumps({"model": "chat", "max_tokens": 1,
                       "messages": [{"role": "user", "content": "hi"}]}).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return is_relayed(response.headers, url)
    except (urllib.error.URLError, TimeoutError, OSError):
        return False          # down altogether: the first real call says so and puts its item back


def _relay_note(name: str) -> str:
    return f"{name}: its proxy relays to {_RELAY.get('to') or 'another server'} (its own model is down or busy)"


class Pool:
    """Workers, one per server, take items from one queue until it is closed and empty.

    `work(item, name, url)` returns a result; `on_done(item, result, name, seconds)` runs
    under the pool's lock. A worker whose server is relayed or down puts its item back and
    stops. When every worker has stopped, the items left are in `left`."""

    def __init__(self, work: Callable[[Any, str, str], Any],
                 on_done: Callable[[Any, Any, str, float], None],
                 endpoints: dict[str, str] | None = None):
        self.work, self.on_done = work, on_done
        self.endpoints = endpoints or ENDPOINTS
        self.queue: list[Any] = []
        self.closed = False
        self.cond = threading.Condition()
        self.problems: list[str] = []
        self.threads = [threading.Thread(target=self._worker, args=item, daemon=True)
                        for item in self.endpoints.items()]
        self.alive = len(self.threads)
        for t in self.threads:
            t.start()

    def add(self, *items: Any) -> None:
        with self.cond:
            self.queue.extend(items)
            self.cond.notify_all()

    def close(self) -> None:
        with self.cond:
            self.closed = True
            self.cond.notify_all()

    @property
    def left(self) -> list[Any]:
        return list(self.queue)

    def join(self) -> list[str]:
        self.close()
        for t in self.threads:
            t.join()
        return self.problems

    def _worker(self, name: str, url: str) -> None:
        try:
            if relayed(url):
                with self.cond:
                    self.problems.append(_relay_note(name) + "; this ran on the other servers only")
                return
            while True:
                with self.cond:
                    while not self.queue and not self.closed:
                        self.cond.wait()
                    if not self.queue:
                        return
                    item = self.queue.pop(0)
                t0 = time.time()
                try:
                    result = self.work(item, name, url)
                except (Relayed, Unavailable) as exc:
                    with self.cond:
                        self.queue.insert(0, item)
                        self.problems.append(
                            _relay_note(name) + "; the rest ran on the other servers only" if isinstance(exc, Relayed)
                            else f"{name}: {exc}; the rest ran on the other servers only")
                        self.cond.notify_all()
                    return
                with self.cond:
                    self.on_done(item, result, name, time.time() - t0)
        finally:
            with self.cond:
                self.alive -= 1
                self.cond.notify_all()


def run_all(items: list[Any], work: Callable[[Any, str, str], Any],
            on_done: Callable[[Any, Any, str, float], None],
            endpoints: dict[str, str] | None = None) -> tuple[list[str], list[Any]]:
    """Every item through the pool; returns (problems, items no server could take)."""
    pool = Pool(work, on_done, endpoints)
    pool.add(*items)
    problems = pool.join()
    return problems, pool.left
