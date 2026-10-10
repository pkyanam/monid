import {
    type Candidate,
    rerank,
    type RerankContext,
    type RerankResult,
    type Snapshot,
} from "@monid/feedback-rerank";

/**
 * The host side of the FeedbackReranker seam — DevBot's
 * `@monid/feedback-rerank` (feedback/rerank/, branch feedback-reranker):
 *
 *     rerank(candidates, snapshot, ctx) -> {ranked, propensities, explorationSlot}
 *
 * With a null snapshot the reranker behaves like control (base order, no
 * exploration, propensity 1) — that IS the pass-through until M3 starts
 * publishing snapshots built from `signal_aggregates` (see
 * feedback/aggregates.ts `readEvidence`).
 */
export type { Candidate, RerankContext, RerankResult, Snapshot };

export type FeedbackReranker = (
    candidates: Candidate[],
    snapshot: Snapshot | null,
    ctx: RerankContext,
) => RerankResult;

export const defaultReranker: FeedbackReranker = rerank;

/**
 * Holds the current snapshot; `swap` is a single reference assignment, so
 * in-flight requests keep the object they started with (JS is
 * single-threaded — the swap is atomic by construction).
 */
export class SnapshotHolder {
    private current: { version: number; snapshot: Snapshot | null } = {
        version: 0,
        snapshot: null,
    };

    get(): { version: number; snapshot: Snapshot | null } {
        return this.current;
    }

    swap(snapshot: Snapshot): void {
        if (snapshot.version <= this.current.version) return;
        this.current = { version: snapshot.version, snapshot };
    }
}
