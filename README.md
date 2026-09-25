# Quiet Feed

Quiet Feed is a browser extension (Chrome Manifest V3, also tested in Brave) that hides rage bait, low-effort filler, and topics you choose from your social feed. It works on the X home timeline today. The classification side knows nothing about X, so other feeds such as Threads or LinkedIn need only a small site adapter; see [Adding another site](#adding-another-site).

A hidden post collapses into one line, for example "Hidden: Rage bait · Show post · Always allow @author". Nothing is deleted, and every decision can be undone from the feed or the popup.

## Models

You choose which model judges posts. GLiNER2.5-Decide is the GLiNER model Quiet Feed is built for. The Fastino API option exists so the API path is ready when Fastino hosts Decide; until then it uses Fastino's general GLiNER2.5 model, which barely works for this task.

| Model | Where it runs | Default | Strengths | Weaknesses |
|---|---|---|---|---|
| Jev (`jev-latest`) by TypeSafe | TypeSafe's API, with your key | Yes | Reads long instructions; handles nuance, including slop | Needs a TypeSafe key |
| GLiNER2.5-Decide (`fastino/GLiNER2.5-Decide`) | Your computer, through the optional [local server](#local-model) | No | Rage bait, slop, and topics with no key or cost; post text stays on your computer | You run a Python server |
| GLiNER2.5 (`fastino/gliner2.5-multi-v1`) by Fastino | Fastino's API, with your key | No | Scaffolding for GLiNER2.5-Decide on Fastino's API | Barely works today; see [Model notes](#model-notes) |

## What it filters

| Filter | Jev | GLiNER2.5-Decide (local) | GLiNER2.5 (Fastino API) |
|---|---|---|---|
| Rage bait in the author's own text | Yes | Yes | Yes |
| Rage bait in a quoted post | Yes | Yes | Yes |
| LLM slop (generic, formulaic filler) | Yes | Yes | No |
| AI video slop, judged from the caption and media labels | Yes | Yes | Yes |
| Custom topics, with optional exceptions | Yes | Yes | Yes |

Quiet Feed never looks at video footage, only the text around it.

On X it filters the For You and Following timelines at `x.com/home`. Search, profiles, lists, and replies are left alone.

## Install

Quiet Feed is not in the Chrome Web Store yet, so you load it unpacked:

1. Build it (see [Develop](#develop)).
2. Open `chrome://extensions` (`brave://extensions` in Brave), turn on **Developer mode**, click **Load unpacked**, and choose the `dist/` folder.
3. Pin Quiet Feed from the extensions menu.

After you pull new code and rebuild, click the reload icon on Quiet Feed's card, then reload your X tabs. The browser keeps running the old background code until you do; the popup and settings page say so when that happens.

## Set up

1. Open Quiet Feed's **Settings**.
2. Under **Model**, keep Jev, pick GLiNER2.5-Decide on this computer, or pick GLiNER2.5 (Fastino). The local option switches only after its server answers.
3. For Jev or Fastino, read **What gets sent, and where** and check the box, then paste your key under **API keys** and click **Save and test**. Fastino keys start with `fast_sk_`. Choose **Session only** to re-enter the key after each browser restart, or **Remember on this device**.
4. Add custom topics if you want them, then turn on **Filtering** in the popup.

The popup shows today's blocked and checked counts, the reasons, the most recently hidden posts (their text stays covered until you click **Show**), the model's connection status, and usage. The toolbar badge counts today's hidden posts.

## Local model

The local model is optional. It runs `fastino/GLiNER2.5-Decide`, a 340-million-parameter classifier, in a small Python server that listens on `127.0.0.1`, on the Apple GPU when there is one and on the CPU otherwise.

### Install once

You need Python 3.10 or later and [uv](https://docs.astral.sh/uv/).

```bash
cd local-server
```

```bash
uv venv --python 3.12 .venv
```

```bash
VIRTUAL_ENV="$PWD/.venv" uv pip install --no-deps --require-hashes -r requirements.lock
```

`requirements.lock` pins every package by hash. It overrides `gliner2`'s requirement of `transformers<5` with `transformers==5.17.0`, because the 4.x line has known advisories that only 5.x fixes.

### Run

```bash
cd local-server && .venv/bin/python -m quiet_feed_local
```

The first start downloads about 2 GB of model weights from Hugging Face; later starts read them from the cache. Keep the terminal open while you browse, and choose **GLiNER2.5-Decide on this computer** in Settings. Settings then shows what the server reported, for example "fastino/GLiNER2.5-Decide on mps".

Flags: `--port` (default 8765; set **Server address** in Settings to match), `--device` (`auto`, `mps`, `cuda`, or `cpu`), `--extension-id` to accept requests only from your copy of Quiet Feed, and `--quiet` to stop logging request lines.

If the server stops while local mode is on, posts stay visible until it comes back.

### Server security

The server binds to `127.0.0.1` only and rejects any `Host` header other than 127.0.0.1 or localhost on its port, which blocks DNS rebinding. Classification requests must carry a `chrome-extension://` origin, which web pages cannot forge, and the server sends no CORS headers, so a web page cannot read its answers. Post text never reaches its logs.

## Privacy

For each post it checks, Quiet Feed sends the post text, any quoted text, image descriptions and labels, whether a video is attached, and the wording of your enabled filters and topics. That goes to the model you picked and nowhere else; with the local model it never leaves your computer.

Direct messages, drafts, cookies, and account details are never sent.

Fastino says it trains on customer data unless you are on its Pro or Custom plan and opt out.

On your device, decisions are cached for 24 hours as hashes and scores, without post text. The popup's list of the last 50 hidden posts (author, first 280 characters, and reason) lives in memory and disappears when the browser closes.

API keys sit in extension storage that only Quiet Feed's own pages and background worker can read. Quiet Feed never syncs, exports, or logs them, or hands them to the web page. "Remember on this device" is ordinary local storage, not an encrypted vault.

When a request fails, the post stays visible.

## Model notes

These come from a small spot check (about 40 hand-written posts plus some live browsing), not an accuracy evaluation.

GLiNER2.5-Decide separated rage bait, slop, and topics cleanly on the spot-check posts and never refuses a request. It needs no API key, and post text stays on your computer.

GLiNER models have no free-text prompt: the task name and label names carry the question, so wording matters. On Fastino's hosted `fastino/gliner2.5-multi-v1`, named labels ("rage bait" versus "not rage bait") separated rage bait with an AUC (area under the curve, where 1.0 separates perfectly and 0.5 is chance) of 0.97 to 0.98 on 16 posts, and a bare topic name reached 1.00 on 10 posts. Adding a description to a topic label broke topic detection on that model, so Quiet Feed sends it topic names only.

Fastino's API model has no slop filter, and its usage policy refuses many requests about hostile posts. Because a refusal usually means a hostile post, Quiet Feed hides refused posts by default and labels them "Refused by Fastino"; **Hide posts Fastino refuses to process** in Settings turns that off.

Thresholds are set per model in [src/shared/settings.ts](src/shared/settings.ts), because the models' scores are not on the same scale.

## Adding another site

Everything after extraction is site-neutral. The content script turns each post into a `PostPayload` (id, author, text, quoted text, media labels, whether a video is attached, and whether the text is truncated), and the background worker, models, cache, and decisions work only with that.

To support a site such as Threads or LinkedIn:

1. Write an extractor like [src/content/extract.ts](src/content/extract.ts): selectors for a post, its text, and a quoted post, plus `extractPost()` and a check for which pages to filter.
2. Add the site to `content_scripts.matches` and `host_permissions` in [src/manifest.json](src/manifest.json), and to the tab list that settings changes are broadcast to in [src/background/index.ts](src/background/index.ts).
3. Loosen the X-specific formats: the author-handle check in `allowAuthor`, the post-id check in the recently-blocked list, and the `x.com` links the popup builds for hidden posts.

Right now the content script loads only the X extractor. Choosing an extractor by hostname is the next step toward multiple sites; contributions are welcome.

## Develop

You need Node 23 or later.

```bash
npm install
```

```bash
npm run build
```

`npm run build:nodeps` builds `dist/` with Node's built-in type stripping and no installed packages.

## Tests

The unit, integration, and browser tests use Node's built-in test runner and no packages.

| Command | What it covers |
|---|---|
| `npm test` | Unit and integration tests |
| `npm run test:unit` | Request building for all three models, response parsing, decisions and refusals, retries, cache, queue, key storage, settings, badge, tally, and popup state |
| `npm run test:integration` | The real background worker against a stubbed `chrome.*` API and stubbed model endpoints, plus a build into a temporary folder that loads the built worker |
| `npm run test:browser` | Builds `dist/` and serves two suites: the content script at http://localhost:4173/home, and the popup and settings pages at http://localhost:4173/test/browser/pages.html |
| `npm run test:local-server` | The Python server: validation, the request limits the extension relies on, security checks, one response per request, the command line, and real HTTP round trips with a stand-in model (needs `local-server/.venv`) |
| `npm run test:mutation` | Mutation testing of the TypeScript and Python code; fails below 80% (`-- --suite js` or `-- --suite python` runs one language) |

The content-script suite loads the built `dist/content.js` into a page with X-shaped markup and a scripted `chrome.runtime`. When the page is hidden, it swaps in timer-based `requestAnimationFrame` and `IntersectionObserver` and notes it in the report. The pages suite loads the built popup and settings pages with a scripted `chrome.*`, including an out-of-date background worker and a stopped local server.

[scripts/mutation.mjs](scripts/mutation.mjs) is a dependency-free mutation tester. It changes one thing at a time in the source, reruns that language's tests, and lists every change no test caught. The Python suite needs `local-server/.venv` and permission to open a local port. A line marked `mutation-ignore: <reason>` is skipped, which is reserved for tunable defaults and changes that cannot alter behavior.

## Layout

| Path | What it does |
|---|---|
| `src/content/extract.ts` | X selectors and post extraction (the site adapter) |
| `src/content/index.ts` | Viewport watching, placeholders, and restoring posts |
| `src/background/index.ts` | Background worker: messages, model selection, cache, usage, badge |
| `src/background/jev.ts` | TypeSafe Jev client |
| `src/background/gliner.ts` | Fastino GLiNER client, including refusals |
| `src/background/local.ts` | Local model client, health check, and address validation |
| `src/background/decide.ts` | Overrides, thresholds, refusals, and the plain-language reason |
| `src/background/cache.ts` | Hash-keyed decision cache with expiry; stores no post text |
| `src/background/queue.ts` | Concurrency limit and deduplication across tabs |
| `src/background/keystore.ts` | API key storage limited to the extension's own pages |
| `src/popup/`, `src/options/` | Popup and settings pages |
| `local-server/` | The optional local model server (Python standard library plus `gliner2`) |
| `test/` | Unit, integration, and browser tests |
| `docs/SPEC.md` | The original product and technical spec |

## License

MIT; see [LICENSE](LICENSE). The `fastino/GLiNER2.5-Decide` model and the `gliner2` library that the local server downloads are licensed separately under Apache-2.0.
