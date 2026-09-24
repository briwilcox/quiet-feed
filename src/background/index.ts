import { isSettingsChange, loadSettings, saveSettings, todayKey } from "../shared/settings.ts";
import type {
  BlockedPost,
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

// ---- recently blocked (session memory only) + toolbar badge ----

const RECENT_LIMIT = 50;
const SNIPPET_CHARS = 280;

async function getRecentBlocked(): Promise<BlockedPost[]> {
  return ((await chrome.storage.session.get("recentBlocked")).recentBlocked as BlockedPost[]) ?? [];
}

let recentChain: Promise<unknown> = Promise.resolve();
function addRecentBlocked(p: Omit<BlockedPost, "at">): Promise<void> {
  // Only accept well-formed ids; they are used to build x.com links in the popup.
  if (!/^\d{1,25}$/.test(p.statusId) || !/^[A-Za-z0-9_]{1,15}$/.test(p.authorHandle)) return Promise.resolve();
  const entry: BlockedPost = {
    statusId: p.statusId,
    authorHandle: p.authorHandle,
    snippet: String(p.snippet).slice(0, SNIPPET_CHARS),
    labels: p.labels.slice(0, 10).map(String),
    at: Date.now(),
  };
  const next = recentChain.then(async () => {
    const list = (await getRecentBlocked()).filter((b) => b.statusId !== entry.statusId);
    await chrome.storage.session.set({ recentBlocked: [entry, ...list].slice(0, RECENT_LIMIT) });
  });
  recentChain = next.catch(() => {});
  return next;
}

function badgeText(n: number): string {
  if (n <= 0) return "";
  if (n < 1000) return String(n);
  return n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.floor(n / 1000)}k`;
}

async function updateBadge() {
  const [settings, usage] = await Promise.all([loadSettings(), getUsage()]);
  const active = settings.enabled && settings.disclosureAccepted;
  await chrome.action.setBadgeText({ text: active ? badgeText(usage.blocked) : "" });
  await chrome.action.setTitle({
    title: active ? `Quiet Feed: ${usage.blocked} blocked of ${usage.checked} checked today` : "Quiet Feed (off)",
  });
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
      await updateUsage((u) => {
        if (msg.newlyChecked) u.checked++;
        if (!msg.newlyBlocked) return;
        u.blocked++;
        for (const id of msg.ruleIds) u.hiddenByRule[id] = (u.hiddenByRule[id] ?? 0) + 1;
      });
      if (msg.newlyBlocked && msg.blockedPost) await addRecentBlocked(msg.blockedPost);
      await updateBadge();
      return null;
    case "clearRecentBlocked":
      await chrome.storage.session.remove("recentBlocked");
      return null;
    case "allowAuthor": {
      const handle = msg.handle.toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid handle");
      const { allowedAuthors } = await loadSettings();
      if (!allowedAuthors.includes(handle)) await saveSettings({ allowedAuthors: [...allowedAuthors, handle] });
      return null;
    }
    case "getStatus":
      void updateBadge();
      return {
        settings: await loadSettings(),
        hasKey: (await getApiKey()) !== null,
        connection: await getConnection(),
        usage: await getUsage(),
        recentBlocked: await getRecentBlocked(),
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
  void updateBadge();
  const config = await contentConfig();
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  for (const tab of tabs) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "configChanged", config }).catch(() => {});
  }
});

async function init() {
  await restrictStorageAccess();
  await cachePrune();
  await chrome.action.setBadgeBackgroundColor({ color: "#536471" });
  await updateBadge();
}
// The daily count resets at midnight UTC; refresh the badge so it doesn't show yesterday's number.
setInterval(() => void updateBadge(), 60_000);
chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());
void init();
