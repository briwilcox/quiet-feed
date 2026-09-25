import { isActive, isSettingsChange, loadSettings, saveSettings, todayKey } from "../shared/settings.ts";
import type {
  Backend,
  BlockedPost,
  KeyedBackend,
  ConnectionStatus,
  ContentConfig,
  Decision,
  Message,
  PostPayload,
  Settings,
  StatusResponse,
  UsageStats,
} from "../shared/types.ts";
import { BUILD_ID } from "../shared/build.ts";
import { badgeText } from "./badge.ts";
import { cacheGet, cacheKey, cachePrune, cachePut } from "./cache.ts";
import { applyRefusal, decide, preDecide, visible } from "./decide.ts";
import { buildGlinerRequest, callGliner, GLINER_MODEL, GLINER_PROMPT_VERSION, GlinerError } from "./gliner.ts";
import { deleteApiKey, getApiKey, restrictStorageAccess, saveApiKey } from "./keystore.ts";
import { buildLocalRequest, callLocal, checkHealth, LOCAL_PROMPT_VERSION, LocalError } from "./local.ts";
import { buildRequest, callJev, JEV_MODEL, JevError, PROMPT_VERSION, type RuleMeta } from "./jev.ts";
import { RequestQueue } from "./queue.ts";

/** What every backend returns: scores per rule, plus whether the provider refused the post. */
interface ClassifierResult {
  model: string;
  probabilities: Record<string, number>;
  refused: boolean;
  usage: { input_tokens: number; output_tokens: number };
}

const queue = new RequestQueue<ClassifierResult>(2, 50);
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
    refused: 0,
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

/**
 * Count `calls` against today's requests and report whether they fit under
 * `limit` (null means no limit). It runs in the same serialized chain as every
 * other usage update, so posts arriving together cannot all pass one stale check.
 */
function reserveRequests(calls: number, limit: number | null): Promise<boolean> {
  let reserved = false;
  return updateUsage((u) => {
    if (limit !== null && u.requests + calls > limit) return;
    u.requests += calls;
    reserved = true;
  }).then(() => reserved);
}

class DailyLimitReached extends Error {}

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

async function updateBadge() {
  const [settings, usage] = await Promise.all([loadSettings(), getUsage()]);
  const active = isActive(settings);
  await chrome.action.setBadgeText({ text: active ? badgeText(usage.blocked) : "" });
  await chrome.action.setTitle({
    title: active ? `Quiet Feed: ${usage.blocked} blocked of ${usage.checked} checked today` : "Quiet Feed (off)",
  });
}

const connectionKey = (provider: Backend) => `connection:${provider}`;

async function getConnection(provider: Backend): Promise<ConnectionStatus> {
  if (provider !== "local" && !(await getApiKey(provider))) return { state: "no_key" };
  const key = connectionKey(provider);
  return ((await chrome.storage.session.get(key))[key] as ConnectionStatus) ?? { state: "untested" };
}

// ---- classification ----

interface Prepared {
  rules: RuleMeta[];
  /** Everything that determines the model's answers; hashed for the cache key. */
  body: unknown;
  promptVersion: string;
  /** API calls one classification makes; counted against the daily limit. */
  calls: number;
  run: (apiKey: string) => Promise<ClassifierResult>;
}

/** The model the local server last reported, so a model swap on the same endpoint gets fresh cache keys. */
async function localModel(): Promise<string> {
  const c = await getConnection("local");
  return c.state === "ok" ? c.model : "";
}

async function prepare(post: PostPayload, settings: Settings): Promise<Prepared> {
  if (settings.backend === "local") {
    const { body, rules } = buildLocalRequest(post, settings);
    return {
      rules,
      body: { endpoint: settings.localEndpoint, model: await localModel(), ...body },
      promptVersion: LOCAL_PROMPT_VERSION,
      calls: body.items.length,
      run: () => callLocal(settings.localEndpoint, body),
    };
  }
  if (settings.backend === "jev") {
    const { body, rules } = buildRequest(post, settings);
    return {
      rules,
      body,
      promptVersion: PROMPT_VERSION,
      calls: 1,
      run: async (apiKey) => {
        const r = await callJev(apiKey, body);
        const probabilities = Object.fromEntries(Object.entries(r.answers).map(([id, a]) => [id, a.noul as number]));
        return { model: r.model, probabilities, refused: false, usage: r.usage };
      },
    };
  }
  const { body, rules } = buildGlinerRequest(post, settings);
  return {
    rules,
    body,
    promptVersion: GLINER_PROMPT_VERSION,
    calls: body.items.length,
    run: (apiKey) => callGliner(apiKey, body),
  };
}

async function classify(post: PostPayload): Promise<Decision> {
  const settings = await loadSettings();
  const prepared = await prepare(post, settings);
  const early = preDecide(post, settings, prepared.rules.length > 0);
  if (early) return early;

  const key = await cacheKey(prepared.body, prepared.promptVersion);
  const cached = await cacheGet(key);
  if (cached) {
    await updateUsage((u) => void u.cacheHits++);
    return applyRefusal(decide(prepared.rules, cached.probabilities, settings), cached.refused === true, settings);
  }

  // Local mode needs no key and costs nothing, so the daily limit does not apply.
  const local = settings.backend === "local";
  const apiKey = local ? "" : await getApiKey(settings.backend as KeyedBackend);
  if (!local && !apiKey) return visible("no_key");

  try {
    const res = await queue.run(key, async () => {
      // Reserved inside the queued task so a post shared by two tabs counts once.
      if (!(await reserveRequests(prepared.calls, local ? null : settings.dailyRequestLimit))) {
        throw new DailyLimitReached();
      }
      const started = performance.now();
      const r = await prepared.run(apiKey as string);
      const latency = Math.round(performance.now() - started);
      await updateUsage((u) => {
        u.inputTokens += r.usage.input_tokens;
        u.outputTokens += r.usage.output_tokens;
        u.lastLatencyMs = latency;
        u.lastModel = r.model;
        if (r.refused) u.refused++;
      });
      return r;
    });
    await cachePut(key, { probabilities: res.probabilities, model: res.model, refused: res.refused });
    return applyRefusal(decide(prepared.rules, res.probabilities, settings), res.refused, settings);
  } catch (err) {
    if (err instanceof DailyLimitReached) return visible("daily_limit", "Daily request limit reached.");
    // Any failure leaves the post visible.
    await updateUsage((u) => void u.errors++);
    const message =
      err instanceof JevError || err instanceof GlinerError || err instanceof LocalError ? err.message : "Classification failed";
    return visible("api_error", message);
  }
}

async function testConnection(provider: Backend): Promise<ConnectionStatus> {
  if (provider === "local") {
    let status: ConnectionStatus;
    try {
      const { localEndpoint } = await loadSettings();
      const h = await checkHealth(localEndpoint);
      status = { state: "ok", model: h.model, device: h.device, provider: "local", checkedAt: Date.now() };
    } catch (err) {
      status = {
        state: "error",
        message: err instanceof LocalError ? err.message : "Unknown error",
        provider: "local",
        checkedAt: Date.now(),
      };
    }
    await chrome.storage.session.set({ [connectionKey("local")]: status });
    return status;
  }
  const apiKey = await getApiKey(provider);
  if (!apiKey) return { state: "no_key" };
  let status: ConnectionStatus;
  try {
    const model =
      provider === "jev"
        ? (
            await callJev(
              apiKey,
              {
                model: JEV_MODEL,
                state: "Connection test.",
                questions: { ping: { type: "noul", instructions: { question: "Is this text a connection test?" }, criteria: { true: "Yes", false: "No" } } },
              },
              { maxAttempts: 1 }, // mutation-ignore: 0 and 1 behave identically (one attempt)
            )
          ).model
        : (
            await callGliner(
              apiKey,
              { model: GLINER_MODEL, items: [{ ruleId: "ping", text: "Connection test.", head: { task: "connection test", positive: "yes", negatives: ["no"] } }] },
              { maxAttempts: 1 }, // mutation-ignore: 0 and 1 behave identically (one attempt)
            )
          ).model;
    status = { state: "ok", model, provider, checkedAt: Date.now() };
  } catch (err) {
    status = {
      state: "error",
      message: err instanceof JevError || err instanceof GlinerError ? err.message : "Unknown error",
      provider,
      checkedAt: Date.now(),
    };
  }
  await chrome.storage.session.set({ [connectionKey(provider)]: status });
  return status;
}

async function contentConfig(): Promise<ContentConfig> {
  const s = await loadSettings();
  return {
    active: isActive(s),
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
  if ("provider" in msg) {
    const known = msg.type === "testConnection" ? ["jev", "gliner", "local"] : ["jev", "gliner"];
    if (!known.includes(msg.provider)) throw new Error("Unknown provider");
  }

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
    case "getStatus": {
      void updateBadge();
      const settings = await loadSettings();
      const keys = {
        jev: (await getApiKey("jev")) !== null,
        gliner: (await getApiKey("gliner")) !== null,
      };
      const connections = {
        jev: await getConnection("jev"),
        gliner: await getConnection("gliner"),
        local: await getConnection("local"),
      };
      return {
        buildId: BUILD_ID,
        settings,
        keys,
        hasKey: settings.backend === "local" || keys[settings.backend],
        connection: connections[settings.backend],
        connections,
        usage: await getUsage(),
        recentBlocked: await getRecentBlocked(),
      } satisfies StatusResponse;
    }
    case "saveKey":
      await saveApiKey(msg.provider, msg.key, msg.mode);
      await chrome.storage.session.remove(connectionKey(msg.provider));
      return testConnection(msg.provider);
    case "deleteKey":
      await deleteApiKey(msg.provider);
      await chrome.storage.session.remove(connectionKey(msg.provider));
      return null;
    case "testConnection":
      return testConnection(msg.provider);
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
