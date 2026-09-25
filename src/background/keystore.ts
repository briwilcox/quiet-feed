import type { KeyStorageMode, KeyedBackend } from "../shared/types.ts";

// API keys live only in chrome.storage.session or chrome.storage.local, both
// restricted to trusted extension contexts (see restrictStorageAccess). They are
// never synced, exported, sent to content scripts, or logged. Local storage is
// plain on-disk storage, not an encrypted vault; the UI says so.
const KEY_FIELDS: Record<KeyedBackend, string> = { jev: "jevApiKey", gliner: "fastinoApiKey" };

export async function restrictStorageAccess() {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function getApiKey(provider: KeyedBackend): Promise<string | null> {
  const field = KEY_FIELDS[provider];
  const s = (await chrome.storage.session.get(field))[field];
  if (typeof s === "string" && s) return s;
  const l = (await chrome.storage.local.get(field))[field];
  return typeof l === "string" && l ? l : null;
}

export async function saveApiKey(provider: KeyedBackend, key: string, mode: KeyStorageMode) {
  await deleteApiKey(provider);
  const area = mode === "local" ? chrome.storage.local : chrome.storage.session;
  await area.set({ [KEY_FIELDS[provider]]: key.trim() });
}

export async function deleteApiKey(provider: KeyedBackend) {
  const field = KEY_FIELDS[provider];
  await chrome.storage.session.remove(field);
  await chrome.storage.local.remove(field);
}
