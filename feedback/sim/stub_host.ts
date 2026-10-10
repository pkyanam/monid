/**
 * TEST-ONLY stub of the Monid feedback host. It is a contract fixture for the
 * sim, not a second host: a fixed candidate list (no BM25), synthetic run
 * outputs, in-memory evidence with exponential decay and no trust weighting, and a snapshot
 * rebuilt on a timer with @monid/feedback-rerank.
 *
 * Env: HOST (default 127.0.0.1), PORT (default 8787), MONID_SNAPSHOT_INTERVAL_MS (default 60000),
 * MONID_FAKE_FAULTS ("provider#endpoint:error_rate=0.6[,empty_rate=0.1];..."),
 * MONID_ADMIN_KEY (optional; required bearer for /v1/admin/*),
 * MONID_DECAY_HALF_LIFE_MS (evidence half-life; unset = no decay).
 */
import {
    buildSnapshot,
    type EvidenceRow,
    lookup,
    rerank,
    type Snapshot,
} from "@monid/feedback-rerank";
import { hash, rng } from "./rng.ts";
import { ENDPOINTS, LEAF } from "./scenario.ts";
import type { Arm } from "./wire.ts";

export interface StubOptions {
    hostname?: string;
    port?: number;
    snapshotIntervalMs?: number;
    faults?: string;
    adminKey?: string;
    seed?: number;
    /** Evidence half-life; undefined or 0 = no decay. */
    halfLifeMs?: number;
    /** Leave results[].quality out, to test that the sim fails without it. */
    omitQuality?: boolean;
}

interface Fault {
    errorRate: number;
    emptyRate: number;
}

interface Run {
    runId: string;
    provider: string;
    endpoint: string;
    status: "RUNNING" | "COMPLETED" | "FAILED";
    final: "COMPLETED" | "FAILED";
    output?: Record<string, unknown>;
    error?: { source: "provider"; message: string };
    createdAt: string;
}

const PRICE = { type: "PER_CALL", amount: { value: 0.002, currency: "USD" } };

export function parseFaults(spec = ""): Map<string, Fault> {
    const faults = new Map<string, Fault>();
    for (const part of spec.split(";").map((s) => s.trim()).filter(Boolean)) {
        const at = part.lastIndexOf(":");
        const kv = Object.fromEntries(
            part.slice(at + 1).split(",").map((p) => p.split("=")),
        );
        faults.set(part.slice(0, at), {
            errorRate: Number(kv.error_rate ?? 0),
            emptyRate: Number(kv.empty_rate ?? 0),
        });
    }
    return faults;
}

export function startStubHost(opts: StubOptions = {}) {
    const faults = parseFaults(opts.faults);
    const rand = rng(opts.seed ?? 7);
    // Each row is decayed to its own timestamp t: S <- S * d(dt) + new.
    const evidence = new Map<string, EvidenceRow & { t: number }>();
    const decay = (
        dt: number,
    ) => (opts.halfLifeMs ? 0.5 ** (dt / opts.halfLifeMs) : 1);
    const runs = new Map<string, Run>();
    let snapshot: Snapshot = buildSnapshot([], {
        version: 1,
        builtAt: new Date().toISOString(),
    });
    let seq = 0;

    const rebuild = () => {
        const now = Date.now();
        const rows = [...evidence.values()].map(({ t, ...row }) => ({
            ...row,
            s: row.s * decay(now - t),
            f: row.f * decay(now - t),
        }));
        snapshot = buildSnapshot(rows, {
            version: snapshot.version + 1,
            builtAt: new Date().toISOString(),
        });
    };
    const timer = setInterval(rebuild, opts.snapshotIntervalMs ?? 60_000);

    const addEvidence = (
        endpoint: string,
        aspect: EvidenceRow["aspect"],
        s: number,
        f: number,
    ) => {
        const key = `${endpoint}|${aspect}`;
        const now = Date.now();
        const prev = evidence.get(key) ??
            { endpoint, cluster: LEAF, aspect, s: 0, f: 0, t: now };
        const d = decay(now - prev.t);
        evidence.set(key, {
            ...prev,
            s: prev.s * d + s,
            f: prev.f * d + f,
            t: now,
        });
    };

    const json = (body: unknown, status = 200) =>
        Response.json(body, { status });
    const fail = (status: number, message: string) =>
        json({ error: { message } }, status);
    const find = (provider: string, endpoint: string) =>
        ENDPOINTS.find((e) =>
            e.id === `${provider}#${String(endpoint).replace(/^\/+/, "")}`
        );
    const result = (id: string) => {
        const [provider, endpoint] = id.split("#");
        return {
            provider,
            providerName: provider,
            endpoint,
            description: `${id} (stub)`,
            price: PRICE,
        };
    };

    const routes: Record<
        string,
        (req: Request, key: string, body: any) => Response
    > = {
        "POST /v1/discover": (req, key, body) => {
            const workspaceId = `ws:${key}`;
            const forced = req.headers.get("X-Monid-Arm");
            const arm: Arm = forced === "control" || forced === "treatment"
                ? forced
                : hash(workspaceId) % 2
                ? "treatment"
                : "control";
            const { ranked } = rerank(
                ENDPOINTS.map((e) => ({
                    endpoint: e.id,
                    baseScore: e.stubBaseScore,
                })),
                snapshot,
                {
                    workspaceId,
                    clusterId: LEAF,
                    limit: Number(body.limit ?? 10),
                    arm,
                },
            );
            const results = ranked.map((r) => {
                // n = evidence behind the cell (reliability trials, decayed), 0 when there is none.
                const { cell } = lookup(snapshot, r.endpoint, LEAF);
                const n = cell
                    ? cell.reliability.alpha + cell.reliability.beta -
                        snapshot.params.k
                    : 0;
                return {
                    ...result(r.endpoint),
                    score: r.finalScore,
                    tags: [LEAF],
                    ...(!opts.omitQuality &&
                        {
                            quality: {
                                term: r.term,
                                n: Math.round(n * 10) / 10,
                            },
                        }),
                };
            });
            return json({
                results,
                query: body.query,
                count: results.length,
                discoverId: `dsc_${++seq}`,
                clusterId: LEAF,
                arm,
                snapshotVersion: snapshot.version,
            });
        },
        "POST /v1/inspect": (_req, _key, body) => {
            const e = find(body.provider, body.endpoint);
            return e
                ? json({ id: e.id, ...result(e.id), input: {} })
                : fail(404, "unknown endpoint");
        },
        "POST /v1/run": (_req, _key, body) => {
            const e = find(body.provider, body.endpoint);
            if (!e) return fail(404, "unknown endpoint");
            const fault = faults.get(e.id) ?? { errorRate: 0, emptyRate: 0 };
            const u = rand();
            const failed = u < fault.errorRate;
            const empty = !failed && u < fault.errorRate + fault.emptyRate;
            // Implicit signals (README): every run is one reliability trial; a clean
            // success is also a weak (0.05) quality positive, an empty result a quality negative.
            addEvidence(e.id, "reliability", failed ? 0 : 1, failed ? 1 : 0);
            if (empty) addEvidence(e.id, "quality", 0, 1);
            else if (!failed) addEvidence(e.id, "quality", 0.05, 0);

            const n = ++seq;
            const final = failed ? "FAILED" : "COMPLETED";
            const run: Run = {
                runId: `run_${n}`,
                ...result(e.id),
                status: n % 3 === 0 ? "RUNNING" : final, // every 3rd run makes the agent poll
                final,
                output: failed ? undefined : {
                    articles: empty
                        ? []
                        : [{ title: "Synthetic headline", source: "stub" }],
                },
                error: failed
                    ? { source: "provider", message: "injected fault (stub)" }
                    : undefined,
                createdAt: new Date().toISOString(),
            };
            runs.set(run.runId, run);
            const { final: _, output, ...wire } = run;
            return json({
                ...wire,
                providerResponse: run.status === "RUNNING"
                    ? undefined
                    : { httpStatus: failed ? 502 : 200, data: output },
            });
        },
        "POST /v1/feedback": (_req, _key, body) => {
            const run = runs.get(body.runId);
            if (!run) {
                return fail(422, "runId is required and must be a known run");
            }
            if (!Number.isInteger(body.rating) || Math.abs(body.rating) > 2) {
                return fail(422, "rating must be -2..2");
            }
            const aspect =
                (body.aspects ?? []).some((a: string) =>
                        a === "reliability" || a === "latency"
                    )
                    ? "reliability"
                    : "quality";
            const s = (body.rating + 2) / 4;
            addEvidence(`${run.provider}#${run.endpoint}`, aspect, s, 1 - s);
            return json({ feedbackId: `fb_${++seq}`, status: "queued" }, 202);
        },
        "POST /v1/admin/snapshot": () => {
            rebuild();
            return json({ snapshotVersion: snapshot.version });
        },
        "POST /v1/admin/faults": (_req, _key, body) => {
            faults.set(body.target, {
                errorRate: Number(body.error_rate ?? 0),
                emptyRate: Number(body.empty_rate ?? 0),
            });
            return json({ faults: Object.fromEntries(faults) });
        },
    };

    const server = Deno.serve({
        hostname: opts.hostname ?? "127.0.0.1",
        port: opts.port ?? 0,
        onListen: () => {},
    }, async (req) => {
        const url = new URL(req.url);
        const key = req.headers.get("Authorization")?.match(/^Bearer (.+)$/)
            ?.[1];
        if (!key) return fail(401, "missing bearer token");
        if (
            url.pathname.startsWith("/v1/admin/") && opts.adminKey &&
            key !== opts.adminKey
        ) return fail(403, "admin only");
        const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
        if (req.method === "GET" && runMatch) {
            const run = runs.get(decodeURIComponent(runMatch[1]));
            if (!run) return fail(404, "unknown run");
            run.status = run.final; // one poll later it's done
            const { final: _, ...wire } = run;
            return json(wire);
        }
        const route = routes[`${req.method} ${url.pathname}`];
        return route
            ? route(req, key, await req.json().catch(() => ({})))
            : fail(404, "no such route");
    });

    return {
        url: `http://${server.addr.hostname}:${server.addr.port}`,
        async close() {
            clearInterval(timer);
            await server.shutdown();
        },
    };
}

if (import.meta.main) {
    const host = startStubHost({
        hostname: Deno.env.get("HOST"),
        port: Number(Deno.env.get("PORT") ?? 8787),
        snapshotIntervalMs: Number(
            Deno.env.get("MONID_SNAPSHOT_INTERVAL_MS") ?? 60_000,
        ),
        faults: Deno.env.get("MONID_FAKE_FAULTS"),
        adminKey: Deno.env.get("MONID_ADMIN_KEY"),
        halfLifeMs: Number(Deno.env.get("MONID_DECAY_HALF_LIFE_MS") ?? 0),
    });
    console.log(`TEST-ONLY monid stub host on ${host.url}`);
}
