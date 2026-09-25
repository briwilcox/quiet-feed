import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteApiKey, getApiKey, restrictStorageAccess, saveApiKey } from "../../src/background/keystore.ts";
import { installChrome } from "../helpers/chrome-stub.ts";

test("restrictStorageAccess locks both areas to trusted contexts", async () => {
  const { chrome } = installChrome();
  await restrictStorageAccess();
  assert.equal(chrome.storage.session.accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(chrome.storage.local.accessLevel, "TRUSTED_CONTEXTS");
});

test("keys are trimmed and stored only in the chosen area", async () => {
  const { chrome } = installChrome();
  await saveApiKey("jev", "  abc  ", "session");
  assert.equal(chrome.storage.session.data.get("jevApiKey"), "abc");
  assert.equal(chrome.storage.local.data.has("jevApiKey"), false);
  assert.equal(await getApiKey("jev"), "abc");

  await saveApiKey("jev", "def", "local");
  assert.equal(chrome.storage.session.data.has("jevApiKey"), false);
  assert.equal(await getApiKey("jev"), "def");
});

test("session key wins over a local one; empty values count as no key", async () => {
  const { chrome } = installChrome();
  await chrome.storage.local.set({ jevApiKey: "local" });
  await chrome.storage.session.set({ jevApiKey: "session" });
  assert.equal(await getApiKey("jev"), "session");
  await chrome.storage.session.set({ jevApiKey: "" });
  assert.equal(await getApiKey("jev"), "local");
  await chrome.storage.local.set({ jevApiKey: "" });
  assert.equal(await getApiKey("jev"), null);
  await chrome.storage.local.set({ jevApiKey: 42 });
  assert.equal(await getApiKey("jev"), null);
});

test("deleteApiKey clears both areas", async () => {
  const { chrome } = installChrome();
  await chrome.storage.local.set({ jevApiKey: "a" });
  await chrome.storage.session.set({ jevApiKey: "b" });
  await deleteApiKey("jev");
  assert.equal(await getApiKey("jev"), null);
  assert.equal(chrome.storage.local.data.size + chrome.storage.session.data.size, 0);
});

test("each provider has its own key slot", async () => {
  const { chrome } = installChrome();
  await saveApiKey("jev", "jev-key", "session");
  await saveApiKey("gliner", "fast_sk_x", "local");
  assert.equal(await getApiKey("jev"), "jev-key");
  assert.equal(await getApiKey("gliner"), "fast_sk_x");
  assert.equal(chrome.storage.local.data.get("fastinoApiKey"), "fast_sk_x");
  await deleteApiKey("gliner");
  assert.equal(await getApiKey("gliner"), null);
  assert.equal(await getApiKey("jev"), "jev-key");
});
