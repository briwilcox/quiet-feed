import type { BlockedPost, ContentConfig, Decision, Message } from "../shared/types.ts";
import { extractPost, isSupportedPage, SEL, signature } from "./extract.ts";
import { PostTally } from "./tally.ts";

const ATTR_SIG = "data-qf-sig";
const PLACEHOLDER_CLASS = "qf-placeholder";

let config: ContentConfig | null = null;
/** Posts the user chose to show this page session, by status id. */
const revealed = new Set<string>();
const concealTimers = new WeakMap<Element, number>();
const tally = new PostTally();

function recordResult(statusId: string, blocked: boolean, ruleIds: string[], blockedPost?: Omit<BlockedPost, "at">) {
  const delta = tally.record(statusId, blocked);
  if (!delta) return;
  void send({
    type: "recordResult",
    ...delta,
    ruleIds,
    ...(delta.newlyBlocked && blockedPost && { blockedPost }),
  }).catch(() => {});
}

async function send<T>(msg: Message): Promise<T> {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error ?? "No response");
  return res.result as T;
}

// ---- restore / hide ----

function restore(article: HTMLElement) {
  const ph = article.previousElementSibling;
  if (ph?.classList.contains(PLACEHOLDER_CLASS)) ph.remove();
  article.style.removeProperty("display");
  unconceal(article);
  article.removeAttribute(ATTR_SIG);
}

function restoreAll() {
  document.querySelectorAll<HTMLElement>(`${SEL.post}[${ATTR_SIG}]`).forEach(restore);
}

function conceal(article: HTMLElement) {
  if (!config?.concealWhilePending) return;
  article.style.setProperty("visibility", "hidden");
  concealTimers.set(article, window.setTimeout(() => unconceal(article), config.concealTimeoutMs));
}

function unconceal(article: HTMLElement) {
  const t = concealTimers.get(article);
  if (t !== undefined) clearTimeout(t);
  concealTimers.delete(article);
  article.style.removeProperty("visibility");
}

function hide(article: HTMLElement, statusId: string, author: string, decision: Decision) {
  const ph = document.createElement("div");
  ph.className = PLACEHOLDER_CLASS;
  ph.title = decision.explanation;
  ph.style.cssText =
    "padding:10px 16px;font:14px/1.4 system-ui,sans-serif;color:rgb(113,118,123);border-bottom:1px solid rgba(113,118,123,.25)";

  const label = document.createElement("span");
  label.textContent = `Hidden: ${decision.matched.map((m) => m.label).join(", ")}`;
  const show = linkButton("Show post", () => {
    revealed.add(statusId);
    restore(article);
    article.setAttribute(ATTR_SIG, "revealed");
  });
  const allow = linkButton(`Always allow @${author}`, async () => {
    await send({ type: "allowAuthor", handle: author }).catch(() => {});
    restore(article);
  });
  ph.append(label, " · ", show, " · ", allow);

  article.before(ph);
  article.style.setProperty("display", "none");
  unconceal(article);
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.cssText = "all:unset;cursor:pointer;color:rgb(29,155,240)";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// ---- evaluation ----

async function evaluate(article: HTMLElement) {
  if (!config?.active || !isSupportedPage()) return;
  const post = extractPost(article);
  if (!post) return;
  const sig = signature(post);
  const current = article.getAttribute(ATTR_SIG);
  if (current === sig || current === "revealed") return;
  if (current !== null) restore(article); // element reused or text expanded
  if (revealed.has(post.statusId) || config.allowedAuthors.includes(post.authorHandle.toLowerCase())) {
    article.setAttribute(ATTR_SIG, sig);
    return;
  }

  article.setAttribute(ATTR_SIG, sig);
  conceal(article);
  const version = config.settingsVersion;
  let decision: Decision;
  try {
    decision = await send<Decision>({ type: "classify", post });
  } catch {
    unconceal(article);
    return; // errors leave the post visible
  }

  // Recheck identity: the element may have been reused or settings changed meanwhile.
  const now = extractPost(article);
  if (!now || signature(now) !== sig || article.getAttribute(ATTR_SIG) !== sig || config.settingsVersion !== version) {
    unconceal(article);
    return;
  }
  const blocked = decision.hide && !revealed.has(post.statusId);
  // Only real verdicts count as checked; errors, limits, and skips do not.
  if (decision.reason === "hidden" || decision.reason === "below_threshold") {
    recordResult(post.statusId, blocked, decision.matched.map((m) => m.ruleId), {
      statusId: post.statusId,
      authorHandle: post.authorHandle,
      snippet: post.text || post.quotedText || post.mediaLabels.join(", "),
      labels: decision.matched.map((m) => m.label),
    });
  }
  if (blocked) hide(article, post.statusId, post.authorHandle, decision);
  else unconceal(article);
}

// Only classify posts near the viewport.
const nearViewport = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) void evaluate(e.target as HTMLElement);
  },
  { rootMargin: "800px 0px" },
);
const observed = new WeakSet<Element>();

let lastPath = location.pathname;
function scan() {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    if (!isSupportedPage()) restoreAll();
  }
  if (!config?.active || !isSupportedPage()) return;
  document.querySelectorAll<HTMLElement>(SEL.post).forEach((a) => {
    if (!observed.has(a)) {
      observed.add(a);
      nearViewport.observe(a);
    } else if (isOnScreenish(a)) {
      // Re-evaluate reused elements, expanded text, and posts restored after a settings change.
      void evaluate(a);
    }
  });
}

function isOnScreenish(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > -800 && r.top < window.innerHeight + 800;
}

let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    scan();
  });
}).observe(document.body, { childList: true, subtree: true, characterData: true });

chrome.runtime.onMessage.addListener((msg: { type: string; config?: ContentConfig }, sender) => {
  if (sender.id !== chrome.runtime.id || msg.type !== "configChanged" || !msg.config) return;
  config = msg.config;
  restoreAll(); // immediate restoration; active filters re-apply below
  scan();
});

send<ContentConfig>({ type: "getContentConfig" })
  .then((c) => {
    config = c;
    scan();
  })
  .catch(() => {});
