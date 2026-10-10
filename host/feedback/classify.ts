import type { Aspect } from "./weights.ts";

/**
 * Tier 0 + tier 1 extraction (no model, no network):
 *  - tier 0: the agent's own structured fields (rating, aspects) — the
 *    caller is an LLM, so self-classification is free;
 *  - tier 1: keyword rules over the free text.
 * Anything still ambiguous is marked `needsLlm` (tier 2 is on the later list)
 * and produces NO score signal.
 */
export const AGENT_ASPECTS = [
    "correctness",
    "completeness",
    "schema",
    "reliability",
    "latency",
    "cost",
    "docs",
    "other",
] as const;
export type AgentAspect = (typeof AGENT_ASPECTS)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

const TO_SCORED: Record<AgentAspect, Aspect | null> = {
    correctness: "quality",
    completeness: "quality",
    schema: "quality",
    docs: "quality",
    reliability: "reliability",
    latency: null, // live metrics only
    cost: null, // live metrics only
    other: null,
};

export interface Extraction {
    tier: 0 | 1;
    /** Scored aspects this feedback speaks to. */
    aspects: Aspect[];
    /** 1 = good, 0 = bad; null = no usable sentiment. */
    value: number | null;
    confidence: number;
    needsLlm: boolean;
    /** Agent/keyword aspects before mapping (stored for later tiers). */
    rawAspects: string[];
}

const RELIABILITY_WORDS = [
    "error",
    "timeout",
    "timed out",
    "500",
    "502",
    "503",
    "504",
    "5xx",
    "failed",
    "failure",
    "down",
    "outage",
    "unavailable",
    "rate limit",
    "429",
    "crash",
    "flaky",
    "broken",
];
const QUALITY_WORDS = [
    "wrong",
    "incorrect",
    "outdated",
    "stale",
    "mismatch",
    "mismatched",
    "missing",
    "empty",
    "no results",
    "irrelevant",
    "inaccurate",
    "hallucinat",
    "malformed",
    "incomplete",
    "schema",
    "garbage",
    "useless",
    "accurate",
    "relevant",
    "complete",
    "correct",
    "fresh",
];
const POSITIVE = [
    "great",
    "accurate",
    "perfect",
    "worked",
    "works well",
    "useful",
    "correct",
    "excellent",
    "helpful",
    "reliable",
    "good",
    "relevant",
    "complete",
    "fresh",
    "fast",
];
const NEGATIVE = [
    "wrong",
    "incorrect",
    "outdated",
    "stale",
    "mismatch",
    "missing",
    "empty",
    "no results",
    "irrelevant",
    "inaccurate",
    "hallucinat",
    "malformed",
    "incomplete",
    "garbage",
    "useless",
    "error",
    "timeout",
    "timed out",
    "failed",
    "failure",
    "down",
    "outage",
    "broken",
    "bad",
    "slow",
    "crash",
    "flaky",
    "unavailable",
];

function count(text: string, words: string[]): number {
    let n = 0;
    for (const w of words) if (text.includes(w)) n++;
    return n;
}

export function classify(input: {
    rating?: number | null;
    text?: string | null;
    aspects?: string[] | null;
}): Extraction {
    const text = (input.text ?? "").toLowerCase();
    const agentAspects = (input.aspects ?? []).filter((a): a is AgentAspect =>
        (AGENT_ASPECTS as readonly string[]).includes(a)
    );

    // sentiment: rating wins; else lexicon
    let value: number | null = null;
    let confidence = 0;
    if (typeof input.rating === "number") {
        value = (Math.max(-2, Math.min(2, input.rating)) + 2) / 4;
        confidence = 1;
    } else if (text) {
        const pos = count(text, POSITIVE);
        // a negator flips nearby praise ("not accurate") — crude but cheap
        const negated = /\b(not|never|no longer|isn't|wasn't|didn't)\b/.test(
            text,
        );
        const neg = count(text, NEGATIVE) + (negated ? pos : 0);
        const posEff = negated ? 0 : pos;
        if (posEff > neg) value = 0.85;
        else if (neg > posEff) value = 0.15;
        confidence = value === null ? 0 : 0.6;
    }

    // aspects: agent's own (tier 0), else keyword rules (tier 1)
    let raw: string[] = agentAspects;
    let tier: 0 | 1 =
        agentAspects.length > 0 || typeof input.rating === "number" ? 0 : 1;
    if (raw.length === 0 && text) {
        tier = 1;
        raw = [];
        if (count(text, RELIABILITY_WORDS) > 0) raw.push("reliability");
        if (count(text, QUALITY_WORDS) > 0) raw.push("correctness");
    }
    let aspects = [
        ...new Set(
            raw.map((a) => TO_SCORED[a as AgentAspect]).filter((
                a,
            ): a is Aspect => a !== null),
        ),
    ];
    // sentiment with no aspect speaks to overall quality — unless the agent
    // explicitly scoped it to an unscored aspect (latency/cost/other)
    if (aspects.length === 0 && value !== null && agentAspects.length === 0) {
        aspects = ["quality"];
    }
    const needsLlm = value === null && text.length > 0;
    return { tier, aspects, value, confidence, needsLlm, rawAspects: raw };
}
