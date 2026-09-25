// In-memory stand-in for the parts of the chrome.* API the extension uses.
// Behavior mirrors Chrome where it matters to the code under test: storage
// returns copies, fires onChanged with the area name, and get() accepts a key,
// an array of keys, or null for everything.

type Listener = (...args: any[]) => unknown;

class Event {
  listeners: Listener[] = [];
  addListener(fn: Listener) {
    this.listeners.push(fn);
  }
  fire(...args: unknown[]) {
    for (const fn of this.listeners) fn(...args);
  }
}

class StorageArea {
  data = new Map<string, unknown>();
  accessLevel: string | null = null;
  private readonly name: string;
  private readonly onChanged: Event;

  constructor(name: string, onChanged: Event) {
    this.name = name;
    this.onChanged = onChanged;
  }

  async get(keys: string | string[] | null) {
    const wanted = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of wanted) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }

  async set(items: Record<string, unknown>) {
    const changes: Record<string, { oldValue?: unknown; newValue: unknown }> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.data.get(k), newValue: structuredClone(v) };
      this.data.set(k, structuredClone(v));
    }
    this.onChanged.fire(changes, this.name);
  }

  async remove(keys: string | string[]) {
    const changes: Record<string, { oldValue?: unknown }> = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (!this.data.has(k)) continue;
      changes[k] = { oldValue: this.data.get(k) };
      this.data.delete(k);
    }
    if (Object.keys(changes).length) this.onChanged.fire(changes, this.name);
  }

  async setAccessLevel({ accessLevel }: { accessLevel: string }) {
    this.accessLevel = accessLevel;
  }
}

export const EXTENSION_ID = "qf-test-extension";
export const EXTENSION_PAGE = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` };
export const X_TAB = { id: EXTENSION_ID, url: "https://x.com/home", tab: { id: 7 } };

export function createChrome() {
  const onChanged = new Event();
  const onMessage = new Event();
  const badge = { text: "", title: "", color: "" };
  const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
  let openTabs: Array<{ id?: number; url: string }> = [];

  const chrome = {
    storage: {
      onChanged,
      local: new StorageArea("local", onChanged),
      session: new StorageArea("session", onChanged),
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (p: string) => `chrome-extension://${EXTENSION_ID}/${p}`,
      onMessage,
      onInstalled: new Event(),
      onStartup: new Event(),
    },
    tabs: {
      async query({ url }: { url: string[] }) {
        return openTabs.filter((t) => url.some((pattern) => t.url.startsWith(pattern.replace("*", ""))));
      },
      async sendMessage(tabId: number, msg: unknown) {
        tabMessages.push({ tabId, msg });
      },
    },
    action: {
      async setBadgeText({ text }: { text: string }) {
        badge.text = text;
      },
      async setTitle({ title }: { title: string }) {
        badge.title = title;
      },
      async setBadgeBackgroundColor({ color }: { color: string }) {
        badge.color = color;
      },
    },
  };

  /** Deliver a message the way chrome.runtime.sendMessage would, from `sender`. */
  function send<T = unknown>(msg: unknown, sender: { id: string; url?: string } = EXTENSION_PAGE) {
    return new Promise<{ ok: boolean; result?: T; error?: string }>((resolve, reject) => {
      let handled = false;
      for (const fn of onMessage.listeners) {
        if (fn(msg, sender, resolve) === true) handled = true;
      }
      if (!handled) reject(new Error("No listener handled the message"));
    });
  }

  return {
    chrome,
    send,
    badge,
    tabMessages,
    setOpenTabs(tabs: Array<{ id?: number; url: string }>) {
      openTabs = tabs;
    },
  };
}

/** Install a fresh stub as globalThis.chrome. */
export function installChrome() {
  const stub = createChrome();
  (globalThis as any).chrome = stub.chrome;
  return stub;
}

/** Scriptable fetch replacement that records every request. */
export function installFetch(handler: (body: any, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  (globalThis as any).fetch = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, init, body });
    return handler(body, init);
  };
  return calls;
}

/** A Jev response answering every question in `body` with `p` (or per-id overrides). */
export function jevAnswer(body: any, p: number | Record<string, number>, model = "jev-test-1") {
  const answers = Object.fromEntries(
    Object.keys(body.questions).map((id) => [id, { type: "noul", noul: typeof p === "number" ? p : (p[id] ?? 0) }]),
  );
  return Response.json({ model, answers, usage: { input_tokens: 100, output_tokens: 10 } });
}

/** Let queued microtasks and storage chains settle. */
export const flush = () => new Promise((r) => setTimeout(r, 0));
