import { RULE_VERSION } from "../learning/contracts";

export const AI_LEARNING_MIN_GROUP = 5;
const bands = ["insufficient_evidence", "weak", "developing", "mastered"] as const;
type Band = (typeof bands)[number];
export type AiLearningSource = {
  rule_version: typeof RULE_VERSION;
  mastery_bands: Record<Band, number> | null;
  training_completion: "unavailable";
};
export type AiLearningSourceResult =
  | { eligible: false; reason: "invalid_facts" | "insufficient_evidence" }
  | { eligible: true; source: AiLearningSource };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 200;
}
function safeGroup(value: number): boolean {
  return value === 0 || value >= AI_LEARNING_MIN_GROUP;
}

/** Only server-computed effective facts belong here. No identifiers or free text leave this boundary. */
export function sanitizeAiLearningFacts(value: unknown): AiLearningSourceResult {
  const facts = record(value);
  const learning = record(facts?.learning);
  const classification = record(learning?.mastery_bands);
  if (!learning || !classification || learning.rule_version !== RULE_VERSION ||
      !count(learning.roster_count) || !count(learning.projected_count) ||
      learning.projected_count > learning.roster_count ||
      !bands.every(key => count(classification[key])) ||
      !["ready", "insufficient"].includes(String(learning.status)))
    return { eligible: false, reason: "invalid_facts" };
  if (learning.status !== "ready" || learning.roster_count < AI_LEARNING_MIN_GROUP ||
      learning.projected_count < AI_LEARNING_MIN_GROUP)
    return { eligible: false, reason: "insufficient_evidence" };
  const counts = Object.fromEntries(bands.map(key => [key, classification[key]])) as Record<Band, number>;
  const classified = bands.reduce((sum, key) => sum + counts[key], 0);
  if (classified > learning.projected_count)
    return { eligible: false, reason: "invalid_facts" };
  // Suppress the whole partition, including complementary categories; never disclose a residual 1–4 people.
  const safe = bands.every(key => safeGroup(counts[key])) &&
    safeGroup(learning.projected_count - classified) &&
    safeGroup(learning.roster_count - learning.projected_count);
  return { eligible: true, source: {
    rule_version: RULE_VERSION,
    mastery_bands: safe && classified >= AI_LEARNING_MIN_GROUP ? counts : null,
    // Task completion has no recipient denominator in the current report contract.
    // Event counts, overlapping weak-point groups, titles and task totals are deliberately omitted.
    training_completion: "unavailable",
  } };
}
