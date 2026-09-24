import type { BuiltInFilterId, Sensitivity, Settings } from "./types.ts";

export const FILTER_LABELS: Record<BuiltInFilterId, string> = {
  rage_bait: "Rage bait",
  llm_slop: "LLM slop",
  ai_video_slop: "AI video slop",
};

export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

/**
 * Placeholder thresholds on the Noul yes-probability. These are NOT calibrated:
 * the Evaluation milestone replaces them with per-category values tuned on a
 * labeled set (see docs/SPEC.md section 7). Higher threshold = hides less.
 */
export const THRESHOLDS: Record<Sensitivity, Record<BuiltInFilterId | "topic", number>> = {
  conservative: { rage_bait: 0.9, llm_slop: 0.92, ai_video_slop: 0.93, topic: 0.88 },
  balanced: { rage_bait: 0.8, llm_slop: 0.85, ai_video_slop: 0.88, topic: 0.75 },
  aggressive: { rage_bait: 0.65, llm_slop: 0.72, ai_video_slop: 0.8, topic: 0.6 },
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  disclosureAccepted: false,
  filters: { rage_bait: true, llm_slop: true, ai_video_slop: false },
  sensitivity: "balanced",
  topics: [],
  allowedAuthors: [],
  dailyRequestLimit: 1000,
  concealWhilePending: false,
  concealTimeoutMs: 2500,
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
