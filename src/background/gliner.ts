import { FILTER_LABELS, RULE_LABELS, THRESHOLDS } from "../shared/settings.ts";
import type { PostPayload, Settings } from "../shared/types.ts";
import { backoff, type RuleMeta } from "./jev.ts";

// Fastino's hosted GLiNER2.5 (OpenAI-style chat completions with a GLiNER schema).
// GLiNER reads the task name and the label names, so unlike Jev the wording of
// both carries the question. There is no free-text prompt field.
export const FASTINO_ENDPOINT = "https://api.fastino.ai/v1/chat/completions";
/** The only GLiNER2.5 model in Fastino's hosted catalog as of 2026-09-24. */
export const GLINER_MODEL = "fastino/gliner2.5-multi-v1";
/** Bump whenever head wording or item text changes; it is part of the cache key. */
export const GLINER_PROMPT_VERSION = "gliner-2026-09-24.2";

/**
 * One single-label head. P(positive) is the confidence when the positive label
 * wins. With one negative label the softmax is two-way, so P = 1 - confidence
 * otherwise; with several competing labels (topic exceptions) P is taken as 0.
 */
export interface Head {
  task: string;
  positive: string;
  negatives: string[];
}

/** One request: one text, one head. Heads are asked separately because combining them raised refusals and cross-talk. */
export interface GlinerItem {
  ruleId: string;
  text: string;
  head: Head;
}

export interface GlinerRequest {
  model: string;
  items: GlinerItem[];
}

// Wordings chosen on a small hand-labeled spot check plus live tests (see README):
// named labels separated rage bait and topics well. No wording separated
// "LLM slop" (on live posts it scored backwards), so GLiNER does not offer it.
const RAGE: Head = { task: "tone", positive: "rage bait", negatives: ["not rage bait"] };
const VIDEO: Head = { task: "video", positive: "low-value AI-generated video", negatives: ["other video"] };

/** Filters GLiNER cannot run; the UI says to switch to Jev for these. */
export const GLINER_UNSUPPORTED: ReadonlySet<string> = new Set(["llm_slop"]);

function ownText(post: PostPayload): string {
  const parts = [post.text.trim()];
  if (post.mediaLabels.length) parts.push(`[Media: ${post.mediaLabels.join("; ")}]`);
  if (post.hasVideo) parts.push("[Video attached]");
  return parts.filter(Boolean).join("\n");
}

export function buildGlinerRequest(post: PostPayload, settings: Settings): { body: GlinerRequest; rules: RuleMeta[] } {
  const thresholds = THRESHOLDS.gliner[settings.sensitivity];
  const rules: RuleMeta[] = [];
  const items: GlinerItem[] = [];
  const own = ownText(post);
  const quotedText = post.quotedText?.trim() ?? "";
  // Topics look at the whole post, so they need the quoted text too.
  const whole = [own, quotedText && `[Quoted post] ${quotedText}`].filter(Boolean).join("\n");

  if (settings.filters.rage_bait && post.text.trim()) {
    items.push({ ruleId: "rage_bait", text: own, head: RAGE });
    rules.push({ ruleId: "rage_bait", label: FILTER_LABELS.rage_bait, threshold: thresholds.rage_bait });
  }
  if (settings.filters.rage_bait && quotedText) {
    items.push({ ruleId: "rage_bait_quoted", text: quotedText, head: RAGE });
    rules.push({ ruleId: "rage_bait_quoted", label: RULE_LABELS.rage_bait_quoted, threshold: thresholds.rage_bait });
  }
  if (settings.filters.ai_video_slop && post.hasVideo) {
    items.push({ ruleId: "ai_video_slop", text: own, head: VIDEO });
    rules.push({ ruleId: "ai_video_slop", label: FILTER_LABELS.ai_video_slop, threshold: thresholds.ai_video_slop });
  }
  for (const topic of settings.topics) {
    const name = topic.name.trim();
    if (!topic.enabled || !name || !whole) continue;
    const ruleId = `topic:${topic.id}`;
    const exceptions = topic.exceptions.trim();
    items.push({
      ruleId,
      text: whole,
      head: { task: `topic: ${name}`, positive: name, negatives: exceptions ? [exceptions, "other topic"] : ["other topic"] },
    });
    rules.push({ ruleId, label: `Topic: ${name}`, threshold: thresholds.topic });
  }
  return { body: { model: GLINER_MODEL, items }, rules };
}

// ---- API client ----

export class GlinerError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export interface GlinerResult {
  model: string;
  /** P(positive) per rule id. Refused items contribute nothing. */
  probabilities: Record<string, number>;
  /** True when the provider refused at least one item under its usage policy. */
  refused: boolean;
  usage: { input_tokens: number; output_tokens: number };
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const DEFAULT_BASE_DELAY_MS = 500; // mutation-ignore: timing only, not observable in tests

interface CallOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

type ItemOutcome =
  | { refused: true }
  | { refused: false; model: string; p: number; usage: { input_tokens: number; output_tokens: number } };

async function callItem(apiKey: string, model: string, item: GlinerItem, opts: Required<CallOptions>): Promise<ItemOutcome> {
  const schema = { classifications: [{ task: item.head.task, labels: [item.head.positive, ...item.head.negatives] }] };
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: item.text }],
    schema,
    include_confidence: true,
  });
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await opts.fetchImpl(FASTINO_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch {
      if (attempt >= opts.maxAttempts) throw new GlinerError("Network error reaching Fastino", null);
      await opts.sleepImpl(backoff(attempt, opts.baseDelayMs));
      continue;
    }
    if (res.ok) return { refused: false, ...parseResponse(await res.json(), item.head) };
    if (res.status === 400 && (await isPolicyRefusal(res))) return { refused: true };
    if (RETRYABLE.has(res.status) && attempt < opts.maxAttempts) {
      await opts.sleepImpl(backoff(attempt, opts.baseDelayMs));
      continue;
    }
    // Never include the request (it carries the key header) in errors or logs.
    throw new GlinerError(`Fastino returned HTTP ${res.status}`, res.status);
  }
}

async function isPolicyRefusal(res: Response): Promise<boolean> {
  try {
    const text = await res.text();
    return /usage policy/i.test(text);
  } catch {
    return false;
  }
}

/** Validate one chat-completions response and turn its head into P(positive). */
export function parseResponse(
  raw: unknown,
  head: Head,
): { model: string; p: number; usage: { input_tokens: number; output_tokens: number } } {
  const r = raw as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const content = r?.choices?.[0]?.message?.content;
  if (!r || typeof r.model !== "string" || typeof content !== "string") {
    throw new GlinerError("Malformed Fastino response", null);
  }
  let parsed: Record<string, { label?: unknown; confidence?: unknown }>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new GlinerError("Fastino response content is not JSON", null);
  }
  const a = parsed?.[head.task];
  const c = a?.confidence;
  if (typeof c !== "number" || !(c >= 0 && c <= 1)) throw new GlinerError(`Missing or invalid answer for ${head.task}`, null);
  let p: number;
  if (a?.label === head.positive) p = c;
  else if (typeof a?.label === "string" && head.negatives.includes(a.label)) p = head.negatives.length === 1 ? 1 - c : 0;
  else throw new GlinerError(`Unexpected label for ${head.task}`, null);
  return {
    model: r.model,
    p,
    usage: { input_tokens: r.usage?.prompt_tokens ?? 0, output_tokens: r.usage?.completion_tokens ?? 0 },
  };
}

export async function callGliner(apiKey: string, req: GlinerRequest, options: CallOptions = {}): Promise<GlinerResult> {
  const opts: Required<CallOptions> = {
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    fetchImpl: options.fetchImpl ?? fetch,
    sleepImpl: options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const outcomes = await Promise.all(req.items.map((item) => callItem(apiKey, req.model, item, opts)));

  const result: GlinerResult = { model: req.model, probabilities: {}, refused: false, usage: { input_tokens: 0, output_tokens: 0 } };
  outcomes.forEach((o, i) => {
    if (o.refused) {
      result.refused = true;
      return;
    }
    result.model = o.model;
    result.probabilities[req.items[i].ruleId] = o.p;
    result.usage.input_tokens += o.usage.input_tokens;
    result.usage.output_tokens += o.usage.output_tokens;
  });
  return result;
}
