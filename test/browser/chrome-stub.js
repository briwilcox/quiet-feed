// Minimal chrome.runtime stand-in for the content script. The background side
// is scripted by the tests through window.qfStub.
(() => {
  // Hidden pages (a background tab, a collapsed preview pane) get no animation
  // frames or IntersectionObserver callbacks. Substitute timer-driven versions
  // so the suite still exercises the content script; the report says so.
  if (document.hidden) {
    window.qfHiddenShims = true;
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
    const observers = new Set();
    window.IntersectionObserver = class {
      constructor(callback, options = {}) {
        this.callback = callback;
        this.margin = parseInt(options.rootMargin ?? "0", 10) || 0;
        this.state = new Map();
        observers.add(this);
      }
      observe(el) {
        this.state.set(el, false);
        this.check();
      }
      unobserve(el) {
        this.state.delete(el);
      }
      disconnect() {
        this.state.clear();
        observers.delete(this);
      }
      check() {
        const entries = [];
        for (const [el, was] of this.state) {
          const r = el.getBoundingClientRect();
          const now = r.bottom >= -this.margin && r.top <= window.innerHeight + this.margin;
          if (now !== was) {
            this.state.set(el, now);
            entries.push({ target: el, isIntersecting: now });
          }
        }
        if (entries.length) this.callback(entries, this);
      }
    };
    setInterval(() => observers.forEach((o) => o.check()), 50);
  }

  const listeners = [];
  const stub = {
    messages: [],
    config: { active: true, concealWhilePending: false, concealTimeoutMs: 400, allowedAuthors: ["friend"], settingsVersion: 1 },
    /** statusId -> ms delay before answering classify */
    delays: new Map(),
    /** statusIds whose classify call should fail */
    failing: new Set(),
    /** statusId -> fn run synchronously just before the classify reply is delivered */
    beforeReply: new Map(),
    decide(post) {
      const rage = /RAGE/.test(post.text) ? "rage_bait" : /RAGE/.test(post.quotedText ?? "") ? "rage_bait_quoted" : null;
      if (!rage) return { hide: false, reason: "below_threshold", matched: [], explanation: "" };
      const label = rage === "rage_bait" ? "Rage bait" : "Rage bait (quoted post)";
      return {
        hide: true,
        reason: "hidden",
        matched: [{ ruleId: rage, label, probability: 0.97, threshold: 0.8 }],
        explanation: `Matched your ${label} filter at Balanced sensitivity.`,
      };
    },
    async handle(msg) {
      stub.messages.push(msg);
      if (msg.type === "getContentConfig") return stub.config;
      if (msg.type === "allowAuthor") {
        // Mirror the background: the author is saved before the reply arrives.
        stub.config = { ...stub.config, allowedAuthors: [...stub.config.allowedAuthors, msg.handle.toLowerCase()] };
        return null;
      }
      if (msg.type === "classify") {
        if (stub.config.allowedAuthors.includes(msg.post.authorHandle.toLowerCase())) {
          return { hide: false, reason: "allowed_author", matched: [], explanation: "" };
        }
        const id = msg.post.statusId;
        const delay = stub.delays.get(id) ?? 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (stub.failing.has(id)) throw new Error("boom");
        const decision = stub.decide(msg.post);
        stub.beforeReply.get(id)?.();
        return decision;
      }
      return null;
    },
    /** Push a configChanged message as the background would. */
    pushConfig(patch) {
      stub.config = { ...stub.config, ...patch, settingsVersion: stub.config.settingsVersion + 1 };
      for (const fn of listeners) fn({ type: "configChanged", config: stub.config }, { id: "qf-test" });
    },
  };
  window.qfStub = stub;
  window.chrome = {
    runtime: {
      id: "qf-test",
      async sendMessage(msg) {
        try {
          return { ok: true, result: await stub.handle(msg) };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
})();
