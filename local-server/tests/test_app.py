"""Unit tests for validation and classification, plus HTTP integration tests
against a real ThreadingHTTPServer with a fake model (no torch needed)."""

from __future__ import annotations

import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

from quiet_feed_local.app import (
    MAX_BODY_BYTES,
    MAX_LABELS,
    MAX_TASKS,
    MAX_TEXT_CHARS,
    RequestError,
    check_result,
    classify,
    host_allowed,
    make_handler,
    origin_allowed,
    validate_request,
)

RAGE = {"labels": ["rage bait", "not rage bait"]}


class FakeModel:
    """Mimics GLiNER2 classify_text(include_confidence=True) for single-label tasks.
    `picks` maps task name -> (label, confidence); default is the last label at 0.9."""

    def __init__(self, picks=None, fail=False):
        self.picks = picks or {}
        self.fail = fail
        self.calls = []

    def classify_text(self, text, tasks, **kwargs):
        self.calls.append((text, tasks, kwargs))
        if self.fail:
            raise RuntimeError(f"model exploded on {text}")
        out = {}
        for name, labels in tasks.items():
            names = list(labels)
            label, conf = self.picks.get(name, (names[-1], 0.9))
            out[name] = {"label": label, "confidence": conf}
        return out


class ValidateRequestTests(unittest.TestCase):
    def test_accepts_label_lists_and_described_labels(self):
        text, tasks = validate_request(
            {"text": "a", "tasks": {"tone": RAGE, "quality": {"labels": {"generic filler": "d1", "specific content": "d2"}, "x": 1}}}
        )
        self.assertEqual(text, "a")
        self.assertEqual(tasks, {"tone": ["rage bait", "not rage bait"], "quality": {"generic filler": "d1", "specific content": "d2"}})

    def test_rejects_bad_shapes(self):
        bad = [
            None,
            [],
            {},
            {"text": "", "tasks": {"t": RAGE}},
            {"text": "  ", "tasks": {"t": RAGE}},
            {"text": 3, "tasks": {"t": RAGE}},
            {"text": "a", "tasks": {}},
            {"text": "a", "tasks": []},
            {"text": "a", "tasks": {"t": "labels"}},
            {"text": "a", "tasks": {"t": {"labels": "x"}}},
            {"text": "a", "tasks": {"t": {"labels": ["only one"]}}},
            {"text": "a", "tasks": {"t": {"labels": ["same", "same"]}}},
            {"text": "a", "tasks": {"t": {"labels": ["ok", ""]}}},
            {"text": "a", "tasks": {"t": {"labels": ["ok", 5]}}},
            {"text": "a", "tasks": {"t": {"labels": {"a": "desc", "b": ""}}}},
            {"text": "a", "tasks": {" ": RAGE}},
        ]
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(RequestError):
                validate_request(payload)

    def test_limits(self):
        validate_request({"text": "a" * MAX_TEXT_CHARS, "tasks": {"t": RAGE}})
        with self.assertRaises(RequestError):
            validate_request({"text": "a" * (MAX_TEXT_CHARS + 1), "tasks": {"t": RAGE}})
        validate_request({"text": "a", "tasks": {"t": {"labels": [f"l{i}" for i in range(MAX_LABELS)]}}})
        with self.assertRaises(RequestError):
            validate_request({"text": "a", "tasks": {"t": {"labels": [f"l{i}" for i in range(MAX_LABELS + 1)]}}})
        validate_request({"text": "a", "tasks": {f"t{i}": RAGE for i in range(MAX_TASKS)}})
        with self.assertRaises(RequestError):
            validate_request({"text": "a", "tasks": {f"t{i}": RAGE for i in range(MAX_TASKS + 1)}})
        with self.assertRaises(RequestError):
            validate_request({"text": "a", "tasks": {"t": {"labels": ["x" * 501, "y"]}}})


class ClassifyTests(unittest.TestCase):
    def test_check_result(self):
        labels = ["rage bait", "not rage bait"]
        self.assertEqual(check_result({"label": "rage bait", "confidence": 0.9}, labels), {"label": "rage bait", "confidence": 0.9})
        self.assertEqual(check_result({"label": "not rage bait", "confidence": 1}, labels)["confidence"], 1.0)
        self.assertEqual(check_result({"label": "a", "confidence": 0.5}, {"a": "d", "b": "e"})["label"], "a")
        for bad in [None, {}, {"label": "rage bait"}, {"confidence": 0.5}, {"label": "maybe", "confidence": 0.5},
                    {"label": "rage bait", "confidence": 1.2}, {"label": "rage bait", "confidence": -0.1}, "x"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                check_result(bad, labels)

    def test_each_task_runs_in_its_own_pass_with_confidence(self):
        model = FakeModel({"tone": ("rage bait", 0.93)})
        _, tasks = validate_request({"text": "t", "tasks": {"tone": RAGE, "quality": {"labels": {"generic filler": "d", "specific content": "e"}}}})
        results = classify(model, "post text", tasks, threading.Lock())
        self.assertEqual(results["tone"], {"label": "rage bait", "confidence": 0.93})
        self.assertEqual(results["quality"], {"label": "specific content", "confidence": 0.9})
        self.assertEqual([list(c[1]) for c in model.calls], [["tone"], ["quality"]])
        self.assertEqual(model.calls[1][1]["quality"], {"generic filler": "d", "specific content": "e"})
        self.assertTrue(all(c[0] == "post text" and c[2] == {"include_confidence": True} for c in model.calls))

    def test_classify_without_lock(self):
        self.assertEqual(classify(FakeModel(), "t", {"tone": ["a", "b"]})["tone"]["label"], "b")

    def test_missing_answer_is_an_error(self):
        class Silent(FakeModel):
            def classify_text(self, text, tasks, **kwargs):
                return {}

        with self.assertRaises(ValueError):
            classify(Silent(), "t", {"tone": ["a", "b"]})


class GuardTests(unittest.TestCase):
    def test_origin(self):
        self.assertTrue(origin_allowed("chrome-extension://abc", None))
        self.assertTrue(origin_allowed("chrome-extension://abc", "abc"))
        self.assertFalse(origin_allowed("chrome-extension://other", "abc"))
        self.assertFalse(origin_allowed("https://x.com", None))
        self.assertFalse(origin_allowed("null", None))
        self.assertFalse(origin_allowed(None, None))
        self.assertFalse(origin_allowed("", None))

    def test_host(self):
        self.assertTrue(host_allowed("127.0.0.1:8765", 8765))
        self.assertTrue(host_allowed("localhost:8765", 8765))
        self.assertFalse(host_allowed("evil.example:8765", 8765))
        self.assertFalse(host_allowed("127.0.0.1:9999", 8765))
        self.assertFalse(host_allowed("127.0.0.1", 8765))
        self.assertFalse(host_allowed(None, 8765))


class HttpIntegrationTests(unittest.TestCase):
    """Real HTTP round trips on an ephemeral port."""

    ORIGIN = "chrome-extension://quietfeedtestid"

    def start(self, model, extension_id=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), None)
        port = server.server_address[1]
        server.RequestHandlerClass = make_handler(model, port=port, extension_id=extension_id, model_id="test-model", device="mps")
        server.quiet = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return port

    def request(self, port, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        h = {"Host": host or f"127.0.0.1:{port}", "Origin": self.ORIGIN, "Content-Type": "application/json"}
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        conn.request(method, path, body=data, headers=h)
        res = conn.getresponse()
        payload = res.read()
        conn.close()
        return res.status, json.loads(payload), dict(res.getheaders())

    def test_health_reports_model_and_device_without_cors(self):
        port = self.start(FakeModel())
        status, body, headers = self.request(port, "GET", "/v1/health")
        self.assertEqual((status, body), (200, {"ok": True, "model": "test-model", "device": "mps"}))
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_health_allows_a_missing_origin_but_not_a_web_origin(self):
        port = self.start(FakeModel())
        self.assertEqual(self.request(port, "GET", "/v1/health", headers={"Origin": None})[0], 200)
        self.assertEqual(self.request(port, "GET", "/v1/health", headers={"Origin": "https://x.com"})[0], 403)

    def test_classify_round_trip(self):
        port = self.start(FakeModel({"tone": ("rage bait", 0.91)}))
        status, body, _ = self.request(port, "POST", "/v1/classify", {"text": "my text", "tasks": {"tone": RAGE, "other": {"labels": ["a", "b"]}}})
        self.assertEqual(status, 200)
        self.assertEqual(body["model"], "test-model")
        self.assertEqual(body["results"], {"tone": {"label": "rage bait", "confidence": 0.91}, "other": {"label": "b", "confidence": 0.9}})
        self.assertIsInstance(body["elapsed_ms"], int)

    def test_classify_needs_an_extension_origin_and_a_local_host(self):
        port = self.start(FakeModel())
        for headers, host in [({"Origin": "https://x.com"}, None), ({"Origin": None}, None), ({}, f"attacker.example:{port}")]:
            with self.subTest(headers=headers, host=host):
                status, _, _ = self.request(port, "POST", "/v1/classify", {"text": "t", "tasks": {"tone": RAGE}}, headers, host)
                self.assertEqual(status, 403)
        self.assertEqual(self.request(port, "GET", "/v1/health", host=f"attacker.example:{port}")[0], 403)

    def test_pinned_extension_id(self):
        port = self.start(FakeModel(), extension_id="quietfeedtestid")
        self.assertEqual(self.request(port, "POST", "/v1/classify", {"text": "t", "tasks": {"tone": RAGE}})[0], 200)
        status, _, _ = self.request(port, "POST", "/v1/classify", {"text": "t", "tasks": {"tone": RAGE}}, {"Origin": "chrome-extension://someoneelse"})
        self.assertEqual(status, 403)

    def test_bad_requests(self):
        port = self.start(FakeModel())
        ok_body = {"text": "t", "tasks": {"tone": RAGE}}
        self.assertEqual(self.request(port, "POST", "/v1/classify", ok_body, {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request(port, "POST", "/v1/classify", b"{not json")[0], 400)
        self.assertEqual(self.request(port, "POST", "/v1/classify", {"text": "t", "tasks": {}})[0], 400)
        self.assertEqual(self.request(port, "POST", "/v1/classify", b"x" * (MAX_BODY_BYTES + 1))[0], 413)
        self.assertEqual(self.request(port, "POST", "/v1/other", ok_body)[0], 404)
        self.assertEqual(self.request(port, "GET", "/v1/classify")[0], 404)
        self.assertEqual(self.request(port, "OPTIONS", "/v1/classify")[0], 405)

    def test_model_failure_is_a_500_without_post_text(self):
        port = self.start(FakeModel(fail=True))
        status, body, _ = self.request(port, "POST", "/v1/classify", {"text": "secret post text", "tasks": {"tone": RAGE}})
        self.assertEqual(status, 500)
        self.assertNotIn("secret", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
