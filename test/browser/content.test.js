// Content-script integration tests. Loads the built dist/content.js into a page
// with X-shaped markup and a stubbed chrome.runtime, then drives it the way the
// real feed does: appending posts, reusing elements, navigating, and pushing
// settings changes. Results render at the top and land on window.qfResults.
(() => {
  const feed = document.getElementById("feed");
  const below = document.getElementById("below");
  const stub = window.qfStub;
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });
  let n = 0;
  const uid = () => String(1_000_000 + n++);

  // ---- fixtures shaped like X's timeline markup ----

  function postHtml({ id, author = "someone", text = "", quoted = null, truncated = false, video = false, photoAlt = null }) {
    return `
      <div data-testid="User-Name"><span>${author}</span></div>
      <a href="/${author}/status/${id}"><time datetime="2026-09-24T12:00:00Z">1h</time></a>
      <div data-testid="tweetText">${text}</div>
      ${truncated ? '<button data-testid="tweet-text-show-more-link">Show more</button>' : ""}
      ${photoAlt ? `<div data-testid="tweetPhoto"><img alt="${photoAlt}" src="data:,"></div>` : ""}
      ${video ? '<div data-testid="videoPlayer"></div>' : ""}
      ${
        quoted
          ? `<div role="link" tabindex="0"><div data-testid="User-Name"><span>quoted_author</span></div>
               <div data-testid="tweetText">${quoted}</div></div>`
          : ""
      }`;
  }

  function addPost(opts, container = feed) {
    const cell = document.createElement("div");
    cell.setAttribute("data-testid", "cellInnerDiv");
    const article = document.createElement("article");
    article.setAttribute("data-testid", "tweet");
    article.innerHTML = postHtml(opts);
    cell.append(article);
    container.append(cell);
    return article;
  }

  // ---- helpers ----

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond, what, timeout = 2000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      if (cond()) return;
      await sleep(20);
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }
  const isHidden = (a) => a.style.display === "none";
  const placeholderOf = (a) => (a.previousElementSibling?.classList.contains("qf-placeholder") ? a.previousElementSibling : null);
  const classifyCalls = (id) => stub.messages.filter((m) => m.type === "classify" && m.post.statusId === id);
  const recordCalls = () => stub.messages.filter((m) => m.type === "recordResult");
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
  }

  // ---- tests ----

  test("hides rage bait behind a placeholder and leaves calm posts alone", async () => {
    const rage = addPost({ id: uid(), text: "RAGE: they are ruining everything" });
    const calm = addPost({ id: uid(), text: "Nice sunset at the beach today" });
    await waitFor(() => isHidden(rage), "rage post hidden");
    const ph = placeholderOf(rage);
    assert(ph, "no placeholder");
    assert(ph.textContent.startsWith("Hidden: Rage bait"), `placeholder text: ${ph.textContent}`);
    assert(ph.textContent.includes("Show post") && ph.textContent.includes("Always allow @someone"), "placeholder actions missing");
    eq(ph.title, "Matched your Rage bait filter at Balanced sensitivity.", "explanation tooltip");
    await waitFor(() => classifyCalls(calm.querySelector("a").href.split("/").pop()).length === 1, "calm post classified");
    assert(!isHidden(calm) && !placeholderOf(calm), "calm post was hidden");
  });

  test("extracts own text, quoted text, media labels, video, and truncation separately", async () => {
    const id = uid();
    addPost({ id, author: "Quoter_1", text: "my take", quoted: "the original post", video: true, photoAlt: "A chart of prices", truncated: false });
    await waitFor(() => classifyCalls(id).length === 1, "classified");
    const p = classifyCalls(id)[0].post;
    eq(
      { statusId: p.statusId, authorHandle: p.authorHandle, text: p.text, quotedText: p.quotedText, mediaLabels: p.mediaLabels, hasVideo: p.hasVideo, textTruncated: p.textTruncated },
      { statusId: id, authorHandle: "Quoter_1", text: "my take", quotedText: "the original post", mediaLabels: ["A chart of prices"], hasVideo: true, textTruncated: false },
      "payload",
    );
  });

  test("emoji images keep their meaning in extracted text", async () => {
    const id = uid();
    const a = addPost({ id, text: "so happy " });
    a.querySelector('[data-testid="tweetText"]').insertAdjacentHTML("beforeend", '<img alt="😀" src="data:,"> today');
    await waitFor(() => classifyCalls(id).length >= 1, "classified");
    eq(classifyCalls(id).at(-1).post.text, "so happy 😀 today", "emoji alt text");
  });

  test("a calm quote of rage bait is hidden by the quoted-post rule", async () => {
    const a = addPost({ id: uid(), text: "lol look at this", quoted: "RAGE bait original" });
    await waitFor(() => isHidden(a), "quote tweet hidden");
    assert(placeholderOf(a).textContent.startsWith("Hidden: Rage bait (quoted post)"), "label");
  });

  test("a link-preview card is not mistaken for a quoted post", async () => {
    const id = uid();
    const a = addPost({ id, text: "reading this" });
    a.insertAdjacentHTML("beforeend", '<div role="link"><span>example.com</span><span>Article title</span></div>');
    await waitFor(() => classifyCalls(id).length >= 1, "classified");
    eq(classifyCalls(id).at(-1).post.quotedText, null, "quotedText");
    eq(classifyCalls(id).at(-1).post.text, "reading this", "own text");
  });

  test("truncated text is reported so the background can leave it visible", async () => {
    const id = uid();
    addPost({ id, text: "A very long post that goes on", truncated: true });
    await waitFor(() => classifyCalls(id).length === 1, "classified");
    eq(classifyCalls(id)[0].post.textTruncated, true, "textTruncated");
  });

  test("allowed authors are never sent for classification", async () => {
    const a = addPost({ id: uid(), author: "Friend", text: "RAGE from a friend" });
    await sleep(300);
    assert(!isHidden(a), "allowed author hidden");
    eq(classifyCalls(a.querySelector("a").href.split("/").pop()).length, 0, "classify calls");
  });

  test("Show post restores the original element and it stays shown after a settings change", async () => {
    const a = addPost({ id: uid(), text: "RAGE please reveal me" });
    await waitFor(() => isHidden(a), "hidden");
    const original = a.innerHTML;
    [...placeholderOf(a).querySelectorAll("button")].find((b) => b.textContent === "Show post").click();
    assert(!isHidden(a) && !placeholderOf(a), "not restored");
    eq(a.innerHTML, original, "element content changed");
    stub.pushConfig({});
    await sleep(300);
    assert(!isHidden(a), "re-hidden after settings change");
  });

  test("Always allow asks the background to allow the author and restores the post", async () => {
    const a = addPost({ id: uid(), author: "Loud_One", text: "RAGE again" });
    await waitFor(() => isHidden(a), "hidden");
    [...placeholderOf(a).querySelectorAll("button")].find((b) => b.textContent.startsWith("Always allow")).click();
    await waitFor(() => !isHidden(a), "restored");
    eq(stub.messages.filter((m) => m.type === "allowAuthor").at(-1), { type: "allowAuthor", handle: "Loud_One" }, "allowAuthor message");
  });

  test("each post is tallied once even when re-evaluated", async () => {
    const id = uid();
    const a = addPost({ id, text: "RAGE count me once" });
    await waitFor(() => isHidden(a), "hidden");
    const before = recordCalls().length;
    stub.pushConfig({});
    await waitFor(() => isHidden(a), "re-hidden after settings change");
    await sleep(200);
    eq(recordCalls().length, before, "recordResult sent again");
    const mine = recordCalls().filter((m) => m.blockedPost?.statusId === id);
    eq(mine.length, 1, "blocked tally for this post");
    eq({ newlyChecked: mine[0].newlyChecked, newlyBlocked: mine[0].newlyBlocked, ruleIds: mine[0].ruleIds }, { newlyChecked: true, newlyBlocked: true, ruleIds: ["rage_bait"] }, "tally payload");
  });

  test("a reused element showing a different post is restored and re-evaluated", async () => {
    const a = addPost({ id: uid(), text: "RAGE first occupant" });
    await waitFor(() => isHidden(a), "hidden");
    const newId = uid();
    a.innerHTML = postHtml({ id: newId, text: "A calm replacement post" });
    await waitFor(() => classifyCalls(newId).length === 1, "new occupant classified");
    await waitFor(() => !isHidden(a) && !placeholderOf(a), "restored for new occupant");
  });

  test("expanding truncated text triggers a fresh evaluation", async () => {
    const id = uid();
    const a = addPost({ id, text: "Starts calm but", truncated: true });
    await waitFor(() => classifyCalls(id).length === 1, "first pass");
    a.querySelector('[data-testid="tweet-text-show-more-link"]').remove();
    a.querySelector('[data-testid="tweetText"]').textContent = "Starts calm but then RAGE";
    await waitFor(() => isHidden(a), "hidden after expansion");
    eq(classifyCalls(id).at(-1).post.textTruncated, false, "second pass not truncated");
  });

  test("a late result is dropped if the element changed while waiting", async () => {
    const slowId = uid();
    stub.delays.set(slowId, 400);
    const a = addPost({ id: slowId, text: "RAGE but slow" });
    await waitFor(() => classifyCalls(slowId).length === 1, "request sent");
    const newId = uid();
    a.innerHTML = postHtml({ id: newId, text: "Different calm post" });
    await sleep(700);
    assert(!isHidden(a) && !placeholderOf(a), "stale result hid the wrong post");
  });

  test("a result arriving in the same tick as a content swap is not applied", async () => {
    // No rescan can run between the swap and the reply, so only the signature
    // recheck in evaluate() stands between the old verdict and the new post.
    const id = uid();
    const newId = uid();
    let a;
    let everHidden = false;
    const watch = new MutationObserver(() => {
      if (a.style.display === "none") everHidden = true;
    });
    stub.beforeReply.set(id, () => {
      a.innerHTML = postHtml({ id: newId, text: "Innocent replacement" });
    });
    a = addPost({ id, text: "RAGE swapped at reply time" });
    watch.observe(a, { attributes: true, attributeFilter: ["style"] });
    await waitFor(() => classifyCalls(newId).length >= 1, "replacement evaluated");
    await sleep(150);
    watch.disconnect();
    assert(!everHidden, "the old post's verdict hid the replacement, even briefly");
    eq(recordCalls().filter((m) => m.blockedPost?.statusId === id).length, 0, "blocked tally for the swapped-out post");
    assert(!isHidden(a) && !placeholderOf(a), "replacement left hidden");
  });

  test("classification errors leave the post visible", async () => {
    const id = uid();
    stub.failing.add(id);
    const a = addPost({ id, text: "RAGE but the API is down" });
    await waitFor(() => classifyCalls(id).length === 1, "request sent");
    await sleep(200);
    assert(!isHidden(a), "hidden despite error");
  });

  test("posts far below the viewport are not classified until scrolled near", async () => {
    const id = uid();
    const a = addPost({ id, text: "RAGE far below" }, below);
    await sleep(400);
    eq(classifyCalls(id).length, 0, "classified while offscreen");
    a.scrollIntoView();
    await waitFor(() => isHidden(a), "hidden after scrolling near");
    window.scrollTo(0, 0);
  });

  test("concealment while pending hides the post until the verdict arrives", async () => {
    stub.pushConfig({ concealWhilePending: true, concealTimeoutMs: 2000 });
    const id = uid();
    stub.delays.set(id, 300);
    const a = addPost({ id, text: "Calm but slow" });
    await waitFor(() => a.style.visibility === "hidden", "concealed while pending");
    await waitFor(() => a.style.visibility === "", "revealed after verdict");
    assert(!isHidden(a), "calm post hidden");
    stub.pushConfig({ concealWhilePending: false });
  });

  test("concealment times out if the verdict never comes back in time", async () => {
    stub.pushConfig({ concealWhilePending: true, concealTimeoutMs: 150 });
    const id = uid();
    stub.delays.set(id, 1500);
    const a = addPost({ id, text: "Very slow calm post" });
    await waitFor(() => a.style.visibility === "hidden", "concealed");
    await waitFor(() => a.style.visibility === "", "timeout unconcealed", 1000);
    stub.pushConfig({ concealWhilePending: false });
  });

  test("turning filtering off restores every hidden post immediately", async () => {
    const a = addPost({ id: uid(), text: "RAGE until switched off" });
    await waitFor(() => isHidden(a), "hidden");
    try {
      stub.pushConfig({ active: false });
      assert(!isHidden(a), "not restored synchronously");
      eq(document.querySelectorAll(".qf-placeholder").length, 0, "placeholders left");
    } finally {
      stub.pushConfig({ active: true });
    }
    await waitFor(() => isHidden(a), "re-hidden when switched back on");
  });

  test("leaving /home restores posts, and nothing is filtered elsewhere", async () => {
    const a = addPost({ id: uid(), text: "RAGE on the home feed" });
    await waitFor(() => isHidden(a), "hidden");
    history.pushState({}, "", "/explore");
    feed.append(document.createElement("div")); // any mutation triggers a scan
    await waitFor(() => !isHidden(a), "restored after navigation");
    const id = uid();
    addPost({ id, text: "RAGE on explore" });
    await sleep(300);
    eq(classifyCalls(id).length, 0, "classified off /home");
    history.pushState({}, "", "/home");
    feed.append(document.createElement("div"));
    await waitFor(() => isHidden(a), "re-hidden back on /home");
  });

  // ---- runner ----

  async function run() {
    const script = document.createElement("script");
    script.src = "/dist/content.js";
    document.body.append(script);
    await new Promise((r) => (script.onload = r));
    await waitFor(() => stub.messages.some((m) => m.type === "getContentConfig"), "content script booted");

    const results = [];
    for (const t of tests) {
      try {
        await t.fn();
        results.push({ name: t.name, ok: true });
      } catch (err) {
        results.push({ name: t.name, ok: false, error: String(err.message ?? err) });
      }
    }
    const failed = results.filter((r) => !r.ok);
    window.qfResults = { done: true, passed: results.length - failed.length, failed: failed.length, results };
    const report = document.getElementById("report");
    report.innerHTML = `<strong>${results.length - failed.length}/${results.length} passed</strong>${
      window.qfHiddenShims ? " <em>(page was hidden: ran with timer-based requestAnimationFrame and IntersectionObserver)</em>" : ""
    }`;
    for (const r of results) {
      const div = document.createElement("div");
      div.className = r.ok ? "pass" : "fail";
      div.textContent = `${r.ok ? "✔" : "✖"} ${r.name}${r.ok ? "" : `\n    ${r.error}`}`;
      report.append(div);
    }
  }

  run();
})();
