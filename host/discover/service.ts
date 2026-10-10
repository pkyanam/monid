import { lookup } from "@monid/feedback-rerank";
import type { Catalog, CatalogEntry, WirePrice } from "../catalog/catalog.ts";
import type { EndpointMetrics, HealthTracker } from "../health/tracker.ts";
import type {
    Candidate,
    FeedbackReranker,
    SnapshotHolder,
} from "../rerank/port.ts";
import { type Db, exec } from "../store/db.ts";
import { type Arm, assignArm, type Clock, HttpError, newId } from "../util.ts";
import { type Bm25Hit, Bm25Index, normalizeScore } from "./bm25.ts";

/** Wire request — cli/src/api/client.ts `discover()`. */
export interface DiscoverRequest {
    query: string;
    limit?: number;
    minScore?: number;
    includeUnavailable?: boolean;
}

/** Wire result — cli `DiscoverResult` (+ nothing removed). */
export interface DiscoverResult {
    provider: string;
    providerName: string;
    endpoint: string;
    description: string;
    price: WirePrice;
    score: number;
    tags: string[];
    /** Additive: the clamped feedback term applied (0 in control) and the decayed evidence behind it. */
    quality: { term: number; n?: number };
    metrics?: EndpointMetrics;
}

/** cli `DiscoverResponse` + additive `discoverId` / `clusterId`. */
export interface DiscoverResponse {
    results: DiscoverResult[];
    query: string;
    count: number;
    discoverId: string;
    clusterId: string;
    /** Experiment arm this workspace is in (additive). */
    arm: Arm;
    /** Scorer snapshot the ranking used; 0 = none published yet (additive). */
    snapshotVersion: number;
    hints?: Record<string, unknown>;
}

export interface ImpressionCandidate {
    endpointId: string;
    position: number;
    baseScore: number;
    finalScore: number;
    /** Clamped feedback term the reranker applied. */
    term: number;
    health: number;
    flag: number;
    propensity: number;
}

/** Health status → the reranker's multiplier (outside the feedback cap). */
export function healthMultiplier(metrics: EndpointMetrics | undefined): number {
    switch (metrics?.status) {
        case "outage":
            return 0;
        case "degraded":
            return 0.6;
        default:
            return 1;
    }
}

export interface DiscoverDeps {
    db: Db;
    catalog: Catalog;
    health: HealthTracker;
    reranker: FeedbackReranker;
    snapshots: SnapshotHolder;
    clock: Clock;
    controlPercent: number;
    experimentSalt: string;
    /**
     * Test mode: index only these endpoint ids or provider slugs (e.g. the
     * sim's fixture-backed scenario). Inspect/run still see the whole catalog.
     */
    allow?: string[];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_SHORTLIST = 20;
/** Hits scored before the leaf boost reorders them. */
const RECALL = 100;
const CLUSTER_VOTERS = 10;
/** Relevance multiplier for endpoints in the inferred leaf, at full confidence. */
const LEAF_BOOST = 0.3;

export class DiscoverService {
    private readonly index: Bm25Index;

    constructor(private readonly deps: DiscoverDeps) {
        const names = deps.catalog.categoryNames;
        this.index = new Bm25Index(
            deps.catalog.entries.filter((e) =>
                !deps.allow?.length || deps.allow.includes(e.id) ||
                deps.allow.includes(e.provider)
            ).map((e) => ({
                id: e.id,
                fields: [
                    { text: e.displayName, weight: 3 },
                    { text: `${e.provider} ${e.providerName}`, weight: 2 },
                    { text: e.summary, weight: 2 },
                    {
                        text: e.categories.map((c) =>
                            `${c} ${names.get(c) ?? ""}`
                        ).join(" "),
                        weight: 2,
                    },
                    { text: e.description, weight: 1 },
                    { text: e.notes.join(" "), weight: 1 },
                ],
            })),
        );
    }

    /**
     * Category leaf for the query (v1 cluster = category leaf): a
     * score-weighted vote over the top hits' categories, ties by leaf id.
     * Confidence is the winner's margin over the runner-up (1 = unopposed).
     */
    inferCluster(hits: Bm25Hit[]): { clusterId: string; confidence: number } {
        const votes = new Map<string, number>();
        for (const hit of hits.slice(0, CLUSTER_VOTERS)) {
            const cats = this.deps.catalog.get(hit.id)?.categories ?? [];
            for (const cat of cats) {
                votes.set(cat, (votes.get(cat) ?? 0) + hit.score / cats.length);
            }
        }
        const [best, second] = [...votes.entries()].sort((a, b) =>
            b[1] - a[1] || a[0].localeCompare(b[0])
        );
        if (!best) return { clusterId: "uncategorized", confidence: 0 };
        return {
            clusterId: best[0],
            confidence: 1 - (second?.[1] ?? 0) / best[1],
        };
    }

    /**
     * Endpoints in the query's leaf get up to LEAF_BOOST more relevance,
     * scaled by confidence: a curated category is evidence a lexical match
     * on one shared word ("headline" on a profile scraper) is not.
     */
    private leafRerank(
        hits: Bm25Hit[],
        clusterId: string,
        confidence: number,
    ): Bm25Hit[] {
        const boost = 1 + LEAF_BOOST * confidence;
        return hits
            .map((h) => ({
                id: h.id,
                score: this.deps.catalog.get(h.id)?.categories.includes(
                        clusterId,
                    )
                    ? h.score * boost
                    : h.score,
            }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }

    discover(
        workspaceId: string,
        req: DiscoverRequest,
        opts: { arm?: Arm } = {},
    ): DiscoverResponse {
        const { catalog, health, clock } = this.deps;
        const query = typeof req.query === "string" ? req.query.trim() : "";
        if (!query) {
            throw new HttpError(400, "INVALID_REQUEST", "query is required");
        }
        const limit = Math.min(
            MAX_LIMIT,
            Math.max(
                1,
                Math.trunc(Number(req.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT,
            ),
        );
        const minScore = typeof req.minScore === "number" ? req.minScore : 0;
        const now = clock();

        const shortlistSize = Math.max(limit * 2, MIN_SHORTLIST);
        const recalled = this.index.search(query, RECALL);
        const { clusterId, confidence } = this.inferCluster(recalled);
        const hits = this.leafRerank(recalled, clusterId, confidence)
            .slice(0, shortlistSize);
        const arm: Arm = opts.arm ?? assignArm(
            workspaceId,
            this.deps.experimentSalt,
            this.deps.controlPercent,
        );

        const candidates: Candidate[] = [];
        const outage: Candidate[] = [];
        for (const hit of hits) {
            if (normalizeScore(hit.score) < minScore) continue;
            const metrics = health.metrics(hit.id, now);
            const candidate: Candidate = {
                endpoint: hit.id,
                baseScore: hit.score,
                health: healthMultiplier(metrics),
            };
            // outage is filtered server-side unless opted in, then ranked last
            if (metrics?.status === "outage") outage.push(candidate);
            else candidates.push(candidate);
        }

        // includeUnavailable: an outage endpoint that would have made the cut
        // on relevance alone keeps its slot, shown after everything healthy.
        let reserved: Candidate[] = [];
        if (req.includeUnavailable && outage.length > 0) {
            const cut = [...candidates, ...outage]
                .map((c) => c.baseScore)
                .sort((a, b) => b - a)[limit - 1] ?? -Infinity;
            reserved = outage
                .filter((c) => c.baseScore >= cut)
                .sort((a, b) => b.baseScore - a.baseScore)
                .slice(0, limit);
        }

        const { version, snapshot } = this.deps.snapshots.get();
        const reranked = this.deps.reranker(candidates, snapshot, {
            workspaceId,
            clusterId,
            limit: limit - reserved.length,
            arm,
        });
        const shown: ImpressionCandidate[] = reranked.ranked.map((
            r,
            position,
        ) => ({
            endpointId: r.endpoint,
            position,
            baseScore: r.baseScore,
            finalScore: r.finalScore,
            term: r.term,
            health: r.health,
            flag: r.flag,
            propensity: reranked.propensities[position] ?? 1,
        }));
        for (const c of reserved) {
            shown.push({
                endpointId: c.endpoint,
                position: shown.length,
                baseScore: c.baseScore,
                finalScore: 0,
                term: 0,
                health: 0,
                flag: 1,
                propensity: 1,
            });
        }

        const discoverId = newId("dsc", now);
        exec(
            this.deps.db,
            `INSERT INTO discover_impressions
               (id, workspace_id, query, cluster_id, arm, snapshot_version,
                exploration_slot, candidates_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            discoverId,
            workspaceId,
            query,
            clusterId,
            arm,
            version,
            reranked.explorationSlot?.position ?? null,
            JSON.stringify(shown),
            now,
        );

        const results: DiscoverResult[] = shown.map((r) => {
            // n = decayed reliability trials behind the cell (alpha+beta minus
            // the prior's k pseudo-counts), as in the sim's stub host
            const cell = snapshot
                ? lookup(snapshot, r.endpointId, clusterId).cell
                : undefined;
            const n = cell && snapshot
                ? cell.reliability.alpha + cell.reliability.beta -
                    snapshot.params.k
                : 0;
            const entry = catalog.get(r.endpointId) as CatalogEntry;
            const metrics = health.metrics(r.endpointId, now);
            return {
                provider: entry.provider,
                providerName: entry.providerName,
                endpoint: entry.endpoint,
                description: entry.summary,
                price: entry.price,
                // the score the list is ordered by (relevance × health ×
                // flag × bounded feedback term in treatment)
                score: normalizeScore(r.finalScore),
                tags: entry.categories,
                // the clamped feedback term actually applied (0 in control)
                quality: { term: r.term, n: Math.round(n * 10) / 10 },
                ...(metrics ? { metrics } : {}),
            };
        });
        return {
            results,
            query,
            count: results.length,
            discoverId,
            clusterId,
            arm,
            snapshotVersion: version,
            hints: {
                discoverId:
                    "Pass discoverId to /v1/run so feedback and retries link to this ranking.",
            },
        };
    }
}
