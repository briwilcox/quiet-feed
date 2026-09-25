// Builds the extension into a temporary folder with the dependency-free build
// and checks it the way a browser would load it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installChrome } from "../helpers/chrome-stub.ts";

let out = "";
const workerIntervals: ReturnType<typeof setInterval>[] = [];

before(() => {
  out = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "qf-build-"));
  execFileSync(process.execPath, ["scripts/build-nodeps.mjs"], { env: { ...process.env, QF_DIST: out }, stdio: "ignore" });
});
after(() => {
  workerIntervals.forEach((t) => clearInterval(t));
  rmSync(out, { recursive: true, force: true });
});

const read = (p: string) => readFileSync(join(out, p), "utf8");

test("the manifest and every page and script are in place", () => {
  for (const f of ["manifest.json", "background.js", "content.js", "popup/popup.html", "popup/popup.js", "options/options.html", "options/options.js", "shared/ui.css", "shared/build.js"]) {
    assert.ok(existsSync(join(out, f)), f);
  }
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" });
  for (const host of ["https://x.com/*", "https://api.typesafe.ai/*", "https://api.fastino.ai/*", "http://127.0.0.1/*", "http://localhost/*"]) {
    assert.ok(manifest.host_permissions.includes(host), host);
  }
  assert.deepEqual(manifest.permissions, ["storage"]);
});

test("the build is stamped with one id that the worker and pages share", async () => {
  const m = read("shared/build.js").match(/BUILD_ID = "([^"]+)"/);
  assert.ok(m, "build id not stamped");
  assert.ok(!Number.isNaN(Date.parse(m[1])), "build id is a timestamp");
  const mod = await import(pathToFileURL(join(out, "shared/build.js")).href);
  assert.equal(mod.BUILD_ID, m[1]);
  // Both the worker and the pages import this one module.
  assert.match(read("background/index.js"), /from "\.\.\/shared\/build\.js"/);
  assert.match(read("options/options.js"), /from "\.\.\/shared\/build\.js"/);
  assert.match(read("popup/popup.js"), /from "\.\.\/shared\/build\.js"/);
});

test("the built service worker loads and registers its message listener", async () => {
  const stub = installChrome();
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const t = realSetInterval(...args);
    workerIntervals.push(t);
    return t;
  }) as typeof setInterval;
  try {
    await import(pathToFileURL(join(out, "background.js")).href);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(stub.chrome.runtime.onMessage.listeners.length, 1);
  const res = await stub.send<{ buildId: string }>({ type: "getStatus" });
  assert.equal(res.ok, true);
  assert.equal(res.result!.buildId, read("shared/build.js").match(/BUILD_ID = "([^"]+)"/)![1]);
});

test("the content script is one classic script with no module syntax or TypeScript", () => {
  const js = read("content.js");
  assert.ok(!/^\s*(import|export)\s/m.test(js), "content scripts cannot be ES modules");
  assert.ok(js.startsWith("(() => {"), "wrapped in an IIFE");
  assert.match(js, /class PostTally/);
  assert.match(js, /function extractPost/);
  execFileSync(process.execPath, ["--check", join(out, "content.js")]);
});

test("no built file still imports a .ts path", () => {
  for (const f of ["background/index.js", "background/local.js", "options/options.js", "popup/popup.js"]) {
    assert.ok(!/from\s+["'][^"']+\.ts["']/.test(read(f)), f);
  }
});
