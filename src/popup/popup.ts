import { FILTER_LABELS, saveSettings } from "../shared/settings.ts";
import type { BuiltInFilterId, Message, Sensitivity, StatusResponse } from "../shared/types.ts";

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
  const { settings, hasKey, connection, usage } = await send<StatusResponse>({ type: "getStatus" });
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
    FILTER_LABELS[ruleId as BuiltInFilterId] ??
    settings.topics.find((t) => `topic:${t.id}` === ruleId)?.name ??
    "Removed topic";
  const hidden = Object.entries(usage.hiddenByRule);
  rows(
    $("#hidden"),
    hidden.length ? hidden.map(([id, n]) => [labelFor(id), n]) : [["Nothing hidden yet", ""]],
  );

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

document.querySelectorAll(".open-options").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
  }),
);
chrome.storage.onChanged.addListener(() => void render());
void render();
