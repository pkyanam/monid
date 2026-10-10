import { allRows, type Db, exec, getRow } from "../store/db.ts";
import { HALF_LIFE_MS } from "./weights.ts";

/**
 * Signals → decayed Beta evidence per (endpoint, cluster, aspect, source) —
 * the table the scorer (DevBot, M3) reads. Each row is decayed to `as_of`;
 * a reader decays further with `0.5^((now - as_of) / half_life_ms)`.
 *
 * Every producer goes through `addSignal`, whose dedupe_key makes re-runs
 * idempotent: the aggregate only moves when the signal row is NEW.
 */
export interface Signal {
    dedupeKey: string;
    source: "implicit" | "explicit";
    kind: string;
    endpointId: string;
    clusterId: string;
    aspect: string;
    /** 1 = good, 0 = bad */
    value: number;
    weight: number;
    ts: number;
    workspaceId: string;
    runId?: string | null;
    feedbackId?: string | null;
}

export function decay(ageMs: number, halfLifeMs: number): number {
    return ageMs <= 0 ? 1 : Math.pow(0.5, ageMs / halfLifeMs);
}

/** Insert if new and fold into the aggregate. Returns true when inserted. */
export function addSignal(db: Db, s: Signal): boolean {
    const inserted = exec(
        db,
        `INSERT OR IGNORE INTO signals
           (dedupe_key, source, kind, endpoint_id, cluster_id, aspect, value, weight,
            ts, workspace_id, run_id, feedback_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.dedupeKey,
        s.source,
        s.kind,
        s.endpointId,
        s.clusterId,
        s.aspect,
        s.value,
        s.weight,
        s.ts,
        s.workspaceId,
        s.runId ?? null,
        s.feedbackId ?? null,
    ).changes === 1;
    if (inserted) fold(db, s);
    return inserted;
}

function fold(
    db: Db,
    s: Pick<
        Signal,
        | "endpointId"
        | "clusterId"
        | "aspect"
        | "source"
        | "value"
        | "weight"
        | "ts"
    >,
): void {
    const halfLife = HALF_LIFE_MS[s.source];
    const row = getRow<{ pos: number; neg: number; n: number; as_of: number }>(
        db,
        `SELECT pos, neg, n, as_of FROM signal_aggregates
         WHERE endpoint_id = ? AND cluster_id = ? AND aspect = ? AND source = ?`,
        s.endpointId,
        s.clusterId,
        s.aspect,
        s.source,
    );
    let pos = row?.pos ?? 0;
    let neg = row?.neg ?? 0;
    let asOf = row?.as_of ?? s.ts;
    let w = s.weight;
    if (s.ts >= asOf) {
        const f = decay(s.ts - asOf, halfLife);
        pos *= f;
        neg *= f;
        asOf = s.ts;
    } else {
        w *= decay(asOf - s.ts, halfLife); // late arrival
    }
    pos += w * s.value;
    neg += w * (1 - s.value);
    exec(
        db,
        `INSERT INTO signal_aggregates
           (endpoint_id, cluster_id, aspect, source, pos, neg, n, as_of, half_life_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint_id, cluster_id, aspect, source)
         DO UPDATE SET pos = excluded.pos, neg = excluded.neg, n = excluded.n,
                       as_of = excluded.as_of, half_life_ms = excluded.half_life_ms`,
        s.endpointId,
        s.clusterId,
        s.aspect,
        s.source,
        pos,
        neg,
        (row?.n ?? 0) + 1,
        asOf,
        halfLife,
    );
}

/** Full rebuild from `signals` (after a workspace deletion). */
export function rebuildAggregates(db: Db): void {
    exec(db, `DELETE FROM signal_aggregates`);
    const rows = allRows<{
        endpoint_id: string;
        cluster_id: string;
        aspect: string;
        source: "implicit" | "explicit";
        value: number;
        weight: number;
        ts: number;
    }>(
        db,
        `SELECT endpoint_id, cluster_id, aspect, source, value, weight, ts FROM signals ORDER BY ts, id`,
    );
    for (const r of rows) {
        fold(db, {
            endpointId: r.endpoint_id,
            clusterId: r.cluster_id,
            aspect: r.aspect,
            source: r.source,
            value: r.value,
            weight: r.weight,
            ts: r.ts,
        });
    }
}

export interface AggregateRow {
    endpoint_id: string;
    cluster_id: string;
    aspect: string;
    source: string;
    pos: number;
    neg: number;
    n: number;
    as_of: number;
    half_life_ms: number;
}

/** Read helper for the scorer: aggregates decayed to `now`. */
export function readAggregates(db: Db, now: number): AggregateRow[] {
    return allRows<AggregateRow>(db, `SELECT * FROM signal_aggregates`).map(
        (r) => {
            const f = decay(now - r.as_of, r.half_life_ms);
            return { ...r, pos: r.pos * f, neg: r.neg * f, as_of: now };
        },
    );
}

/** DevBot's `EvidenceRow` (feedback/rerank/snapshot.ts). */
export interface EvidenceRow {
    endpoint: string;
    cluster: string;
    aspect: "reliability" | "quality";
    s: number;
    f: number;
}

/**
 * What `buildSnapshot` consumes: decayed, trust-weighted success/failure
 * mass per (endpoint, cluster = category leaf, aspect), implicit + explicit
 * summed (each source decayed with its own half-life).
 */
export function readEvidence(db: Db, now: number): EvidenceRow[] {
    const cells = new Map<string, EvidenceRow>();
    for (const r of readAggregates(db, now)) {
        if (r.aspect !== "reliability" && r.aspect !== "quality") continue;
        const key = `${r.endpoint_id}\u0000${r.cluster_id}\u0000${r.aspect}`;
        const cell = cells.get(key) ??
            {
                endpoint: r.endpoint_id,
                cluster: r.cluster_id,
                aspect: r.aspect,
                s: 0,
                f: 0,
            };
        cell.s += r.pos;
        cell.f += r.neg;
        cells.set(key, cell);
    }
    return [...cells.values()].sort((a, b) =>
        a.endpoint.localeCompare(b.endpoint) ||
        a.cluster.localeCompare(b.cluster) ||
        a.aspect.localeCompare(b.aspect)
    );
}

/** Live severe flags → `buildSnapshot`'s `flags` (endpoint → strongest multiplier). */
export function readFlags(db: Db, now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (
        const r of allRows<{ endpoint_id: string; multiplier: number }>(
            db,
            `SELECT endpoint_id, multiplier FROM endpoint_flags WHERE expires_at > ?`,
            now,
        )
    ) {
        out[r.endpoint_id] = Math.min(out[r.endpoint_id] ?? 1, r.multiplier);
    }
    return out;
}
