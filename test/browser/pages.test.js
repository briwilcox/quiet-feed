// Browser tests for the built popup and settings pages. Each scenario loads the
// real page in a fresh iframe with a scripted chrome.* stub, so it can play an
// up-to-date worker, an out-of-date one, a running local server, or a stopped one.
(async () => {
  const { BUILD_ID } = await import("/dist/shared/build.js");
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond, what, timeout = 3000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      if (cond()) return;
      await sleep(20);
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const eq = (a, e, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${msg}\n  expected ${JSON.stringify(e)}\n  actual   ${JSON.stringify(a)}`);
  };

  const OK_LOCAL = { state: "ok", model: "fastino/GLiNER2.5-Decide", device: "mps", provider: "local", checkedAt: 1 };
  // What a worker from before provider echo sends: it tested Jev instead.
  const OLD_WORKER_OK = { state: "ok", model: "jev-1.13.0", checkedAt: 1 };
  const DOWN = { state: "error", message: "Local server not reachable. Is it running?", provider: "local", checkedAt: 1 };

  /** A scenario: stored settings, what the worker reports, and how it answers a local connection test. */
  function scenario({ settings = {}, buildId = BUILD_ID, noBuildId = false, localTest = OK_LOCAL, connections = {} } = {}) {
    const state = {
      local: new Map([["settings", { enabled: true, disclosureAccepted: true, backend: "jev", localEndpoint: "http://127.0.0.1:8765", filters: { rage_bait: true, llm_slop: true, ai_video_slop: false }, sensitivity: "balanced", topics: [], allowedAuthors: [], dailyRequestLimit: 1000, concealWhilePending: false, concealTimeoutMs: 2500, keyStorageMode: "session", hideProviderRefusals: true, ...settings }]]),
      listeners: [],
      messages: [],
      connections: { jev: { state: "ok", model: "jev-1.13.0", provider: "jev", checkedAt: 1 }, gliner: { state: "no_key" }, local: { state: "untested" }, ...connections },
    };
    const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    const fire = (changes) => state.listeners.forEach((fn) => fn(changes, "local"));
    state.chrome = {
      runtime: {
        id: "qf-test",
        async sendMessage(msg) {
          state.messages.push(msg);
          if (msg.type === "getStatus") {
            const s = clone(state.local.get("settings"));
            return {
              ok: true,
              result: {
                ...(noBuildId ? {} : { buildId }),
                settings: s,
                keys: { jev: true, gliner: false },
                hasKey: s.backend === "local" || s.backend === "jev",
                connection: state.connections[s.backend],
                connections: state.connections,
                usage: { day: "2026-09-25", requests: 3, cacheHits: 1, inputTokens: 0, outputTokens: 0, errors: 0, lastLatencyMs: 90, lastModel: "m", checked: 10, blocked: 2, refused: 0, hiddenByRule: { rage_bait: 2 } },
                recentBlocked: [],
              },
            };
          }
          if (msg.type === "testConnection") {
            if (msg.provider === "local") state.connections.local = localTest;
            return { ok: true, result: msg.provider === "local" ? localTest : state.connections[msg.provider] };
          }
          return { ok: true, result: null };
        },
        openOptionsPage() {},
      },
      storage: {
        local: {
          async get(key) {
            return state.local.has(key) ? { [key]: clone(state.local.get(key)) } : {};
          },
          async set(items) {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { oldValue: state.local.get(k), newValue: clone(v) };
              state.local.set(k, clone(v));
            }
            fire(changes);
          },
        },
        onChanged: { addListener: (fn) => state.listeners.push(fn) },
      },
    };
    return state;
  }

  let current = null;
  window.qfStubFor = () => current.chrome;

  async function open(page, sc) {
    current = sc;
    const frame = document.createElement("iframe");
    frame.src = `/test/browser/page-host.html?page=${page}`;
    document.getElementById("frames").replaceChildren(frame);
    await waitFor(() => frame.contentWindow?.qfLoaded, `${page} loaded`);
    await waitFor(() => sc.messages.some((m) => m.type === "getStatus"), `${page} asked for status`);
    await sleep(50);
    const doc = frame.contentDocument;
    return { doc, $: (sel) => doc.querySelector(sel), win: frame.contentWindow };
  }
  const backendSetting = (sc) => sc.local.get("settings").backend;
  const choose = (doc, value) => {
    const r = doc.querySelector(`input[name="backend"][value="${value}"]`);
    r.checked = true;
    r.dispatchEvent(new Event("change"));
  };
  const pick = (doc, value) => {
    const sel = doc.querySelector("#backend");
    sel.value = value;
    sel.dispatchEvent(new Event("change"));
  };

  // ---- settings page ----

  test("settings: no stale banner when the worker matches this build", async () => {
    const { $ } = await open("options", scenario());
    assert($("#stale").hidden, "banner shown for a matching worker");
  });

  test("settings: a worker from another build shows the reload banner", async () => {
    const { $ } = await open("options", scenario({ buildId: "2026-01-01T00:00:00.000Z" }));
    assert(!$("#stale").hidden, "banner hidden");
    assert(/reload icon on Quiet Feed/.test($("#stale").textContent), $("#stale").textContent);
  });

  test("settings: a worker too old to send a build id also shows the banner", async () => {
    const { $ } = await open("options", scenario({ noBuildId: true }));
    assert(!$("#stale").hidden, "banner hidden");
  });

  test("settings: choosing the local model saves it once the server answers, and shows model and device", async () => {
    const sc = scenario();
    const { doc, $ } = await open("options", sc);
    choose(doc, "local");
    await waitFor(() => backendSetting(sc) === "local", "backend saved as local");
    eq(sc.messages.filter((m) => m.type === "testConnection").map((m) => m.provider), ["local"], "health checked first");
    await waitFor(() => /GLiNER2\.5-Decide on mps/.test($("#local-model").textContent), "model and device shown");
    assert(/Connected\. Model: fastino\/GLiNER2\.5-Decide on mps/.test($("#local-status").textContent), $("#local-status").textContent);
  });

  test("settings: a stopped local server keeps the previous model and says why", async () => {
    const sc = scenario({ localTest: DOWN });
    const { doc, $ } = await open("options", sc);
    choose(doc, "local");
    await waitFor(() => /not reachable/.test($("#local-status").textContent), "error shown");
    await sleep(100);
    eq(backendSetting(sc), "jev", "backend unchanged");
    assert(doc.querySelector('input[name="backend"][value="jev"]').checked, "selection restored to Jev");
  });

  test("settings: an out-of-date worker answering OK for the wrong model does not switch", async () => {
    const sc = scenario({ localTest: OLD_WORKER_OK });
    const { doc, $ } = await open("options", sc);
    choose(doc, "local");
    await sleep(300);
    eq(backendSetting(sc), "jev", "switched on a Jev answer");
    assert(doc.querySelector('input[name="backend"][value="jev"]').checked, "selection restored");
  });

  test("settings: cloud models switch without a local check", async () => {
    const sc = scenario({ settings: { backend: "local" } });
    const { doc } = await open("options", sc);
    choose(doc, "gliner");
    await waitFor(() => backendSetting(sc) === "gliner", "saved gliner");
    eq(sc.messages.filter((m) => m.type === "testConnection").length, 0, "no connection test");
  });

  test("settings: an invalid server address is refused; a valid one is saved normalized", async () => {
    const sc = scenario();
    const { $ } = await open("options", sc);
    const input = $("#local-endpoint");
    input.value = "http://evil.example:8765";
    input.dispatchEvent(new Event("change"));
    await sleep(100);
    eq(sc.local.get("settings").localEndpoint, "http://127.0.0.1:8765", "bad endpoint saved");
    eq(input.value, "http://127.0.0.1:8765", "input restored");
    assert(/127\.0\.0\.1/.test($("#local-status").textContent), "explains the rule");
    input.value = "http://localhost:9001/";
    input.dispatchEvent(new Event("change"));
    await waitFor(() => sc.local.get("settings").localEndpoint === "http://localhost:9001", "normalized endpoint saved");
  });

  test("settings: the local model line reports a missing server", async () => {
    const { $ } = await open("options", scenario({ connections: { local: DOWN } }));
    eq($("#local-model").textContent, "(server not connected)", "local model line");
  });

  // ---- popup ----

  test("popup: switching to local checks the server and saves on success", async () => {
    const sc = scenario();
    const { doc, $ } = await open("popup", sc);
    pick(doc, "local");
    await waitFor(() => backendSetting(sc) === "local", "backend saved");
    assert($("#notice").hidden, "no notice on success");
  });

  test("popup: a stopped server reverts the choice and shows why", async () => {
    const sc = scenario({ localTest: DOWN });
    const { doc, $ } = await open("popup", sc);
    pick(doc, "local");
    await waitFor(() => !$("#notice").hidden, "notice shown");
    assert(/Local model unavailable: Local server not reachable/.test($("#notice").textContent), $("#notice").textContent);
    eq(doc.querySelector("#backend").value, "jev", "select reverted");
    eq(backendSetting(sc), "jev", "backend unchanged");
  });

  test("popup: an out-of-date worker gets the reload message, not a switch", async () => {
    const sc = scenario({ localTest: OLD_WORKER_OK });
    const { doc, $ } = await open("popup", sc);
    pick(doc, "local");
    await waitFor(() => !$("#notice").hidden, "notice shown");
    assert(/reload icon on Quiet Feed/.test($("#notice").textContent), $("#notice").textContent);
    eq(backendSetting(sc), "jev", "backend unchanged");
  });

  test("popup: stale banner and local connection text", async () => {
    const stale = await open("popup", scenario({ buildId: "old" }));
    assert(!stale.$("#stale").hidden, "stale banner hidden");
    const fresh = await open("popup", scenario({ settings: { backend: "local", disclosureAccepted: false }, connections: { local: OK_LOCAL } }));
    assert(fresh.$("#stale").hidden, "banner shown for a matching worker");
    eq(fresh.$("#connection").textContent, "Connected: fastino/GLiNER2.5-Decide on mps", "connection line");
    assert(!fresh.$("#enabled").disabled, "local mode is ready without a key or disclosure");
    assert(fresh.$("#setup").hidden, "setup prompt hidden in local mode");
  });

  test("popup: slop is offered locally but not on hosted GLiNER", async () => {
    const local = await open("popup", scenario({ settings: { backend: "local" } }));
    assert(!local.$('[data-filter="llm_slop"]').disabled, "slop disabled locally");
    const hosted = await open("popup", scenario({ settings: { backend: "gliner" } }));
    assert(hosted.$('[data-filter="llm_slop"]').disabled, "slop enabled on hosted GLiNER");
    assert(!hosted.$("#slop-note").hidden, "needs-Jev note hidden");
  });

  // ---- runner ----

  const results = [];
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
    } catch (err) {
      results.push({ name: t.name, ok: false, error: String(err.message ?? err) });
    }
  }
  document.getElementById("frames").replaceChildren();
  const failed = results.filter((r) => !r.ok);
  window.qfResults = { done: true, passed: results.length - failed.length, failed: failed.length, results };
  const report = document.getElementById("report");
  report.innerHTML = `<strong>${results.length - failed.length}/${results.length} passed</strong>`;
  for (const r of results) {
    const div = document.createElement("div");
    div.className = r.ok ? "pass" : "fail";
    div.textContent = `${r.ok ? "✔" : "✖"} ${r.name}${r.ok ? "" : `\n    ${r.error}`}`;
    report.append(div);
  }
})();
