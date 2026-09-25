"""The HTTP contract the extension relies on: exact limits, boundaries, and one
response per request. Limits are written as literals on purpose: they are part of
the protocol with the extension (src/background/local.ts), not internal tuning."""

from __future__ import annotations

import json
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

from quiet_feed_local.app import RequestError, check_result, classify, make_handler, validate_request

from .test_app import RAGE, FakeModel

ORIGIN = "chrome-extension://quietfeedtestid"


class SlowModel(FakeModel):
    def classify_text(self, text, tasks, **kwargs):
        time.sleep(0.05)
        return super().classify_text(text, tasks, **kwargs)


def start(test, model=None, **kwargs):
    server = ThreadingHTTPServer(("127.0.0.1", 0), None)
    port = server.server_address[1]
    server.RequestHandlerClass = make_handler(model or FakeModel(), port=port, **kwargs)
    server.quiet = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    test.addCleanup(server.server_close)
    test.addCleanup(server.shutdown)
    return port


def exchange(port, request: bytes) -> bytes:
    """Send one raw request and read everything the server writes until it closes."""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(request)
        chunks = []
        while True:
            data = s.recv(65536)
            if not data:
                break
            chunks.append(data)
    return b"".join(chunks)


def http_request(port, method, path, *, host=None, origin=ORIGIN, content_type="application/json", body=b"", length=None):
    lines = [f"{method} {path} HTTP/1.1", f"Host: {host or f'127.0.0.1:{port}'}", "Connection: close"]
    if origin is not None:
        lines.append(f"Origin: {origin}")
    if content_type is not None:
        lines.append(f"Content-Type: {content_type}")
    if length is not None or body:
        lines.append(f"Content-Length: {len(body) if length is None else length}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode() + body


def status_lines(raw: bytes) -> list[str]:
    """Every HTTP status line in the stream, including one glued to the end of a previous body."""
    import re

    return re.findall(r"HTTP/1\.[01] \d{3} [^\r\n]*", raw.decode(errors="replace"))


class OneResponseTests(unittest.TestCase):
    """After rejecting a request the handler must stop, not write a second response."""

    def test_every_outcome_writes_exactly_one_response(self):
        port = start(self)
        ok = json.dumps({"text": "t", "tasks": {"tone": RAGE}}).encode()
        cases = {
            "health ok": (http_request(port, "GET", "/v1/health"), "200"),
            "health bad host": (http_request(port, "GET", "/v1/health", host="evil.example"), "403"),
            "health web origin": (http_request(port, "GET", "/v1/health", origin="https://x.com"), "403"),
            "get unknown path": (http_request(port, "GET", "/v1/other"), "404"),
            "post ok": (http_request(port, "POST", "/v1/classify", body=ok), "200"),
            "post bad host": (http_request(port, "POST", "/v1/classify", host="evil.example", body=ok), "403"),
            "post no origin": (http_request(port, "POST", "/v1/classify", origin=None, body=ok), "403"),
            "post unknown path": (http_request(port, "POST", "/v1/other", body=ok), "404"),
            "post wrong type": (http_request(port, "POST", "/v1/classify", content_type="text/plain", body=ok), "415"),
            "post empty": (http_request(port, "POST", "/v1/classify", length=0), "413"),
            "post bad json": (http_request(port, "POST", "/v1/classify", body=b"{nope"), "400"),
        }
        for name, (request, code) in cases.items():
            with self.subTest(name):
                lines = status_lines(exchange(port, request))
                self.assertEqual(len(lines), 1, f"{name}: {lines}")
                self.assertIn(f" {code} ", lines[0] + " ")

    def test_model_failure_writes_exactly_one_500(self):
        port = start(self, FakeModel(fail=True))
        body = json.dumps({"text": "t", "tasks": {"tone": RAGE}}).encode()
        lines = status_lines(exchange(port, http_request(port, "POST", "/v1/classify", body=body)))
        self.assertEqual(len(lines), 1)
        self.assertIn(" 500 ", lines[0] + " ")


class LimitContractTests(unittest.TestCase):
    def task(self, n_labels=2):
        return {"labels": [f"label {i}" for i in range(n_labels)]}

    def test_text_up_to_4000_characters(self):
        validate_request({"text": "a" * 4000, "tasks": {"t": RAGE}})
        with self.assertRaises(RequestError):
            validate_request({"text": "a" * 4001, "tasks": {"t": RAGE}})

    def test_up_to_16_tasks(self):
        validate_request({"text": "a", "tasks": {f"t{i}": RAGE for i in range(16)}})
        with self.assertRaises(RequestError):
            validate_request({"text": "a", "tasks": {f"t{i}": RAGE for i in range(17)}})

    def test_2_to_8_labels(self):
        for n in (2, 8):
            validate_request({"text": "a", "tasks": {"t": self.task(n)}})
        for n in (1, 9):
            with self.subTest(n=n), self.assertRaises(RequestError):
                validate_request({"text": "a", "tasks": {"t": self.task(n)}})

    def test_labels_and_names_up_to_500_characters(self):
        validate_request({"text": "a", "tasks": {"n" * 500: {"labels": ["x" * 500, "y"]}}})
        for payload in (
            {"text": "a", "tasks": {"n" * 501: RAGE}},
            {"text": "a", "tasks": {"t": {"labels": ["x" * 501, "y"]}}},
            {"text": "a", "tasks": {"t": {"labels": {"x": "d" * 501, "y": "e"}}}},
        ):
            with self.assertRaises(RequestError):
                validate_request(payload)

    def test_body_up_to_64_kib(self):
        port = start(self)
        exactly = b" " * 65536  # the right size but not JSON: gets past the size check, then fails parsing
        self.assertIn(" 400 ", status_lines(exchange(port, http_request(port, "POST", "/v1/classify", body=exactly)))[0] + " ")
        # Declared too large: rejected from the header alone, before any body is read.
        over = http_request(port, "POST", "/v1/classify", length=65537)
        self.assertIn(" 413 ", status_lines(exchange(port, over))[0] + " ")
        one = b"x"
        self.assertIn(" 400 ", status_lines(exchange(port, http_request(port, "POST", "/v1/classify", body=one)))[0] + " ")


class BoundaryTests(unittest.TestCase):
    def test_confidence_bounds_are_inclusive(self):
        labels = ["a", "b"]
        self.assertEqual(check_result({"label": "a", "confidence": 0.0}, labels)["confidence"], 0.0)
        self.assertEqual(check_result({"label": "a", "confidence": 0.05}, labels)["confidence"], 0.05)
        self.assertEqual(check_result({"label": "a", "confidence": 1.0}, labels)["confidence"], 1.0)

    def test_classify_asks_for_confidence_with_or_without_a_lock(self):
        for lock in (None, threading.Lock()):
            model = FakeModel()
            classify(model, "t", {"tone": ["a", "b"]}, lock)
            self.assertEqual(model.calls[0][2], {"include_confidence": True})

    def test_elapsed_time_is_reported_in_milliseconds(self):
        port = start(self, SlowModel())
        body = json.dumps({"text": "t", "tasks": {"tone": RAGE}}).encode()
        raw = exchange(port, http_request(port, "POST", "/v1/classify", body=body)).decode()
        elapsed = json.loads(raw.split("\r\n\r\n", 1)[1])["elapsed_ms"]
        self.assertGreaterEqual(elapsed, 40)
        self.assertLess(elapsed, 5000)

    def test_a_server_without_a_quiet_setting_logs(self):
        import io
        from contextlib import redirect_stderr

        server = ThreadingHTTPServer(("127.0.0.1", 0), None)
        port = server.server_address[1]
        server.RequestHandlerClass = make_handler(FakeModel(), port=port)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        err = io.StringIO()
        with redirect_stderr(err):
            exchange(port, http_request(port, "GET", "/v1/health"))
        self.assertIn('"GET /v1/health HTTP/1.1" 200', err.getvalue())


if __name__ == "__main__":
    unittest.main()
