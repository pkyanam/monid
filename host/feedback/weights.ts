/**
 * FIXED weights (v1 decision 6 — no learned trust). One place, so the
 * scorer, the sim and the docs read the same numbers.
 *
 * Aspects (v1 decision 3): only `reliability` and `quality` are scored.
 * Latency and cost come from live metrics, never from feedback.
 */
export type Aspect = "reliability" | "quality";
export const ASPECTS: readonly Aspect[] = ["reliability", "quality"];

export const SIGNAL_WEIGHTS = {
    /** run finished 2xx / provider-failed: reliability ±1 */
    runOutcome: 1.0,
    /** engine CONTRACT_VIOLATION / FN_CONTRACT / DECODE_FAILED: quality −1 */
    contractViolation: 1.0,
    /** 2xx but nothing in it: quality −0.25 */
    emptyResult: 0.25,
    /** caller re-ran elsewhere in the window (qualifying cases only): quality −0.5 */
    retryElsewhere: 0.5,
    /** 2xx, non-empty, no retry in the window: quality +0.05, once per window */
    successNoRetry: 0.05,
    /** explicit run-linked feedback: ×(workspace trust) */
    explicit: 1.0,
} as const;

/** Default per-workspace trust; config may pin others (MONID_HOST_TRUST). */
export const DEFAULT_TRUST = 1.0;

/** Decay half-lives the aggregates carry (the scorer decays to "now"). */
export const HALF_LIFE_MS = {
    implicit: 3 * 24 * 60 * 60_000,
    explicit: 14 * 24 * 60 * 60_000,
} as const;

/** Severe fast lane (v1: flags sit OUTSIDE the ±15% feedback cap). */
export const SEVERE_FLAG = {
    provisionalMultiplier: 0.5,
    provisionalTtlMs: 30 * 60_000,
    confirmedMultiplier: 0.2,
    confirmedTtlMs: 24 * 60 * 60_000,
    /** distinct workspaces needed to confirm without corroboration */
    confirmWorkspaces: 2,
    /** fresh failure rate that corroborates a single report */
    corroborateFailureRate: 0.5,
} as const;

export const FEEDBACK_PRIORITY = { normal: 0, severe: 10 } as const;
