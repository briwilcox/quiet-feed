import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, preDecide } from "../../src/background/decide.ts";
import { DEFAULT_SETTINGS } from "../../src/shared/settings.ts";
import type { PostPayload, Settings } from "../../src/shared/types.ts";

const on: Settings = { ...DEFAULT_SETTINGS, enabled: true, disclosureAccepted: true };
const post: PostPayload = {
  statusId: "1",
  authorHandle: "Someone",
  text: "hello",
  quotedText: null,
  mediaLabels: [],
  hasVideo: false,
  textTruncated: false,
};
const rules = [
  { ruleId: "rage_bait", label: "Rage bait", threshold: 0.8 },
  { ruleId: "topic:a", label: "Topic: Crypto", threshold: 0.75 },
];

test("hides when a rule exceeds its threshold and names every match", () => {
  const d = decide(rules, { rage_bait: 0.9, "topic:a": 0.95 }, on);
  assert.equal(d.hide, true);
  assert.deepEqual(d.matched.map((m) => m.ruleId), ["topic:a", "rage_bait"]);
  assert.match(d.explanation, /Topic: Crypto, Rage bait filters at Balanced/);
});

test("stays visible at or below threshold", () => {
  assert.equal(decide(rules, { rage_bait: 0.8, "topic:a": 0.1 }, on).hide, false);
});

test("missing probabilities never hide", () => {
  assert.equal(decide(rules, {}, on).hide, false);
});

test("allowed author override wins before any model call", () => {
  const d = preDecide(post, { ...on, allowedAuthors: ["someone"] }, true);
  assert.equal(d?.reason, "allowed_author");
  assert.equal(d?.hide, false);
});

test("disabled or undisclosed means visible", () => {
  assert.equal(preDecide(post, { ...on, enabled: false }, true)?.reason, "disabled");
  assert.equal(preDecide(post, { ...on, disclosureAccepted: false }, true)?.reason, "disabled");
});

test("truncated text stays visible", () => {
  assert.equal(preDecide({ ...post, textTruncated: true }, on, true)?.reason, "incomplete_text");
});

test("complete post with rules needs classification", () => {
  assert.equal(preDecide(post, on, true), null);
});

test("a single match uses singular wording and carries its numbers", () => {
  const d = decide(rules, { rage_bait: 0.81 }, { ...on, sensitivity: "aggressive" });
  assert.equal(d.explanation, "Matched your Rage bait filter at Aggressive sensitivity.");
  assert.deepEqual(d.matched, [{ ruleId: "rage_bait", label: "Rage bait", threshold: 0.8, probability: 0.81 }]);
  assert.equal(d.reason, "hidden");
});

test("visible decisions carry no matches", () => {
  const d = decide(rules, { rage_bait: 0.1 }, on);
  assert.deepEqual(d, { hide: false, reason: "below_threshold", matched: [], explanation: "" });
});

test("allowed author check is case-insensitive and explains itself", () => {
  const d = preDecide({ ...post, authorHandle: "SOMEONE" }, { ...on, allowedAuthors: ["someone"] }, true);
  assert.equal(d?.explanation, "You always allow @SOMEONE.");
});

test("no enabled rules means visible, checked before truncation", () => {
  assert.equal(preDecide({ ...post, textTruncated: true }, on, false)?.reason, "no_rules");
});
