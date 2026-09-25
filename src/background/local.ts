import { FILTER_LABELS, RULE_LABELS, THRESHOLDS } from "../shared/settings.ts";
import type { PostPayload, Settings } from "../shared/types.ts";
import type { RuleMeta } from "./jev.ts";

// GLiNER2.5-Decide running on this computer (see local-server/). The server
// runs each task in its own pass and returns the winning label and confidence.
// Like hosted GLiNER, the task name and label names carry the question.
export const LOCAL_PROMPT_VERSION = "local-2026-09-24.1";
export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8765";
const REQUEST_TIMEOUT_MS = 20_000; // mutation-ignore: timing only, not observable in tests

/** Labels are a list, or a map of label to description. */
export interface LocalTask {
  labels: string[] | Record<string, string>;
  positive: string;
}

export interface LocalItem {
  text: string;
  /** Keyed by task name (sent to the model); each maps to one rule. */
  tasks: Record<string, LocalTask & { ruleId: string }>;
}

export interface LocalRequest {
  items: LocalItem[];
}

// Wordings chosen on a small hand-labeled spot check with the real model (see
// README): named labels for rage bait and topics; for slop, only named labels
// with descriptions separated generic filler from real posts.
const RAGE: LocalTask = { labels: ["rage bait", "not rage bait"], positive: "rage bait" };
const SLOP: LocalTask = {
  labels: {
    "generic filler": "template-like motivational or listicle writing with no specifics",
    "specific content": "concrete facts, personal experience, or a real argument, or casual chat",
  },
  positive: "generic filler",
};
const VIDEO: LocalTask = { labels: ["low-value AI-generated video", "other video"], positive: "low-value AI-generated video" };

function ownText(post: PostPayload): string {
  const parts = [post.text.trim()];
  if (post.mediaLabels.length) parts.push(`[Media: ${post.mediaLabels.join("; ")}]`);
  if (post.hasVideo) parts.push("[Video attached]");
  return parts.filter(Boolean).join("\n");
}

export function buildLocalRequest(post: PostPayload, settings: Settings): { body: LocalRequest; rules: RuleMeta[] } {
  const thresholds = THRESHOLDS.local[settings.sensitivity];
  const rules: RuleMeta[] = [];
  const byText = new Map<string, LocalItem["tasks"]>();
  const add = (text: string, name: string, task: LocalTask, rule: RuleMeta) => {
    const tasks = byText.get(text) ?? {};
    tasks[name] = { ...task, ruleId: rule.ruleId };
    byText.set(text, tasks);
    rules.push(rule);
  };

  const own = ownText(post);
  const quotedText = post.quotedText?.trim() ?? "";
  const whole = [own, quotedText && `[Quoted post] ${quotedText}`].filter(Boolean).join("\n");
  const hasOwnText = post.text.trim() !== "";

  if (settings.filters.rage_bait && hasOwnText) {
    add(own, "tone", RAGE, { ruleId: "rage_bait", label: FILTER_LABELS.rage_bait, threshold: thresholds.rage_bait });
  }
  if (settings.filters.rage_bait && quotedText) {
    add(quotedText, "tone", RAGE, { ruleId: "rage_bait_quoted", label: RULE_LABELS.rage_bait_quoted, threshold: thresholds.rage_bait });
  }
  if (settings.filters.llm_slop && hasOwnText) {
    add(own, "quality", SLOP, { ruleId: "llm_slop", label: FILTER_LABELS.llm_slop, threshold: thresholds.llm_slop });
  }
  if (settings.filters.ai_video_slop && post.hasVideo) {
    add(own, "video", VIDEO, { ruleId: "ai_video_slop", label: FILTER_LABELS.ai_video_slop, threshold: thresholds.ai_video_slop });
  }
  for (const topic of settings.topics) {
    const name = topic.name.trim();
    if (!topic.enabled || !name || !whole) continue;
    const exceptions = topic.exceptions.trim();
    const labels = exceptions ? [name, exceptions, "other topic"] : [name, "other topic"];
    add(whole, `topic: ${name}`, { labels, positive: name }, { ruleId: `topic:${topic.id}`, label: `Topic: ${name}`, threshold: thresholds.topic });
  }

  return { body: { items: [...byText].map(([text, tasks]) => ({ text, tasks })) }, rules };
}

// ---- endpoint ----

/** The local server must be plain http on this machine; anything else is refused. */
export function normalizeEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw); // the URL parser already strips surrounding whitespace
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export class LocalError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

interface CallOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function request(url: string, init: RequestInit, opts: CallOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } catch {
    throw new LocalError("Local server not reachable. Is it running?", null);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new LocalError(`Local server returned HTTP ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new LocalError("Local server sent a malformed response", null);
  }
}

export interface LocalHealth {
  model: string;
  device: string;
}

export async function checkHealth(endpoint: string, opts: CallOptions = {}): Promise<LocalHealth> {
  const origin = normalizeEndpoint(endpoint);
  if (!origin) throw new LocalError("The local endpoint must be http://127.0.0.1:<port> or http://localhost:<port>", null);
  const raw = (await request(`${origin}/v1/health`, { method: "GET" }, opts)) as { ok?: unknown; model?: unknown; device?: unknown } | null;
  if (raw?.ok !== true || typeof raw.model !== "string" || !raw.model) {
    throw new LocalError("Local server sent a malformed health response", null);
  }
  return { model: raw.model, device: typeof raw.device === "string" ? raw.device : "unknown" };
}

/** P(positive) from a winning label and its confidence. */
export function positiveProbability(task: LocalTask, label: unknown, confidence: unknown): number {
  const names = Array.isArray(task.labels) ? task.labels : Object.keys(task.labels);
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
    throw new LocalError("Local server sent an invalid confidence", null);
  }
  if (label === task.positive) return confidence;
  if (typeof label !== "string" || !names.includes(label)) throw new LocalError("Local server sent an unexpected label", null);
  // Two labels: a softmax, so the loser's share is 1 - confidence. More labels: unknown split, so 0.
  return names.length === 2 ? 1 - confidence : 0;
}

export interface LocalResult {
  model: string;
  probabilities: Record<string, number>;
  refused: false;
  usage: { input_tokens: number; output_tokens: number };
}

export async function callLocal(endpoint: string, req: LocalRequest, opts: CallOptions = {}): Promise<LocalResult> {
  const origin = normalizeEndpoint(endpoint);
  if (!origin) throw new LocalError("The local endpoint must be http://127.0.0.1:<port> or http://localhost:<port>", null);
  const responses = await Promise.all(
    req.items.map((item) =>
      request(
        `${origin}/v1/classify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: item.text,
            tasks: Object.fromEntries(Object.entries(item.tasks).map(([name, t]) => [name, { labels: t.labels }])),
          }),
        },
        opts,
      ),
    ),
  );
  const result: LocalResult = { model: "", probabilities: {}, refused: false, usage: { input_tokens: 0, output_tokens: 0 } };
  responses.forEach((raw, i) => {
    const r = raw as { model?: unknown; results?: Record<string, { label?: unknown; confidence?: unknown }> } | null;
    if (!r || typeof r.model !== "string" || typeof r.results !== "object" || r.results === null) {
      throw new LocalError("Local server sent a malformed response", null);
    }
    result.model = r.model;
    for (const [name, task] of Object.entries(req.items[i].tasks)) {
      const answer = r.results[name];
      result.probabilities[task.ruleId] = positiveProbability(task, answer?.label, answer?.confidence);
    }
  });
  return result;
}
