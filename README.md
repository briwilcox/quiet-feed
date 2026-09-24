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

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `dist/`. Use `npm run watch` to rebuild on change.

```bash
npm test
```

```bash
npm run typecheck
```

Tests use Node's built-in runner and type stripping, so they need no installed packages.

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
