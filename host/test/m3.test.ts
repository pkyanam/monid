import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { parseFakeFaults } from "../config.ts";
import { decay } from "../feedback/aggregates.ts";
import { getRow } from "../store/db.ts";
import { call, makeHost, runSearch } from "./helpers.ts";

const ADMIN = { key: null, headers: { authorization: "Bearer admin-test" } };
const NEWS = [
    "opoint#search",
    "search1api#news",
    "akta#v1/news",
    "octen#search",
    "tinyfish#search",
];

Deno.test("host m3: MONID_FAKE_FAULTS parsing", () => {
    assertEquals(
        parseFakeFaults(
            "opoint#search:error_rate=0.6,empty_rate=0.1; akta#v1/news:error_rate=1",
        ),
        {
            "opoint#search": { errorRate: 0.6, emptyRate: 0.1 },
            "akta#v1/news": { errorRate: 1 },
        },
    );
    assertEquals(parseFakeFaults(undefined), {});
    assertThrows(() => parseFakeFaults("x#y:nope=1"));
    assertThrows(() => parseFakeFaults("x#y:error_rate=abc"));
});

Deno.test("host m3: half-life 0 means no decay", () => {
    assertEquals(decay(1e12, 0), 1);
    assertEquals(decay(60_000, 60_000), 0.5);
});

Deno.test("host m3: admin faults + snapshot routes, arm header, quality on discover", async () => {
    const host = await makeHost({
        config: { discoverAllow: NEWS },
        profiles: {},
    });
    try {
        assertEquals(
            (await call(host, "POST", "/v1/admin/snapshot", {})).status,
            403,
        ); // a workspace key is not admin
        const bad = await call(host, "POST", "/v1/admin/faults", {
            target: "nope#x",
            error_rate: 1,
        }, ADMIN);
        assertEquals(bad.status, 404);
        const set = await call(host, "POST", "/v1/admin/faults", {
            target: "tinyfish#search",
            error_rate: 1,
        }, ADMIN);
        assertEquals(set.status, 200);
        assertEquals(set.body.faults["tinyfish#search"], { errorRate: 1 });
        assertEquals((await runSearch(host)).body.status, "FAILED");
        await call(host, "POST", "/v1/admin/faults", {
            target: "tinyfish#search",
            error_rate: 0,
        }, ADMIN);
        assertEquals((await runSearch(host)).body.status, "COMPLETED");

        const d0 = await call(host, "POST", "/v1/discover", {
            query: "latest news about Canva",
            limit: 5,
        }, {
            headers: { "x-monid-arm": "control" },
        });
        assertEquals(d0.body.arm, "control");
        assertEquals(d0.body.clusterId, "news-search");
        assertEquals(d0.body.snapshotVersion, 0);
        for (const r of d0.body.results) assertEquals(r.quality.term, 0);

        host.worker.tick();
        const snap = await call(host, "POST", "/v1/admin/snapshot", {}, ADMIN);
        assertEquals(snap.status, 200);
        assertEquals(snap.body.snapshotVersion, 1);
        const d1 = await call(host, "POST", "/v1/discover", {
            query: "latest news about Canva",
            limit: 5,
        }, {
            headers: { "x-monid-arm": "treatment" },
        });
        assertEquals(d1.body.arm, "treatment");
        assertEquals(d1.body.snapshotVersion, 1);
        const tf = d1.body.results.find((r: { provider: string }) =>
            r.provider === "tinyfish"
        );
        assertExists(tf.quality);
        // those runs carried no discoverId, so their evidence sits in
        // tinyfish's primary leaf (web-search), not this news-search ranking
        assertEquals(tf.quality, { term: 0, n: 0 });
    } finally {
        await host.close();
    }
});

Deno.test("host m3: treatment term goes negative for a failing endpoint; control stays at 0", async () => {
    const host = await makeHost({
        config: { discoverAllow: NEWS, healthIgnoreFaults: true },
        profiles: { "tinyfish#search": { errorRate: 1 } },
    });
    try {
        // runs linked to a news discover land in the news-search cell
        const d = await call(host, "POST", "/v1/discover", {
            query: "news articles about Nvidia earnings",
            limit: 5,
        });
        assertEquals(d.body.clusterId, "news-search");
        for (let i = 0; i < 20; i++) {
            await runSearch(host, { discoverId: d.body.discoverId });
        }
        host.worker.tick();
        host.snapshotBuilder.build();
        const term = async (arm: string) => {
            const d = await call(host, "POST", "/v1/discover", {
                query: "news articles about Nvidia earnings",
                limit: 5,
            }, {
                headers: { "x-monid-arm": arm },
            });
            return d.body.results.find((r: { provider: string }) =>
                r.provider === "tinyfish"
            )?.quality.term;
        };
        assert((await term("treatment")) < 0);
        assertEquals(await term("control"), 0);
        const stored = host.snapshotBuilder.published(1);
        assertEquals(stored?.version, 1);
    } finally {
        await host.close();
    }
});

Deno.test("host m3: MONID_HEALTH_IGNORE_FAULTS keeps injected faults out of health and severe flags", async () => {
    const host = await makeHost({
        config: { healthIgnoreFaults: true },
        profiles: { "tinyfish#search": { errorRate: 1 } },
    });
    try {
        let last = await runSearch(host);
        for (let i = 0; i < 4; i++) last = await runSearch(host);
        assertEquals(
            host.health.metrics("tinyfish#search", host.clock()),
            undefined,
        );
        const row = getRow<{ f: number }>(
            host.db,
            `SELECT fault_injected AS f FROM runs WHERE id = ?`,
            last.body.runId,
        );
        assertEquals(row?.f, 1);
        await call(host, "POST", "/v1/feedback", {
            runId: last.body.runId,
            rating: -2,
            severity: "critical",
            aspects: ["reliability"],
        });
        host.worker.fastLane();
        host.worker.tick();
        assertEquals(host.snapshotBuilder.build().flags, 0);
        // the explicit + implicit evidence is still there for the feedback term
        assert(
            getRow<{ n: number }>(host.db, `SELECT COUNT(*) AS n FROM signals`)!
                .n >= 6,
        );
    } finally {
        await host.close();
    }
});
