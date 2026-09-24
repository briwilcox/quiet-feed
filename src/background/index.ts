import { isSettingsChange, loadSettings, saveSettings, todayKey } from "../shared/settings.ts";
import type {
  ConnectionStatus,
  ContentConfig,
  Decision,
  Message,
  PostPayload,
  StatusResponse,
  UsageStats,
} from "../shared/types.ts";
import { cacheGet, cacheKey, cachePrune, cachePut } from "./cache.ts";
import { decide, preDecide, visible } from "./decide.ts";
import { deleteApiKey, getApiKey, restrictStorageAccess, saveApiKey } from "./keystore.ts";
import { buildRequest, callJev, JEV_MODEL, JevError, PROMPT_VERSION, type JevResponse } from "./jev.ts";
import { RequestQueue } from "./queue.ts";

const queue = new RequestQueue<JevResponse>(2, 50);
let settingsVersion = Date.now();

// ---- usage + connection state (trusted storage) ----

function emptyUsage(): UsageStats {
  return {
    day: todayKey(),
    requests: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: 0,
    lastLatencyMs: null,
    lastModel: null,
    checked: 0,
    blocked: 0,
    hiddenByRule: {},
  };
}

async function getUsage(): Promise<UsageStats> {
  const u = (await chrome.storage.local.get("usage")).usage as UsageStats | undefined;
  return u && u.day === todayKey() ? { ...emptyUsage(), ...u } : emptyUsage();
}

// Serialize read-modify-write so concurrent requests don't drop increments.
let usageChain: Promise<unknown> = Promise.resolve();
function updateUsage(fn: (u: UsageStats) => void): Promise<void> {
  const next = usageChain.then(async () => {
    const u = await getUsage();
    fn(u);
    await chrome.storage.local.set({ usage: u });
  });
  usageChain = next.catch(() => {});
  return next;
}

async function getConnection(): Promise<ConnectionStatus> {
  if (!(await getApiKey())) return { state: "no_key" };
  return ((await chrome.storage.session.get("connection")).connection as ConnectionStatus) ?? { state: "untested" };
}

// ---- classification ----

async function classify(post: PostPayload): Promise<Decision> {
  const settings = await loadSettings();
  const { body, rules } = buildRequest(post, settings);
  const early = preDecide(post, settings, rules.length > 0);
  if (early) return early;

  const key = await cacheKey(body, PROMPT_VERSION);
  const cached = await cacheGet(key);
  if (cached) {
    await updateUsage((u) => void u.cacheHits++);
    return decide(rules, cached.probabilities, settings);
  }

  const apiKey = await getApiKey();
  if (!apiKey) return visible("no_key");
  const usage = await getUsage();
  if (usage.requests >= settings.dailyRequestLimit) return visible("daily_limit", "Daily request limit reached.");

  try {
    const res = await queue.run(key, async () => {
      await updateUsage((u) => void u.requests++);
      const started = performance.now();
      const r = await callJev(apiKey, body);
      const latency = Math.round(performance.now() - started);
      await updateUsage((u) => {
        u.inputTokens += r.usage.input_tokens;
        u.outputTokens += r.usage.output_tokens;
        u.lastLatencyMs = latency;
        u.lastModel = r.model;
      });
      return r;
    });
    const probabilities = Object.fromEntries(
      Object.entries(res.answers).map(([id, a]) => [id, a.noul as number]),
    );
    await cachePut(key, { probabilities, model: res.model });
    return decide(rules, probabilities, settings);
  } catch (err) {
    // Any failure leaves the post visible.
    await updateUsage((u) => void u.errors++);
    return visible("api_error", err instanceof JevError ? err.message : "Classification failed");
  }
}

async function testConnection(): Promise<ConnectionStatus> {
  const apiKey = await getApiKey();
  if (!apiKey) return { state: "no_key" };
  let status: ConnectionStatus;
  try {
    const r = await callJev(
      apiKey,
      {
        model: JEV_MODEL,
        state: "Connection test.",
        questions: { ping: { type: "noul", instructions: { question: "Is this text a connection test?" }, criteria: { true: "Yes", false: "No" } } },
      },
      { maxAttempts: 1 },
    );
    status = { state: "ok", model: r.model, checkedAt: Date.now() };
  } catch (err) {
    status = {
      state: "error",
      message: err instanceof JevError ? err.message : "Unknown error",
      checkedAt: Date.now(),
    };
  }
  await chrome.storage.session.set({ connection: status });
  return status;
}

async function contentConfig(): Promise<ContentConfig> {
  const s = await loadSettings();
  return {
    active: s.enabled && s.disclosureAccepted,
    concealWhilePending: s.concealWhilePending,
    concealTimeoutMs: s.concealTimeoutMs,
    allowedAuthors: s.allowedAuthors,
    settingsVersion,
  };
}

// ---- messaging ----

const CONTENT_MESSAGES = new Set<Message["type"]>(["classify", "getContentConfig", "recordResult", "allowAuthor"]);

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Content scripts run inside x.com; they may only classify and read their own config.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL("")) ?? false;
  if (!fromExtensionPage && !CONTENT_MESSAGES.has(msg.type)) throw new Error("Not allowed");

  switch (msg.type) {
    case "classify":
      return classify(msg.post);
    case "getContentConfig":
      return contentConfig();
    case "recordResult":
      return updateUsage((u) => {
        if (msg.newlyChecked) u.checked++;
        if (!msg.newlyBlocked) return;
        u.blocked++;
        for (const id of msg.ruleIds) u.hiddenByRule[id] = (u.hiddenByRule[id] ?? 0) + 1;
      });
    case "allowAuthor": {
      const handle = msg.handle.toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid handle");
      const { allowedAuthors } = await loadSettings();
      if (!allowedAuthors.includes(handle)) await saveSettings({ allowedAuthors: [...allowedAuthors, handle] });
      return null;
    }
    case "getStatus":
      return {
        settings: await loadSettings(),
        hasKey: (await getApiKey()) !== null,
        connection: await getConnection(),
        usage: await getUsage(),
      } satisfies StatusResponse;
    case "saveKey":
      await saveApiKey(msg.key, msg.mode);
      await chrome.storage.session.remove("connection");
      return testConnection();
    case "deleteKey":
      await deleteApiKey();
      await chrome.storage.session.remove("connection");
      return null;
    case "testConnection":
      return testConnection();
    case "clearCache":
      await cachePrune({ all: true });
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});

// Tell open X tabs to re-evaluate when settings change.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !isSettingsChange(changes)) return;
  settingsVersion = Date.now();
  const config = await contentConfig();
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  for (const tab of tabs) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "configChanged", config }).catch(() => {});
  }
});

async function init() {
  await restrictStorageAccess();
  await cachePrune();
}
chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());
void init();
