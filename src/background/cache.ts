import type { JevRequest } from "./jev.ts";

/** Cached raw judgments. Only a hash of the post is kept, never its text. */
export interface CacheEntry {
  probabilities: Record<string, number>;
  model: string;
  expiresAt: number;
}

const PREFIX = "cache:";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Keyed by post content, question definitions, prompt version, and model.
 * Thresholds are applied after lookup, so a sensitivity change reuses entries.
 */
export async function cacheKey(body: JevRequest, promptVersion: string): Promise<string> {
  const material = JSON.stringify([promptVersion, body.model, body.state, body.questions]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return (
    PREFIX +
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

export async function cacheGet(key: string, now = Date.now()): Promise<CacheEntry | null> {
  const entry = (await chrome.storage.local.get(key))[key] as CacheEntry | undefined;
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry;
}

export async function cachePut(key: string, entry: Omit<CacheEntry, "expiresAt">, now = Date.now()) {
  await chrome.storage.local.set({ [key]: { ...entry, expiresAt: now + CACHE_TTL_MS } });
}

export async function cachePrune({ all = false, now = Date.now() } = {}) {
  const everything = await chrome.storage.local.get(null);
  const stale = Object.entries(everything)
    .filter(([k, v]) => k.startsWith(PREFIX) && (all || (v as CacheEntry).expiresAt <= now))
    .map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}
