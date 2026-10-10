import type { HealthTracker } from "../health/tracker.ts";
import type { RunRow } from "../runs/service.ts";
import { allRows, type Db, exec, getRow, tx } from "../store/db.ts";
import type { Clock } from "../util.ts";
import { addSignal } from "./aggregates.ts";
import { classify } from "./classify.ts";
import {
    DEFAULT_TRUST,
    type HalfLives,
    SEVERE_FLAG,
    SIGNAL_WEIGHTS,
} from "./weights.ts";

/**
 * The background half of the loop. One `tick()`:
 *   1. drain the feedback queue (`processed_at IS NULL`, priority first):
 *      tier 0/1 extraction → explicit signals; severe reports → flags;
 *   2. implicit signals for newly terminal runs (reliability, contract
 *      violation, empty);
 *   3. close run windows: retry-elsewhere (qualifying cases only) or the
 *      0.05 success-no-retry credit (once per window);
 *   4. retention: redact feedback free text past the retention period.
 * Every write is idempotent (signals.dedupe_key), so a crashed or repeated
 * tick never double-counts.
 */
export interface WorkerDeps {
    db: Db;
    clock: Clock;
    health: HealthTracker;
    retryWindowMs: number;
    retentionDays: number;
    trust: Record<string, number>;
    halfLives?: HalfLives;
    /**
     * Severe flags act on BOTH arms (like health), so in test mode they must
     * not fire on runs whose failure a fault profile injected
     * (MONID_HEALTH_IGNORE_FAULTS). The explicit signal is still written.
     */
    flagsIgnoreFaults?: boolean;
    batchSize?: number;
}

export interface TickStats {
    feedback: number;
    severe: number;
    runs: number;
    windows: number;
    redacted: number;
}

const MAX_ATTEMPTS = 5;
const CONTRACT_CODES = new Set([
    "CONTRACT_VIOLATION",
    "FN_CONTRACT",
    "DECODE_FAILED",
]);
const CALLER_FAULT = new Set([
    "INVALID_INPUT",
    "MISSING_CREDENTIAL",
    "STOPPED",
]);

interface FeedbackRow {
    id: string;
    workspace_id: string;
    run_id: string | null;
    target: string;
    endpoint_id: string | null;
    cluster_id: string | null;
    rating: number | null;
    text: string | null;
    aspects_json: string | null;
    severity: string | null;
    priority: number;
    created_at: number;
    attempts: number;
}

const emptyStats = (): TickStats => ({
    feedback: 0,
    severe: 0,
    runs: 0,
    windows: 0,
    redacted: 0,
});

export class FeedbackWorker {
    constructor(private readonly deps: WorkerDeps) {}

    tick(): TickStats {
        const stats = emptyStats();
        this.drainFeedback(stats);
        this.runSignals(stats);
        this.closeWindows(stats);
        stats.redacted = this.redact();
        return stats;
    }

    /** Severe rows only — callable on a tighter cadence than tick(). */
    fastLane(): number {
        const stats = emptyStats();
        this.drainFeedback(stats, true);
        return stats.severe;
    }

    private trustOf(workspaceId: string): number {
        return this.deps.trust[workspaceId] ?? DEFAULT_TRUST;
    }

    // ---- 1. feedback queue -------------------------------------------------

    private drainFeedback(stats: TickStats, severeOnly = false): void {
        const { db, clock } = this.deps;
        const rows = allRows<FeedbackRow>(
            db,
            `SELECT * FROM feedback WHERE processed_at IS NULL ${
                severeOnly ? "AND priority > 0" : ""
            }
             ORDER BY priority DESC, created_at LIMIT ?`,
            this.deps.batchSize ?? 200,
        );
        for (const row of rows) {
            try {
                tx(db, () => this.processFeedback(row, stats));
                stats.feedback++;
            } catch (error) {
                const attempts = row.attempts + 1;
                exec(
                    db,
                    `UPDATE feedback SET attempts = ?, last_error = ?, processed_at = ? WHERE id = ?`,
                    attempts,
                    String(error).slice(0, 500),
                    attempts >= MAX_ATTEMPTS ? clock() : null,
                    row.id,
                );
            }
        }
    }

    private processFeedback(row: FeedbackRow, stats: TickStats): void {
        const { db, clock } = this.deps;
        const now = clock();
        const extraction = classify({
            rating: row.rating,
            text: row.text,
            aspects: row.aspects_json ? JSON.parse(row.aspects_json) : null,
        });
        // only run-linked endpoint feedback moves scores (unverifiable otherwise)
        const scored = row.target === "endpoint" && row.endpoint_id !== null &&
            row.run_id !== null && extraction.value !== null;
        if (scored) {
            for (const aspect of extraction.aspects) {
                addSignal(db, {
                    dedupeKey: `explicit:${row.id}:${aspect}`,
                    source: "explicit",
                    kind: "feedback",
                    endpointId: row.endpoint_id!,
                    clusterId: row.cluster_id ?? "uncategorized",
                    aspect,
                    value: extraction.value!,
                    weight: SIGNAL_WEIGHTS.explicit *
                        this.trustOf(row.workspace_id),
                    ts: row.created_at,
                    workspaceId: row.workspace_id,
                    runId: row.run_id,
                    feedbackId: row.id,
                }, this.deps.halfLives);
            }
        }
        const negative = extraction.value !== null && extraction.value < 0.5;
        const injected = this.deps.flagsIgnoreFaults && row.run_id !== null &&
            getRow<{ f: number }>(
                    db,
                    `SELECT fault_injected AS f FROM runs WHERE id = ?`,
                    row.run_id,
                )?.f === 1;
        if (
            row.priority > 0 && scored && negative &&
            extraction.aspects.length > 0 && !injected
        ) {
            this.raiseFlag(row, now);
            stats.severe++;
        }
        exec(
            db,
            `UPDATE feedback SET processed_at = ?, extraction_json = ?, attempts = attempts + 1 WHERE id = ?`,
            now,
            JSON.stringify({ ...extraction, scored }),
            row.id,
        );
    }

    /**
     * Severe fast lane: one report → provisional (×0.5, 30 min); a second
     * workspace, or corroborating live failures → confirmed (×0.2, 24 h).
     * Never a hard removal on one report.
     */
    private raiseFlag(row: FeedbackRow, now: number): void {
        const { db, health } = this.deps;
        const endpointId = row.endpoint_id!;
        const clusterId = row.cluster_id ?? "*";
        const existing = getRow<
            {
                workspaces_json: string;
                reports: number;
                expires_at: number;
                first_at: number;
            }
        >(
            db,
            `SELECT workspaces_json, reports, expires_at, first_at FROM endpoint_flags
             WHERE endpoint_id = ? AND cluster_id = ? AND kind = 'severe_report'`,
            endpointId,
            clusterId,
        );
        const live = existing !== undefined && existing.expires_at > now;
        const workspaces = new Set<string>(
            live ? JSON.parse(existing.workspaces_json) : [],
        );
        workspaces.add(row.workspace_id);
        const failure = health.freshFailureRate(endpointId, now);
        const confirmed = workspaces.size >= SEVERE_FLAG.confirmWorkspaces ||
            (failure !== undefined &&
                failure >= SEVERE_FLAG.corroborateFailureRate);
        exec(
            db,
            `INSERT INTO endpoint_flags (endpoint_id, cluster_id, kind, state, multiplier, reports,
                workspaces_json, first_at, updated_at, expires_at)
             VALUES (?, ?, 'severe_report', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(endpoint_id, cluster_id, kind) DO UPDATE SET
                state = excluded.state, multiplier = excluded.multiplier, reports = excluded.reports,
                workspaces_json = excluded.workspaces_json, first_at = excluded.first_at,
                updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
            endpointId,
            clusterId,
            confirmed ? "confirmed" : "provisional",
            confirmed
                ? SEVERE_FLAG.confirmedMultiplier
                : SEVERE_FLAG.provisionalMultiplier,
            (live ? existing!.reports : 0) + 1,
            JSON.stringify([...workspaces].sort()),
            live ? existing!.first_at : now,
            now,
            now +
                (confirmed
                    ? SEVERE_FLAG.confirmedTtlMs
                    : SEVERE_FLAG.provisionalTtlMs),
        );
    }

    // ---- 2. implicit signals at terminal ------------------------------------

    private runSignals(stats: TickStats): void {
        const { db, clock } = this.deps;
        const rows = allRows<RunRow>(
            db,
            `SELECT * FROM runs WHERE signals_at IS NULL AND completed_at IS NOT NULL
             ORDER BY completed_at LIMIT ?`,
            this.deps.batchSize ?? 200,
        );
        for (const run of rows) {
            tx(db, () => {
                this.signalsFor(run);
                exec(
                    db,
                    `UPDATE runs SET signals_at = ? WHERE id = ?`,
                    clock(),
                    run.id,
                );
            });
            stats.runs++;
        }
    }

    private signalsFor(run: RunRow): void {
        if (run.error_code && CALLER_FAULT.has(run.error_code)) return;
        const base = {
            source: "implicit" as const,
            endpointId: run.endpoint_id,
            clusterId: run.cluster_id ?? "uncategorized",
            ts: run.completed_at!,
            workspaceId: run.workspace_id,
            runId: run.id,
        };
        const ok = run.status === "COMPLETED";
        addSignal(this.deps.db, {
            ...base,
            dedupeKey: `run_outcome:${run.id}`,
            kind: "run_outcome",
            aspect: "reliability",
            value: ok ? 1 : 0,
            weight: SIGNAL_WEIGHTS.runOutcome,
        }, this.deps.halfLives);
        if (run.error_code && CONTRACT_CODES.has(run.error_code)) {
            addSignal(this.deps.db, {
                ...base,
                dedupeKey: `contract:${run.id}`,
                kind: "contract_violation",
                aspect: "quality",
                value: 0,
                weight: SIGNAL_WEIGHTS.contractViolation,
            }, this.deps.halfLives);
        }
        if (ok && run.is_empty === 1) {
            addSignal(this.deps.db, {
                ...base,
                dedupeKey: `empty:${run.id}`,
                kind: "empty_result",
                aspect: "quality",
                value: 0,
                weight: SIGNAL_WEIGHTS.emptyResult,
            }, this.deps.halfLives);
        }
    }

    // ---- 3. run windows ------------------------------------------------------

    /**
     * After `retryWindowMs` past completion, decide:
     *  - retry-elsewhere (quality −0.5) iff the same workspace started a run
     *    on a DIFFERENT endpoint between this run's start and window end, AND
     *    either a discoverId links the two runs, or this run failed/was empty
     *    and the other run is in the same cluster (v1 decision 4);
     *  - else, if this run completed non-empty: +0.05 quality, at most once
     *    per (workspace, endpoint, cluster, window bucket).
     */
    private closeWindows(stats: TickStats): void {
        const { db, clock, retryWindowMs } = this.deps;
        const now = clock();
        const rows = allRows<RunRow>(
            db,
            `SELECT * FROM runs WHERE window_closed_at IS NULL AND completed_at IS NOT NULL
               AND completed_at <= ? ORDER BY completed_at LIMIT ?`,
            now - retryWindowMs,
            this.deps.batchSize ?? 200,
        );
        for (const run of rows) {
            tx(db, () => {
                this.closeWindow(run);
                exec(
                    db,
                    `UPDATE runs SET window_closed_at = ? WHERE id = ?`,
                    now,
                    run.id,
                );
            });
            stats.windows++;
        }
    }

    private closeWindow(run: RunRow): void {
        const { db, retryWindowMs } = this.deps;
        if (run.error_code && CALLER_FAULT.has(run.error_code)) return;
        const windowEnd = run.completed_at! + retryWindowMs;
        const failedOrEmpty = run.status !== "COMPLETED" || run.is_empty === 1;
        const later = allRows<
            { discover_id: string | null; cluster_id: string | null }
        >(
            db,
            `SELECT discover_id, cluster_id FROM runs
             WHERE workspace_id = ? AND endpoint_id != ? AND id != ?
               AND created_at >= ? AND created_at <= ?`,
            run.workspace_id,
            run.endpoint_id,
            run.id,
            run.created_at,
            windowEnd,
        );
        const retried = later.some((b) =>
            (run.discover_id !== null && b.discover_id === run.discover_id) ||
            (failedOrEmpty && b.cluster_id === run.cluster_id)
        );
        const base = {
            source: "implicit" as const,
            endpointId: run.endpoint_id,
            clusterId: run.cluster_id ?? "uncategorized",
            workspaceId: run.workspace_id,
            runId: run.id,
            aspect: "quality",
        };
        if (retried) {
            addSignal(db, {
                ...base,
                dedupeKey: `retry_elsewhere:${run.id}`,
                kind: "retry_elsewhere",
                value: 0,
                weight: SIGNAL_WEIGHTS.retryElsewhere,
                ts: run.completed_at!,
            }, this.deps.halfLives);
        } else if (!failedOrEmpty) {
            const bucket = Math.floor(run.completed_at! / retryWindowMs);
            addSignal(db, {
                ...base,
                dedupeKey:
                    `success_no_retry:${run.workspace_id}:${run.endpoint_id}:${base.clusterId}:${bucket}`,
                kind: "success_no_retry",
                value: 1,
                weight: SIGNAL_WEIGHTS.successNoRetry,
                ts: windowEnd,
            }, this.deps.halfLives);
        }
    }

    // ---- 4. retention --------------------------------------------------------

    private redact(): number {
        const now = this.deps.clock();
        const cutoff = now - this.deps.retentionDays * 24 * 60 * 60_000;
        return exec(
            this.deps.db,
            `UPDATE feedback SET text = NULL, expected = NULL, observed = NULL, redacted_at = ?
             WHERE redacted_at IS NULL AND created_at < ?`,
            now,
            cutoff,
        ).changes;
    }
}
