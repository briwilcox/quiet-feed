import { RULE_LABELS, SENSITIVITY_LABELS } from "../shared/settings.ts";
import type { Decision, DecisionReason, PostPayload, Settings } from "../shared/types.ts";
import type { RuleMeta } from "./jev.ts";

export function visible(reason: DecisionReason, explanation = ""): Decision {
  return { hide: false, reason, matched: [], explanation };
}

/**
 * Checks that settle a post without a model call. Returns null when the post
 * needs classification. Overrides come first so they always win.
 */
export function preDecide(post: PostPayload, settings: Settings, hasRules: boolean): Decision | null {
  if (!settings.enabled || !settings.disclosureAccepted) return visible("disabled");
  if (settings.allowedAuthors.includes(post.authorHandle.toLowerCase())) {
    return visible("allowed_author", `You always allow @${post.authorHandle}.`);
  }
  if (!hasRules) return visible("no_rules");
  // Incomplete text stays visible; it is re-evaluated once the user expands it.
  if (post.textTruncated) return visible("incomplete_text");
  return null;
}

export function decide(
  rules: RuleMeta[],
  probabilities: Record<string, number>,
  settings: Settings,
): Decision {
  const matched = rules
    .map((r) => ({ ruleId: r.ruleId, label: r.label, threshold: r.threshold, probability: probabilities[r.ruleId] }))
    .filter((m) => typeof m.probability === "number" && m.probability > m.threshold)
    .sort((a, b) => b.probability - a.probability);

  if (matched.length === 0) return visible("below_threshold");

  const labels = matched.map((m) => m.label).join(", ");
  return {
    hide: true,
    reason: "hidden",
    matched,
    explanation: `Matched your ${labels} filter${matched.length > 1 ? "s" : ""} at ${SENSITIVITY_LABELS[settings.sensitivity]} sensitivity.`,
  };
}

/**
 * The provider refused to process the post under its usage policy. Fastino
 * refuses many hostile posts, so by default that refusal hides the post; with
 * the setting off, the post stays visible like any other failure.
 */
export function applyRefusal(d: Decision, refused: boolean, settings: Settings): Decision {
  if (!refused) return d;
  if (!settings.hideProviderRefusals) return d.hide ? d : visible("provider_refused");
  const refusal = { ruleId: "provider_refused", label: RULE_LABELS.provider_refused, probability: 1, threshold: 0 };
  const matched = [...d.matched, refusal];
  return {
    hide: true,
    reason: "hidden",
    matched,
    explanation: d.hide
      ? `${d.explanation} Fastino also refused to process it.`
      : "Fastino refused to process this post under its usage policy, which usually means hostile content.",
  };
}
