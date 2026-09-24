# Quiet Feed: product and technical spec

Build a Chrome extension that filters X using the user’s own TypeSafe/Jev API key, with adjustable filters and a reversible “Show post” action.

**One important limitation:** Jev currently accepts text only. It can assess captions, post text, and available labels, but cannot inspect video footage. The first release should describe AI-video filtering as “based on text and labels.” Visual detection would require an additional model later. [TypeSafe input support](https://docs.typesafe.ai/concepts/state)

**1. Product scope**

Working name: **Quiet Feed**.

| Filter | Intended behavior |
|---|---|
| Rage bait | Hide posts primarily designed to provoke outrage, hostility, or engagement through inflammatory framing. |
| LLM slop | Hide generic, repetitive, formulaic content with little substance. Treat this as a content-quality judgment, not proof of AI authorship. |
| AI video slop | Hide video posts whose accompanying text or labels provide strong evidence of low-value synthetic content. Leave unsupported cases visible. |
| Custom topics | Hide posts semantically related to topics the user enters, including paraphrases and related entities. |

Start with English posts on X’s **For You and Following timelines**. Add search results, profiles, lists, and conversation replies after the core feed behavior is reliable.

**2. User experience**

Setup:

1. Paste a Jev API key into a masked field.
2. Test the connection.
3. Choose filters and sensitivity: Conservative, Balanced, or Aggressive.
4. Enter topics such as “celebrity divorces,” “election polling,” or “Apple product rumors.”
5. Enable filtering.

Each custom topic can include a description and exceptions—for example: “Hide cryptocurrency price speculation; keep technical blockchain research.”

Filtered posts become a compact placeholder:

> Hidden: Rage bait · Show post · Always allow this author

The extension popup provides:

- Master on/off switch and individual filter toggles.
- Custom-topic editor.
- Hidden-post counts by reason.
- API connection status and usage counters.
- A daily request limit.
- A link to settings, including deleting the saved key and cached decisions.

Use plain explanations generated from the matched rule. No extra model request is needed to explain a decision.

**3. Extension architecture**

Use **TypeScript and Chrome Manifest V3**, with three main components:

| Component | Responsibility |
|---|---|
| Content script | Find posts, extract relevant text, monitor newly loaded posts, and collapse or restore them. |
| Background service worker | Call Jev, validate results, enforce usage limits, cache decisions, and manage credentials. |
| Popup and settings page | Configure filters, topics, exceptions, and API-key storage. |

Chrome supports this division through content scripts, extension messaging, and background network requests with host permissions. Restrict access to X/Twitter and the TypeSafe API. [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

The initial architecture needs no application server or X API integration: it evaluates posts already rendered in the user’s browser.

**4. Jev classification design**

Call `POST https://api.typesafe.ai/v1/systemone` with bearer authentication. Prototype using `jev-latest`; validate and pin a supported model version for release so model changes do not silently change filtering behavior. [API reference](https://docs.typesafe.ai/api)

For each post, send structured context:

- Post text.
- Quoted-post text, clearly separated.
- Available media descriptions and labels.
- Whether video is present.
- Whether text appears incomplete.

Ask separate **Noul questions** for each enabled category and each custom topic in one request. Every topic needs its own decision because posts can match multiple topics. Put the full criteria in the question instructions; question identifiers alone carry no meaning to the model.

Noul returns a yes-probability without a separate confidence field. Use category-specific thresholds, calibrated on examples, rather than treating one threshold as universally reliable. [Noul documentation](https://docs.typesafe.ai/primitives/noul)

The extension makes the final decision:

- User overrides take precedence.
- Hide when an enabled rule exceeds its threshold.
- Leave uncertain or incomplete cases visible.
- Leave posts visible on API errors.
- Treat post content as untrusted material to classify, including text attempting to manipulate the classifier.

**5. Feed reliability and performance**

The implementation must handle infinite scrolling, navigation without page reloads, quoted posts, expanded text, and reused post elements.

Key decisions:

- Classify posts near the viewport instead of the entire loaded page.
- Start with two concurrent requests and a bounded queue.
- Deduplicate requests across tabs.
- Cache by post content, filter definitions, prompt version, and model version.
- Recheck post identity before applying an asynchronous result.
- Reevaluate when expanded text or filter settings change.
- Preserve original elements so “Show post” restores them immediately.
- Leave posts visible while pending by default; offer an optional temporary concealment mode with a timeout.
- Use bounded retries with backoff for rate limits and temporary overload.

**6. API-key handling and privacy**

Keep the key in trusted extension contexts, never in the X page or its storage.

Offer two storage choices:

- **Session only:** the user reenters the key after restarting Chrome.
- **Remember on this device:** persist locally with access restricted to trusted extension contexts.

Never sync the key, include it in exports, or log it. Local persistence should not be presented as an encrypted credential vault. Chrome provides session storage and storage-access controls for this design. [Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage)

Before activation, explain that evaluated post text and relevant filter criteria go to TypeSafe. Exclude messages, drafts, cookies, and unrelated page content. Store cached decisions with expiration rather than retaining full browsing content. Prepare the corresponding privacy disclosure for store publication. [Chrome Web Store requirements](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)

**7. Implementation milestones**

| Milestone | Deliverable | Completion check |
|---|---|---|
| Feasibility | Extension skeleton, key entry, direct Jev request, sample-post extraction | Authenticated requests work from the extension; latency and usage are measured. |
| Core filtering | Rage bait, text slop, custom topics, placeholders, reveal action | Filters work while scrolling both home feeds. |
| Reliability | Caching, overrides, request limits, navigation handling, error recovery | No stale decisions hide the wrong post; failures preserve feed usability. |
| Evaluation | Labeled example set and tuned thresholds | Accuracy is measured separately for every category. |
| Private beta | Installable build, setup instructions, privacy text | Real browsing validates usability, performance, and costs. |
| Store release | Packaged extension and listing | Release checks pass and claims accurately describe media limitations. |

For evaluation, assemble roughly **300–500 representative posts**, separating tuning examples from a held-out test set. Include satire, legitimate criticism, polished human writing, ambiguous topics, quoted disagreements, and misleading video captions.

Proposed release targets—not current performance claims:

- At least **90% precision** for automatic hiding on held-out examples, reported per category.
- Measure recall alongside precision so overly cautious filters are visible.
- Target **under two seconds** for uncached decisions under normal conditions.
- Immediate restoration when filtering is disabled.
- Measured request and token usage per 1,000 posts before estimating operating cost.

**Recommended first release:** ship reversible text and topic filtering, plus explicitly limited AI-video filtering from textual evidence. Keep visual video analysis as a separate follow-on milestone requiring a multimodal provider and its own accuracy evaluation.
