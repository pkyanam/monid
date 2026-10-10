/**
 * FeedbackReranker: re-orders BM25 discover candidates using a feedback snapshot.
 *
 *   final = baseScore * health * flag * (1 + clamp(term, -CAP, +CAP))
 *   term  = gain * (cell.lower - prior.lower)       (0 when the cell is missing)
 *
 * Health and flag multipliers are deliberately OUTSIDE the cap: an outage
 * (health 0) or a severe flag must be able to demote an endpoint by more than
 * the 15% that crowd feedback is allowed to move it.
 *
 * Exploration is seeded, not random: with probability epsilon (decided by a PRNG
 * keyed on workspace, cluster and snapshot version) the LAST shown slot is
 * swapped for the most uncertain eligible candidate below the cut. The same
 * inputs always give the same output.
 */
import { lookup, own, type Snapshot } from "./snapshot.ts";

export const FEEDBACK_CAP = 0.15;
export const DEFAULT_EPSILON = 0.1;

export type Arm = "control" | "treatment";

export interface Candidate {
    endpoint: string;
    /** Base relevance score from BM25. */
    baseScore: number;
    /** Live health multiplier in [0, 1]; defaults to 1. */
    health?: number;
}

export interface RerankContext {
    workspaceId: string;
    /** Category leaf inferred for the query. */
    clusterId: string;
    limit: number;
    epsilon?: number;
    /** control: no feedback term and no exploration. Defaults to treatment. */
    arm?: Arm;
}

export interface RankedItem {
    endpoint: string;
    baseScore: number;
    health: number;
    flag: number;
    /** Clamped feedback term actually applied. */
    term: number;
    finalScore: number;
    /** Interval width of the endpoint's cell (or its prior); exploration picks the widest. */
    width: number;
}

export interface ExplorationSlot {
    position: number;
    endpoint: string;
    replaced: string;
}

export interface RerankResult {
    ranked: RankedItem[];
    /** propensities[i] = probability, under the seeded policy, that ranked[i] is shown at position i. */
    propensities: number[];
    explorationSlot: ExplorationSlot | null;
}

/** Both branches of the policy. `explore` is null when there is nothing eligible to explore. */
export interface Policy {
    exploit: RankedItem[];
    explore: RankedItem[] | null;
    epsilon: number;
    explored: boolean;
}

export function rerank(
    candidates: Candidate[],
    snapshot: Snapshot | null,
    ctx: RerankContext,
): RerankResult {
    const p = policy(candidates, snapshot, ctx);
    const ranked = p.explored ? p.explore! : p.exploit;
    const last = ranked.length - 1;
    return {
        ranked,
        propensities: ranked.map((item, i) => propensity(p, item.endpoint, i)),
        explorationSlot: p.explored
            ? {
                position: last,
                endpoint: ranked[last].endpoint,
                replaced: p.exploit[last].endpoint,
            }
            : null,
    };
}

/**
 * Exact propensity of `endpoint` at `position`:
 *   P = (1 - eps) * [exploit[position] = endpoint] + eps * [explore[position] = endpoint]
 * with eps = 0 when no exploration branch exists (so P is 1 or 0).
 */
export function propensity(
    p: Policy,
    endpoint: string,
    position: number,
): number {
    const eps = p.explore ? p.epsilon : 0;
    return (p.exploit[position]?.endpoint === endpoint ? 1 - eps : 0) +
        (p.explore?.[position]?.endpoint === endpoint ? eps : 0);
}

/** Candidates are assumed to have unique endpoint ids. A null snapshot behaves like control. */
export function policy(
    candidates: Candidate[],
    snapshot: Snapshot | null,
    ctx: RerankContext,
): Policy {
    const treatment = snapshot !== null && ctx.arm !== "control";
    const scored = candidates
        .map((c) => score(c, snapshot, ctx.clusterId, treatment))
        .sort((a, b) =>
            b.finalScore - a.finalScore || (a.endpoint < b.endpoint ? -1 : 1)
        );
    const n = Math.max(0, Math.min(Math.floor(ctx.limit), scored.length));
    const exploit = scored.slice(0, n);
    const epsilon = treatment
        ? Math.min(1, Math.max(0, ctx.epsilon ?? DEFAULT_EPSILON))
        : 0;

    const pick = epsilon > 0 && n > 0
        ? mostUncertain(scored.slice(n))
        : undefined;
    const explore = pick ? [...exploit.slice(0, n - 1), pick] : null;
    const explored = explore !== null &&
        seededUniform(
                ctx.workspaceId,
                ctx.clusterId,
                String(snapshot?.version),
            ) < epsilon;
    return { exploit, explore, epsilon, explored };
}

function score(
    c: Candidate,
    snapshot: Snapshot | null,
    clusterId: string,
    treatment: boolean,
): RankedItem {
    const health = c.health ?? 1;
    const flag = (snapshot && own(snapshot.flags, c.endpoint)) ?? 1;
    let term = 0, width = 0;
    if (snapshot) {
        const { cell, prior } = lookup(snapshot, c.endpoint, clusterId);
        width = (cell ?? prior).width;
        if (treatment && cell) {
            const raw = snapshot.params.gain * (cell.lower - prior.lower);
            term = Math.min(FEEDBACK_CAP, Math.max(-FEEDBACK_CAP, raw));
        }
    }
    return {
        endpoint: c.endpoint,
        baseScore: c.baseScore,
        health,
        flag,
        term,
        finalScore: c.baseScore * health * flag * (1 + term),
        width,
    };
}

/**
 * Widest interval among candidates that can score above zero (health and flag > 0).
 * The pool is sorted by score, so a tie goes to the higher-scored candidate.
 */
function mostUncertain(pool: RankedItem[]): RankedItem | undefined {
    let best: RankedItem | undefined;
    for (const c of pool) {
        if (c.finalScore > 0 && (!best || c.width > best.width)) best = c;
    }
    return best;
}

/** Uniform [0, 1) from FNV-1a over the parts, finished with one mulberry32 step. */
export function seededUniform(...parts: string[]): number {
    let h = 0x811c9dc5;
    for (const ch of parts.join("\u0000")) {
        h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
    }
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}
