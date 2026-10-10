import { buildSnapshot, type Snapshot } from "@monid/feedback-rerank";
import { readEvidence, readFlags } from "../feedback/aggregates.ts";
import { allRows, type Db, exec, getRow, tx } from "../store/db.ts";
import { type Clock, fnv1a } from "../util.ts";
import type { SnapshotHolder } from "./port.ts";

export interface SnapshotBuilderDeps {
    db: Db;
    clock: Clock;
    holder: SnapshotHolder;
    /** buildSnapshot overrides; DevBot's defaults when absent. */
    options?: {
        gain?: number;
        k?: number;
        weights?: { reliability?: number; quality?: number };
    };
    /** Published snapshots kept in the table (audit / replay). */
    keep?: number;
}

export interface BuildStats {
    version: number;
    rows: number;
    flags: number;
    ms: number;
}

/**
 * M3 publisher: evidence + severe flags → `buildSnapshot` → `snapshots`
 * table → swap into the in-process holder that discover reads.
 *
 * One process, so publish-then-swap is enough; the table is the audit
 * trail (exact bytes each ranking was computed against, by version) and
 * makes versions monotonic across restarts. Snapshots are rebuilt from
 * evidence at boot rather than revived from JSON, so the holder always
 * carries DevBot's deep-frozen object.
 */
export class SnapshotBuilder {
    constructor(private readonly deps: SnapshotBuilderDeps) {}

    lastVersion(): number {
        return getRow<{ v: number | null }>(
            this.deps.db,
            `SELECT MAX(version) AS v FROM snapshots`,
        )?.v ?? 0;
    }

    build(): BuildStats {
        const { db, clock, holder } = this.deps;
        const t0 = performance.now();
        const now = clock();
        const rows = readEvidence(db, now);
        const flags = readFlags(db, now);
        const version = Math.max(this.lastVersion(), holder.get().version) + 1;
        const snapshot: Snapshot = buildSnapshot(rows, {
            ...this.deps.options,
            version,
            builtAt: new Date(now).toISOString(),
            flags,
        });
        const blob = JSON.stringify(snapshot);
        tx(db, () => {
            exec(
                db,
                `INSERT INTO snapshots (version, built_at, blob, checksum) VALUES (?, ?, ?, ?)`,
                version,
                now,
                blob,
                fnv1a(blob).toString(16),
            );
            exec(
                db,
                `DELETE FROM snapshots WHERE version <= ?`,
                version - (this.deps.keep ?? 200),
            );
        });
        holder.swap(snapshot);
        return {
            version,
            rows: rows.length,
            flags: Object.keys(flags).length,
            ms: Math.round(performance.now() - t0),
        };
    }

    /** Published blob for a version (what a logged impression was ranked against). */
    published(version: number): Snapshot | undefined {
        const row = getRow<{ blob: string }>(
            this.deps.db,
            `SELECT blob FROM snapshots WHERE version = ?`,
            version,
        );
        return row ? JSON.parse(row.blob) : undefined;
    }

    versions(): number[] {
        return allRows<{ version: number }>(
            this.deps.db,
            `SELECT version FROM snapshots ORDER BY version`,
        ).map((r) => r.version);
    }
}
