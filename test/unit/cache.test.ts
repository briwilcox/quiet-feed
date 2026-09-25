import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_TTL_MS, cacheGet, cacheKey, cachePrune, cachePut } from "../../src/background/cache.ts";
import type { JevRequest } from "../../src/background/jev.ts";
import { installChrome } from "../helpers/chrome-stub.ts";

const body = (text: string, extra: Partial<JevRequest> = {}): JevRequest => ({
  model: "jev-latest",
  state: { post: { text } },
  questions: { rage_bait: { type: "noul", instructions: { q: "?" }, criteria: { true: "y", false: "n" } } },
  ...extra,
});

test("cache key is stable for the same input and changes with post, questions, model, or prompt version", async () => {
  const k = await cacheKey(body("hello"), "v1");
  assert.match(k, /^cache:[0-9a-f]{64}$/);
  assert.equal(await cacheKey(body("hello"), "v1"), k);
  assert.notEqual(await cacheKey(body("hello!"), "v1"), k);
  assert.notEqual(await cacheKey(body("hello"), "v2"), k);
  assert.notEqual(await cacheKey(body("hello", { model: "jev-1.2.3" }), "v1"), k);
  assert.notEqual(await cacheKey(body("hello", { questions: {} }), "v1"), k);
});

test("entries expire after the TTL and are removed on read", async () => {
  const { chrome } = installChrome();
  await cachePut("cache:a", { probabilities: { x: 0.5 }, model: "m" }, 1000);
  assert.deepEqual((await cacheGet("cache:a", 1000 + CACHE_TTL_MS - 1))?.probabilities, { x: 0.5 });
  assert.equal(await cacheGet("cache:a", 1000 + CACHE_TTL_MS), null);
  assert.equal(chrome.storage.local.data.has("cache:a"), false);
  assert.equal(await cacheGet("cache:missing"), null);
});

test("prune removes only expired cache entries, or all of them when asked", async () => {
  const { chrome } = installChrome();
  await chrome.storage.local.set({ settings: { keep: true }, usage: { keep: true } });
  await cachePut("cache:old", { probabilities: {}, model: "m" }, 0);
  await cachePut("cache:new", { probabilities: {}, model: "m" }, 10 * CACHE_TTL_MS);
  await cachePrune({ now: 5 * CACHE_TTL_MS });
  assert.deepEqual([...chrome.storage.local.data.keys()].sort(), ["cache:new", "settings", "usage"]);
  await cachePrune({ all: true, now: 0 });
  assert.deepEqual([...chrome.storage.local.data.keys()].sort(), ["settings", "usage"]);
});

test("prune with nothing stale does not write", async () => {
  const { chrome } = installChrome();
  let writes = 0;
  chrome.storage.onChanged.addListener(() => writes++);
  await cachePrune({ now: 0 });
  assert.equal(writes, 0);
});

test("entries live exactly 24 hours", async () => {
  installChrome();
  const day = 24 * 60 * 60 * 1000;
  await cachePut("cache:d", { probabilities: {}, model: "m" }, 0);
  assert.notEqual(await cacheGet("cache:d", day - 1), null);
  assert.equal(await cacheGet("cache:d", day), null);
});

test("prune treats an entry expiring exactly now as stale", async () => {
  const { chrome } = installChrome();
  await cachePut("cache:edge", { probabilities: {}, model: "m" }, 0);
  await cachePrune({ now: CACHE_TTL_MS });
  assert.equal(chrome.storage.local.data.has("cache:edge"), false);
});
