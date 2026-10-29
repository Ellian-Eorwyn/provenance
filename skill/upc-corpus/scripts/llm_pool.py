"""Several model servers side by side: one queue, one worker per server.

A local model server usually answers one request at a time, so a batch of model
calls runs fastest with one worker per server pulling from a shared queue. The
servers are listed in order of preference: a worker takes an item only when no
server listed before it is ready to, so a lone job goes to the first server and
leaves the others to whatever else uses them.

Some setups put a proxy in front of a server that, when its own model is down or
lent out, relays to another server and says so in a response header. A worker that
gets a relayed reply puts its item back and rests, then asks again (`relay_rest`),
so the other server isn't asked to do two things at once and the first comes back
into use when its own model does. The pool says so once.

A server can also have a gate: a command that exits 0 while the server is free for
batch work (say, while nobody is chatting with it). Its worker takes nothing while
the gate is shut; an item already running is never stopped.

The machine's config (common.CONFIG) describes the pool:

    "pool": {"gpu-box": "http://gpu-box:8012/v1/chat/completions",
             "desk":    "http://127.0.0.1:8012/v1/chat/completions"},
    "relay": {"header": "X-LLM-Served-By", "value": "fallback", "to": "desk"},
    "context": {"gpu-box": 131072, "desk": 262144},
    "gate": {"desk": ["/path/to/gate-command", "desk"]},
    "same_as": {"gpu-box": ["http://gpu-box:8007/v1/chat/completions"]}

Without "pool", the one chat server (common.CHAT_URL) is the pool. "relay.to" is
the server relayed replies come from: one name (every other server relays to it),
or a map from each server to the one its proxy relays to (a server it leaves out
never counts as relayed). Without "relay", no reply counts as relayed. "context" is
each server's context window in tokens: with a `fits(item, name)` test, a worker
takes only the items that fit its server, and an item no server fits is left over
(`left`) rather than stopping a worker on an error. "gate" is a command per server,
run without a shell; exit 0 means free, anything else (or no answer) means busy.
"same_as" lists other addresses of a pool server, so `server_of` can name the server
behind them.

    chat(url, system, user, ...)      one chat call -> text
    Pool(work, on_done, fits=…)       add() items, close(), join() -> problems
    run_all(items, work, on_done)     -> (problems, items no server could take)
    map_ordered(items, fn)            -> (results in input order, problems, items left)
    context_of(name)                  a server's context window in tokens, or None
    server_of(url), model_for(url, m) the pool server behind an address; the model name to send it
"""
from __future__ import annotations

import json
import os
import re
import subprocess
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
_TO = _RELAY.get("to") or ""
# Each server whose proxy may relay, and the server it relays to.
RELAY_TO: dict[str, str] = ({name: str(to) for name, to in _TO.items()} if isinstance(_TO, dict)
                            else {name: _TO for name in ENDPOINTS if name != _TO} if _TO else {})
# The one server relayed replies come from, when "to" names one (kept for older callers).
HOME = ENDPOINTS.get(_TO, "") if isinstance(_TO, str) else ""
CONTEXT: dict[str, int] = dict(C.CONFIG.get("context") or {})
SAME_AS: dict[str, list[str]] = {name: list(urls) for name, urls in (C.CONFIG.get("same_as") or {}).items()}
GATES: dict[str, list[str]] = {name: [os.path.expanduser(str(part)) for part in command]
                               for name, command in (C.CONFIG.get("gate") or {}).items() if command}
THINK_HEADROOM = 8000            # thinking spends tokens before the answer starts
GATE_TTL = 5                     # seconds a gate's answer is good for
GATE_WAIT = 15                   # seconds a shut gate is left before it is asked again
PROBE_GRACE = 10                 # seconds a later server waits for an earlier one still probing
RELAY_REST = 600                 # seconds a relayed worker rests before it asks again
PATIENCE = 1800                  # seconds waiting workers keep waiting once nothing is running


def context_of(name: str) -> int | None:
    """A server's context window in tokens, from the config's "context"; None when it doesn't say."""
    return CONTEXT.get(name)


def server_of(url: str) -> str:
    """The pool server at `url` (its own address or one in "same_as"); "" for an address outside the pool."""
    for name, address in ENDPOINTS.items():
        if address == url:
            return name
    return next((name for name, urls in SAME_AS.items() if url in urls), "")


def model_for(url: str, model: str) -> str:
    """The model name to send to `url`. A pool server serves think, chat and code, so a `task` call
    (no thinking) goes to it as `chat`; any other address keeps the name."""
    return "chat" if model == "task" and url in ENDPOINTS.values() else model


class Unavailable(RuntimeError):
    """The server didn't answer."""


class Relayed(RuntimeError):
    """A proxy answered from another server in the pool."""


class TooLong(RuntimeError):
    """The reply used its whole token budget."""


class NotNow(RuntimeError):
    """Raised by `work` when its server shouldn't take this item now: the item goes back to the queue
    and the worker waits for its gate before taking another."""


def relay_target(url: str) -> str:
    """The server `url`'s proxy relays to, or "" when its replies never count as relayed. An address
    outside the pool counts as relayed whenever the header says so."""
    if not (RELAY_HEADER and RELAY_TO):
        return ""
    name = server_of(url)
    if name in ENDPOINTS:
        return RELAY_TO.get(name, "")
    return "" if url == HOME else next(iter(RELAY_TO.values()))


def is_relayed(headers, url: str) -> bool:
    """Did a proxy that relays (see relay_target) answer this reply from another server?"""
    return bool(relay_target(url) and headers.get(RELAY_HEADER) == RELAY_VALUE)


def chat(url: str, system: str, user: str, max_tokens: int, model: str = "chat",
         effort: str = "", temperature: float | None = 0, timeout: int = 900,
         schema: dict | None = None) -> str:
    """One chat call. Raises Relayed for a relayed reply, TooLong when the reply hit
    max_tokens, Unavailable when nothing answered. `schema` asks the server to hold
    the answer to that JSON shape (as common.llm_chat does)."""
    model = model_for(url, model)
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
    the other server's own work and then throw the answer away."""
    if not relay_target(url):
        return False
    body = json.dumps({"model": "chat", "max_tokens": 1,
                       "messages": [{"role": "user", "content": "hi"}]}).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return is_relayed(response.headers, url)
    except (urllib.error.URLError, TimeoutError, OSError):
        return False          # down altogether: the first real call says so and puts its item back


_GATE_SEEN: dict[str, tuple[float, bool]] = {}
_GATE_LOCK = threading.Lock()


def gate_open(name: str) -> bool:
    """Is server `name` free for batch work? True without a "gate" command; else the command's answer
    (exit 0 = free), kept for GATE_TTL seconds. A command that fails or hangs counts as busy."""
    command = GATES.get(name)
    if not command:
        return True
    with _GATE_LOCK:
        seen = _GATE_SEEN.get(name)
        if seen and time.monotonic() - seen[0] < GATE_TTL:
            return seen[1]
    try:
        free = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        free = False
    with _GATE_LOCK:
        _GATE_SEEN[name] = (time.monotonic(), free)
    return free


def _relay_note(name: str, to: str) -> str:
    return f"{name}: its proxy relays to {to or 'another server'} (its own model is down or busy)"


_DONE, _AGAIN = object(), object()


class Pool:
    """Workers, one per server, take items from one queue until it is closed and empty.

    `work(item, name, url)` returns a result; `on_done(item, result, name, seconds)` runs
    under the pool's lock. A worker whose reply was relayed puts its item back, rests and
    asks again; one whose server is down puts its item back and stops; one whose gate is
    shut (or whose `work` raised NotNow) waits. A worker leaves only when the queue is
    closed, holds nothing it could take and no item is running anywhere, since a running
    item may yet come back. Waiting workers give up once nothing has run for `patience`
    seconds. Items still queued after join() are in `left`; items whose `work` raised
    anything else are in `failed` with their error."""

    def __init__(self, work: Callable[[Any, str, str], Any],
                 on_done: Callable[[Any, Any, str, float], None],
                 endpoints: dict[str, str] | None = None,
                 fits: Callable[[Any, str], bool] | None = None,
                 gate: Callable[[str], bool] | None = None,
                 relay_rest: float = RELAY_REST, gate_wait: float = GATE_WAIT,
                 patience: float = PATIENCE, probe: Callable[[str], bool] | None = None):
        self.work, self.on_done = work, on_done
        self.fits = fits or (lambda item, name: True)
        self.gate = gate or gate_open
        self.probe = probe or relayed
        self.relay_rest, self.gate_wait, self.patience = relay_rest, gate_wait, patience
        self.endpoints = endpoints or ENDPOINTS
        self.names = list(self.endpoints)
        self.queue: list[Any] = []
        self.closed = False
        self.cond = threading.Condition()
        self.problems: list[str] = []
        self.failed: list[tuple[Any, BaseException]] = []
        now = time.monotonic()
        self.state = {name: "probing" for name in self.names}
        self.since = {name: now for name in self.names}
        self.in_flight = 0
        self.last_progress = now
        self.threads = [threading.Thread(target=self._worker, args=item, daemon=True)
                        for item in self.endpoints.items()]
        for t in self.threads:
            t.start()

    @property
    def alive(self) -> int:
        """Workers that haven't stopped."""
        with self.cond:
            return sum(state != "gone" for state in self.state.values())

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

    # Everything below runs under self.cond unless it says otherwise.

    def _note(self, text: str) -> None:
        if text not in self.problems:
            self.problems.append(text)

    def _set(self, name: str, state: str) -> None:
        if self.state[name] != state:
            self.state[name], self.since[name] = state, time.monotonic()
        self.cond.notify_all()

    def _ahead(self, name: str) -> bool:
        """Is a server listed before `name` ready for a queued item it can take? Then it goes first."""
        now = time.monotonic()
        for other in self.names[:self.names.index(name)]:
            state = self.state[other]
            if state == "probing" and now - self.since[other] < PROBE_GRACE:
                return True
            if state == "idle" and any(self.fits(item, other) for item in self.queue):
                return True
        return False

    def _finished(self) -> bool:
        return self.closed and not self.queue and self.in_flight == 0

    def _stalled(self) -> bool:
        """Every item is in, yet nothing has run or finished for `patience` seconds: waiting is pointless."""
        return self.closed and self.in_flight == 0 and time.monotonic() - self.last_progress > self.patience

    def _hand_back(self, item: Any) -> None:
        self.queue.insert(0, item)
        self.in_flight -= 1
        self.last_progress = time.monotonic()
        self.cond.notify_all()

    def _take(self, name: str) -> Any:
        """The next item for this worker, _AGAIN when its gate's answer has gone stale, or _DONE."""
        self._set(name, "idle")
        fresh_until = time.monotonic() + GATE_TTL
        while True:
            at = next((i for i, item in enumerate(self.queue) if self.fits(item, name)), None)
            if at is not None and not self._ahead(name):
                if time.monotonic() > fresh_until:
                    return _AGAIN
                self.in_flight += 1
                self._set(name, "busy")
                return self.queue.pop(at)
            if self.closed and at is None and self.in_flight == 0:
                return _DONE
            self.cond.wait(timeout=1.0)

    def _wait(self, name: str, state: str, seconds: float) -> bool:
        """Wait up to `seconds` in `state`; False when the pool is finished or stalled."""
        self._set(name, state)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self._finished():
                return False
            if self._stalled():
                self._note(f"{name}: waited with nothing else running; the rest is left over")
                return False
            self.cond.wait(timeout=min(1.0, max(0.0, deadline - time.monotonic())))
        return True

    # These run outside the lock.

    def _ready(self, name: str, url: str) -> bool:
        """Probe until this server answers for itself, resting between tries; False to stop."""
        while self.probe(url):
            with self.cond:
                self._note(_relay_note(name, RELAY_TO.get(name, "")) + "; it rests and asks again")
                if not self._wait(name, "resting", self.relay_rest):
                    return False
                self._set(name, "probing")
        return True

    def _gate_ok(self, name: str) -> bool:
        """Wait until this server's gate is open; False to stop."""
        while not self.gate(name):
            with self.cond:
                if not self._wait(name, "gated", self.gate_wait):
                    return False
        return True

    def _worker(self, name: str, url: str) -> None:
        try:
            if not self._ready(name, url):
                return
            while True:
                if not self._gate_ok(name):
                    return
                with self.cond:
                    item = self._take(name)
                if item is _DONE:
                    return
                if item is _AGAIN:
                    continue
                t0 = time.time()
                try:
                    result = self.work(item, name, url)
                except NotNow:
                    with self.cond:
                        self._hand_back(item)
                        if not self._wait(name, "gated", self.gate_wait):
                            return
                    continue
                except Relayed:
                    with self.cond:       # rest before asking again: a quick probe can pass while real calls relay
                        self._hand_back(item)
                        self._note(_relay_note(name, RELAY_TO.get(name, "")) + "; it rests and asks again")
                        if not self._wait(name, "resting", self.relay_rest):
                            return
                        self._set(name, "probing")
                    if not self._ready(name, url):
                        return
                    continue
                except Unavailable as exc:
                    with self.cond:
                        self._hand_back(item)
                        self._note(f"{name}: {exc}; the rest ran on the other servers only")
                    return
                except Exception as exc:  # noqa: BLE001  (one bad item must not stop the worker or vanish)
                    with self.cond:
                        self.in_flight -= 1
                        self.last_progress = time.monotonic()
                        self.failed.append((item, exc))
                        self._note(f"{name}: an item failed ({type(exc).__name__}: {exc})")
                    continue
                with self.cond:
                    self.in_flight -= 1
                    self.last_progress = time.monotonic()
                    try:
                        self.on_done(item, result, name, time.time() - t0)
                    finally:
                        self.cond.notify_all()
        finally:
            with self.cond:
                self._set(name, "gone")


def run_all(items: list[Any], work: Callable[[Any, str, str], Any],
            on_done: Callable[[Any, Any, str, float], None],
            endpoints: dict[str, str] | None = None,
            fits: Callable[[Any, str], bool] | None = None,
            **options: Any) -> tuple[list[str], list[Any]]:
    """Every item through the pool; returns (problems, items no server could take)."""
    pool = Pool(work, on_done, endpoints, fits, **options)
    pool.add(*items)
    problems = pool.join()
    return problems, pool.left


def map_ordered(items: list[Any], fn: Callable[[Any, str, str], Any],
                endpoints: dict[str, str] | None = None,
                fits: Callable[[Any, str], bool] | None = None,
                **options: Any) -> tuple[list[Any], list[str], list[Any]]:
    """fn(item, name, url) for every item through the pool. Returns (results, problems, left):
    results in input order, None where an item was left over. When fn raised for any item, the
    first such error in input order is raised once the pool has finished, as a serial loop would."""
    results: list[Any] = [None] * len(items)
    pool = Pool(lambda job, name, url: fn(job[1], name, url),
                lambda job, result, name, seconds: results.__setitem__(job[0], result),
                endpoints, (lambda job, name: fits(job[1], name)) if fits else None, **options)
    pool.add(*enumerate(items))
    problems = pool.join()
    if pool.failed:
        raise min(pool.failed, key=lambda failure: failure[0][0])[1]
    return results, problems, [job[1] for job in pool.left]
