"""Request validation, classification, and the HTTP handler.

The extension sends one post text and a few classification tasks. Each task has
a name and two or more labels, optionally with a description per label; the
task name and label names carry the question, as GLiNER2 expects. Each task
runs in its own forward pass: asking several at once let the answers bleed into
each other in testing. The response gives each task's winning label and its
confidence, exactly as GLiNER2's classify_text(include_confidence=True) reports
them; the extension turns those into probabilities.

Only the Quiet Feed extension should be able to classify through this server:
  * it listens on 127.0.0.1 only;
  * the Host header must name 127.0.0.1 or localhost on our port (blocks DNS rebinding);
  * POST requests need a chrome-extension:// Origin, which web pages cannot forge,
    optionally pinned to one extension id; the health check also accepts no
    Origin, and reveals only the model name and device;
  * the body must be JSON with Content-Type application/json;
  * no CORS headers are sent, so web pages cannot read responses.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler
from typing import Any, Protocol

MODEL_ID = "fastino/GLiNER2.5-Decide"

MAX_BODY_BYTES = 64 * 1024
MAX_TASKS = 16
MAX_LABELS = 8
MAX_TEXT_CHARS = 4000
MAX_FIELD_CHARS = 500


class RequestError(ValueError):
    """The request is malformed; reported to the caller as HTTP 400."""


class Classifier(Protocol):
    def classify_text(self, text: str, tasks: dict, **kwargs: Any) -> dict: ...


def _string(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str):
        raise RequestError(f"{name} must be a string")
    if not value.strip():
        raise RequestError(f"{name} must not be empty")
    if len(value) > limit:
        raise RequestError(f"{name} is longer than {limit} characters")
    return value


def _labels(value: Any, name: str) -> list[str] | dict[str, str]:
    """Labels are a list of names, or a map of name to description."""
    if isinstance(value, list):
        labels = [_string(v, f"{name} label", MAX_FIELD_CHARS) for v in value]
        out: list[str] | dict[str, str] = labels
    elif isinstance(value, dict):
        labels = [_string(k, f"{name} label", MAX_FIELD_CHARS) for k in value]
        out = {k: _string(v, f"{name} description for {k!r}", MAX_FIELD_CHARS) for k, v in value.items()}
    else:
        raise RequestError(f"{name} labels must be a list or an object")
    if not 2 <= len(labels) <= MAX_LABELS:
        raise RequestError(f"{name} needs 2 to {MAX_LABELS} labels")
    if len(set(labels)) != len(labels):
        raise RequestError(f"{name} labels must be unique")
    return out


def validate_request(payload: Any) -> tuple[str, dict[str, list[str] | dict[str, str]]]:
    """Return (text, {task name: labels}), or raise RequestError."""
    if not isinstance(payload, dict):
        raise RequestError("body must be a JSON object")
    text = _string(payload.get("text"), "text", MAX_TEXT_CHARS)
    tasks = payload.get("tasks")
    if not isinstance(tasks, dict) or not tasks:
        raise RequestError("tasks must be a non-empty object")
    if len(tasks) > MAX_TASKS:
        raise RequestError(f"at most {MAX_TASKS} tasks per request")
    out = {}
    for name, task in tasks.items():
        _string(name, "task name", MAX_FIELD_CHARS)
        if not isinstance(task, dict):
            raise RequestError(f"task {name!r} must be an object")
        out[name] = _labels(task.get("labels"), f"task {name!r}")
    return text, out


def check_result(result: Any, labels: list[str] | dict[str, str]) -> dict:
    """Validate one formatted single-label result: {"label": ..., "confidence": ...}."""
    if not isinstance(result, dict) or "label" not in result or "confidence" not in result:
        raise ValueError(f"unexpected classification result: {result!r}")
    confidence = float(result["confidence"])
    if not 0.0 <= confidence <= 1.0:
        raise ValueError(f"confidence out of range: {confidence}")
    if result["label"] not in labels:
        raise ValueError(f"unexpected label: {result['label']!r}")
    return {"label": result["label"], "confidence": confidence}


def classify(model: Classifier, text: str, tasks: dict, lock: threading.Lock | None = None) -> dict[str, dict]:
    """Run each task in its own pass; the model is not thread-safe, so hold the lock."""
    results = {}
    for name, labels in tasks.items():
        if lock:
            with lock:
                raw = model.classify_text(text, {name: labels}, include_confidence=True)
        else:
            raw = model.classify_text(text, {name: labels}, include_confidence=True)
        results[name] = check_result(raw.get(name), labels)
    return results


def origin_allowed(origin: str | None, extension_id: str | None) -> bool:
    if not origin or not origin.startswith("chrome-extension://"):
        return False
    return extension_id is None or origin == f"chrome-extension://{extension_id}"


def host_allowed(host: str | None, port: int) -> bool:
    return host in (f"127.0.0.1:{port}", f"localhost:{port}")


def make_handler(
    model: Classifier,
    *,
    port: int,
    extension_id: str | None = None,
    model_id: str = MODEL_ID,
    device: str = "cpu",
):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "QuietFeedLocal/0.2"

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _guard(self, *, allow_missing_origin: bool) -> bool:
            if not host_allowed(self.headers.get("Host"), port):
                self._send(403, {"error": "host not allowed"})
                return False
            origin = self.headers.get("Origin")
            if origin is None and allow_missing_origin:
                return True
            if not origin_allowed(origin, extension_id):
                self._send(403, {"error": "origin not allowed"})
                return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            if not self._guard(allow_missing_origin=True):
                return
            if self.path != "/v1/health":
                self._send(404, {"error": "not found"})
                return
            self._send(200, {"ok": True, "model": model_id, "device": device})

        def do_POST(self) -> None:  # noqa: N802
            if not self._guard(allow_missing_origin=False):
                return
            if self.path != "/v1/classify":
                self._send(404, {"error": "not found"})
                return
            if self.headers.get_content_type() != "application/json":
                self._send(415, {"error": "Content-Type must be application/json"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send(413, {"error": f"body must be 1 to {MAX_BODY_BYTES} bytes"})
                return
            try:
                text, tasks = validate_request(json.loads(self.rfile.read(length)))
            except (RequestError, json.JSONDecodeError, UnicodeDecodeError) as err:
                self._send(400, {"error": str(err)})
                return
            started = time.perf_counter()
            try:
                results = classify(model, text, tasks, lock)
            except Exception:  # noqa: BLE001 - report failure without echoing post text
                self._send(500, {"error": "classification failed"})
                return
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            self._send(200, {"model": model_id, "results": results, "elapsed_ms": elapsed_ms})

        def do_OPTIONS(self) -> None:  # noqa: N802
            self._send(405, {"error": "method not allowed"})

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Request lines only; bodies (post text) are never logged.
            if self.server and getattr(self.server, "quiet", False):
                return
            super().log_message(format, *args)

    return Handler
