import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueFullError, RequestQueue } from "../src/background/queue.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("deduplicates identical in-flight keys", async () => {
  const q = new RequestQueue<number>(2);
  let runs = 0;
  const task = async () => (runs++, await tick(), 7);
  const [a, b] = await Promise.all([q.run("k", task), q.run("k", task)]);
  assert.deepEqual([a, b, runs], [7, 7, 1]);
});

test("never exceeds concurrency", async () => {
  const q = new RequestQueue<void>(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
  };
  await Promise.all(Array.from({ length: 6 }, (_, i) => q.run(String(i), task)));
  assert.equal(peak, 2);
});

test("rejects when the waiting list is full", async () => {
  const q = new RequestQueue<void>(1, 1);
  const p1 = q.run("a", tick);
  const p2 = q.run("b", tick);
  await assert.rejects(q.run("c", tick), QueueFullError);
  await Promise.all([p1, p2]);
});
