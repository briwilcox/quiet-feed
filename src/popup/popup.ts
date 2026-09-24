import { RULE_LABELS, saveSettings } from "../shared/settings.ts";
import type { BlockedPost, BuiltInFilterId, Message, Sensitivity, StatusResponse } from "../shared/types.ts";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

async function send<T>(msg: Message): Promise<T> {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? "No response");
  return res.result as T;
}

function rows(table: HTMLTableElement, data: Array<[string, string | number]>) {
  table.replaceChildren(
    ...data.map(([k, v]) => {
      const tr = document.createElement("tr");
      const a = document.createElement("td");
      const b = document.createElement("td");
      a.textContent = k;
      b.textContent = String(v);
      tr.append(a, b);
      return tr;
    }),
  );
}

async function render() {
  const { settings, hasKey, connection, usage, recentBlocked } = await send<StatusResponse>({ type: "getStatus" });
  const ready = hasKey && settings.disclosureAccepted;

  $("#setup").hidden = ready;
  const enabled = $<HTMLInputElement>("#enabled");
  enabled.checked = settings.enabled;
  enabled.disabled = !ready;
  enabled.onchange = () => saveSettings({ enabled: enabled.checked });

  document.querySelectorAll<HTMLInputElement>("[data-filter]").forEach((box) => {
    const id = box.dataset.filter as BuiltInFilterId;
    box.checked = settings.filters[id];
    box.onchange = () => saveSettings({ filters: { ...settings.filters, [id]: box.checked } });
  });

  $("#topics").replaceChildren(
    ...settings.topics.map((t) => {
      const label = document.createElement("label");
      label.className = "row";
      label.textContent = `Topic: ${t.name}`;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = t.enabled;
      box.onchange = () =>
        saveSettings({ topics: settings.topics.map((x) => (x.id === t.id ? { ...x, enabled: box.checked } : x)) });
      label.append(box);
      return label;
    }),
  );

  const sens = $<HTMLSelectElement>("#sensitivity");
  sens.value = settings.sensitivity;
  sens.onchange = () => saveSettings({ sensitivity: sens.value as Sensitivity });

  const labelFor = (ruleId: string) =>
    RULE_LABELS[ruleId] ??
    settings.topics.find((t) => `topic:${t.id}` === ruleId)?.name ??
    "Removed topic";
  const blocked = usage.blocked ?? 0;
  const checked = usage.checked ?? 0;
  $("#blocked").textContent = blocked.toLocaleString();
  $("#checked").textContent = checked.toLocaleString();
  $("#rate").textContent = checked ? `(${((blocked / checked) * 100).toFixed(1)}%)` : "";

  const hidden = Object.entries(usage.hiddenByRule ?? {});
  rows(
    $("#hidden"),
    hidden.length ? hidden.map(([id, n]) => [labelFor(id), n]) : [["Nothing hidden yet", ""]],
  );

  renderRecent(recentBlocked ?? []);

  const conn = $("#connection");
  conn.className =
    connection.state === "ok" ? "ok" : connection.state === "error" ? "err" : "muted";
  conn.textContent = {
    no_key: "No API key saved",
    untested: "Key saved, not tested",
    ok: connection.state === "ok" ? `Connected (${connection.model})` : "",
    error: connection.state === "error" ? `Error: ${connection.message}` : "",
  }[connection.state];

  rows($("#usage"), [
    ["Requests today", `${usage.requests} / ${settings.dailyRequestLimit}`],
    ["Cache hits", usage.cacheHits],
    ["Tokens in / out", `${usage.inputTokens} / ${usage.outputTokens}`],
    ["Errors", usage.errors],
    ["Last latency", usage.lastLatencyMs === null ? "n/a" : `${usage.lastLatencyMs} ms`],
  ]);
}

function renderRecent(list: BlockedPost[]) {
  $("#clear-recent").hidden = list.length === 0;
  if (list.length === 0) {
    $("#recent").innerHTML = '<p class="muted">Nothing blocked since the browser opened.</p>';
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "recent";
  for (const b of list) {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    const who = document.createElement("span");
    who.textContent = `@${b.authorHandle} · ${b.labels.join(", ")}`;
    const open = document.createElement("a");
    open.href = `https://x.com/${encodeURIComponent(b.authorHandle)}/status/${encodeURIComponent(b.statusId)}`;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open";
    meta.append(who, open);
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    snippet.textContent = b.snippet || "(no text)";
    li.append(meta, snippet);
    ul.append(li);
  }
  $("#recent").replaceChildren(ul);
}

$("#clear-recent").addEventListener("click", async () => {
  await send({ type: "clearRecentBlocked" });
  void render();
});

document.querySelectorAll(".open-options").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  }),
);
function renderSafely() {
  render().then(
    () => ($("#error").hidden = true),
    (err: unknown) => {
      // Usually means the popup (read fresh from disk) is newer than the running service worker.
      const el = $("#error");
      el.hidden = false;
      el.textContent = `Couldn't load status (${err instanceof Error ? err.message : String(err)}). If you just rebuilt, click reload on the extension, then reload your X tabs.`;
    },
  );
}

chrome.storage.onChanged.addListener(() => renderSafely());
renderSafely();
