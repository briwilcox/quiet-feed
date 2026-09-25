import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueFullError, RequestQueue } from "../../src/background/queue.ts";

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

test("a failing task frees its slot and its key", async () => {
  const q = new RequestQueue<number>(1);
  await assert.rejects(q.run("k", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await q.run("k", async () => 3), 3);
});

test("waiting tasks run in order once a slot frees", async () => {
  const q = new RequestQueue<void>(1);
  const order: string[] = [];
  const job = (id: string) => async () => { order.push(id); await tick(); };
  await Promise.all(["a", "b", "c"].map((id) => q.run(id, job(id))));
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("default limits: two concurrent and fifty waiting", async () => {
  const q = new RequestQueue<void>();
  let active = 0;
  let peak = 0;
  const slow = async () => { active++; peak = Math.max(peak, active); await tick(); active--; };
  const runs = Array.from({ length: 52 }, (_, i) => q.run(String(i), slow));
  await assert.rejects(q.run("overflow", slow), QueueFullError);
  await Promise.all(runs);
  assert.equal(peak, 2);
});
