import type { Backend, BuiltInFilterId, Sensitivity, Settings } from "./types.ts";

export const FILTER_LABELS: Record<BuiltInFilterId, string> = {
  rage_bait: "Rage bait",
  llm_slop: "LLM slop",
  ai_video_slop: "AI video slop",
};

/** Labels for every rule id the classifier can report, built-in or derived. */
export const RULE_LABELS: Record<string, string> = {
  ...FILTER_LABELS,
  rage_bait_quoted: "Rage bait (quoted post)",
  provider_refused: "Refused by Fastino",
};

export const BACKEND_LABELS: Record<Backend, string> = {
  gliner: "GLiNER2.5 (Fastino)",
  jev: "Jev (TypeSafe)",
};

export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

export type ThresholdTable = Record<Sensitivity, Record<BuiltInFilterId | "topic", number>>;

/**
 * Placeholder thresholds on each model's yes-probability, per backend because
 * the two models' scores are not on the same scale. NOT calibrated: the
 * Evaluation milestone replaces them with per-category values tuned on a labeled
 * set (see docs/SPEC.md section 7). Higher threshold = hides less.
 */
export const THRESHOLDS: Record<Backend, ThresholdTable> = {
  jev: {
    conservative: { rage_bait: 0.9, llm_slop: 0.92, ai_video_slop: 0.93, topic: 0.88 }, // mutation-ignore: tunable default
    balanced: { rage_bait: 0.8, llm_slop: 0.85, ai_video_slop: 0.88, topic: 0.75 }, // mutation-ignore: tunable default
    aggressive: { rage_bait: 0.65, llm_slop: 0.72, ai_video_slop: 0.8, topic: 0.6 }, // mutation-ignore: tunable default
  },
  // GLiNER scores are sharp (mostly near 0 or 1) on a small spot check, and its
  // slop judgments were weak, so slop needs a higher bar.
  gliner: {
    conservative: { rage_bait: 0.9, llm_slop: 0.97, ai_video_slop: 0.93, topic: 0.9 }, // mutation-ignore: tunable default
    balanced: { rage_bait: 0.75, llm_slop: 0.9, ai_video_slop: 0.85, topic: 0.7 }, // mutation-ignore: tunable default
    aggressive: { rage_bait: 0.55, llm_slop: 0.8, ai_video_slop: 0.75, topic: 0.5 }, // mutation-ignore: tunable default
  },
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  disclosureAccepted: false,
  backend: "gliner",
  hideProviderRefusals: true,
  filters: { rage_bait: true, llm_slop: true, ai_video_slop: false }, // mutation-ignore: tunable default
  sensitivity: "balanced",
  topics: [],
  allowedAuthors: [],
  dailyRequestLimit: 1000, // mutation-ignore: tunable default
  concealWhilePending: false,
  concealTimeoutMs: 2500, // mutation-ignore: tunable default
  keyStorageMode: "session",
};

const SETTINGS_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function isSettingsChange(changes: Record<string, chrome.storage.StorageChange>): boolean {
  return SETTINGS_KEY in changes;
}

export function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
