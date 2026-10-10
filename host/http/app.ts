import type { HostConfig } from "../config.ts";
import type { Catalog } from "../catalog/catalog.ts";
import type { DiscoverService } from "../discover/service.ts";
import type { FeedbackService } from "../feedback/service.ts";
import type { HealthTracker } from "../health/tracker.ts";
import type { RunService } from "../runs/service.ts";
import type { SnapshotHolder } from "../rerank/port.ts";
import type { SnapshotBuilder } from "../rerank/builder.ts";
import type { FakeProfile } from "../config.ts";
import type { TransportFactory } from "../transport/factory.ts";
import { type Clock, errorResponse, HttpError, json } from "../util.ts";

/**
 * The wire surface — a pure `Request → Response` handler (Deno.serve in
 * main.ts; called directly in tests, so no socket is needed there).
 * Paths and shapes follow the stock CLI (cli/src/api/client.ts + types.ts).
 */
export interface AppDeps {
    config: HostConfig;
    catalog: Catalog;
    discover: DiscoverService;
    runs: RunService;
    feedback: FeedbackService;
    health: HealthTracker;
    snapshots: SnapshotHolder;
    snapshotBuilder: SnapshotBuilder;
    transports: TransportFactory;
    clock: Clock;
}

type Caller = { workspaceId: string; keyId: string };

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
    const { config, catalog } = deps;

    const auth = (req: Request): Caller => {
        const header = req.headers.get("authorization") ?? "";
        const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const entry = key ? config.apiKeys.get(key) : undefined;
        if (!entry) {
            throw new HttpError(
                401,
                "AUTH_FAILED",
                "missing or unknown API key",
            );
        }
        return { workspaceId: entry.workspaceId, keyId: entry.keyId };
    };

    const body = async (req: Request): Promise<Record<string, unknown>> => {
        const text = await req.text();
        if (!text) return {};
        try {
            const parsed = JSON.parse(text);
            if (
                parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ) return parsed;
        } catch { /* fall through */ }
        throw new HttpError(
            400,
            "INVALID_REQUEST",
            "body must be a JSON object",
        );
    };

    /** Admin = MONID_ADMIN_KEY as `Authorization: Bearer` (sim) or `x-admin-key`. */
    const admin = (req: Request) => {
        const header = req.headers.get("authorization") ?? "";
        const key = req.headers.get("x-admin-key") ??
            (header.startsWith("Bearer ") ? header.slice(7).trim() : "");
        if (!config.adminKey || key !== config.adminKey) {
            throw new HttpError(403, "FORBIDDEN", "admin key required");
        }
    };

    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method;
        try {
            // ---- public ---------------------------------------------------
            if (method === "GET" && path === "/healthz") {
                return json({
                    ok: true,
                    endpoints: catalog.entries.length,
                    transport: config.transport,
                    snapshotVersion: deps.snapshots.get().version,
                });
            }
            if (
                method === "POST" && path === "/public/v1/telemetry/skill-setup"
            ) {
                await req.body?.cancel();
                return new Response(null, { status: 204 });
            }

            // ---- admin (fake-transport chaos, for the sim) ------------------
            if (path === "/v1/_admin/fake-profiles") {
                admin(req);
                if (method === "GET") {
                    return json(deps.transports.profiles?.() ?? {});
                }
                if (method === "PUT") {
                    const next = await body(req);
                    try {
                        deps.transports.setProfiles?.(
                            next as Record<string, never>,
                        );
                    } catch (error) {
                        throw new HttpError(
                            409,
                            "CONFLICT",
                            String((error as Error).message),
                        );
                    }
                    return json(deps.transports.profiles?.() ?? {});
                }
            }

            if (path === "/v1/admin/faults") {
                admin(req);
                if (!deps.transports.setProfiles) {
                    throw new HttpError(
                        409,
                        "CONFLICT",
                        "faults need MONID_HOST_TRANSPORT=fake or fixture",
                    );
                }
                if (method === "POST") {
                    const b = await body(req);
                    const target = String(b.target ?? "");
                    if (
                        !target ||
                        !catalog.get(target) &&
                            !catalog.entries.some((e) => e.provider === target)
                    ) {
                        throw new HttpError(
                            404,
                            "NOT_FOUND",
                            `unknown fault target ${target}`,
                        );
                    }
                    const rate = (v: unknown, name: string) => {
                        if (v === undefined) return undefined;
                        if (typeof v !== "number" || !(v >= 0 && v <= 1)) {
                            throw new HttpError(
                                400,
                                "INVALID_REQUEST",
                                `${name} must be in [0, 1]`,
                            );
                        }
                        return v;
                    };
                    const errorRate = rate(b.error_rate, "error_rate");
                    const emptyRate = rate(b.empty_rate, "empty_rate");
                    const garbageRate = rate(b.garbage_rate, "garbage_rate");
                    const profiles = { ...deps.transports.profiles?.() };
                    const next: FakeProfile = {
                        ...profiles[target],
                        ...(errorRate !== undefined ? { errorRate } : {}),
                        ...(emptyRate !== undefined ? { emptyRate } : {}),
                        ...(garbageRate !== undefined ? { garbageRate } : {}),
                    };
                    if (Object.values(next).every((v) => !v)) {
                        delete profiles[target];
                    } else profiles[target] = next;
                    deps.transports.setProfiles(profiles);
                    return json({ faults: deps.transports.profiles?.() ?? {} });
                }
                if (method === "GET") {
                    return json({ faults: deps.transports.profiles?.() ?? {} });
                }
            }
            if (method === "POST" && path === "/v1/admin/snapshot") {
                admin(req);
                await req.body?.cancel();
                const stats = deps.snapshotBuilder.build();
                return json({ snapshotVersion: stats.version, ...stats });
            }

            const caller = auth(req);

            // ---- discover / inspect / run -----------------------------------
            if (method === "POST" && path === "/v1/discover") {
                const b = await body(req);
                const forced = config.honorArmHeader
                    ? req.headers.get("x-monid-arm")?.trim().toLowerCase()
                    : undefined;
                return json(
                    deps.discover.discover(caller.workspaceId, b as never, {
                        ...(forced === "control" || forced === "treatment"
                            ? { arm: forced }
                            : {}),
                    }),
                );
            }
            if (method === "POST" && path === "/v1/inspect") {
                const b = await body(req);
                const entry = catalog.resolve(
                    String(b.provider ?? ""),
                    String(b.endpoint ?? ""),
                );
                if (!entry) {
                    throw new HttpError(
                        404,
                        "NOT_FOUND",
                        `unknown endpoint ${b.provider} ${b.endpoint}`,
                    );
                }
                const metrics = deps.health.metrics(entry.id, deps.clock());
                const schema = (entry.doc.input as unknown as {
                    schema: Record<string, unknown>;
                }).schema;
                return json({
                    id: entry.id,
                    provider: entry.provider,
                    providerName: entry.providerName,
                    endpoint: entry.endpoint,
                    description: entry.description,
                    summary: entry.summary,
                    input: {
                        ...(schema.pathParams
                            ? { pathParams: schema.pathParams }
                            : {}),
                        ...(schema.queryParams
                            ? { queryParams: schema.queryParams }
                            : {}),
                        ...(schema.body ? { body: schema.body } : {}),
                    },
                    price: entry.price,
                    tags: entry.categories,
                    ...(entry.docsUrl ? { docUrl: entry.docsUrl } : {}),
                    notes: entry.notes,
                    ...(metrics ? { metrics } : {}),
                });
            }
            if (method === "POST" && path === "/v1/run") {
                const b = await body(req);
                const row = await deps.runs.start(
                    caller.workspaceId,
                    caller.keyId,
                    b as never,
                );
                return json(
                    deps.runs.toWire(row, false),
                    row.status === "RUNNING" ? 202 : 200,
                );
            }
            if (method === "GET" && path === "/v1/runs") {
                const limit = Number(url.searchParams.get("limit") ?? 20);
                const cursor = url.searchParams.get("cursor") ?? undefined;
                const { items, cursor: next } = deps.runs.list(
                    caller.workspaceId,
                    limit,
                    cursor,
                );
                return json({
                    items: items.map((r) => deps.runs.toWire(r, false)),
                    cursor: next,
                });
            }
            const runMatch = path.match(/^\/v1\/runs\/([^/]+)(\/stop)?$/);
            if (runMatch) {
                const id = decodeURIComponent(runMatch[1]);
                if (method === "GET" && !runMatch[2]) {
                    return json(
                        deps.runs.toWire(
                            deps.runs.mustGet(caller.workspaceId, id),
                            true,
                        ),
                    );
                }
                if (method === "POST" && runMatch[2]) {
                    const row = await deps.runs.stop(caller.workspaceId, id);
                    return json({ runId: row.id, status: row.status });
                }
            }

            // ---- feedback ---------------------------------------------------
            if (method === "POST" && path === "/v1/feedback") {
                const b = await body(req);
                const out = deps.feedback.submit(
                    caller.workspaceId,
                    caller.keyId,
                    b,
                    req.headers.get("idempotency-key"),
                );
                return json(out, 202);
            }
            if (method === "DELETE" && path === "/v1/feedback") {
                return json(deps.feedback.deleteWorkspace(caller.workspaceId));
            }
            const fbMatch = path.match(/^\/v1\/feedback\/([^/]+)$/);
            if (method === "GET" && fbMatch) {
                return json(
                    deps.feedback.get(
                        caller.workspaceId,
                        decodeURIComponent(fbMatch[1]),
                    ),
                );
            }

            // ---- stubs the stock CLI calls -----------------------------------
            if (method === "GET" && path === "/v1/wallet/balance") {
                return json({
                    balance: { value: 0, currency: "USD" },
                    hints: {
                        note:
                            "self-hosted test host: no wallet, runs are not billed",
                    },
                });
            }
            if (method === "GET" && path === "/v1/auth/whoami") {
                const now = new Date(0).toISOString();
                return json({
                    user: {
                        userId: caller.keyId,
                        username: "monid-host",
                        createdAt: now,
                        updatedAt: now,
                    },
                    workspace: {
                        workspaceId: caller.workspaceId,
                        name: caller.workspaceId,
                        slug: caller.workspaceId,
                        createdAt: now,
                        updatedAt: now,
                    },
                });
            }
            if (method === "GET" && path === "/v1/auth/workspaces") {
                return json({
                    workspaces: [{
                        workspaceId: caller.workspaceId,
                        slug: caller.workspaceId,
                    }],
                });
            }
            if (method === "GET" && path === "/v1/resources") {
                return json({ items: [], cursor: null });
            }
            throw new HttpError(404, "NOT_FOUND", `no route ${method} ${path}`);
        } catch (error) {
            if (error instanceof HttpError) return errorResponse(error);
            console.error("[monid-host] unhandled", error);
            return errorResponse(
                new HttpError(500, "INTERNAL", "internal error"),
            );
        }
    };
}
