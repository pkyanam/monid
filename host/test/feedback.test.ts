import {
    assert,
    assertAlmostEquals,
    assertEquals,
    assertExists,
} from "@std/assert";
import { allRows, type Db, exec, getRow } from "../store/db.ts";
import { readEvidence, readFlags } from "../mod.ts";
import { ALPHA, BETA, call, makeHost, runSearch } from "./helpers.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WINDOW = 120_000; // testConfig().retryWindowMs

type SignalRow = {
    kind: string;
    endpoint_id: string;
    cluster_id: string;
    aspect: string;
    value: number;
    weight: number;
};
const signals = (db: Db, kind: string) =>
    allRows<SignalRow>(
        db,
        `SELECT kind, endpoint_id, cluster_id, aspect, value, weight FROM signals WHERE kind = ? ORDER BY rowid`,
        kind,
    );

Deno.test("host feedback: 202 queued, stored, readable; validation errors", async () => {
    const host = await makeHost();
    try {
        const run = await runSearch(host);
        const fb = await call(host, "POST", "/v1/feedback", {
            runId: run.body.runId,
            rating: -1,
            aspects: ["correctness"],
            severity: "medium",
            text: "stale results",
            expected: "2026",
            observed: "2025",
        });
        assertEquals(fb.status, 202);
        assertEquals(Object.keys(fb.body).sort(), ["feedbackId", "status"]);
        assertEquals(fb.body.status, "queued");
        assert(fb.body.feedbackId.startsWith("fb_"));
        const got = await call(
            host,
            "GET",
            `/v1/feedback/${fb.body.feedbackId}`,
        );
        assertEquals(got.status, 200);
        assertEquals(got.body.endpointId, "tinyfish#search");
        assertEquals(
            (await call(
                host,
                "GET",
                `/v1/feedback/${fb.body.feedbackId}`,
                undefined,
                { key: BETA },
            )).status,
            404,
        );

        const bad = async (body: unknown, status = 400) =>
            assertEquals(
                (await call(host, "POST", "/v1/feedback", body)).status,
                status,
                JSON.stringify(body),
            );
        await bad({});
        await bad({ rating: 3, runId: run.body.runId });
        await bad({ rating: 1.5, runId: run.body.runId });
        await bad({ rating: 1, runId: run.body.runId, aspects: ["vibes"] });
        await bad({ rating: 1, runId: run.body.runId, text: "x".repeat(4001) });
        await bad({ rating: 1, target: "elsewhere", runId: run.body.runId });
        await bad({ rating: 1 }); // endpoint feedback needs a runId or an endpoint
        await bad({ rating: 1, runId: "run_nope" }, 404);
        await bad({ rating: 1, endpoint: "nope#nope" }, 404);
        await bad({
            rating: 1,
            runId: run.body.runId,
            endpoint: "octen#search",
        }); // must agree with the run
        assertEquals(
            (await call(host, "POST", "/v1/feedback", {
                rating: 1,
                runId: run.body.runId,
            }, { key: BETA })).status,
            404,
        );
        assertEquals(
            (await call(host, "POST", "/v1/feedback", {
                rating: -1,
                target: "platform",
                text: "slow",
            })).status,
            202,
        );
    } finally {
        await host.close();
    }
});

Deno.test("host feedback: endpoint without runId (id or provider+path) is stored, unscored", async () => {
    const host = await makeHost();
    try {
        const a = await call(host, "POST", "/v1/feedback", {
            rating: 2,
            endpoint: "tinyfish#search",
        });
        assertEquals(a.status, 202);
        const b = await call(host, "POST", "/v1/feedback", {
            rating: 2,
            provider: "tinyfish",
            endpoint: "/search",
        });
        assertEquals(b.status, 202);
        assertEquals(
            (await call(host, "GET", `/v1/feedback/${b.body.feedbackId}`)).body
                .endpointId,
            "tinyfish#search",
        );
        host.worker.tick();
        assertEquals(signals(host.db, "feedback").length, 0);
        const [{ n }] = allRows<{ n: number }>(
            host.db,
            `SELECT COUNT(*) AS n FROM feedback WHERE processed_at IS NOT NULL`,
        );
        assertEquals(n, 2);
    } finally {
        await host.close();
    }
});

Deno.test("host feedback: idempotency key and 60/min/key rate limit", async () => {
    const host = await makeHost();
    try {
        const body = { rating: 1, target: "platform" };
        const h = { headers: { "idempotency-key": "abc" } };
        const first = await call(host, "POST", "/v1/feedback", body, h);
        const again = await call(host, "POST", "/v1/feedback", body, h);
        assertEquals(again.body.feedbackId, first.body.feedbackId);
        const beta = await call(host, "POST", "/v1/feedback", body, {
            ...h,
            key: BETA,
        });
        assert(beta.body.feedbackId !== first.body.feedbackId);

        for (let i = 2; i < 60; i++) {
            assertEquals(
                (await call(host, "POST", "/v1/feedback", body)).status,
                202,
                `call ${i + 1}`,
            );
        }
        const limited = await call(host, "POST", "/v1/feedback", body);
        assertEquals(limited.status, 429);
        assertExists(limited.headers.get("retry-after"));
        assertEquals(
            (await call(host, "POST", "/v1/feedback", body, { key: BETA }))
                .status,
            202,
        );
        host.clock.advance(MIN + 1);
        assertEquals(
            (await call(host, "POST", "/v1/feedback", body)).status,
            202,
        );
    } finally {
        await host.close();
    }
});

Deno.test("host worker: run outcomes + explicit feedback → aggregates → EvidenceRow", async () => {
    const host = await makeHost({ profiles: {} });
    try {
        const ok = await runSearch(host);
        host.transports.setProfiles!({ "tinyfish#search": { errorRate: 1 } });
        await runSearch(host);
        await call(host, "POST", "/v1/run", {
            provider: "tinyfish",
            endpoint: "/search",
            input: { queryParams: {} },
        });
        await call(host, "POST", "/v1/feedback", {
            runId: ok.body.runId,
            rating: 2,
            aspects: ["correctness"],
        });

        const stats = host.worker.tick();
        assertEquals(stats.feedback, 1);
        assertEquals(stats.runs, 3);
        const outcomes = signals(host.db, "run_outcome");
        assertEquals(outcomes.map((s) => s.value), [1, 0]); // INVALID_INPUT is the caller's fault
        assertEquals(outcomes[0].cluster_id, "web-search");
        const explicit = signals(host.db, "feedback");
        assertEquals(explicit.length, 1);
        assertEquals(explicit[0].aspect, "quality");
        assertEquals(explicit[0].value, 1);

        const again = host.worker.tick();
        assertEquals(again.runs + again.feedback, 0); // idempotent

        const ev = readEvidence(host.db, host.clock());
        assertEquals(ev.find((e) => e.aspect === "reliability"), {
            endpoint: "tinyfish#search",
            cluster: "web-search",
            aspect: "reliability",
            s: 1,
            f: 1,
        });
        assertAlmostEquals(ev.find((e) => e.aspect === "quality")!.s, 1);

        host.clock.advance(3 * DAY); // implicit half-life
        const later = readEvidence(host.db, host.clock()).find((e) =>
            e.aspect === "reliability"
        )!;
        assertAlmostEquals(later.s, 0.5, 1e-6);
    } finally {
        await host.close();
    }
});

Deno.test("host worker: contract violations and empty results are implicit negatives", async () => {
    const host = await makeHost({
        profiles: { "tinyfish#search": { emptyRate: 1 } },
    });
    try {
        await runSearch(host);
        const now = host.clock();
        exec(
            host.db,
            `INSERT INTO runs (id, workspace_id, api_key_id, endpoint_id, provider, endpoint, cluster_id,
                status, error_code, is_provider_error, is_empty, created_at, started_at, completed_at)
             VALUES ('run_cv', 'ws_alpha', 'key_1', 'tinyfish#search', 'tinyfish', '/search', 'web-search',
                'FAILED', 'CONTRACT_VIOLATION', 0, 0, ?, ?, ?)`,
            now,
            now,
            now,
        );
        host.worker.tick();
        const empty = signals(host.db, "empty_result");
        assertEquals(empty.length, 1);
        assertEquals(empty[0].aspect, "quality");
        assertEquals(empty[0].weight, 1);
        const cv = signals(host.db, "contract_violation");
        assertEquals(cv.length, 1);
        assertEquals(cv[0].value, 0);
    } finally {
        await host.close();
    }
});

Deno.test("host worker: severe report → provisional flag; second workspace → confirmed; expiry", async () => {
    const host = await makeHost();
    try {
        const a = await runSearch(host, {}, ALPHA);
        const b = await runSearch(host, {}, BETA);
        const severe = {
            rating: -2,
            severity: "critical",
            aspects: ["reliability"],
            text: "useless",
        };
        await call(host, "POST", "/v1/feedback", {
            ...severe,
            runId: a.body.runId,
        }, { key: ALPHA });
        assertEquals(host.worker.fastLane(), 1);
        const state = () =>
            getRow<{ state: string; multiplier: number }>(
                host.db,
                `SELECT state, multiplier FROM endpoint_flags`,
            );
        assertEquals(state()?.state, "provisional");
        assertEquals(readFlags(host.db, host.clock()), {
            "tinyfish#search": 0.5,
        });

        await call(host, "POST", "/v1/feedback", {
            ...severe,
            runId: a.body.runId,
        }, { key: ALPHA });
        host.worker.fastLane();
        assertEquals(state()?.state, "provisional"); // same workspace twice ≠ corroboration

        await call(host, "POST", "/v1/feedback", {
            ...severe,
            runId: b.body.runId,
        }, { key: BETA });
        host.worker.fastLane();
        assertEquals(state()?.state, "confirmed");
        assertEquals(readFlags(host.db, host.clock()), {
            "tinyfish#search": 0.2,
        });

        host.clock.advance(DAY + 1);
        assertEquals(readFlags(host.db, host.clock()), {});

        await call(host, "POST", "/v1/feedback", {
            ...severe,
            severity: "low",
            runId: a.body.runId,
        });
        await call(host, "POST", "/v1/feedback", {
            ...severe,
            endpoint: "tinyfish#search",
        });
        assertEquals(host.worker.fastLane(), 0);
        host.worker.tick();
        assertEquals(readFlags(host.db, host.clock()), {});
    } finally {
        await host.close();
    }
});

Deno.test("host worker: a severe report corroborated by live failures confirms at once", async () => {
    const host = await makeHost({
        profiles: { "tinyfish#search": { errorRate: 1 } },
    });
    try {
        let last = await runSearch(host);
        for (let i = 0; i < 2; i++) last = await runSearch(host);
        await call(host, "POST", "/v1/feedback", {
            runId: last.body.runId,
            rating: -2,
            severity: "high",
            aspects: ["reliability"],
        });
        host.worker.fastLane();
        assertEquals(readFlags(host.db, host.clock()), {
            "tinyfish#search": 0.2,
        });
    } finally {
        await host.close();
    }
});

Deno.test("host worker: retry-elsewhere only after a failed/empty run or a shared discoverId", async () => {
    const host = await makeHost({
        profiles: { "tinyfish#search": { errorRate: 1 } },
    });
    try {
        const cluster = host.catalog.primaryCategory("tinyfish#search");
        const sibling = host.catalog.entries.find((e) =>
            e.id !== "tinyfish#search" && e.categories[0] === cluster
        )!;
        assertExists(sibling);
        const runSibling = (extra: Record<string, unknown> = {}) =>
            call(host, "POST", "/v1/run", {
                provider: sibling.provider,
                endpoint: sibling.endpoint,
                input: {},
                ...extra,
            });
        const retriesOnTf = () =>
            signals(host.db, "retry_elsewhere").filter((s) =>
                s.endpoint_id === "tinyfish#search"
            );

        // 1. failed run, then a different endpoint in the same cluster
        await runSearch(host);
        host.clock.advance(30_000);
        await runSibling();
        host.clock.advance(WINDOW + 1);
        host.worker.tick();
        assertEquals(retriesOnTf().length, 1);
        assertEquals(retriesOnTf()[0].weight, 0.5);
        assertEquals(retriesOnTf()[0].aspect, "quality");

        // 2. success, then a different endpoint, no discoverId: not a retry; one +0.05 per window
        host.transports.setProfiles!({});
        host.clock.advance(10 * WINDOW);
        await runSearch(host);
        await runSearch(host);
        host.clock.advance(1000);
        await runSibling();
        host.clock.advance(WINDOW + 5000);
        host.worker.tick();
        assertEquals(retriesOnTf().length, 1);
        const wins = signals(host.db, "success_no_retry").filter((s) =>
            s.endpoint_id === "tinyfish#search"
        );
        assertEquals(wins.length, 1);
        assertEquals(wins[0].weight, 0.05);

        // 3. success, but a discoverId links it to the next pick
        host.clock.advance(10 * WINDOW);
        const d = await call(host, "POST", "/v1/discover", {
            query: "live web news search results",
            limit: 50,
        });
        await runSearch(host, { discoverId: d.body.discoverId });
        host.clock.advance(1000);
        await runSibling({ discoverId: d.body.discoverId });
        host.clock.advance(WINDOW + 5000);
        host.worker.tick();
        assertEquals(retriesOnTf().length, 2);

        // 4. a later run outside the window never counts
        host.transports.setProfiles!({ "tinyfish#search": { errorRate: 1 } });
        host.clock.advance(10 * WINDOW);
        await runSearch(host);
        host.clock.advance(WINDOW + 5000);
        await runSibling();
        host.worker.tick();
        assertEquals(retriesOnTf().length, 2);
    } finally {
        await host.close();
    }
});

Deno.test("host feedback: DELETE removes the workspace's feedback and its ranking effect", async () => {
    const host = await makeHost();
    try {
        const a = await runSearch(host, {}, ALPHA);
        const b = await runSearch(host, {}, BETA);
        await call(host, "POST", "/v1/feedback", {
            runId: a.body.runId,
            rating: -2,
            aspects: ["correctness"],
        }, { key: ALPHA });
        await call(host, "POST", "/v1/feedback", {
            runId: b.body.runId,
            rating: 2,
            aspects: ["correctness"],
        }, { key: BETA });
        host.worker.tick();
        const quality = () =>
            readEvidence(host.db, host.clock()).find((e) =>
                e.aspect === "quality"
            )!;
        assertAlmostEquals(quality().f, 1);
        const del = await call(host, "DELETE", "/v1/feedback", undefined, {
            key: ALPHA,
        });
        assertEquals(del.status, 200);
        assertEquals(del.body.deleted, 1);
        assertAlmostEquals(quality().f, 0);
        assertAlmostEquals(quality().s, 1);
        assertEquals(allRows(host.db, `SELECT id FROM feedback`).length, 1);
    } finally {
        await host.close();
    }
});

Deno.test("host feedback: DELETE withdraws the workspace's severe-flag reports", async () => {
    const host = await makeHost();
    try {
        const a = await runSearch(host, {}, ALPHA);
        const b = await runSearch(host, {}, BETA);
        const severe = {
            rating: -2,
            severity: "critical",
            aspects: ["reliability"],
            text: "useless",
        };
        await call(host, "POST", "/v1/feedback", {
            ...severe,
            runId: a.body.runId,
        }, { key: ALPHA });
        await call(host, "POST", "/v1/feedback", {
            ...severe,
            runId: b.body.runId,
        }, { key: BETA });
        host.worker.fastLane();
        assertEquals(readFlags(host.db, host.clock()), {
            "tinyfish#search": 0.2,
        });

        // one reporter left → back to provisional
        await call(host, "DELETE", "/v1/feedback", undefined, { key: BETA });
        assertEquals(readFlags(host.db, host.clock()), {
            "tinyfish#search": 0.5,
        });
        // no reporters left → flag gone
        await call(host, "DELETE", "/v1/feedback", undefined, { key: ALPHA });
        assertEquals(readFlags(host.db, host.clock()), {});
        assertEquals(
            allRows(host.db, `SELECT * FROM endpoint_flags`).length,
            0,
        );
    } finally {
        await host.close();
    }
});

Deno.test("host worker: free text is redacted after the retention period", async () => {
    const host = await makeHost();
    try {
        const run = await runSearch(host);
        const fb = await call(host, "POST", "/v1/feedback", {
            runId: run.body.runId,
            rating: -1,
            text: "details",
            expected: "x",
            observed: "y",
        });
        host.worker.tick();
        host.clock.advance(89 * DAY);
        assertEquals(host.worker.tick().redacted, 0);
        host.clock.advance(2 * DAY);
        assertEquals(host.worker.tick().redacted, 1);
        const row = getRow<Record<string, unknown>>(
            host.db,
            `SELECT text, expected, observed, rating FROM feedback WHERE id = ?`,
            fb.body.feedbackId,
        );
        assertEquals({ ...row }, {
            text: null,
            expected: null,
            observed: null,
            rating: -1,
        });
    } finally {
        await host.close();
    }
});
