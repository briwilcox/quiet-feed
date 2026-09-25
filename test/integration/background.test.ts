// Integration tests: the real service worker module (router, classify pipeline,
// cache, queue, key storage, usage, badge) against a stubbed chrome.* API and a
// stubbed TypeSafe endpoint. Each test loads a fresh copy of the worker.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { Decision, PostPayload, Settings, StatusResponse } from "../../src/shared/types.ts";
import { EXTENSION_PAGE, X_TAB, flush, installChrome, installFetch, jevAnswer } from "../helpers/chrome-stub.ts";

let instance = 0;

// The worker starts a badge-refresh interval at load. Capture those timers so the
// test process can exit on its own instead of relying on --test-force-exit,
// which can end a run before every test file finishes.
const workerIntervals: ReturnType<typeof setInterval>[] = [];
const realSetInterval = globalThis.setInterval;
after(() => workerIntervals.forEach((t) => clearInterval(t)));
const KEY = "sk-test-SECRET-123";

async function boot(settings: Partial<Settings> = {}, { key = KEY as string | null } = {}) {
  const stub = installChrome();
  await stub.chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, backend: "jev", enabled: true, disclosureAccepted: true, ...settings },
  });
  if (key) await stub.chrome.storage.session.set({ jevApiKey: key });
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const t = realSetInterval(...args);
    workerIntervals.push(t);
    return t;
  }) as typeof setInterval;
  try {
    await import(`../../src/background/index.ts?instance=${instance++}`);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  await flush();
  return stub;
}

const post = (over: Partial<PostPayload> = {}): PostPayload => ({
  statusId: "1001",
  authorHandle: "Author_1",
  text: "Everyone who disagrees with me is an idiot and should be fired",
  quotedText: null,
  mediaLabels: [],
  hasVideo: false,
  textTruncated: false,
  ...over,
});

async function classify(stub: Awaited<ReturnType<typeof boot>>, p = post()) {
  const res = await stub.send<Decision>({ type: "classify", post: p }, X_TAB);
  assert.equal(res.ok, true, res.error);
  return res.result!;
}

async function status(stub: Awaited<ReturnType<typeof boot>>) {
  return (await stub.send<StatusResponse>({ type: "getStatus" })).result!;
}

test("classify sends one authenticated request with a question per enabled rule and hides above threshold", async () => {
  const stub = await boot({ filters: { rage_bait: true, llm_slop: true, ai_video_slop: true } });
  const calls = installFetch((body) => jevAnswer(body, { rage_bait: 0.97, llm_slop: 0.1 }));

  const d = await classify(stub);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(calls[0].body.questions), ["rage_bait", "llm_slop"]); // no video, so no video question
  assert.equal(calls[0].body.state.post.text, post().text);
  assert.equal(d.hide, true);
  assert.equal(d.reason, "hidden");
  assert.deepEqual(d.matched.map((m) => m.ruleId), ["rage_bait"]);

  const { usage } = await status(stub);
  assert.equal(usage.requests, 1);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 10);
  assert.equal(usage.lastModel, "jev-test-1");
});

test("a repeat post is served from cache without another request", async () => {
  const stub = await boot();
  const calls = installFetch((body) => jevAnswer(body, 0.95));
  await classify(stub);
  const again = await classify(stub);
  assert.equal(calls.length, 1);
  assert.equal(again.hide, true);
  assert.equal((await status(stub)).usage.cacheHits, 1);
});

test("the cache stores hashes and scores, never post text", async () => {
  const stub = await boot();
  installFetch((body) => jevAnswer(body, 0.2));
  await classify(stub);
  const dump = JSON.stringify([...stub.chrome.storage.local.data.entries()]);
  assert.ok(!dump.includes("idiot"), "post text leaked into local storage");
});

test("changing sensitivity re-thresholds cached scores without a new request", async () => {
  const stub = await boot({ sensitivity: "balanced", filters: { rage_bait: true, llm_slop: false, ai_video_slop: false } });
  const calls = installFetch((body) => jevAnswer(body, 0.7));
  assert.equal((await classify(stub)).hide, false); // 0.7 is below balanced (0.8)

  const s = (await stub.chrome.storage.local.get("settings")).settings as Settings;
  await stub.chrome.storage.local.set({ settings: { ...s, sensitivity: "aggressive" } });
  assert.equal((await classify(stub)).hide, true); // 0.7 is above aggressive (0.65)
  assert.equal(calls.length, 1);
});

test("identical posts from two tabs at once make a single request", async () => {
  const stub = await boot();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls = installFetch(async (body) => {
    await gate;
    return jevAnswer(body, 0.9);
  });
  const a = classify(stub);
  const b = stub.send<Decision>({ type: "classify", post: post() }, { ...X_TAB, tab: { id: 8 } } as typeof X_TAB);
  await flush();
  release();
  const [da, db] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(da.hide, true);
  assert.equal(db.result!.hide, true);
});

test("API errors leave the post visible and are counted", async () => {
  const stub = await boot();
  installFetch(() => new Response("nope", { status: 401 }));
  const d = await classify(stub);
  assert.equal(d.hide, false);
  assert.equal(d.reason, "api_error");
  assert.match(d.explanation, /401/);
  assert.equal((await status(stub)).usage.errors, 1);
});

test("a malformed or out-of-range answer leaves the post visible", async () => {
  const stub = await boot();
  installFetch((body) => jevAnswer(body, 1.5));
  const d = await classify(stub);
  assert.equal(d.hide, false);
  assert.equal(d.reason, "api_error");
});

test("the daily request limit stops calls and leaves posts visible", async () => {
  const stub = await boot({ dailyRequestLimit: 1 });
  const calls = installFetch((body) => jevAnswer(body, 0.99));
  assert.equal((await classify(stub)).hide, true);
  const d = await classify(stub, post({ statusId: "1002", text: "A different post entirely" }));
  assert.equal(d.reason, "daily_limit");
  assert.equal(d.hide, false);
  assert.equal(calls.length, 1);
});

test("no key, disabled, truncated, allowed author, and no rules never call the API", async () => {
  const cases: Array<[Partial<Settings>, { key?: string | null }, Partial<PostPayload>, string]> = [
    [{}, { key: null }, {}, "no_key"],
    [{ enabled: false }, {}, {}, "disabled"],
    [{ disclosureAccepted: false }, {}, {}, "disabled"],
    [{}, {}, { textTruncated: true }, "incomplete_text"],
    [{ allowedAuthors: ["author_1"] }, {}, {}, "allowed_author"],
    [{ filters: { rage_bait: false, llm_slop: false, ai_video_slop: false }, topics: [] }, {}, {}, "no_rules"],
  ];
  for (const [settings, opts, over, reason] of cases) {
    const stub = await boot(settings, opts);
    const calls = installFetch((body) => jevAnswer(body, 0.99));
    const d = await classify(stub, post(over));
    assert.equal(d.reason, reason);
    assert.equal(d.hide, false);
    assert.equal(calls.length, 0, `${reason} made a request`);
  }
});

test("quote tweets of rage bait are hidden by the quoted-post rule", async () => {
  const stub = await boot({ filters: { rage_bait: true, llm_slop: false, ai_video_slop: false } });
  const calls = installFetch((body) => jevAnswer(body, { rage_bait: 0.05, rage_bait_quoted: 0.96 }));
  const d = await classify(stub, post({ text: "lol look at this", quotedText: "They are destroying the country, RT if furious" }));
  assert.equal(calls[0].body.state.post.quoted_post, "They are destroying the country, RT if furious");
  assert.equal(d.hide, true);
  assert.deepEqual(d.matched.map((m) => m.label), ["Rage bait (quoted post)"]);
});

test("content scripts may only use content messages; foreign senders are ignored", async () => {
  const stub = await boot();
  for (const type of ["getStatus", "saveKey", "deleteKey", "testConnection", "clearCache", "clearRecentBlocked"]) {
    const res = await stub.send({ type, provider: "jev", key: "x", mode: "local" }, X_TAB);
    assert.deepEqual(res, { ok: false, error: "Not allowed" }, type);
  }
  await assert.rejects(stub.send({ type: "getStatus" }, { id: "some-other-extension", url: "https://evil.example" }));
  assert.equal((await stub.chrome.storage.session.get("jevApiKey")).jevApiKey, KEY);
});

test("the API key never reaches content scripts or local storage in session mode", async () => {
  const stub = await boot({}, { key: null });
  installFetch((body) => jevAnswer(body, 0.5, "jev-ping"));
  const saved = await stub.send({ type: "saveKey", provider: "jev", key: `  ${KEY}  `, mode: "session" });
  assert.equal((saved.result as { state: string }).state, "ok");

  assert.equal((await stub.chrome.storage.session.get("jevApiKey")).jevApiKey, KEY);
  assert.deepEqual(await stub.chrome.storage.local.get("jevApiKey"), {});
  const config = await stub.send({ type: "getContentConfig" }, X_TAB);
  assert.ok(!JSON.stringify(config).includes(KEY));
  assert.equal(stub.chrome.storage.local.accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(stub.chrome.storage.session.accessLevel, "TRUSTED_CONTEXTS");
});

test("switching key storage mode moves the key, and delete removes it everywhere", async () => {
  const stub = await boot({}, { key: null });
  installFetch((body) => jevAnswer(body, 0.5));
  await stub.send({ type: "saveKey", provider: "jev", key: KEY, mode: "session" });
  await stub.send({ type: "saveKey", provider: "jev", key: KEY, mode: "local" });
  assert.deepEqual(await stub.chrome.storage.session.get("jevApiKey"), {});
  assert.equal((await stub.chrome.storage.local.get("jevApiKey")).jevApiKey, KEY);

  await stub.send({ type: "deleteKey", provider: "jev" });
  assert.deepEqual(await stub.chrome.storage.local.get("jevApiKey"), {});
  assert.equal((await status(stub)).hasKey, false);
  assert.deepEqual((await status(stub)).connection, { state: "no_key" });
});

test("a failed connection test reports the HTTP status without the key", async () => {
  const stub = await boot();
  installFetch(() => new Response("", { status: 403 }));
  const res = await stub.send<{ state: string; message: string }>({ type: "testConnection", provider: "jev" });
  assert.equal(res.result!.state, "error");
  assert.match(res.result!.message, /403/);
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("recordResult counts checked and blocked, updates the badge, and keeps a recent list", async () => {
  const stub = await boot();
  await stub.send({ type: "recordResult", newlyChecked: true, newlyBlocked: false, ruleIds: [] }, X_TAB);
  await stub.send(
    {
      type: "recordResult",
      newlyChecked: true,
      newlyBlocked: true,
      ruleIds: ["rage_bait"],
      blockedPost: { statusId: "55", authorHandle: "loud", snippet: "x".repeat(400), labels: ["Rage bait"] },
    },
    X_TAB,
  );
  const s = await status(stub);
  assert.equal(s.usage.checked, 2);
  assert.equal(s.usage.blocked, 1);
  assert.deepEqual(s.usage.hiddenByRule, { rage_bait: 1 });
  assert.equal(s.recentBlocked.length, 1);
  assert.equal(s.recentBlocked[0].snippet.length, 280);
  assert.equal(stub.badge.text, "1");
  assert.match(stub.badge.title, /1 blocked of 2 checked/);
});

test("the recent list rejects malformed ids, dedupes by post, and caps at 50", async () => {
  const stub = await boot();
  const block = (statusId: string, authorHandle = "ok_user") =>
    stub.send(
      { type: "recordResult", newlyChecked: true, newlyBlocked: true, ruleIds: [], blockedPost: { statusId, authorHandle, snippet: "s", labels: [] } },
      X_TAB,
    );
  await block("12/../../evil");
  await block("99", "bad handle!");
  assert.equal((await status(stub)).recentBlocked.length, 0);

  for (let i = 0; i < 55; i++) await block(String(i));
  await block("54");
  const list = (await status(stub)).recentBlocked;
  assert.equal(list.length, 50);
  assert.equal(list[0].statusId, "54");
  assert.equal(list.filter((b) => b.statusId === "54").length, 1);

  await stub.send({ type: "clearRecentBlocked" });
  assert.equal((await status(stub)).recentBlocked.length, 0);
});

test("the badge is blank while filtering is off", async () => {
  const stub = await boot({ enabled: false });
  await stub.send({ type: "recordResult", newlyChecked: true, newlyBlocked: true, ruleIds: [] }, X_TAB);
  assert.equal(stub.badge.text, "");
  assert.equal(stub.badge.title, "Quiet Feed (off)");
});

test("allowAuthor normalizes handles and rejects invalid ones", async () => {
  const stub = await boot();
  assert.equal((await stub.send({ type: "allowAuthor", handle: "@Some_User" }, X_TAB)).ok, true);
  assert.deepEqual((await status(stub)).settings.allowedAuthors, ["some_user"]);
  await stub.send({ type: "allowAuthor", handle: "some_user" }, X_TAB);
  const bad = await stub.send({ type: "allowAuthor", handle: "no spaces allowed" }, X_TAB);
  assert.equal(bad.ok, false);
  assert.deepEqual((await status(stub)).settings.allowedAuthors, ["some_user"]);
});

test("settings changes notify open X tabs with a new settings version", async () => {
  const stub = await boot();
  stub.setOpenTabs([{ id: 3, url: "https://x.com/home" }, { id: 4, url: "https://example.com/" }]);
  const before = (await stub.send<{ settingsVersion: number }>({ type: "getContentConfig" }, X_TAB)).result!;
  await new Promise((r) => setTimeout(r, 2));
  const s = (await stub.chrome.storage.local.get("settings")).settings as Settings;
  await stub.chrome.storage.local.set({ settings: { ...s, enabled: false } });
  await flush();
  await flush();
  assert.equal(stub.tabMessages.length, 1);
  const { tabId, msg } = stub.tabMessages[0] as { tabId: number; msg: { type: string; config: { active: boolean; settingsVersion: number } } };
  assert.equal(tabId, 3);
  assert.equal(msg.type, "configChanged");
  assert.equal(msg.config.active, false);
  assert.ok(msg.config.settingsVersion > before.settingsVersion);
});

test("clearCache forces a fresh request", async () => {
  const stub = await boot();
  const calls = installFetch((body) => jevAnswer(body, 0.1));
  await classify(stub);
  await stub.send({ type: "clearCache" });
  await classify(stub);
  assert.equal(calls.length, 2);
});

test("status reports extension state for the popup", async () => {
  const stub = await boot({ sensitivity: "conservative" });
  const s = await status(stub);
  assert.equal(s.settings.sensitivity, "conservative");
  assert.equal(s.hasKey, true);
  assert.deepEqual(s.connection, { state: "untested" });
  assert.equal(EXTENSION_PAGE.url.startsWith("chrome-extension://"), true);
});

test("a sender without a URL is treated as a content script", async () => {
  const stub = await boot();
  const res = await stub.send({ type: "getStatus" }, { id: X_TAB.id });
  assert.deepEqual(res, { ok: false, error: "Not allowed" });
});

test("only newly blocked posts join the recent list, with at most 10 labels", async () => {
  const stub = await boot();
  const blockedPost = { statusId: "77", authorHandle: "someone", snippet: "s", labels: Array.from({ length: 12 }, (_, i) => `L${i}`) };
  await stub.send({ type: "recordResult", newlyChecked: true, newlyBlocked: false, ruleIds: [], blockedPost }, X_TAB);
  assert.equal((await status(stub)).recentBlocked.length, 0);
  await stub.send({ type: "recordResult", newlyChecked: false, newlyBlocked: true, ruleIds: [], blockedPost }, X_TAB);
  const [entry] = (await status(stub)).recentBlocked;
  assert.deepEqual(entry.labels, ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"]);
});

test("storage changes other than local settings do not notify tabs", async () => {
  const stub = await boot();
  stub.setOpenTabs([{ id: 3, url: "https://x.com/home" }]);
  await stub.chrome.storage.local.set({ usage: { day: "x" } });
  await stub.chrome.storage.session.set({ settings: { enabled: false } });
  await flush();
  await flush();
  assert.equal(stub.tabMessages.length, 0);
});

test("latency is the time spent in the API call", async () => {
  const stub = await boot();
  const realNow = performance.now.bind(performance);
  let clock = 1_000_000;
  Object.defineProperty(performance, "now", { value: () => clock, configurable: true, writable: true });
  try {
    installFetch((body) => ((clock += 42), jevAnswer(body, 0.1)));
    await classify(stub);
  } finally {
    Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true });
  }
  assert.equal((await status(stub)).usage.lastLatencyMs, 42);
});

test("the connection test asks one yes/no question with both criteria, in a single attempt", async () => {
  const stub = await boot();
  const calls = installFetch(() => new Response("", { status: 503 }));
  await stub.send({ type: "testConnection", provider: "jev" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.questions.ping.criteria, { true: "Yes", false: "No" });
});

test("the queue runs two different posts at once and caps the backlog at 50", async () => {
  const stub = await boot();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inFlight = 0;
  let peak = 0;
  installFetch(async (body) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await gate;
    inFlight--;
    return jevAnswer(body, 0.1);
  });
  const pending = Array.from({ length: 53 }, (_, i) => classify(stub, post({ statusId: String(5000 + i), text: `distinct post ${i}` })));
  for (let i = 0; i < 20; i++) await flush();
  release();
  const results = await Promise.all(pending);
  assert.equal(peak, 2);
  assert.equal(results.filter((d) => d.reason === "api_error").length, 1);
});

// ---- GLiNER (Fastino) backend ----

/** Fastino reply giving P(positive) per task name (default 0.1). */
function fastinoAnswer(body: any, pByTask: Record<string, number> = {}) {
  const content: Record<string, { label: string; confidence: number }> = {};
  for (const c of body.schema.classifications) {
    const p = pByTask[c.task] ?? 0.1;
    content[c.task] = p >= 0.5 ? { label: c.labels[0], confidence: p } : { label: c.labels[1], confidence: 1 - p };
  }
  return Response.json({
    model: "fastino/gliner2.5-multi-v1",
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 20, completion_tokens: 40 },
  });
}
const FAST_KEY = "fast_sk_test_KEY";
const policyRefusal = () =>
  new Response(JSON.stringify({ error: { message: "This request was rejected because its content violates the usage policy." } }), { status: 400 });

async function bootGliner(settings: Partial<Settings> = {}, { key = FAST_KEY as string | null } = {}) {
  const stub = await boot({ backend: "gliner", ...settings }, { key: null });
  if (key) await stub.chrome.storage.session.set({ fastinoApiKey: key });
  return stub;
}

test("GLiNER is the default backend and classifies through Fastino with its own key", async () => {
  assert.equal(DEFAULT_SETTINGS.backend, "gliner");
  const stub = await bootGliner();
  await stub.chrome.storage.session.set({ jevApiKey: KEY });
  const calls = installFetch((body) => fastinoAnswer(body, { tone: 0.97 }));
  const d = await classify(stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.fastino.ai/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${FAST_KEY}`);
  assert.equal(calls[0].body.model, "fastino/gliner2.5-multi-v1");
  assert.deepEqual(calls[0].body.messages, [{ role: "user", content: post().text }]);
  assert.equal(d.hide, true);
  assert.deepEqual(d.matched.map((m) => m.ruleId), ["rage_bait"]);
  const s = await status(stub);
  assert.deepEqual(s.usage.inputTokens, 20);
  assert.deepEqual(s.keys, { jev: true, gliner: true });
  assert.equal(s.hasKey, true);
});

test("GLiNER without a Fastino key stays visible even if a Jev key exists", async () => {
  const stub = await bootGliner({}, { key: null });
  await stub.chrome.storage.session.set({ jevApiKey: KEY });
  const calls = installFetch((body) => fastinoAnswer(body));
  assert.equal((await classify(stub)).reason, "no_key");
  assert.equal(calls.length, 0);
  assert.equal((await status(stub)).hasKey, false);
});

test("a Fastino refusal hides the post by default, is cached, and is counted", async () => {
  const stub = await bootGliner();
  const calls = installFetch(() => policyRefusal());
  const d = await classify(stub);
  assert.equal(d.hide, true);
  assert.deepEqual(d.matched.map((m) => m.label), ["Refused by Fastino"]);
  const again = await classify(stub);
  assert.equal(again.hide, true);
  assert.equal(calls.length, 1, "refusal was not cached");
  const { usage } = await status(stub);
  assert.equal(usage.refused, 1);
  assert.equal(usage.errors, 0);
});

test("with refusals not hidden, a refused post stays visible", async () => {
  const stub = await bootGliner({ hideProviderRefusals: false });
  installFetch(() => policyRefusal());
  const d = await classify(stub);
  assert.equal(d.hide, false);
  assert.equal(d.reason, "provider_refused");
});

test("a refused quote does not hide a post whose own text is fine, unless refusals hide", async () => {
  const quoted = post({ text: "calm take", quotedText: "hostile quoted post" });
  for (const [hideProviderRefusals, expected] of [[true, true], [false, false]] as const) {
    const stub = await bootGliner({ hideProviderRefusals });
    installFetch((body) => (body.messages[0].content === "hostile quoted post" ? policyRefusal() : fastinoAnswer(body)));
    assert.equal((await classify(stub, quoted)).hide, expected, `hideProviderRefusals=${hideProviderRefusals}`);
  }
});

test("switching backend changes the cache key and the provider", async () => {
  const stub = await bootGliner();
  await stub.chrome.storage.session.set({ jevApiKey: KEY });
  const calls = installFetch((body) => (body.messages ? fastinoAnswer(body) : jevAnswer(body, 0.1)));
  await classify(stub);
  const s = (await stub.chrome.storage.local.get("settings")).settings as Settings;
  await stub.chrome.storage.local.set({ settings: { ...s, backend: "jev" } });
  await classify(stub);
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ["api.fastino.ai", "api.typesafe.ai"]);
});

test("per-provider keys: save, test, and delete touch only that provider", async () => {
  const stub = await bootGliner({}, { key: null });
  installFetch((body) => (body.messages ? fastinoAnswer(body, { "connection test": 0.9 }) : jevAnswer(body, 0.5)));
  const saved = await stub.send<{ state: string; model: string }>({ type: "saveKey", provider: "gliner", key: FAST_KEY, mode: "session" });
  assert.deepEqual([saved.result!.state, saved.result!.model], ["ok", "fastino/gliner2.5-multi-v1"]);
  await stub.send({ type: "saveKey", provider: "jev", key: KEY, mode: "local" });
  let s = await status(stub);
  assert.deepEqual(s.keys, { jev: true, gliner: true });
  assert.equal(s.connections.gliner.state, "ok");
  assert.equal(s.connection.state, "ok");

  await stub.send({ type: "deleteKey", provider: "gliner" });
  s = await status(stub);
  assert.deepEqual(s.keys, { jev: true, gliner: false });
  assert.deepEqual(s.connections.gliner, { state: "no_key" });
  assert.equal(s.connections.jev.state, "ok");
});

test("a Fastino connection failure reports the status without the key", async () => {
  const stub = await bootGliner();
  const calls = installFetch(() => new Response("", { status: 401 }));
  const res = await stub.send<{ state: string; message: string }>({ type: "testConnection", provider: "gliner" });
  assert.equal(calls.length, 1);
  assert.equal(res.result!.state, "error");
  assert.match(res.result!.message, /HTTP 401/);
  assert.ok(!JSON.stringify(res).includes(FAST_KEY));
});

test("GLiNER API errors leave the post visible", async () => {
  const stub = await bootGliner();
  installFetch(() => new Response("", { status: 401 }));
  const d = await classify(stub);
  assert.deepEqual([d.hide, d.reason], [false, "api_error"]);
  assert.match(d.explanation, /Fastino returned HTTP 401/);
});

test("unknown providers are rejected", async () => {
  const stub = await bootGliner();
  for (const type of ["saveKey", "deleteKey", "testConnection"]) {
    const res = await stub.send({ type, provider: "openai", key: "x", mode: "session" });
    assert.deepEqual(res, { ok: false, error: "Unknown provider" }, type);
  }
});

test("the daily limit counts every GLiNER call a post needs", async () => {
  const stub = await bootGliner({ dailyRequestLimit: 3 });
  const calls = installFetch((body) => fastinoAnswer(body));
  await classify(stub, post({ statusId: "1", text: "first", quotedText: "a quote" })); // 2 calls
  assert.equal((await status(stub)).usage.requests, 2);
  const d = await classify(stub, post({ statusId: "2", text: "second", quotedText: "another quote" })); // would be 4
  assert.equal(d.reason, "daily_limit");
  assert.equal(calls.length, 2);
  await classify(stub, post({ statusId: "3", text: "third" })); // 1 call fits exactly
  assert.equal((await status(stub)).usage.requests, 3);
});
