import { DatabaseSync } from "node:sqlite";

/**
 * The host's ONE store: SQLite (WAL) through `node:sqlite` — no FFI, no
 * extra permission beyond read/write on the db file. A single file holds
 * runs, discover impressions, feedback (which doubles as the work queue —
 * `processed_at IS NULL`, ordered `priority DESC, created_at`; no outbox
 * table, v1 decision 7), implicit + explicit signals, the decayed
 * aggregates the scorer reads, severe flags, and published snapshots.
 *
 * Times are epoch MILLISECONDS (integers) everywhere.
 */
export type Db = DatabaseSync;

export const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    api_key_id        TEXT,
    endpoint_id       TEXT NOT NULL,
    provider          TEXT NOT NULL,
    endpoint          TEXT NOT NULL,
    discover_id       TEXT,
    cluster_id        TEXT,
    status            TEXT NOT NULL,
    input_json        TEXT,
    output_json       TEXT,
    error_json        TEXT,
    error_code        TEXT,
    http_status       INTEGER,
    is_provider_error INTEGER,
    is_empty          INTEGER,
    provider_total_ms INTEGER,
    usage_json        TEXT,
    created_at        INTEGER NOT NULL,
    started_at        INTEGER,
    completed_at      INTEGER,
    signals_at        INTEGER,
    window_closed_at  INTEGER,
    -- 1 when a fake/fixture fault profile tampered with this run (test mode)
    fault_injected    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_ws_created ON runs (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS runs_endpoint_completed ON runs (endpoint_id, completed_at);
CREATE INDEX IF NOT EXISTS runs_signals_pending ON runs (completed_at) WHERE signals_at IS NULL;
CREATE INDEX IF NOT EXISTS runs_window_pending ON runs (completed_at) WHERE window_closed_at IS NULL;

CREATE TABLE IF NOT EXISTS discover_impressions (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    query             TEXT NOT NULL,
    cluster_id        TEXT NOT NULL,
    arm               TEXT NOT NULL,
    snapshot_version  INTEGER NOT NULL,
    exploration_slot  INTEGER,
    candidates_json   TEXT NOT NULL,
    created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS impressions_ws_created ON discover_impressions (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL,
    api_key_id       TEXT,
    run_id           TEXT,
    discover_id      TEXT,
    target           TEXT NOT NULL,
    endpoint_id      TEXT,
    cluster_id       TEXT,
    rating           INTEGER,
    text             TEXT,
    expected         TEXT,
    observed         TEXT,
    aspects_json     TEXT,
    severity         TEXT,
    idempotency_key  TEXT,
    priority         INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    processed_at     INTEGER,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    extraction_json  TEXT,
    redacted_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_idempotency
    ON feedback (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS feedback_queue
    ON feedback (priority DESC, created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS feedback_ws ON feedback (workspace_id);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at) WHERE redacted_at IS NULL;

-- One row per scored observation. dedupe_key makes every producer
-- idempotent (a re-run worker tick can never double-count).
CREATE TABLE IF NOT EXISTS signals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key   TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL,          -- implicit | explicit
    kind         TEXT NOT NULL,
    endpoint_id  TEXT NOT NULL,
    cluster_id   TEXT NOT NULL,
    aspect       TEXT NOT NULL,          -- reliability | quality
    value        REAL NOT NULL,          -- 1 = good, 0 = bad
    weight       REAL NOT NULL,
    ts           INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    run_id       TEXT,
    feedback_id  TEXT
);
CREATE INDEX IF NOT EXISTS signals_cell ON signals (endpoint_id, cluster_id, aspect);
CREATE INDEX IF NOT EXISTS signals_ws ON signals (workspace_id);

-- What the scorer reads: time-decayed Beta evidence per
-- endpoint x cluster (category leaf) x aspect x source, decayed to as_of.
CREATE TABLE IF NOT EXISTS signal_aggregates (
    endpoint_id  TEXT NOT NULL,
    cluster_id   TEXT NOT NULL,
    aspect       TEXT NOT NULL,
    source       TEXT NOT NULL,
    pos          REAL NOT NULL,
    neg          REAL NOT NULL,
    n            INTEGER NOT NULL,
    as_of        INTEGER NOT NULL,
    half_life_ms INTEGER NOT NULL,
    PRIMARY KEY (endpoint_id, cluster_id, aspect, source)
);

CREATE TABLE IF NOT EXISTS endpoint_flags (
    endpoint_id     TEXT NOT NULL,
    cluster_id      TEXT NOT NULL,       -- '*' = every cluster
    kind            TEXT NOT NULL,
    state           TEXT NOT NULL,       -- provisional | confirmed
    multiplier      REAL NOT NULL,
    reports         INTEGER NOT NULL,
    workspaces_json TEXT NOT NULL,
    first_at        INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    PRIMARY KEY (endpoint_id, cluster_id, kind)
);

-- Published by host/rerank/builder.ts (M3): the exact snapshot each version ranked with.
CREATE TABLE IF NOT EXISTS snapshots (
    version   INTEGER PRIMARY KEY,
    built_at  INTEGER NOT NULL,
    blob      BLOB NOT NULL,
    checksum  TEXT NOT NULL
);
`;

export interface OpenDbOptions {
    /** `:memory:` for tests. */
    path: string;
    busyTimeoutMs?: number;
}

export function openDb(opts: OpenDbOptions): Db {
    const db = new DatabaseSync(opts.path);
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 5000)}`);
    if (opts.path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
}

function migrate(db: Db): void {
    db.exec(MIGRATION_1);
    db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
}

/** BEGIN IMMEDIATE … COMMIT, rolled back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const out = fn();
        db.exec("COMMIT");
        return out;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

export type Row = Record<string, unknown>;

export function getRow<T = Row>(
    db: Db,
    sql: string,
    ...params: SqlParam[]
): T | undefined {
    return db.prepare(sql).get(...params) as T | undefined;
}

export function allRows<T = Row>(
    db: Db,
    sql: string,
    ...params: SqlParam[]
): T[] {
    return db.prepare(sql).all(...params) as T[];
}

export function exec(
    db: Db,
    sql: string,
    ...params: SqlParam[]
): { changes: number } {
    const result = db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
}

export type SqlParam = string | number | bigint | null | Uint8Array;
