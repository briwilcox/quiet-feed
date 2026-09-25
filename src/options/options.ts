import { loadSettings, saveSettings } from "../shared/settings.ts";
import { normalizeEndpoint } from "../background/local.ts";
import { BUILD_ID } from "../shared/build.ts";
import { describeModel, localModelReady, STALE_WORKER_MESSAGE, workerIsStale } from "../shared/format.ts";
import type { Backend, ConnectionStatus, CustomTopic, KeyStorageMode, KeyedBackend, Message, StatusResponse } from "../shared/types.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function send<T>(msg: Message): Promise<T> {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? "No response");
  return res.result as T;
}

const statusEl = (provider: Backend) =>
  provider === "local"
    ? $("#local-status")
    : document.querySelector<HTMLElement>(`.key-block[data-provider="${provider}"] [data-role="status"]`)!;

function showConnection(provider: Backend, c: ConnectionStatus) {
  const el = statusEl(provider);
  el.className = c.state === "ok" ? "ok" : c.state === "error" ? "err" : "muted";
  el.textContent =
    c.state === "ok" ? `Connected. Model: ${describeModel(c)}`
    : c.state === "error" ? `Connection failed: ${c.message}`
    : c.state === "no_key" ? "No key saved."
    : provider === "local" ? "Not tested yet."
    : "Key saved, not tested.";
}

async function render() {
  const { settings, connections, buildId } = await send<StatusResponse>({ type: "getStatus" });
  const stale = workerIsStale(buildId, BUILD_ID);
  $("#stale").hidden = !stale;
  $("#stale").textContent = stale ? STALE_WORKER_MESSAGE : "";

  document.querySelectorAll<HTMLInputElement>('input[name="backend"]').forEach((r) => {
    r.checked = r.value === settings.backend;
    r.onchange = async () => {
      if (!r.checked) return;
      const backend = r.value as Backend;
      if (backend !== "local") return void saveSettings({ backend });
      // Only switch to the local model once its server answers.
      statusEl("local").textContent = "Checking the local server…";
      const c = await send<ConnectionStatus>({ type: "testConnection", provider: "local" });
      showConnection("local", c);
      if (localModelReady(c)) {
        await saveSettings({ backend: "local" });
      } else {
        if (c.state === "ok") {
          // An out-of-date worker answered for a different model.
          statusEl("local").className = "err";
          statusEl("local").textContent = STALE_WORKER_MESSAGE;
        }
        r.checked = false;
        await render(); // restores the previous selection
      }
    };
  });
  const local = connections.local;
  $("#local-model").textContent = local.state === "ok" ? `(${describeModel(local)})` : "(server not connected)";
  const endpoint = $<HTMLInputElement>("#local-endpoint");
  endpoint.value = settings.localEndpoint;
  endpoint.onchange = async () => {
    const normalized = normalizeEndpoint(endpoint.value);
    if (!normalized) {
      statusEl("local").className = "err";
      statusEl("local").textContent = "Use http://127.0.0.1:<port> or http://localhost:<port>.";
      endpoint.value = settings.localEndpoint;
      return;
    }
    await saveSettings({ localEndpoint: normalized });
  };
  const refusals = $<HTMLInputElement>("#refusals");
  refusals.checked = settings.hideProviderRefusals;
  refusals.onchange = () => saveSettings({ hideProviderRefusals: refusals.checked });

  const disclosure = $<HTMLInputElement>("#disclosure");
  disclosure.checked = settings.disclosureAccepted;
  disclosure.onchange = () =>
    saveSettings({ disclosureAccepted: disclosure.checked, ...(!disclosure.checked && { enabled: false }) });

  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
    r.checked = r.value === settings.keyStorageMode;
  });
  showConnection("gliner", connections.gliner);
  showConnection("local", connections.local);
  showConnection("jev", connections.jev);

  renderTopics(settings.topics);
  renderAuthors(settings.allowedAuthors);

  const limit = $<HTMLInputElement>("#limit");
  limit.value = String(settings.dailyRequestLimit);
  limit.onchange = () => saveSettings({ dailyRequestLimit: Math.max(0, Number(limit.value) || 0) });

  const conceal = $<HTMLInputElement>("#conceal");
  conceal.checked = settings.concealWhilePending;
  conceal.onchange = () => saveSettings({ concealWhilePending: conceal.checked });
}

function renderTopics(topics: CustomTopic[]) {
  const update = async (id: string, patch: Partial<CustomTopic>) => {
    const s = await loadSettings();
    await saveSettings({ topics: s.topics.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  };
  $("#topics").replaceChildren(
    ...topics.map((t) => {
      const box = document.createElement("div");
      box.className = "topic";
      const field = (placeholder: string, key: "name" | "description" | "exceptions") => {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = placeholder;
        input.value = t[key];
        input.onchange = () => update(t.id, { [key]: input.value });
        return input;
      };
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = t.enabled;
      enabled.onchange = () => update(t.id, { enabled: enabled.checked });
      const enabledRow = document.createElement("label");
      enabledRow.className = "row";
      enabledRow.append("Enabled", enabled);
      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Remove topic";
      remove.onclick = async () => {
        const s = await loadSettings();
        await saveSettings({ topics: s.topics.filter((x) => x.id !== t.id) });
      };
      box.append(
        field("Topic, e.g. Apple product rumors", "name"),
        field("Description (optional)", "description"),
        field("Exceptions to keep visible (optional)", "exceptions"),
        enabledRow,
        remove,
      );
      return box;
    }),
  );
}

function renderAuthors(authors: string[]) {
  const table = $<HTMLTableElement>("#authors");
  if (authors.length === 0) {
    table.innerHTML = '<tr><td class="muted">None yet. Use "Always allow" on a hidden post.</td></tr>';
    return;
  }
  table.replaceChildren(
    ...authors.map((a) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = `@${a}`;
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.textContent = "Remove";
      btn.onclick = () => saveSettings({ allowedAuthors: authors.filter((x) => x !== a) });
      td.append(btn);
      tr.append(name, td);
      return tr;
    }),
  );
}

document.querySelectorAll<HTMLElement>(".key-block").forEach((block) => {
  const provider = block.dataset.provider as KeyedBackend;
  const input = block.querySelector<HTMLInputElement>("input")!;
  const button = (action: string) => block.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  const testing = () => (statusEl(provider).textContent = "Testing…");

  button("save").addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key) return;
    const mode = (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "session") as KeyStorageMode;
    await saveSettings({ keyStorageMode: mode });
    input.value = "";
    testing();
    showConnection(provider, await send<ConnectionStatus>({ type: "saveKey", provider, key, mode }));
  });
  button("test").addEventListener("click", async () => {
    testing();
    showConnection(provider, await send<ConnectionStatus>({ type: "testConnection", provider }));
  });
  button("delete").addEventListener("click", async () => {
    await send({ type: "deleteKey", provider });
    const s = await loadSettings();
    if (s.backend === provider) await saveSettings({ enabled: false });
    await render();
  });
});

$("#local-test").addEventListener("click", async () => {
  statusEl("local").textContent = "Checking the local server…";
  showConnection("local", await send<ConnectionStatus>({ type: "testConnection", provider: "local" }));
  await render();
});

$("#add-topic").addEventListener("click", async () => {
  const s = await loadSettings();
  await saveSettings({
    topics: [...s.topics, { id: crypto.randomUUID(), name: "", description: "", exceptions: "", enabled: true }],
  });
});

$("#clear-cache").addEventListener("click", async () => {
  await send({ type: "clearCache" });
});

// Re-render on settings changes, but not while the user is typing in a topic field.
chrome.storage.onChanged.addListener((changes) => {
  if ("settings" in changes && !(document.activeElement instanceof HTMLInputElement && document.activeElement.type === "text")) {
    void render();
  }
});
void render();
