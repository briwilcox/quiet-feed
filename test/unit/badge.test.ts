import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeText } from "../../src/background/badge.ts";

test("badge is blank at zero and below", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(-3), "");
});

test("exact counts up to 999", () => {
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(999), "999");
});

test("thousands abbreviate to fit the badge", () => {
  assert.equal(badgeText(1000), "1k");
  assert.equal(badgeText(1250), "1.3k");
  assert.equal(badgeText(9949), "9.9k");
  assert.equal(badgeText(10000), "10k");
  assert.equal(badgeText(12999), "12k");
});

test("just under ten thousand rounds up to 10k", () => {
  assert.equal(badgeText(9999), "10k");
});
