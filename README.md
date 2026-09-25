# Quiet Feed

A Chrome extension (Manifest V3) that hides rage bait, low-substance "slop," and topics you choose from your X home timeline. It classifies posts with TypeSafe's Jev model using your own API key. Every hidden post is replaced by a placeholder with **Show post** and **Always allow this author**.

The full product and technical spec is in [docs/SPEC.md](docs/SPEC.md).

AI video filtering is based on post text and labels only. Jev accepts text, so Quiet Feed cannot inspect video footage.

## Status

Milestone 1 (feasibility) scaffold, with most of milestone 2 wired up:

- Service worker: Jev client with bounded retries, one Noul question per enabled filter and topic in a single request, response validation, a two-slot request queue that deduplicates across tabs, a 24-hour hash-keyed cache of raw probabilities, a daily request limit, and usage counters.
- Content script: extracts post text, quoted text, image labels, video presence, and truncation on `/home`; classifies posts near the viewport; rechecks post identity before applying a result; restores posts immediately on "Show post" or when settings change.
- Popup: master switch, filter and topic toggles, sensitivity, hidden counts, connection status, usage.
- Settings page: privacy disclosure (required before filtering turns on), API key entry with session-only or on-device storage, topic editor with exceptions, allowed authors, limits.

Not done yet: calibrated thresholds (the values in `src/shared/settings.ts` are placeholders), a pinned model version (`jev-latest` for now), the labeled evaluation set, and testing against the live X DOM. X's markup is undocumented; all selectors live in `src/content/extract.ts`.

## Develop

Requires Node 23 or later.

```bash
npm install
```

```bash
npm run build
```

If `npm install` is unavailable, `npm run build:nodeps` builds `dist/` with Node's built-in type stripping and no packages.

Then open `chrome://extensions` (or `brave://extensions` in Brave), turn on Developer mode, choose **Load unpacked**, and select `dist/`. Use `npm run watch` to rebuild on change.

## Tests

Everything runs on Node's built-in test runner and type stripping, with no installed packages.

| Command | What it covers |
|---|---|
| `npm test` | Unit and integration tests together |
| `npm run test:unit` | Pure modules: request building, decisions, retries, cache, queue, key storage, settings, badge, tally, popup reveal state |
| `npm run test:integration` | The real service worker against a stubbed `chrome.*` API and a stubbed TypeSafe endpoint: classify pipeline, caching, cross-tab dedupe, daily limit, sender restrictions, key handling, counters, badge, recent list, settings broadcast |
| `npm run test:browser` | Builds `dist/`, then serves the content-script suite at http://localhost:4173/home. Open it in Chrome; results render at the top of the page |
| `npm run test:mutation` | Mutation testing (see below); fails under 80% |

### Browser suite

`test/browser/` loads the built `dist/content.js` into a page with X-shaped markup and a scripted `chrome.runtime`. It covers placeholders, extraction (own text, quoted text, media labels, video, truncation, emoji), link cards versus quoted posts, allowed authors, Show post, Always allow, tallying, reused elements, expanded text, late and same-tick results, errors, viewport gating, concealment, turning filtering off, and leaving `/home`. If the page is hidden (a background tab), it substitutes timer-based `requestAnimationFrame` and `IntersectionObserver` and says so in the report.

### Mutation testing

`scripts/mutation.mjs` is a small dependency-free mutation tester. It makes one change at a time to the Node-testable source (comparison and boundary flips, `&&`/`||` swaps, arithmetic, booleans, negations, numbers, a few method swaps), runs the unit and integration suites against each mutant in a scratch copy, and lists survivors. A line marked `// mutation-ignore: <reason>` is skipped; that is reserved for tunable defaults and equivalent mutants. Browser-only code (`src/content/index.ts`, `extract.ts`, popup and settings pages) is covered by the browser suite instead.

## Layout

| Path | What it does |
|---|---|
| `src/background/jev.ts` | Builds the Jev request (state plus Noul questions) and calls the API |
| `src/background/decide.ts` | Overrides, thresholds, and the plain-language explanation |
| `src/background/cache.ts` | SHA-256 keyed decision cache with expiry; stores no post text |
| `src/background/queue.ts` | Concurrency limit and in-flight deduplication |
| `src/background/keystore.ts` | API key storage, restricted to trusted extension contexts |
| `src/content/extract.ts` | X DOM selectors and post extraction |
| `src/content/index.ts` | Viewport observation, placeholders, restore |
| `src/popup/`, `src/options/` | Extension UI |

## API key handling

The key is stored in `chrome.storage.session` (session only) or `chrome.storage.local` (remember on this device). Both areas are set to `TRUSTED_CONTEXTS`, so the X page and the content script cannot read them. The key is never synced, exported, sent to the content script, or logged. On-device storage is not encrypted.
