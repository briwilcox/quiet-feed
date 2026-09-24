import type { PostPayload } from "../shared/types.ts";

// X's DOM is undocumented and changes without notice. Every selector lives here
// so breakage is fixed in one place.
export const SEL = {
  post: 'article[data-testid="tweet"]',
  text: '[data-testid="tweetText"]',
  showMore: '[data-testid="tweet-text-show-more-link"]',
  quote: 'div[role="link"]',
  video: '[data-testid="videoPlayer"], [data-testid="videoComponent"]',
  photo: '[data-testid="tweetPhoto"] img[alt]',
  permalink: 'a[href*="/status/"]:has(time)',
  userName: '[data-testid="User-Name"]',
};

/** Timelines the first release filters: For You and Following both live at /home. */
export function isSupportedPage(loc: Location = location): boolean {
  return loc.pathname === "/home";
}

export function extractPost(article: Element): PostPayload | null {
  const link = article.querySelector<HTMLAnchorElement>(SEL.permalink);
  const m = link?.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  if (!m) return null;

  const quote =
    [...article.querySelectorAll(SEL.quote)].find((el) => el.querySelector(SEL.text) || el.querySelector(SEL.userName)) ??
    null;
  const inQuote = (el: Element) => quote !== null && quote.contains(el);
  const texts = [...article.querySelectorAll(SEL.text)];
  const own = texts.find((t) => !inQuote(t));
  const quoted = texts.find(inQuote);

  const mediaLabels = [...article.querySelectorAll<HTMLImageElement>(SEL.photo)]
    .filter((img) => !inQuote(img))
    .map((img) => img.alt.trim())
    .filter((alt) => alt && alt !== "Image");

  const text = own ? readText(own) : "";
  const quotedText = quoted ? readText(quoted) : null;
  if (!text && !quotedText && mediaLabels.length === 0) return null;

  return {
    statusId: m[2],
    authorHandle: m[1],
    text,
    quotedText,
    mediaLabels,
    hasVideo: [...article.querySelectorAll(SEL.video)].some((v) => !inQuote(v)),
    textTruncated: [...article.querySelectorAll(SEL.showMore)].some((s) => !inQuote(s)),
  };
}

/** innerText drops emoji images; include their alt text so meaning survives. */
function readText(el: Element): string {
  let out = "";
  el.childNodes.forEach(function walk(n: Node) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
    else if (n instanceof HTMLImageElement) out += n.alt;
    else n.childNodes.forEach(walk);
  });
  return out.trim();
}

/** Identity + content signature; a reused element with new content gets a new one. */
export function signature(p: PostPayload): string {
  return JSON.stringify([p.statusId, p.text, p.quotedText, p.mediaLabels, p.hasVideo, p.textTruncated]);
}
