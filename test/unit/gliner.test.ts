import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FASTINO_ENDPOINT,
  GLINER_MODEL,
  GLINER_UNSUPPORTED,
  GlinerError,
  buildGlinerRequest,
  callGliner,
  parseResponse,
  type GlinerItem,
  type GlinerRequest,
  type Head,
} from "../../src/background/gliner.ts";
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
  filters: { rage_bait: true, llm_slop: true, ai_video_slop: true },
  ...over,
});
const topic = (over = {}) => ({ id: "t", name: "Crypto prices", description: "", exceptions: "", enabled: true, ...over });
const RAGE: Head = { task: "tone", positive: "rage bait", negatives: ["not rage bait"] };

/** A Fastino chat-completions reply for one item's head. `p` is P(positive); `label` overrides the winner. */
function reply(item: GlinerItem, p: number, label?: string, model = GLINER_MODEL) {
  const win = label ?? (p >= 0.5 ? item.head.positive : item.head.negatives[0]);
  const confidence = win === item.head.positive ? p : 1 - p;
  return Response.json({
    model,
    choices: [{ message: { role: "assistant", content: JSON.stringify({ [item.head.task]: { label: win, confidence } }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  });
}

/** fetch stub that routes each request to its item (by text + task) and answers with pByRule. */
function fakeFastino(req: GlinerRequest, pByRule: Record<string, number>, overrides: Record<string, () => Response> = {}) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    const item = req.items.find(
      (i) => i.text === body.messages[0].content && i.head.task === body.schema.classifications[0].task,
    )!;
    return overrides[item.ruleId]?.() ?? reply(item, pByRule[item.ruleId] ?? 0.1);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("each question is its own item; slop is not offered", () => {
  const { body, rules } = buildGlinerRequest(post(), settings());
  assert.equal(body.model, "fastino/gliner2.5-multi-v1");
  assert.deepEqual(body.items, [{ ruleId: "rage_bait", text: "my own words", head: RAGE }]);
  assert.deepEqual(rules.map((r) => [r.ruleId, r.label, r.threshold]), [["rage_bait", "Rage bait", 0.75]]);
  assert.ok(GLINER_UNSUPPORTED.has("llm_slop"));
});

test("the quote is judged on its own and topics see the whole post", () => {
  const { body, rules } = buildGlinerRequest(post({ quotedText: "  the quoted post  " }), settings({ topics: [topic()] }));
  assert.deepEqual(
    body.items.map((i) => [i.ruleId, i.text, i.head.task]),
    [
      ["rage_bait", "my own words", "tone"],
      ["rage_bait_quoted", "the quoted post", "tone"],
      ["topic:t", "my own words\n[Quoted post] the quoted post", "topic: Crypto prices"],
    ],
  );
  assert.deepEqual(body.items[1].head, RAGE);
  assert.ok(rules.some((r) => r.ruleId === "rage_bait_quoted" && r.label === "Rage bait (quoted post)"));
});

test("a quote-only post skips own-text rage but still checks the quote and topics", () => {
  const { body } = buildGlinerRequest(post({ text: "  ", quotedText: "quoted" }), settings({ topics: [topic()] }));
  assert.deepEqual(
    body.items.map((i) => [i.ruleId, i.text]),
    [
      ["rage_bait_quoted", "quoted"],
      ["topic:t", "[Quoted post] quoted"],
    ],
  );
});

test("topic labels are the bare name; descriptions are ignored; exceptions compete as a third label", () => {
  const plain = buildGlinerRequest(post(), settings({ topics: [topic({ description: "price calls" })] })).body.items[1];
  assert.deepEqual(plain.head, { task: "topic: Crypto prices", positive: "Crypto prices", negatives: ["other topic"] });
  const withExc = buildGlinerRequest(post(), settings({ topics: [topic({ exceptions: "  technical research " })] })).body.items[1];
  assert.deepEqual(withExc.head.negatives, ["technical research", "other topic"]);
  const blankExc = buildGlinerRequest(post(), settings({ topics: [topic({ exceptions: " \n " })] })).body.items[1];
  assert.deepEqual(blankExc.head.negatives, ["other topic"]);
});

test("disabled filters, blank or disabled topics, and empty posts add nothing", () => {
  const off = settings({
    filters: { rage_bait: false, llm_slop: false, ai_video_slop: false },
    topics: [topic({ enabled: false }), topic({ id: "b", name: "  " })],
  });
  assert.deepEqual(buildGlinerRequest(post({ quotedText: "q", hasVideo: true }), off), { body: { model: GLINER_MODEL, items: [] }, rules: [] });
  const empty = buildGlinerRequest(post({ text: "" }), settings({ topics: [topic()] }));
  assert.deepEqual(empty.body.items, []);
});

test("video posts get the video question, with media labels in the text", () => {
  const { body } = buildGlinerRequest(post({ hasVideo: true, mediaLabels: ["AI-generated", "Dancing cat"] }), settings());
  const video = body.items.find((i) => i.ruleId === "ai_video_slop")!;
  assert.equal(video.text, "my own words\n[Media: AI-generated; Dancing cat]\n[Video attached]");
  assert.deepEqual(video.head, { task: "video", positive: "low-value AI-generated video", negatives: ["other video"] });
  assert.ok(!buildGlinerRequest(post(), settings()).body.items.some((i) => i.ruleId === "ai_video_slop"));
});

test("thresholds come from the GLiNER table for the chosen sensitivity", () => {
  const t = (sensitivity: Settings["sensitivity"]) =>
    buildGlinerRequest(post({ hasVideo: true }), settings({ sensitivity, topics: [topic()] })).rules.map((r) => r.threshold);
  assert.deepEqual(t("conservative"), [0.9, 0.93, 0.9]);
  assert.deepEqual(t("balanced"), [0.75, 0.85, 0.7]);
  assert.deepEqual(t("aggressive"), [0.55, 0.75, 0.5]);
});

test("parseResponse turns the winning label into P(positive) and validates everything", () => {
  const ok = (content: unknown, extra = {}) => ({ model: "m", choices: [{ message: { content: JSON.stringify(content) } }], ...extra });
  const r = parseResponse(ok({ tone: { label: "rage bait", confidence: 0.8 } }, { usage: { prompt_tokens: 3, completion_tokens: 4 } }), RAGE);
  assert.deepEqual(r, { model: "m", p: 0.8, usage: { input_tokens: 3, output_tokens: 4 } });
  assert.equal(parseResponse(ok({ tone: { label: "not rage bait", confidence: 0.75 } }), RAGE).p, 0.25);
  assert.deepEqual(parseResponse(ok({ tone: { label: "rage bait", confidence: 0 } }), RAGE).usage, { input_tokens: 0, output_tokens: 0 });

  const three: Head = { task: "topic: x", positive: "x", negatives: ["exception", "other topic"] };
  assert.equal(parseResponse(ok({ "topic: x": { label: "x", confidence: 0.9 } }), three).p, 0.9);
  assert.equal(parseResponse(ok({ "topic: x": { label: "exception", confidence: 0.6 } }), three).p, 0);
  assert.equal(parseResponse(ok({ "topic: x": { label: "other topic", confidence: 1 } }), three).p, 0);

  const bad = [
    null,
    { choices: [{ message: { content: "{}" } }] },
    { model: "m", choices: [] },
    ok({ other: { label: "rage bait", confidence: 0.8 } }),
    ok({ tone: { label: "rage bait", confidence: 1.2 } }),
    ok({ tone: { label: "rage bait", confidence: -0.1 } }),
    ok({ tone: { label: "rage bait", confidence: "0.5" } }),
    ok({ tone: { label: "maybe", confidence: 0.5 } }),
    ok({ tone: { label: 3, confidence: 0.5 } }),
  ];
  for (const raw of bad) assert.throws(() => parseResponse(raw, RAGE), GlinerError, JSON.stringify(raw));
});

test("a response without string content is malformed; non-JSON content is reported as such", () => {
  for (const content of [undefined, { tone: { label: "rage bait", confidence: 1 } }]) {
    assert.throws(() => parseResponse({ model: "m", choices: [{ message: { content } }] }, RAGE), /Malformed Fastino response/);
  }
  assert.throws(() => parseResponse({ model: "m", choices: [{ message: { content: "nope" } }] }, RAGE), /not JSON/);
});

test("callGliner sends one authenticated request per item in parallel and merges answers and usage", async () => {
  const { body } = buildGlinerRequest(post({ quotedText: "quoted" }), settings({ topics: [topic({ exceptions: "research" })] }));
  const { calls, impl } = fakeFastino(body, { rage_bait: 0.2, rage_bait_quoted: 0.95, "topic:t": 0.9 });
  const r = await callGliner("fast_sk_test", body, { fetchImpl: impl });
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, FASTINO_ENDPOINT);
    assert.equal(c.init.method, "POST");
    assert.deepEqual(c.init.headers, { Authorization: "Bearer fast_sk_test", "Content-Type": "application/json" });
    assert.equal(c.body.model, GLINER_MODEL);
    assert.equal(c.body.include_confidence, true);
    assert.equal(c.body.schema.classifications.length, 1);
  }
  assert.deepEqual(calls[2].body.schema, {
    classifications: [{ task: "topic: Crypto prices", labels: ["Crypto prices", "research", "other topic"] }],
  });
  assert.deepEqual(calls[1].body.messages, [{ role: "user", content: "quoted" }]);
  assert.equal(r.refused, false);
  assert.ok(Math.abs(r.probabilities.rage_bait - 0.2) < 1e-9);
  assert.ok(Math.abs(r.probabilities.rage_bait_quoted - 0.95) < 1e-9);
  assert.ok(Math.abs(r.probabilities["topic:t"] - 0.9) < 1e-9);
  assert.deepEqual(r.usage, { input_tokens: 60, output_tokens: 90 });
  assert.equal(r.model, GLINER_MODEL);
});

test("a usage-policy refusal marks the result refused and drops only that question", async () => {
  const { body } = buildGlinerRequest(post({ quotedText: "hostile quote" }), settings());
  const refusal = () =>
    new Response(JSON.stringify({ error: { message: "This request was rejected because its content violates the usage policy." } }), { status: 400 });
  const { impl } = fakeFastino(body, { rage_bait: 0.3 }, { rage_bait_quoted: refusal });
  const r = await callGliner("k", body, { fetchImpl: impl });
  assert.equal(r.refused, true);
  assert.deepEqual(Object.keys(r.probabilities), ["rage_bait"]);
});

test("other 400s are errors, not refusals", async () => {
  const { body } = buildGlinerRequest(post(), settings());
  const bad = (async () => new Response(JSON.stringify({ error: { message: "schema input is not a valid GLiNER schema" } }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(callGliner("k", body, { fetchImpl: bad }), (e: GlinerError) => e.status === 400 && /HTTP 400/.test(e.message));
  const unreadable = (async () => ({ ok: false, status: 400, text: async () => { throw new Error("x"); } })) as unknown as typeof fetch;
  await assert.rejects(callGliner("k", body, { fetchImpl: unreadable }), GlinerError);
});

test("retries 429/5xx with backoff, gives up after maxAttempts, and never leaks the key", async () => {
  const { body } = buildGlinerRequest(post(), settings());
  let calls = 0;
  const delays: number[] = [];
  const statuses = [429, 529, 500];
  const flaky = (async () => {
    const s = statuses[calls++];
    return s ? new Response("", { status: s }) : reply(body.items[0], 0.9);
  }) as unknown as typeof fetch;
  const real = Math.random;
  Math.random = () => 0.5;
  try {
    const r = await callGliner("k", body, { maxAttempts: 4, baseDelayMs: 10, fetchImpl: flaky, sleepImpl: async (ms) => void delays.push(ms) });
    assert.equal(r.probabilities.rage_bait, 0.9);
  } finally {
    Math.random = real;
  }
  assert.equal(calls, 4);
  assert.deepEqual(delays, [10, 20, 40]);

  calls = 0;
  const down = (async () => (calls++, new Response("", { status: 503 }))) as unknown as typeof fetch;
  await assert.rejects(callGliner("fast_sk_SECRET", body, { fetchImpl: down, sleepImpl: async () => {} }), (e: GlinerError) => e.status === 503 && !e.message.includes("SECRET"));
  assert.equal(calls, 3);

  calls = 0;
  const offline = (async () => { calls++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(callGliner("fast_sk_SECRET", body, { maxAttempts: 2, fetchImpl: offline, sleepImpl: async () => {} }), (e: GlinerError) => e.status === null && !e.message.includes("SECRET"));
  assert.equal(calls, 2);

  calls = 0;
  const unauthorized = (async () => (calls++, new Response("", { status: 401 }))) as unknown as typeof fetch;
  await assert.rejects(callGliner("k", body, { fetchImpl: unauthorized, sleepImpl: async () => {} }), /HTTP 401/);
  assert.equal(calls, 1);
});

test("502 is retried and 501 is not", async () => {
  const { body } = buildGlinerRequest(post(), settings());
  for (const [status, expected] of [[502, 2], [501, 1]] as const) {
    let calls = 0;
    const once = (async () => (calls++ === 0 ? new Response("", { status }) : reply(body.items[0], 0.1))) as unknown as typeof fetch;
    await callGliner("k", body, { fetchImpl: once, sleepImpl: async () => {} }).catch(() => {});
    assert.equal(calls, expected, `HTTP ${status}`);
  }
});

test("the default sleep really waits", async () => {
  const { body } = buildGlinerRequest(post(), settings());
  let calls = 0;
  const once = (async () => (calls++ === 0 ? new Response("", { status: 429 }) : reply(body.items[0], 0.1))) as unknown as typeof fetch;
  const started = Date.now();
  await callGliner("k", body, { baseDelayMs: 40, fetchImpl: once });
  assert.ok(Date.now() - started >= 25);
});
