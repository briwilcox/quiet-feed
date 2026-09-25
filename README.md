# Quiet Feed

Quiet Feed is a Chrome extension (Manifest V3) that hides rage bait, low-substance posts, and topics you choose from your X home timeline. Each hidden post turns into a one-line placeholder with **Show post** and **Always allow @author**, so nothing is ever deleted and every decision is reversible.

Posts are classified by one of three models. You pick which:

| Model | Runs | Default | Good at | Weak at |
|---|---|---|---|---|
| Jev (`jev-latest`) | TypeSafe's cloud, your API key | Yes | Long instructions and nuance, including slop | Needs a TypeSafe key |
| GLiNER2.5 (`fastino/gliner2.5-multi-v1`) | Fastino's cloud, your API key | No | Rage bait, quoted rage bait, custom topics; about 0.5 seconds per question | Generic "slop" (not offered), topic exceptions; Fastino refuses some hostile posts |
| GLiNER2.5-Decide (`fastino/GLiNER2.5-Decide`) | This computer, through the optional [local server](#local-model) | No | Rage bait, slop, topics; no key, no cost, post text never leaves the computer; about 0.1 seconds per question on an Apple GPU | Needs a Python server running; slop sometimes also fires on hype and rage posts |

The full product and technical spec is in [docs/SPEC.md](docs/SPEC.md).

## What it filters

| Filter | Jev | GLiNER (Fastino) | GLiNER-Decide (local) |
|---|---|---|---|
| Rage bait (the author's own text) | Yes | Yes | Yes |
| Rage bait in a quoted post | Yes | Yes | Yes |
| LLM slop (generic, formulaic filler) | Yes | No, see [Model notes](#model-notes) | Yes |
| AI video slop, judged from text and labels only | Yes | Yes | Yes |
| Custom topics, with optional exceptions | Yes | Yes | Yes |

Quiet Feed cannot see video footage. AI video filtering reads only the caption and any media labels.

Filtering covers the For You and Following timelines at `x.com/home`. Search, profiles, lists, and replies are not filtered yet.

## Install

Quiet Feed is not in the Chrome Web Store. Load it unpacked:

1. Build it (see [Develop](#develop)), or use an existing `dist/` folder.
2. Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click **Load unpacked**, and select the `dist/` folder.
3. Pin Quiet Feed from the extensions menu.

After pulling new code, rebuild, click the reload icon on the extension's card, and reload your X tabs.

## Set up

1. Open the extension's **Settings**.
2. Under **Model**, keep Jev (TypeSafe), the default, or choose GLiNER2.5 (Fastino) or GLiNER2.5-Decide on this computer. The local option switches over only after its server answers; see [Local model](#local-model).
3. For a cloud model, read **What gets sent, and where**, then check the box to allow it. The local model does not need this.
4. For a cloud model, paste its key under **API keys** and click **Save and test**. Fastino keys start with `fast_sk_`. Choose **Session only** (you re-enter the key after restarting the browser) or **Remember on this device**.
5. Add custom topics if you want them, then turn on **Filtering** in the popup.

The popup shows today's blocked and checked counts, a per-filter breakdown, the most recently hidden posts (hidden until you click **Show**), the model and its connection status, and usage. The toolbar badge shows today's blocked count.

## Local model

The local model is optional; the extension works without it. It runs `fastino/GLiNER2.5-Decide` (340 million parameters, Apache-2.0) in a small Python server on `127.0.0.1`. It uses the Apple GPU when available, otherwise the CPU.

### Install once

Requires Python 3.10 or later and [uv](https://docs.astral.sh/uv/).

```bash
cd local-server
```

```bash
uv venv --python 3.12 .venv
```

```bash
VIRTUAL_ENV="$PWD/.venv" uv pip install --no-deps --require-hashes -r requirements.lock
```

`requirements.lock` pins all 45 packages with hashes, none newer than 14 days when locked. It overrides `gliner2`'s declared `transformers<5` with `transformers==5.17.0`, because every 4.x release has unfixed advisories (including remote code execution when loading a malicious model config) that are fixed only in 5.x. `--no-deps` is required: a normal resolve would reject the override. To regenerate the lock, see `requirements.in` and `overrides.txt`.

### Run

```bash
cd local-server && .venv/bin/python -m quiet_feed_local
```

The first run downloads the model (about 2 GB) from Hugging Face; later starts load it from the local cache. Leave the terminal open while you browse. Then, in the extension's settings, choose **GLiNER2.5-Decide on this computer**. Quiet Feed checks the server first and shows the model and device it reports, for example "fastino/GLiNER2.5-Decide on mps". If the server is not running, the setting does not switch.

Options: `--port` (default 8765; change **Server address** in settings to match), `--device` (`auto`, `mps`, `cuda`, or `cpu`), `--extension-id` (accept requests only from your copy of Quiet Feed, using the ID shown on `chrome://extensions`), and `--quiet`.

If the server stops while local mode is selected, posts stay visible until it is back.

### Server security

The server listens on `127.0.0.1` only. It checks that the `Host` header names 127.0.0.1 or localhost on its port, which blocks DNS rebinding. Classification requests must come from a `chrome-extension://` origin, which web pages cannot fake. It sends no CORS headers, so a web page cannot read its answers. It never logs post text.

## Privacy

- **Sent:** for each post evaluated on the home timeline, Quiet Feed sends the post text, any quoted-post text, image descriptions and labels, whether a video is attached, and the wording of the filters and topics you enabled. It goes to the model you picked, and nowhere else. With the local model, it goes only to the server on your computer.
- **Not sent:** direct messages, drafts, cookies, account details, and anything else on the page.
- **Fastino's policy:** Fastino states that it trains on customer data unless you are on a Pro or Custom plan and opt out.
- **Stored on this device:** decisions are cached for 24 hours as hashes and scores, with no post text. The last 50 hidden posts (author, first 280 characters, and reason) stay in memory for the popup and are erased when the browser closes.
- **API keys:** kept in extension storage that only the extension's own pages and service worker can read. They are never synced, exported, sent to the X page, or logged. "Remember on this device" is plain local storage, not an encrypted vault.
- **On failure:** if a request fails, the post stays visible.

## Model notes

These observations come from a small spot check: about 40 posts I wrote by hand, plus a few live runs. They explain the current design. They are not accuracy claims; see [Status](#status).

- **Wording matters for GLiNER.** GLiNER has no free-text prompt field; the task name and label names carry the question. Named labels (`"rage bait"` versus `"not rage bait"`) separated rage bait well (an AUC, or area under the curve, of 0.97 to 0.98 on 16 posts, where 1.0 separates perfectly and 0.5 is chance), and a bare topic name worked well (AUC 1.00 on 10 posts). Adding a description to a topic label broke topic detection, so GLiNER ignores topic descriptions.
- **One question per request.** Asking several questions in one GLiNER request caused cross-talk, and Fastino refused more of those requests. Quiet Feed sends each question as its own request, in parallel. The daily request limit counts each of these calls.
- **No slop filter on GLiNER.** No wording separated generic slop from normal posts; on live posts the scores ran backwards. Use Jev for slop.
- **Topic exceptions are unreliable on GLiNER.** An exception competes as a third label. It kept research posts visible, but it also sometimes mistook a price-speculation post for research.
- **Fastino refuses some hostile posts, unpredictably.** Across all runs, its usage policy rejected 18 of 40 requests about hostile test posts and none about calm ones. The rate swung from 1 in 8 to 6 in 8 depending on the question wording, on which other questions shared the request, and between runs of the identical request. A refusal is a strong hint that a post is hostile, so by default a refused post is hidden with the reason "Refused by Fastino". Turn off **Hide posts Fastino refuses to process** to leave them visible instead.
- **The local model does better on the same posts.** Named labels separated rage bait, slop (with a one-line description per label), and topics perfectly on the hand-written set (AUC 1.00 each), and it never refuses. Asking several questions in one pass still hurt, so the server runs each question separately; on an Apple GPU that costs about 90 milliseconds per question (about 600 on the CPU). On live posts, slop also fired on hype and rage posts, and a clickbait video post scored 0.78 for rage bait, which set the local thresholds higher than the spot check alone suggested.
- **Model version.** The only GLiNER2.5 model Fastino hosts is `fastino/gliner2.5-multi-v1`. It is probably the multilingual Decide variant, not the English `fastino/GLiNER2.5-Decide`; Fastino has not confirmed this.
- **Thresholds are placeholders.** Each model has its own table in [src/shared/settings.ts](src/shared/settings.ts), because their scores are not on the same scale.

## Status

This is a private beta. What remains before a public release:

- a labeled evaluation set of 300 to 500 posts, with per-category thresholds tuned on it
- pinned model versions instead of `jev-latest`
- a longer check against the live X page (all X selectors live in [src/content/extract.ts](src/content/extract.ts))
- running the local server as a background service, if starting it by hand becomes a chore
- confirming in a real browser that the extension's requests reach the local server (verified so far with stubs and direct calls)

## Develop

Requires Node 23 or later.

```bash
npm install
```

```bash
npm run build
```

If `npm install` is unavailable, this builds `dist/` using only Node's built-in type stripping:

```bash
npm run build:nodeps
```

## Tests

Everything runs on Node's built-in test runner, with no installed packages.

| Command | What it covers |
|---|---|
| `npm test` | Unit and integration tests together |
| `npm run test:unit` | Pure modules: request building for all three models, response parsing, decisions and refusals, retries, cache, queue, key storage, settings, badge, tally, popup reveal state |
| `npm run test:integration` | The real service worker against a stubbed `chrome.*` API and stubbed provider endpoints: all three backends, caching, cross-tab deduplication, daily limit, refusals, sender restrictions, per-provider keys, counters, badge, recent list, settings broadcast |
| `npm run test:browser` | Builds `dist/`, then serves the content-script suite at http://localhost:4173/home; open it in a browser and read the results at the top |
| `npm run test:mutation` | Mutation testing; fails below 80% |
| `npm run test:local-server` | The Python server: validation, classification, security checks, and real HTTP round trips with a stand-in model (needs `local-server/.venv`) |

The browser suite loads the built `dist/content.js` into a page with X-shaped markup and a scripted `chrome.runtime`. If the page is hidden, it substitutes timer-based `requestAnimationFrame` and `IntersectionObserver` and says so in the report.

[scripts/mutation.mjs](scripts/mutation.mjs) is a small mutation tester with no dependencies. It changes one thing at a time in the Node-testable source, reruns the unit and integration suites against each change, and lists any change no test caught. Lines marked `// mutation-ignore: <reason>` are skipped; that marker is reserved for tunable defaults and equivalent mutants.

## Layout

| Path | What it does |
|---|---|
| `src/background/gliner.ts` | Fastino GLiNER requests (one question per request), response parsing, refusals |
| `src/background/jev.ts` | TypeSafe Jev request (state plus Noul questions) and client |
| `src/background/local.ts` | Local GLiNER2.5-Decide requests, health check, endpoint validation |
| `local-server/` | The optional local model server (Python, standard library plus `gliner2`) |
| `src/background/decide.ts` | Overrides, thresholds, refusal handling, and the plain-language explanation |
| `src/background/index.ts` | Service worker: message router, backend selection, cache, usage, badge |
| `src/background/cache.ts` | SHA-256 keyed decision cache with expiry; stores no post text |
| `src/background/queue.ts` | Concurrency limit and in-flight deduplication |
| `src/background/keystore.ts` | Per-provider API key storage, restricted to trusted extension contexts |
| `src/content/extract.ts` | X DOM selectors and post extraction |
| `src/content/index.ts` | Viewport observation, placeholders, restore |
| `src/popup/`, `src/options/` | Extension UI |
| `test/` | Unit, integration, and browser tests |

## License

No license file yet. Until one is added, the repository is private and all rights are reserved.
