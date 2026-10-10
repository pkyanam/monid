import { assert, assertEquals, assertExists } from "@std/assert";
import { allRows } from "../store/db.ts";
import { ALPHA, BETA, call, makeHost, runSearch } from "./helpers.ts";

Deno.test("host http: health, auth and CLI stubs", async () => {
    const host = await makeHost();
    try {
        const health = await call(host, "GET", "/healthz", undefined, {
            key: null,
        });
        assertEquals(health.status, 200);
        assert(health.body.endpoints > 500);

        const anon = await call(host, "POST", "/v1/discover", { query: "x" }, {
            key: null,
        });
        assertEquals(anon.status, 401);
        assertExists(anon.body.error.code);
        const wrong = await call(host, "POST", "/v1/discover", { query: "x" }, {
            key: "monid_test_nope",
        });
        assertEquals(wrong.status, 401);

        const who = await call(host, "GET", "/v1/auth/whoami");
        assertEquals(who.status, 200);
        assertEquals(who.body.workspace.workspaceId, "ws_alpha");
        assertEquals(
            (await call(host, "GET", "/v1/wallet/balance")).status,
            200,
        );
        const setup = await call(
            host,
            "POST",
            "/public/v1/telemetry/skill-setup",
            {},
            { key: null },
        );
        assertEquals(setup.status, 204);
        assertEquals((await call(host, "GET", "/v1/nope")).status, 404);
    } finally {
        await host.close();
    }
});

Deno.test("host http: discover returns wire results, discoverId, clusterId and logs an impression", async () => {
    const host = await makeHost();
    try {
        const res = await call(host, "POST", "/v1/discover", {
            query: "live web news search results",
            limit: 5,
        });
        assertEquals(res.status, 200);
        const b = res.body;
        assert(b.discoverId.startsWith("dsc_"));
        assertEquals(typeof b.clusterId, "string");
        assertEquals(b.count, b.results.length);
        assert(b.results.length > 0 && b.results.length <= 5);
        for (const r of b.results) {
            assertExists(r.provider);
            assert(r.endpoint.startsWith("/"));
            assertExists(r.price.type);
            assert(r.score >= 0 && r.score <= 1);
            assert(Array.isArray(r.tags));
        }
        const rows = allRows<
            {
                id: string;
                workspace_id: string;
                cluster_id: string;
                candidates_json: string;
            }
        >(
            host.db,
            `SELECT id, workspace_id, cluster_id, candidates_json FROM discover_impressions`,
        );
        assertEquals(rows.length, 1);
        assertEquals(rows[0].id, b.discoverId);
        assertEquals(rows[0].workspace_id, "ws_alpha");
        assertEquals(rows[0].cluster_id, b.clusterId);
        const cands = JSON.parse(rows[0].candidates_json);
        assert(cands.length >= b.results.length);
        for (const c of cands) assert(c.propensity > 0 && c.propensity <= 1);

        const bad = await call(host, "POST", "/v1/discover", { limit: 5 });
        assertEquals(bad.status, 400);
    } finally {
        await host.close();
    }
});

Deno.test("host http: inspect returns per-location input schema", async () => {
    const host = await makeHost();
    try {
        const res = await call(host, "POST", "/v1/inspect", {
            provider: "tinyfish",
            endpoint: "/search",
        });
        assertEquals(res.status, 200);
        assertEquals(res.body.provider, "tinyfish");
        assertEquals(res.body.endpoint, "/search");
        assertExists(res.body.input.queryParams);
        assertEquals(res.body.metrics, undefined); // no runs yet = no block
        const missing = await call(host, "POST", "/v1/inspect", {
            provider: "tinyfish",
            endpoint: "/nope",
        });
        assertEquals(missing.status, 404);
    } finally {
        await host.close();
    }
});

Deno.test("host http: fixture run through the real engine, then get/list", async () => {
    const host = await makeHost();
    try {
        const run = await runSearch(host);
        assertEquals(run.status, 200);
        assertEquals(run.body.status, "COMPLETED");
        assertEquals(run.body.providerResponse.httpStatus, 200);
        assert(run.body.runId.startsWith("run_"));

        const got = await call(host, "GET", `/v1/runs/${run.body.runId}`);
        assertEquals(got.status, 200);
        assertEquals(got.body.status, "COMPLETED");
        assertExists(got.body.output);
        assertEquals(got.body.input.queryParams.query, "deno sqlite");

        const list = await call(host, "GET", "/v1/runs");
        assertEquals(list.body.items.length, 1);
        // other workspace can't see it
        assertEquals(
            (await call(host, "GET", `/v1/runs/${run.body.runId}`, undefined, {
                key: BETA,
            })).status,
            404,
        );

        const invalid = await call(host, "POST", "/v1/run", {
            provider: "tinyfish",
            endpoint: "/search",
            input: { queryParams: {} },
        });
        assertEquals(invalid.body.status, "FAILED");
        assertEquals(invalid.body.error.source, "platform");
        assert(invalid.body.error.message.includes("INVALID_INPUT"));
        // caller faults don't touch health
        assertEquals(
            host.health.metrics("tinyfish#search", host.clock())?.status,
            "unknown",
        );
    } finally {
        await host.close();
    }
});

Deno.test("host http: run links discoverId and the discover cluster", async () => {
    const host = await makeHost();
    try {
        const d = await call(host, "POST", "/v1/discover", {
            query: "live web news search results",
        });
        const run = await runSearch(host, { discoverId: d.body.discoverId });
        assertEquals(run.body.discoverId, d.body.discoverId);
        const [row] = allRows<{ discover_id: string; cluster_id: string }>(
            host.db,
            `SELECT discover_id, cluster_id FROM runs`,
        );
        assertEquals(row.discover_id, d.body.discoverId);
        assertEquals(row.cluster_id, d.body.clusterId);
        // a discoverId from another workspace is rejected
        const foreign = await runSearch(
            host,
            { discoverId: d.body.discoverId },
            BETA,
        );
        assertEquals(foreign.body.status, "COMPLETED");
        assertEquals(foreign.body.discoverId, undefined);
    } finally {
        await host.close();
    }
});

Deno.test("host transport: fake profile errors surface as provider errors and drive health", async () => {
    const host = await makeHost({
        profiles: { "tinyfish#search": { errorRate: 1 } },
    });
    try {
        for (let i = 0; i < 3; i++) {
            const run = await runSearch(host);
            assertEquals(run.body.status, "FAILED");
            assertEquals(run.body.error.source, "provider");
            assertEquals(run.body.providerResponse.httpStatus, 503);
        }
        assertEquals(
            host.health.metrics("tinyfish#search", host.clock())?.status,
            "outage",
        );
        // outage endpoints drop out of discover unless asked for
        const q = { query: "live web news search results", limit: 50 };
        const d = await call(host, "POST", "/v1/discover", q);
        assert(
            !d.body.results.some((r: { provider: string; endpoint: string }) =>
                r.provider === "tinyfish" && r.endpoint === "/search"
            ),
        );
        const all = await call(host, "POST", "/v1/discover", {
            ...q,
            includeUnavailable: true,
        });
        const tf = all.body.results.find((
            r: { provider: string; endpoint: string },
        ) => r.provider === "tinyfish" && r.endpoint === "/search");
        assertEquals(tf?.metrics?.status, "outage");

        // admin can flip the profile at runtime
        assertEquals(
            (await call(host, "PUT", "/v1/_admin/fake-profiles", {}, {
                key: null,
                headers: { "x-admin-key": "wrong" },
            })).status,
            403,
        );
        const put = await call(host, "PUT", "/v1/_admin/fake-profiles", {
            "tinyfish#search": { garbageRate: 1 },
        }, {
            key: null,
            headers: { "x-admin-key": "admin-test" },
        });
        assertEquals(put.status, 200);
        // tinyfish#search declares no output.schema, so the engine can't tell
        // a wrong-shape 200 from a real one: it completes with junk (only the
        // 19 docs with output.schema turn this into CONTRACT_VIOLATION).
        const garbage = await runSearch(host);
        assertEquals(garbage.body.status, "COMPLETED");
        assertExists(garbage.body.providerResponse.data.html);

        await call(host, "PUT", "/v1/_admin/fake-profiles", {
            "tinyfish#search": { latencyMs: 40 },
        }, {
            key: null,
            headers: { "x-admin-key": "admin-test" },
        });
        for (let i = 0; i < 5; i++) {
            assertEquals((await runSearch(host)).body.status, "COMPLETED");
        }
        const m = host.health.metrics("tinyfish#search", host.clock());
        assertExists(m?.runTimeMs?.p50);
    } finally {
        await host.close();
    }
});

Deno.test("host transport: emptied output completes but is marked empty", async () => {
    const host = await makeHost({
        profiles: { "tinyfish#search": { emptyRate: 1 } },
    });
    try {
        const run = await runSearch(host);
        assertEquals(run.body.status, "COMPLETED");
        const [row] = allRows<{ is_empty: number }>(
            host.db,
            `SELECT is_empty FROM runs`,
        );
        assertEquals(row.is_empty, 1);
    } finally {
        await host.close();
    }
});

Deno.test("host http: workspaces are isolated by key", async () => {
    const host = await makeHost();
    try {
        await runSearch(host, {}, ALPHA);
        assertEquals(
            (await call(host, "GET", "/v1/runs", undefined, { key: BETA })).body
                .items.length,
            0,
        );
    } finally {
        await host.close();
    }
});
