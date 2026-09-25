import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCAL_ENDPOINT,
  LOCAL_MAX_TASKS,
  LocalError,
  buildLocalRequest,
  callLocal,
  checkHealth,
  normalizeEndpoint,
  positiveProbability,
  type LocalRequest,
} from "../../src/background/local.ts";
import { describeModel } from "../../src/shared/format.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { PostPayload, Settings } from "../../src/shared/types.ts";

const post = (over: Partial<PostPayload> = {}): PostPayload => ({
  statusId: "1",
  authorHandle: "a",
  text: "my own words",
  quotedText: null,
  mediaLabels: [],
  hasVideo: false,
  textTruncated: false,
  ...over,
});
const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  backend: "local",
  filters: { rage_bait: true, llm_slop: true, ai_video_slop: true },
  ...over,
});
const topic = (over = {}) => ({ id: "t", name: "Crypto prices", description: "ignored", exceptions: "", enabled: true, ...over });
const RAGE_LABELS = ["rage bait", "not rage bait"];

/** A fake local server: answers each task with P(positive) from `p` (by rule id), default 0.1. */
function fakeServer(req: LocalRequest, p: Record<string, number> = {}, status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, init, body });
    if (status !== 200) return new Response("", { status });
    const item = req.items.find((i) => i.text === body.text)!;
    const results: Record<string, { label: string; confidence: number }> = {};
    for (const [name, t] of Object.entries(item.tasks)) {
      const names = Array.isArray(t.labels) ? t.labels : Object.keys(t.labels);
      const q = p[t.ruleIds[0]] ?? 0.1;
      const negative = names.find((n) => n !== t.positive)!;
      results[name] = q >= 0.5 ? { label: t.positive, confidence: q } : { label: negative, confidence: 1 - q };
    }
    return Response.json({ model: "fastino/GLiNER2.5-Decide", results, elapsed_ms: 80 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("own-text questions share one item; the quote and topics get their own texts", () => {
  const { body, rules } = buildLocalRequest(post({ quotedText: "  the quote  " }), settings({ topics: [topic()] }));
  assert.deepEqual(body.items.map((i) => [i.text, Object.keys(i.tasks)]), [
    ["my own words", ["tone", "quality"]],
    ["the quote", ["tone"]],
    ["my own words\n[Quoted post] the quote", ["topic: Crypto prices"]],
  ]);
  assert.deepEqual(body.items[0].tasks.tone, { labels: RAGE_LABELS, positive: "rage bait", ruleIds: ["rage_bait"] });
  assert.deepEqual(body.items[1].tasks.tone.ruleIds, ["rage_bait_quoted"]);
  assert.deepEqual(body.items[0].tasks.quality, {
    labels: {
      "generic filler": "template-like motivational or listicle writing with no specifics",
      "specific content": "concrete facts, personal experience, or a real argument, or casual chat",
    },
    positive: "generic filler",
    ruleIds: ["llm_slop"],
  });
  assert.deepEqual(rules.map((r) => [r.ruleId, r.threshold]), [
    ["rage_bait", 0.8],
    ["rage_bait_quoted", 0.8],
    ["llm_slop", 0.8],
    ["topic:t", 0.7],
  ]);
});

test("without a quote, topics join the own-text item; exceptions compete as a label", () => {
  const { body } = buildLocalRequest(post(), settings({ topics: [topic({ exceptions: " research " })] }));
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.items[0].tasks["topic: Crypto prices"], {
    labels: ["Crypto prices", "research", "other topic"],
    positive: "Crypto prices",
    ruleIds: ["topic:t"],
  });
});

test("video, quote-only, disabled, and empty cases", () => {
  const video = buildLocalRequest(post({ hasVideo: true, mediaLabels: ["AI-generated"] }), settings()).body.items[0];
  assert.equal(video.text, "my own words\n[Media: AI-generated]\n[Video attached]");
  assert.deepEqual(video.tasks.video, { labels: ["low-value AI-generated video", "other video"], positive: "low-value AI-generated video", ruleIds: ["ai_video_slop"] });

  const quoteOnly = buildLocalRequest(post({ text: " ", quotedText: "q" }), settings());
  assert.deepEqual(quoteOnly.body.items.map((i) => [i.text, Object.keys(i.tasks)]), [["q", ["tone"]]]);

  const off = settings({ filters: { rage_bait: false, llm_slop: false, ai_video_slop: false }, topics: [topic({ enabled: false }), topic({ id: "b", name: " " })] });
  assert.deepEqual(buildLocalRequest(post({ quotedText: "q", hasVideo: true }), off), { body: { items: [] }, rules: [] });
  assert.deepEqual(buildLocalRequest(post({ text: "" }), settings({ topics: [topic()] })).body.items, []);
});

test("thresholds come from the local table", () => {
  const t = (sensitivity: Settings["sensitivity"]) =>
    buildLocalRequest(post({ hasVideo: true }), settings({ sensitivity, topics: [topic()] })).rules.map((r) => r.threshold);
  assert.deepEqual(t("conservative"), [0.92, 0.93, 0.9, 0.88]);
  assert.deepEqual(t("balanced"), [0.8, 0.8, 0.8, 0.7]);
  assert.deepEqual(t("aggressive"), [0.65, 0.65, 0.7, 0.55]);
});

test("the endpoint must be plain http on this machine", () => {
  assert.equal(normalizeEndpoint(DEFAULT_LOCAL_ENDPOINT), "http://127.0.0.1:8765");
  assert.equal(normalizeEndpoint(" http://localhost:9000/ "), "http://localhost:9000");
  assert.equal(normalizeEndpoint("http://127.0.0.1"), "http://127.0.0.1");
  for (const bad of [
    "https://127.0.0.1:8765",
    "http://example.com:8765",
    "http://127.0.0.2:8765",
    "http://user:pw@127.0.0.1:8765",
    "http://user@127.0.0.1:8765",
    "http://:pw@127.0.0.1:8765",
    "http://127.0.0.1:8765/api",
    "http://127.0.0.1:8765/?x=1",
    "http://127.0.0.1:8765/#x",
    "not a url",
    "",
  ]) {
    assert.equal(normalizeEndpoint(bad), null, bad);
  }
});

test("positiveProbability handles two-label, many-label, and bad answers", () => {
  const two = { labels: RAGE_LABELS, positive: "rage bait" };
  assert.equal(positiveProbability(two, "rage bait", 0.9), 0.9);
  assert.ok(Math.abs(positiveProbability(two, "not rage bait", 0.9) - 0.1) < 1e-9);
  assert.equal(positiveProbability(two, "rage bait", 0), 0);
  assert.equal(positiveProbability(two, "not rage bait", 1), 0);
  const described = { labels: { yes: "d", no: "e" }, positive: "yes" };
  assert.equal(positiveProbability(described, "no", 0.75), 0.25);
  const three = { labels: ["x", "exception", "other"], positive: "x" };
  assert.equal(positiveProbability(three, "x", 0.6), 0.6);
  assert.equal(positiveProbability(three, "exception", 0.6), 0);
  for (const [label, conf] of [["maybe", 0.5], [3, 0.5], ["rage bait", 1.2], ["rage bait", -0.1], ["rage bait", "0.5"], ["rage bait", undefined]] as const) {
    assert.throws(() => positiveProbability(two, label, conf), LocalError, `${label}/${conf}`);
  }
});

test("callLocal posts each item's labels to /v1/classify and maps answers to rules", async () => {
  const { body } = buildLocalRequest(post({ quotedText: "quote" }), settings({ topics: [topic()] }));
  const { calls, impl } = fakeServer(body, { rage_bait: 0.2, rage_bait_quoted: 0.95, llm_slop: 0.85, "topic:t": 0.7 });
  const r = await callLocal("http://localhost:8765/", body, { fetchImpl: impl });
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, "http://localhost:8765/v1/classify");
    assert.equal(c.init.method, "POST");
    assert.deepEqual(c.init.headers, { "Content-Type": "application/json" });
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(calls[0].body, {
    text: "my own words",
    tasks: {
      tone: { labels: RAGE_LABELS },
      quality: { labels: body.items[0].tasks.quality.labels },
    },
  });
  assert.equal(r.model, "fastino/GLiNER2.5-Decide");
  assert.equal(r.refused, false);
  assert.deepEqual(r.usage, { input_tokens: 0, output_tokens: 0 });
  const rounded = Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  assert.deepEqual(rounded, { rage_bait: 0.2, llm_slop: 0.85, rage_bait_quoted: 0.95, "topic:t": 0.7 });
});

test("callLocal fails clearly: bad endpoint, unreachable, HTTP errors, malformed replies", async () => {
  const { body } = buildLocalRequest(post(), settings());
  await assert.rejects(callLocal("https://evil.example", body), /must be http:\/\/127\.0\.0\.1/);
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: down }), (e: LocalError) => e.status === null && /not reachable/.test(e.message));
  await assert.rejects(callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: fakeServer(body, {}, 403).impl }), (e: LocalError) => e.status === 403 && /HTTP 403/.test(e.message));
  const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: notJson }), /malformed response/);
  for (const reply of [null, {}, { model: 3, results: {} }, { model: "m" }, { model: "m", results: null }]) {
    const f = (async () => Response.json(reply)) as unknown as typeof fetch;
    await assert.rejects(callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: f }), /malformed response/, JSON.stringify(reply));
  }
  const missing = (async () => Response.json({ model: "m", results: {} })) as unknown as typeof fetch;
  await assert.rejects(callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: missing }), /invalid confidence/);
});

test("requests time out instead of hanging", async () => {
  const { body } = buildLocalRequest(post(), settings());
  const hang = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  await assert.rejects(callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: hang, timeoutMs: 20 }), /not reachable/);
});

test("checkHealth reads model and device and validates the reply", async () => {
  let seen = "";
  const ok = (async (url: string) => ((seen = url), Response.json({ ok: true, model: "fastino/GLiNER2.5-Decide", device: "mps" }))) as unknown as typeof fetch;
  assert.deepEqual(await checkHealth("http://127.0.0.1:8765", { fetchImpl: ok }), { model: "fastino/GLiNER2.5-Decide", device: "mps" });
  assert.equal(seen, "http://127.0.0.1:8765/v1/health");
  const noDevice = (async () => Response.json({ ok: true, model: "m" })) as unknown as typeof fetch;
  assert.deepEqual(await checkHealth(DEFAULT_LOCAL_ENDPOINT, { fetchImpl: noDevice }), { model: "m", device: "unknown" });
  for (const reply of [{ ok: false, model: "m" }, { ok: true }, { ok: true, model: "" }, { ok: "yes", model: "m" }, null]) {
    const f = (async () => Response.json(reply)) as unknown as typeof fetch;
    await assert.rejects(checkHealth(DEFAULT_LOCAL_ENDPOINT, { fetchImpl: f }), /malformed health/, JSON.stringify(reply));
  }
  await assert.rejects(checkHealth("http://10.0.0.5:8765"), /must be http:\/\/127\.0\.0\.1/);
});

test("describeModel shows the device when the server reports one", () => {
  assert.equal(describeModel({ state: "ok", model: "fastino/GLiNER2.5-Decide", device: "mps", checkedAt: 1 }), "fastino/GLiNER2.5-Decide on mps");
  assert.equal(describeModel({ state: "ok", model: "jev-1.13.0", checkedAt: 1 }), "jev-1.13.0");
});

test("own text is trimmed before it is sent", () => {
  assert.equal(buildLocalRequest(post({ text: "  padded  " }), settings()).body.items[0].text, "padded");
});

test("the default timeout lets a slow but working server answer", async () => {
  const { body } = buildLocalRequest(post(), settings());
  const { impl } = fakeServer(body);
  const slow = (async (url: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 30));
    if (init.signal?.aborted) throw new Error("aborted");
    return impl(url, init);
  }) as unknown as typeof fetch;
  const r = await callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: slow });
  assert.ok("rage_bait" in r.probabilities);
});

test("more tasks than the server accepts are split across requests for the same text", () => {
  assert.equal(LOCAL_MAX_TASKS, 16);
  const topics = (n: number) => Array.from({ length: n }, (_, i) => topic({ id: `t${i}`, name: `Topic ${i}` }));
  // rage + slop + 14 topics = 16 tasks: one request.
  const fits = buildLocalRequest(post(), settings({ topics: topics(14) })).body.items;
  assert.deepEqual(fits.map((i) => Object.keys(i.tasks).length), [16]);
  // rage + slop + 15 topics = 17 tasks: two requests, nothing lost, same text.
  const { body, rules } = buildLocalRequest(post(), settings({ topics: topics(15) }));
  assert.deepEqual(body.items.map((i) => Object.keys(i.tasks).length), [16, 1]);
  assert.ok(body.items.every((i) => i.text === "my own words"));
  const ruleIds = body.items.flatMap((i) => Object.values(i.tasks).flatMap((t) => t.ruleIds));
  assert.deepEqual(ruleIds, rules.map((r) => r.ruleId));
  // 40 topics: three requests.
  assert.deepEqual(buildLocalRequest(post(), settings({ topics: topics(40) })).body.items.map((i) => Object.keys(i.tasks).length), [16, 16, 10]);
});

test("callLocal merges answers from split requests", async () => {
  const topics = Array.from({ length: 20 }, (_, i) => topic({ id: `t${i}`, name: `Topic ${i}` }));
  const { body } = buildLocalRequest(post(), settings({ topics }));
  // Route by task names, since split requests share one text.
  const routed = (async (url: string, init: RequestInit) => {
    const sent = JSON.parse(String(init.body));
    const item = body.items.find((i) => Object.keys(i.tasks).join() === Object.keys(sent.tasks).join())!;
    return fakeServer({ items: [item] }, { "topic:t19": 0.9 }).impl(url, init);
  }) as unknown as typeof fetch;
  const r = await callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: routed });
  assert.equal(Object.keys(r.probabilities).length, 22);
  assert.equal(r.probabilities["topic:t19"], 0.9);
});

test("two topics with the same name share one question and both get its answer", async () => {
  const s = settings({
    filters: { rage_bait: false, llm_slop: false, ai_video_slop: false },
    topics: [topic({ id: "a", name: "Golf" }), topic({ id: "b", name: " Golf " })],
  });
  const { body, rules } = buildLocalRequest(post(), s);
  assert.deepEqual(rules.map((r) => r.ruleId), ["topic:a", "topic:b"]);
  assert.deepEqual(Object.keys(body.items[0].tasks), ["topic: Golf"]);
  assert.deepEqual(body.items[0].tasks["topic: Golf"].ruleIds, ["topic:a", "topic:b"]);
  const { impl } = fakeServer(body, { "topic:a": 0.9 });
  const r = await callLocal(DEFAULT_LOCAL_ENDPOINT, body, { fetchImpl: impl });
  assert.deepEqual(r.probabilities, { "topic:a": 0.9, "topic:b": 0.9 });
});
