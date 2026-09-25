"""Tests for the command-line entry point and remaining handler paths, with the
model libraries replaced by stand-ins so no torch or model download is needed."""

from __future__ import annotations

import http.client
import io
import json
import sys
import threading
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import ThreadingHTTPServer
from unittest import mock

from quiet_feed_local import __main__ as cli
from quiet_feed_local.app import make_handler

from .test_app import RAGE, FakeModel


def fake_torch(mps=False, cuda=False):
    torch = types.ModuleType("torch")
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps))
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    return torch


class PickDeviceTests(unittest.TestCase):
    def test_auto_prefers_apple_gpu_then_cuda_then_cpu(self):
        cases = [((True, True), "mps"), ((False, True), "cuda"), ((False, False), "cpu")]
        for (mps, cuda), expected in cases:
            with self.subTest(mps=mps, cuda=cuda), mock.patch.dict(sys.modules, {"torch": fake_torch(mps, cuda)}):
                self.assertEqual(cli.pick_device("auto"), expected)

    def test_explicit_device_is_used_as_given(self):
        with mock.patch.dict(sys.modules, {"torch": fake_torch(mps=True)}):
            self.assertEqual(cli.pick_device("cpu"), "cpu")
            self.assertEqual(cli.pick_device("cuda"), "cuda")


class StubModel(FakeModel):
    def __init__(self):
        super().__init__()
        self.device = None

    def to(self, device):
        self.device = device
        return self


class StubServer:
    """Records how main() builds the server; serve_forever ends at once like Ctrl-C."""

    instances: list = []

    def __init__(self, address, handler):
        self.address = address
        self.handler = handler
        self.quiet = None
        self.closed = False
        StubServer.instances.append(self)

    def serve_forever(self):
        raise KeyboardInterrupt

    def server_close(self):
        self.closed = True


class MainTests(unittest.TestCase):
    def run_main(self, argv, *, mps=True):
        model = StubModel()
        loaded = []
        gliner2 = types.ModuleType("gliner2")
        gliner2.AutoExtractor = types.SimpleNamespace(from_pretrained=lambda name: (loaded.append(name), model)[1])
        StubServer.instances = []
        out = io.StringIO()
        with mock.patch.dict(sys.modules, {"gliner2": gliner2, "torch": fake_torch(mps=mps)}), \
                mock.patch.object(cli, "ThreadingHTTPServer", StubServer), \
                mock.patch.object(cli, "make_handler", wraps=make_handler) as handler, \
                redirect_stdout(out):
            cli.main(argv)
        return model, loaded, StubServer.instances[0], handler, out.getvalue()

    def test_defaults_load_the_decide_model_on_the_gpu_and_listen_on_loopback(self):
        model, loaded, server, handler, out = self.run_main([])
        self.assertEqual(loaded, ["fastino/GLiNER2.5-Decide"])
        self.assertEqual(model.device, "mps")
        self.assertEqual(server.address, ("127.0.0.1", 8765))
        self.assertFalse(server.quiet)
        self.assertTrue(server.closed)
        kwargs = handler.call_args.kwargs
        self.assertEqual((kwargs["port"], kwargs["extension_id"], kwargs["model_id"], kwargs["device"]), (8765, None, "fastino/GLiNER2.5-Decide", "mps"))
        self.assertIn("ready on http://127.0.0.1:8765", out)

    def test_options_are_passed_through(self):
        model, loaded, server, handler, _ = self.run_main(
            ["--port", "9001", "--model", "/models/decide", "--device", "cpu", "--extension-id", "abc", "--quiet"]
        )
        self.assertEqual(loaded, ["/models/decide"])
        self.assertEqual(model.device, "cpu")
        self.assertEqual(server.address, ("127.0.0.1", 9001))
        self.assertTrue(server.quiet)
        kwargs = handler.call_args.kwargs
        self.assertEqual((kwargs["port"], kwargs["extension_id"], kwargs["model_id"], kwargs["device"]), (9001, "abc", "/models/decide", "cpu"))

    def test_cpu_fallback_without_a_gpu(self):
        model, *_ = self.run_main([], mps=False)
        self.assertEqual(model.device, "cpu")


class HandlerEdgeTests(unittest.TestCase):
    ORIGIN = "chrome-extension://quietfeedtestid"

    def start(self, *, quiet=True, extension_id=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), None)
        port = server.server_address[1]
        server.RequestHandlerClass = make_handler(FakeModel(), port=port, extension_id=extension_id)
        server.quiet = quiet
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return port

    def raw(self, port, method, path, headers, body=b""):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in headers.items():
            conn.putheader(k, v)
        conn.endheaders(body or None)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, json.loads(data)

    def test_non_numeric_content_length_is_rejected(self):
        port = self.start()
        headers = {"Host": f"127.0.0.1:{port}", "Origin": self.ORIGIN, "Content-Type": "application/json", "Content-Length": "abc"}
        self.assertEqual(self.raw(port, "POST", "/v1/classify", headers)[0], 413)

    def test_localhost_host_header_is_accepted(self):
        port = self.start()
        body = json.dumps({"text": "t", "tasks": {"tone": RAGE}}).encode()
        headers = {"Host": f"localhost:{port}", "Origin": self.ORIGIN, "Content-Type": "application/json", "Content-Length": str(len(body))}
        self.assertEqual(self.raw(port, "POST", "/v1/classify", headers, body)[0], 200)

    def test_pinned_id_also_guards_health(self):
        port = self.start(extension_id="quietfeedtestid")
        base = {"Host": f"127.0.0.1:{port}"}
        self.assertEqual(self.raw(port, "GET", "/v1/health", {**base, "Origin": self.ORIGIN})[0], 200)
        self.assertEqual(self.raw(port, "GET", "/v1/health", {**base, "Origin": "chrome-extension://other"})[0], 403)

    def test_request_lines_are_logged_unless_quiet_and_never_include_post_text(self):
        body = json.dumps({"text": "secret post text", "tasks": {"tone": RAGE}}).encode()
        for quiet in (False, True):
            port = self.start(quiet=quiet)
            headers = {"Host": f"127.0.0.1:{port}", "Origin": self.ORIGIN, "Content-Type": "application/json", "Content-Length": str(len(body))}
            err = io.StringIO()
            with redirect_stderr(err):
                self.raw(port, "POST", "/v1/classify", headers, body)
            log = err.getvalue()
            with self.subTest(quiet=quiet):
                self.assertNotIn("secret", log)
                if quiet:
                    self.assertEqual(log, "")
                else:
                    self.assertIn('"POST /v1/classify HTTP/1.1" 200', log)


if __name__ == "__main__":
    unittest.main()
