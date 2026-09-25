import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILD_ID } from "../../src/shared/build.ts";
import { describeModel, localModelReady, STALE_WORKER_MESSAGE, workerIsStale } from "../../src/shared/format.ts";

test("unbuilt code reports the dev build id", () => {
  assert.equal(BUILD_ID, "dev");
});

test("a worker is stale when its build id differs or is missing", () => {
  assert.equal(workerIsStale("2026-09-25T12:00:00Z", "2026-09-25T12:00:00Z"), false);
  assert.equal(workerIsStale("2026-09-24T01:00:00Z", "2026-09-25T12:00:00Z"), true);
  assert.equal(workerIsStale(undefined, "2026-09-25T12:00:00Z"), true, "workers older than build ids send none");
  assert.match(STALE_WORKER_MESSAGE, /reload icon on Quiet Feed/);
});

test("only an ok answer for the local provider that names a device proves the local model", () => {
  const ok = { state: "ok" as const, model: "fastino/GLiNER2.5-Decide", device: "mps", provider: "local" as const, checkedAt: 1 };
  assert.equal(localModelReady(ok), true);
  // What an out-of-date worker sends: it tested Jev instead.
  assert.equal(localModelReady({ state: "ok", model: "jev-1.13.0", checkedAt: 1 }), false);
  assert.equal(localModelReady({ ...ok, provider: "jev" }), false);
  assert.equal(localModelReady({ ...ok, provider: undefined }), false);
  assert.equal(localModelReady({ ...ok, device: undefined }), false);
  assert.equal(localModelReady({ ...ok, device: "" }), false);
  assert.equal(localModelReady({ state: "error", message: "x", provider: "local", checkedAt: 1 }), false);
  assert.equal(localModelReady({ state: "untested" }), false);
  assert.equal(localModelReady({ state: "no_key" }), false);
});

test("describeModel", () => {
  assert.equal(describeModel({ state: "ok", model: "m", device: "cpu", checkedAt: 1 }), "m on cpu");
  assert.equal(describeModel({ state: "ok", model: "m", device: "", checkedAt: 1 }), "m");
});
