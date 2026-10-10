import type { HalfLives } from "./weights.ts";
import { type Db, exec, getRow, tx } from "../store/db.ts";
import { type Clock, HttpError, newId } from "../util.ts";
import { rebuildAggregates } from "./aggregates.ts";
import { AGENT_ASPECTS, SEVERITIES } from "./classify.ts";
import { RateLimiter } from "./ratelimit.ts";
import { FEEDBACK_PRIORITY } from "./weights.ts";

/**
 * POST /v1/feedback — the WRITE path. Validate, resolve the run (it must be
 * the caller's own), insert ONE row (the row is also the queue entry), 202.
 * No model, no scoring, no snapshot work here.
 */
export interface FeedbackRequest {
    runId?: string;
    /** Endpoint id (`exa#search`), or the wire path when `provider` is given.
     *  Required for endpoint feedback without a runId (stored, unscored). */
    endpoint?: string;
    provider?: string;
    discoverId?: string;
    target?: "endpoint" | "discover" | "platform";
    rating?: number;
    text?: string;
    aspects?: string[];
    severity?: string;
    expected?: string;
    observed?: string;
}

export const MAX_TEXT = 4000;

export interface FeedbackServiceDeps {
    db: Db;
    /** Resolve `{provider?, endpoint}` → bundle id (undefined = unknown). */
    resolveEndpoint: (
        endpoint: string,
        provider?: string,
    ) => string | undefined;
    clock: Clock;
    ratePerMinute: number;
    halfLives?: HalfLives;
}

export class FeedbackService {
    private readonly limiter: RateLimiter;

    constructor(private readonly deps: FeedbackServiceDeps) {
        this.limiter = new RateLimiter(deps.ratePerMinute);
    }

    submit(
        workspaceId: string,
        apiKeyId: string,
        body: FeedbackRequest,
        idempotencyKey: string | null,
    ): { feedbackId: string; status: "queued" } {
        const now = this.deps.clock();
        const wait = this.limiter.take(apiKeyId, now);
        if (wait > 0) {
            throw new HttpError(
                429,
                "RATE_LIMITED",
                "feedback is limited to 60 calls per minute per key",
                {
                    "retry-after": String(Math.ceil(wait / 1000)),
                },
            );
        }
        const f = validate(body);
        const db = this.deps.db;

        if (idempotencyKey) {
            const existing = getRow<{ id: string }>(
                db,
                `SELECT id FROM feedback WHERE workspace_id = ? AND idempotency_key = ?`,
                workspaceId,
                idempotencyKey,
            );
            if (existing) return { feedbackId: existing.id, status: "queued" };
        }

        let endpointId: string | null = null;
        let clusterId: string | null = null;
        if (f.runId) {
            const run = getRow<
                {
                    endpoint_id: string;
                    cluster_id: string | null;
                    discover_id: string | null;
                }
            >(
                db,
                `SELECT endpoint_id, cluster_id, discover_id FROM runs WHERE id = ? AND workspace_id = ?`,
                f.runId,
                workspaceId,
            );
            if (!run) {
                throw new HttpError(
                    404,
                    "NOT_FOUND",
                    `run ${f.runId} not found`,
                );
            }
            endpointId = run.endpoint_id;
            clusterId = run.cluster_id;
            f.discoverId ??= run.discover_id ?? undefined;
        }
        if (f.discoverId) {
            const imp = getRow(
                db,
                `SELECT id FROM discover_impressions WHERE id = ? AND workspace_id = ?`,
                f.discoverId,
                workspaceId,
            );
            if (!imp) {
                throw new HttpError(
                    404,
                    "NOT_FOUND",
                    `discover ${f.discoverId} not found`,
                );
            }
        }
        const target = f.target ?? "endpoint";
        if (f.endpoint !== undefined) {
            const resolved = this.deps.resolveEndpoint(f.endpoint, f.provider);
            if (!resolved) {
                throw new HttpError(
                    404,
                    "NOT_FOUND",
                    `unknown endpoint ${f.endpoint}`,
                );
            }
            if (endpointId && endpointId !== resolved) {
                throw new HttpError(
                    400,
                    "INVALID_REQUEST",
                    "endpoint does not match the run's endpoint",
                );
            }
            endpointId = resolved;
        }
        if (target === "endpoint" && !endpointId) {
            throw new HttpError(
                400,
                "INVALID_REQUEST",
                "endpoint feedback needs a runId or an endpoint",
            );
        }
        // only run-linked feedback is scored, so only it can raise a flag
        const severe = target === "endpoint" && Boolean(f.runId) &&
            (f.severity === "high" || f.severity === "critical");
        const id = newId("fb", now);
        exec(
            db,
            `INSERT INTO feedback (id, workspace_id, api_key_id, run_id, discover_id, target,
                endpoint_id, cluster_id, rating, text, expected, observed, aspects_json,
                severity, idempotency_key, priority, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            workspaceId,
            apiKeyId,
            f.runId ?? null,
            f.discoverId ?? null,
            target,
            endpointId,
            clusterId,
            f.rating ?? null,
            f.text ?? null,
            f.expected ?? null,
            f.observed ?? null,
            f.aspects ? JSON.stringify(f.aspects) : null,
            f.severity ?? null,
            idempotencyKey,
            severe ? FEEDBACK_PRIORITY.severe : FEEDBACK_PRIORITY.normal,
            now,
        );
        return { feedbackId: id, status: "queued" };
    }

    get(workspaceId: string, id: string): Record<string, unknown> {
        const row = getRow<Record<string, unknown>>(
            this.deps.db,
            `SELECT * FROM feedback WHERE id = ? AND workspace_id = ?`,
            id,
            workspaceId,
        );
        if (!row) {
            throw new HttpError(404, "NOT_FOUND", `feedback ${id} not found`);
        }
        return {
            feedbackId: row.id,
            status: row.processed_at ? "processed" : "queued",
            runId: row.run_id ?? undefined,
            discoverId: row.discover_id ?? undefined,
            target: row.target,
            endpointId: row.endpoint_id ?? undefined,
            clusterId: row.cluster_id ?? undefined,
            rating: row.rating ?? undefined,
            text: row.text ?? undefined,
            expected: row.expected ?? undefined,
            observed: row.observed ?? undefined,
            redacted: row.redacted_at !== null,
            extraction: row.extraction_json
                ? JSON.parse(String(row.extraction_json))
                : undefined,
            createdAt: new Date(Number(row.created_at)).toISOString(),
        };
    }

    /** DELETE /v1/feedback — every feedback row of the workspace + its explicit signals. */
    deleteWorkspace(workspaceId: string): { deleted: number } {
        return tx(this.deps.db, () => {
            const { changes } = exec(
                this.deps.db,
                `DELETE FROM feedback WHERE workspace_id = ?`,
                workspaceId,
            );
            const sig = exec(
                this.deps.db,
                `DELETE FROM signals WHERE workspace_id = ? AND source = 'explicit'`,
                workspaceId,
            );
            if (sig.changes > 0) {
                rebuildAggregates(this.deps.db, this.deps.halfLives);
            }
            return { deleted: changes };
        });
    }
}

function validate(body: unknown): FeedbackRequest {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(
            400,
            "INVALID_REQUEST",
            "body must be a JSON object",
        );
    }
    const b = body as Record<string, unknown>;
    const bad = (msg: string) => new HttpError(400, "INVALID_REQUEST", msg);
    const out: FeedbackRequest = {};
    if (b.runId !== undefined) {
        if (typeof b.runId !== "string" || !b.runId) {
            throw bad("runId must be a string");
        }
        out.runId = b.runId;
    }
    if (b.discoverId !== undefined) {
        if (typeof b.discoverId !== "string" || !b.discoverId) {
            throw bad("discoverId must be a string");
        }
        out.discoverId = b.discoverId;
    }
    if (b.endpoint !== undefined) {
        if (typeof b.endpoint !== "string" || !b.endpoint) {
            throw bad("endpoint must be a string");
        }
        out.endpoint = b.endpoint;
    }
    if (b.provider !== undefined) {
        if (typeof b.provider !== "string" || !b.provider) {
            throw bad("provider must be a string");
        }
        out.provider = b.provider;
    }
    for (const field of ["expected", "observed"] as const) {
        if (b[field] !== undefined) {
            if (typeof b[field] !== "string") {
                throw bad(`${field} must be a string`);
            }
            if ((b[field] as string).length > MAX_TEXT) {
                throw bad(`${field} is limited to ${MAX_TEXT} characters`);
            }
            out[field] = b[field] as string;
        }
    }
    if (b.target !== undefined) {
        if (!["endpoint", "discover", "platform"].includes(String(b.target))) {
            throw bad("target must be endpoint | discover | platform");
        }
        out.target = b.target as FeedbackRequest["target"];
    }
    if (b.rating === undefined) throw bad("rating is required (integer -2..2)");
    {
        if (
            !Number.isInteger(b.rating) || (b.rating as number) < -2 ||
            (b.rating as number) > 2
        ) {
            throw bad("rating must be an integer from -2 to 2");
        }
        out.rating = b.rating as number;
    }
    if (b.text !== undefined) {
        if (typeof b.text !== "string") throw bad("text must be a string");
        if (b.text.length > MAX_TEXT) {
            throw bad(`text is limited to ${MAX_TEXT} characters`);
        }
        if (b.text.trim()) out.text = b.text;
    }
    if (b.aspects !== undefined) {
        if (
            !Array.isArray(b.aspects) ||
            b.aspects.some((a) =>
                !(AGENT_ASPECTS as readonly string[]).includes(a)
            )
        ) {
            throw bad(
                `aspects must be a subset of ${AGENT_ASPECTS.join(", ")}`,
            );
        }
        out.aspects = [...new Set(b.aspects as string[])];
    }
    if (b.severity !== undefined) {
        if (!(SEVERITIES as readonly unknown[]).includes(b.severity)) {
            throw bad(`severity must be one of ${SEVERITIES.join(", ")}`);
        }
        out.severity = b.severity as string;
    }
    return out;
}
