import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  FILTER_LABELS,
  RULE_LABELS,
  THRESHOLDS,
  isSettingsChange,
  loadSettings,
  saveSettings,
  todayKey,
} from "../../src/shared/settings.ts";
import { installChrome } from "../helpers/chrome-stub.ts";

test("defaults are safe: off until the user opts in, session-only key", () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_SETTINGS.disclosureAccepted, false);
  assert.equal(DEFAULT_SETTINGS.keyStorageMode, "session");
  assert.equal(DEFAULT_SETTINGS.concealWhilePending, false);
  assert.ok(DEFAULT_SETTINGS.dailyRequestLimit > 0);
});

test("stricter sensitivity never has a lower threshold than a looser one", () => {
  for (const rule of Object.keys(THRESHOLDS.balanced) as Array<keyof typeof THRESHOLDS.balanced>) {
    assert.ok(THRESHOLDS.conservative[rule] > THRESHOLDS.balanced[rule], rule);
    assert.ok(THRESHOLDS.balanced[rule] > THRESHOLDS.aggressive[rule], rule);
    for (const s of ["conservative", "balanced", "aggressive"] as const) {
      assert.ok(THRESHOLDS[s][rule] > 0.5 && THRESHOLDS[s][rule] < 1, `${s}.${rule}`);
    }
  }
});

test("every built-in filter and derived rule has a label", () => {
  for (const id of Object.keys(FILTER_LABELS)) assert.equal(RULE_LABELS[id], FILTER_LABELS[id as keyof typeof FILTER_LABELS]);
  assert.equal(RULE_LABELS.rage_bait_quoted, "Rage bait (quoted post)");
});

test("loadSettings fills defaults under stored values; saveSettings merges a patch", async () => {
  const { chrome } = installChrome();
  assert.deepEqual(await loadSettings(), DEFAULT_SETTINGS);
  await chrome.storage.local.set({ settings: { sensitivity: "aggressive" } });
  const loaded = await loadSettings();
  assert.equal(loaded.sensitivity, "aggressive");
  assert.equal(loaded.dailyRequestLimit, DEFAULT_SETTINGS.dailyRequestLimit);

  const saved = await saveSettings({ enabled: true });
  assert.equal(saved.enabled, true);
  assert.equal(saved.sensitivity, "aggressive");
  assert.equal(((await chrome.storage.local.get("settings")).settings as { enabled: boolean }).enabled, true);
});

test("isSettingsChange only matches the settings key", () => {
  assert.equal(isSettingsChange({ settings: { newValue: 1 } }), true);
  assert.equal(isSettingsChange({ usage: { newValue: 1 } }), false);
});

test("todayKey is the UTC date", () => {
  assert.equal(todayKey(new Date("2026-09-24T23:59:59Z")), "2026-09-24");
  assert.equal(todayKey(new Date("2026-09-25T00:00:00Z")), "2026-09-25");
});
