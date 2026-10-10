import type { Json, RunInput } from "@shared/core";
import { sealUnit } from "@shared/core";
import {
    Engine,
    EngineError,
    type RunCompleted,
} from "@monid/connector-engine";
import type { Catalog, CatalogEntry, WirePrice } from "../catalog/catalog.ts";
import type { HealthTracker } from "../health/tracker.ts";
import type { TransportFactory } from "../transport/factory.ts";
import { allRows, type Db, exec, getRow } from "../store/db.ts";
import { type Clock, HttpError, newId } from "../util.ts";
import { isEmptyOutput } from "./empty.ts";

/** cli RunStatus. */
export type RunStatus =
    | "READY"
    | "RUNNING"
    | "STOPPING"
    | "COMPLETED"
    | "FAILED"
    | "BLOCKED"
    | "STOPPED"
    | "TIMED_OUT";

export const TERMINAL: ReadonlySet<string> = new Set([
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "STOPPED",
    "TIMED_OUT",
]);

export interface RunRequest {
    provider: string;
    endpoint: string;
    input?: RunInput;
    /** Additive: links the run to the ranking that produced it. */
    discoverId?: string;
}

export interface RunRow {
    id: string;
    workspace_id: string;
    endpoint_id: string;
    provider: string;
    endpoint: string;
    discover_id: string | null;
    cluster_id: string | null;
    status: RunStatus;
    input_json: string | null;
    output_json: string | null;
    error_json: string | null;
    error_code: string | null;
    http_status: number | null;
    is_provider_error: number | null;
    is_empty: number | null;
    provider_total_ms: number | null;
    usage_json: string | null;
    created_at: number;
    started_at: number | null;
    completed_at: number | null;
    fault_injected: number;
}

export interface RunServiceDeps {
    db: Db;
    catalog: Catalog;
    health: HealthTracker;
    transports: TransportFactory;
    clock: Clock;
    syncWaitMs: number;
    /** Leave runs with injected faults out of live health (MONID_HEALTH_IGNORE_FAULTS). */
    healthIgnoreFaults?: boolean;
}

interface Outcome {
    faultInjected?: boolean;
    status: RunStatus;
    output?: Json | null;
    error?: { source: "provider" | "platform"; message: string };
    errorCode?: string;
    httpStatus?: number;
    isProviderError?: boolean;
    isEmpty?: boolean;
    providerTotalMs?: number;
    usage?: unknown;
}

/** Caller-fault codes never count against an endpoint's health. */
const CALLER_FAULT = new Set(["INVALID_INPUT", "MISSING_CREDENTIAL"]);
/** Engine codes that mean the VENDOR's answer was unusable. */
const PROVIDER_FAULT = new Set([
    "EXECUTION_FAILED",
    "DECODE_FAILED",
    "CONTRACT_VIOLATION",
    "FN_CONTRACT",
]);

export class RunService {
    private readonly inflight = new Map<
        string,
        { abort: AbortController; done: Promise<void> }
    >();

    constructor(private readonly deps: RunServiceDeps) {}

    /** Hydrate live health from persisted runs (boot). */
    hydrateHealth(sinceMs: number): void {
        const rows = allRows<RunRow>(
            this.deps.db,
            `SELECT * FROM runs WHERE completed_at >= ? ORDER BY completed_at`,
            sinceMs,
        );
        for (const row of rows) this.recordHealth(row);
    }

    async start(
        workspaceId: string,
        apiKeyId: string,
        req: RunRequest,
    ): Promise<RunRow> {
        const { db, catalog, clock } = this.deps;
        if (
            typeof req.provider !== "string" || typeof req.endpoint !== "string"
        ) {
            throw new HttpError(
                400,
                "INVALID_REQUEST",
                "provider and endpoint are required",
            );
        }
        const entry = catalog.resolve(req.provider, req.endpoint);
        if (!entry) {
            throw new HttpError(
                404,
                "NOT_FOUND",
                `unknown endpoint ${req.provider} ${req.endpoint}`,
            );
        }
        const now = clock();
        // Additive field: an unknown or foreign discoverId is dropped, never
        // an error (it only links signals, it must not fail a paid run).
        const discoverId = typeof req.discoverId === "string" &&
                getRow(
                    db,
                    `SELECT 1 AS ok FROM discover_impressions WHERE id = ? AND workspace_id = ?`,
                    req.discoverId,
                    workspaceId,
                )
            ? req.discoverId
            : null;
        const clusterId = this.clusterFor(workspaceId, entry, discoverId);
        const id = newId("run", now);
        const input = (req.input ?? {}) as RunInput;
        exec(
            db,
            `INSERT INTO runs (id, workspace_id, api_key_id, endpoint_id, provider, endpoint,
                discover_id, cluster_id, status, input_json, created_at, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)`,
            id,
            workspaceId,
            apiKeyId,
            entry.id,
            entry.provider,
            entry.endpoint,
            discoverId,
            clusterId,
            JSON.stringify(input),
            now,
            now,
        );

        const abort = new AbortController();
        const done = this.execute(entry, input, abort.signal)
            .then((outcome) => this.finish(id, outcome))
            .finally(() => this.inflight.delete(id));
        this.inflight.set(id, { abort, done });

        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            done,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, this.deps.syncWaitMs);
            }),
        ]);
        clearTimeout(timer);
        return this.mustGet(workspaceId, id);
    }

    /** discoverId's impression cluster when it ranked this endpoint; else the primary category. */
    private clusterFor(
        workspaceId: string,
        entry: CatalogEntry,
        discoverId: string | null,
    ): string {
        if (discoverId) {
            const row = getRow<{ cluster_id: string; candidates_json: string }>(
                this.deps.db,
                `SELECT cluster_id, candidates_json FROM discover_impressions WHERE id = ? AND workspace_id = ?`,
                discoverId,
                workspaceId,
            );
            if (row && entry.categories.includes(row.cluster_id)) {
                return row.cluster_id;
            }
            if (row) {
                const shown = JSON.parse(row.candidates_json) as {
                    endpointId: string;
                }[];
                if (shown.some((c) => c.endpointId === entry.id)) {
                    return row.cluster_id;
                }
            }
        }
        return entry.categories[0] ?? "uncategorized";
    }

    private async execute(
        entry: CatalogEntry,
        input: RunInput,
        signal: AbortSignal,
    ): Promise<Outcome> {
        const probe: { injected?: () => boolean } = {};
        const outcome = await this.executeInner(
            entry,
            input,
            signal,
            (f) => (probe.injected = f),
        );
        return { ...outcome, faultInjected: probe.injected?.() ?? false };
    }

    private async executeInner(
        entry: CatalogEntry,
        input: RunInput,
        signal: AbortSignal,
        onTransport: (injected: (() => boolean) | undefined) => void,
    ): Promise<Outcome> {
        try {
            const unit = sealUnit(this.deps.catalog.bundle, entry.id);
            const { transport, sleep, injected } = await this.deps.transports
                .forRun(entry.doc);
            onTransport(injected);
            const engine = new Engine({
                transport,
                ...(sleep ? { sleep } : {}),
                // the host persists no owned resources in v1: an empty window
                resources: { owned: () => Promise.resolve([]) },
                scopeKey: "monid-host",
            });
            const loaded = await engine.load(unit);
            const completed: RunCompleted = await loaded.run(input, { signal });
            const empty = !completed.isProviderError &&
                isEmptyOutput(completed.output);
            return {
                status: completed.isProviderError ? "FAILED" : "COMPLETED",
                output: completed.output,
                ...(completed.isProviderError
                    ? {
                        error: {
                            source: "provider" as const,
                            message:
                                `provider answered HTTP ${completed.httpStatus}`,
                        },
                        errorCode: "PROVIDER_ERROR",
                    }
                    : {}),
                httpStatus: completed.httpStatus,
                isProviderError: completed.isProviderError,
                isEmpty: empty,
                providerTotalMs: completed.timing.providerTotalMs,
                usage: completed.usage,
            };
        } catch (error) {
            if (signal.aborted) {
                return {
                    status: "STOPPED",
                    errorCode: "STOPPED",
                    error: { source: "platform", message: "stopped by caller" },
                };
            }
            if (error instanceof EngineError) {
                const status: RunStatus = error.code === "TIMEOUT"
                    ? "TIMED_OUT"
                    : "FAILED";
                return {
                    status,
                    errorCode: error.code,
                    error: {
                        source: PROVIDER_FAULT.has(error.code)
                            ? "provider"
                            : "platform",
                        message: error.message,
                    },
                };
            }
            return {
                status: "FAILED",
                errorCode: "INTERNAL",
                error: { source: "platform", message: String(error) },
            };
        }
    }

    private finish(id: string, o: Outcome): void {
        const now = this.deps.clock();
        exec(
            this.deps.db,
            `UPDATE runs SET status = ?, output_json = ?, error_json = ?, error_code = ?,
                http_status = ?, is_provider_error = ?, is_empty = ?, provider_total_ms = ?,
                usage_json = ?, fault_injected = ?, completed_at = ?
             WHERE id = ?`,
            o.status,
            o.output === undefined ? null : JSON.stringify(o.output),
            o.error ? JSON.stringify(o.error) : null,
            o.errorCode ?? null,
            o.httpStatus ?? null,
            o.isProviderError === undefined ? null : Number(o.isProviderError),
            o.isEmpty === undefined ? null : Number(o.isEmpty),
            o.providerTotalMs ?? null,
            o.usage === undefined ? null : JSON.stringify(o.usage),
            o.faultInjected ? 1 : 0,
            now,
            id,
        );
        const row = getRow<RunRow>(
            this.deps.db,
            `SELECT * FROM runs WHERE id = ?`,
            id,
        );
        if (row) this.recordHealth(row);
    }

    private recordHealth(row: RunRow): void {
        if (!row.completed_at || row.status === "STOPPED") return;
        if (row.error_code && CALLER_FAULT.has(row.error_code)) return;
        if (this.deps.healthIgnoreFaults && row.fault_injected) return;
        this.deps.health.record(row.endpoint_id, {
            ts: row.completed_at,
            ok: row.status === "COMPLETED",
            ...(row.provider_total_ms !== null
                ? { ms: row.provider_total_ms }
                : {}),
        });
    }

    get(workspaceId: string, id: string): RunRow | undefined {
        return getRow<RunRow>(
            this.deps.db,
            `SELECT * FROM runs WHERE id = ? AND workspace_id = ?`,
            id,
            workspaceId,
        );
    }

    mustGet(workspaceId: string, id: string): RunRow {
        const row = this.get(workspaceId, id);
        if (!row) throw new HttpError(404, "NOT_FOUND", `run ${id} not found`);
        return row;
    }

    list(
        workspaceId: string,
        limit: number,
        cursor?: string,
    ): { items: RunRow[]; cursor: string | null } {
        const n = Math.min(100, Math.max(1, limit || 20));
        const rows = cursor
            ? allRows<RunRow>(
                this.deps.db,
                `SELECT * FROM runs WHERE workspace_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
                workspaceId,
                cursor,
                n + 1,
            )
            : allRows<RunRow>(
                this.deps.db,
                `SELECT * FROM runs WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`,
                workspaceId,
                n + 1,
            );
        const items = rows.slice(0, n);
        return {
            items,
            cursor: rows.length > n ? items[items.length - 1].id : null,
        };
    }

    async stop(workspaceId: string, id: string): Promise<RunRow> {
        const row = this.mustGet(workspaceId, id);
        const live = this.inflight.get(id);
        if (live && !TERMINAL.has(row.status)) {
            live.abort.abort();
            await live.done;
        }
        return this.mustGet(workspaceId, id);
    }

    /** Wait for every in-flight run (tests, graceful shutdown). */
    async drain(): Promise<void> {
        await Promise.all([...this.inflight.values()].map((r) => r.done));
    }

    // ---- wire projections (cli RunResponse / RunDetailResponse / RunListItem)

    toWire(row: RunRow, detail: boolean): Record<string, unknown> {
        const entry = this.deps.catalog.get(row.endpoint_id);
        const price: WirePrice | undefined = entry?.price;
        const output = row.output_json
            ? JSON.parse(row.output_json)
            : undefined;
        const error = row.error_json ? JSON.parse(row.error_json) : undefined;
        const usage = row.usage_json ? JSON.parse(row.usage_json) : undefined;
        const providerResponse = row.http_status !== null
            ? {
                httpStatus: row.http_status,
                ...(row.is_provider_error
                    ? { error: asRecord(output) }
                    : { data: asRecord(output) }),
            }
            : undefined;
        const iso = (
            ms: number | null,
        ) => (ms === null ? undefined : new Date(ms).toISOString());
        return {
            runId: row.id,
            ...(detail ? { caller: row.workspace_id } : {}),
            provider: row.provider,
            providerName: entry?.providerName,
            endpoint: row.endpoint,
            status: row.status,
            ...(detail && row.input_json
                ? { input: JSON.parse(row.input_json) }
                : {}),
            ...(detail && output !== undefined && !row.is_provider_error
                ? { output: asRecord(output) }
                : {}),
            ...(error ? { error } : {}),
            ...(detail ? { stoppable: !TERMINAL.has(row.status) } : {}),
            ...(providerResponse ? { providerResponse } : {}),
            price,
            cost: costOf(
                usage,
                entry?.doc.usage as unknown as {
                    credits?: Record<string, { label?: string }>;
                },
            ),
            createdAt: iso(row.created_at),
            startedAt: iso(row.started_at),
            completedAt: iso(row.completed_at),
            ...(row.discover_id ? { discoverId: row.discover_id } : {}),
            ...(usage ? { hints: { credits: usage.credits } } : {}),
        };
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { value };
}

/** Settled credits drawn from pools the rate card labels "US dollars"; else null. */
function costOf(
    usage: { credits?: Record<string, number> } | undefined,
    card: { credits?: Record<string, { label?: string }> } | undefined,
) {
    if (!usage?.credits) return null;
    let value = 0;
    let any = false;
    for (const [pool, amount] of Object.entries(usage.credits)) {
        if (card?.credits?.[pool]?.label === "US dollars") {
            value += amount;
            any = true;
        }
    }
    return any
        ? { value: Math.round(value * 1e6) / 1e6, currency: "USD" }
        : null;
}
