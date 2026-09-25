import { test } from "node:test";
import assert from "node:assert/strict";
import { RevealState, loadHiddenPref, saveHiddenPref } from "../../src/popup/reveal.ts";

test("content is hidden by default and can be revealed per post", () => {
  const r = new RevealState();
  assert.equal(r.allHidden, true);
  assert.equal(r.isVisible("1"), false);
  assert.equal(r.toggle("1"), true);
  assert.equal(r.isVisible("1"), true);
  assert.equal(r.isVisible("2"), false);
  assert.equal(r.toggle("1"), false);
  assert.equal(r.isVisible("1"), false);
});

test("show all makes everything visible, and a single post can still be hidden", () => {
  const r = new RevealState(true);
  r.toggle("1");
  r.setAllHidden(false);
  assert.equal(r.allHidden, false);
  assert.equal(r.isVisible("1"), true);
  assert.equal(r.isVisible("2"), true);
  assert.equal(r.toggle("2"), false);
  assert.equal(r.isVisible("2"), false);
});

test("changing the list-wide setting clears per-post choices", () => {
  const r = new RevealState(false);
  r.toggle("1");
  assert.equal(r.isVisible("1"), false);
  r.setAllHidden(true);
  r.setAllHidden(false);
  assert.equal(r.isVisible("1"), true);
});

test("the preference round-trips and defaults to hidden", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(loadHiddenPref(storage), true);
  saveHiddenPref(false, storage);
  assert.equal(loadHiddenPref(storage), false);
  saveHiddenPref(true, storage);
  assert.equal(loadHiddenPref(storage), true);
});

test("storage failures fall back to hidden and never throw", () => {
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  assert.equal(loadHiddenPref(broken), true);
  assert.doesNotThrow(() => saveHiddenPref(false, broken));
  assert.equal(loadHiddenPref(undefined), true);
  assert.doesNotThrow(() => saveHiddenPref(false, undefined));
});
