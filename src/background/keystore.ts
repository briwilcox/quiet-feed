import type { KeyStorageMode } from "../shared/types.ts";

// The key lives only in chrome.storage.session or chrome.storage.local, both
// restricted to trusted extension contexts (see restrictStorageAccess). It is
// never synced, exported, sent to content scripts, or logged. Local storage is
// plain on-disk storage, not an encrypted vault; the UI says so.
const KEY_FIELD = "jevApiKey";

export async function restrictStorageAccess() {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function getApiKey(): Promise<string | null> {
  const s = (await chrome.storage.session.get(KEY_FIELD))[KEY_FIELD];
  if (typeof s === "string" && s) return s;
  const l = (await chrome.storage.local.get(KEY_FIELD))[KEY_FIELD];
  return typeof l === "string" && l ? l : null;
}

export async function saveApiKey(key: string, mode: KeyStorageMode) {
  await deleteApiKey();
  const area = mode === "local" ? chrome.storage.local : chrome.storage.session;
  await area.set({ [KEY_FIELD]: key.trim() });
}

export async function deleteApiKey() {
  await chrome.storage.session.remove(KEY_FIELD);
  await chrome.storage.local.remove(KEY_FIELD);
}
