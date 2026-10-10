import { assert, assertEquals, assertThrows } from "@std/assert";
import { Bm25Index, normalizeScore, tokenize } from "../discover/bm25.ts";
import { HealthTracker } from "../health/tracker.ts";
import { isEmptyOutput } from "../runs/empty.ts";
import { classify } from "../feedback/classify.ts";
import { RateLimiter } from "../feedback/ratelimit.ts";
import { decay } from "../feedback/aggregates.ts";
import { assignArm, percentile } from "../util.ts";
import { parseApiKeys } from "../config.ts";
import { Catalog, priceOf } from "../catalog/catalog.ts";
import { emptyArrays } from "../transport/factory.ts";
import { sharedBundle } from "./helpers.ts";

Deno.test("host bm25: tokenize drops stopwords and stems plurals", () => {
    const t = tokenize("Search the Web for Companies");
    assert(!t.includes("the"));
    assert(!t.includes("search")); // generic catalog word, a stopword here
    assert(t.includes("web"));
    assert(t.some((w) => w.startsWith("compan")));
});

Deno.test("host bm25: weighted fields rank the title match first", () => {
    const index = new Bm25Index([
        {
            id: "a",
            fields: [{ text: "weather forecast", weight: 3 }, {
                text: "maps",
                weight: 1,
            }],
        },
        {
            id: "b",
            fields: [{ text: "maps", weight: 3 }, {
                text: "weather mentioned once",
                weight: 1,
            }],
        },
        { id: "c", fields: [{ text: "stock prices", weight: 3 }] },
    ]);
    const hits = index.search("weather", 10);
    assertEquals(hits.map((h) => h.id), ["a", "b"]);
    assert(hits[0].score > hits[1].score);
    assertEquals(index.search("nothing matches this", 10), []);
});

Deno.test("host bm25: normalizeScore is monotone in [0,1)", () => {
    assertEquals(normalizeScore(0), 0);
    assert(normalizeScore(4) < normalizeScore(8));
    assertEquals(normalizeScore(8), 0.5);
    assert(normalizeScore(1e3) < 1);
});

Deno.test("host health: unknown → outage → degraded → healthy, with p50/p95", () => {
    const h = new HealthTracker();
    const now = 1_000_000_000;
    assertEquals(h.metrics("x#y", now), undefined);
    h.record("x#y", { ts: now - 1000, ok: true, ms: 100 });
    assertEquals(h.metrics("x#y", now)?.status, "unknown");
    for (let i = 0; i < 4; i++) {
        h.record("x#y", { ts: now - 900 + i, ok: false });
    }
    assertEquals(h.metrics("x#y", now)?.status, "outage"); // 4/5 fresh failures
    for (let i = 0; i < 6; i++) {
        h.record("x#y", { ts: now - 500 + i, ok: true, ms: 100 + i * 100 });
    }
    // 4/11 fresh → degraded
    assertEquals(h.metrics("x#y", now)?.status, "degraded");
    for (let i = 0; i < 10; i++) {
        h.record("x#y", { ts: now - 100 + i, ok: true, ms: 200 });
    }
    const m = h.metrics("x#y", now)!;
    assertEquals(m.status, "healthy");
    assert(m.runTimeMs?.p50 !== undefined && m.runTimeMs?.p95 !== undefined);
    assert(m.runTimeMs.p95! >= m.runTimeMs.p50!);
    // everything aged out of the fresh window: 21 runs in 24h, 4 failures → stable
    assertEquals(h.metrics("x#y", now + 30 * 60_000)?.status, "stable");
    assertEquals(h.freshFailureRate("x#y", now + 30 * 60_000), undefined);
});

Deno.test("host health: percentile", () => {
    assertEquals(percentile([], 50), undefined);
    assertEquals(percentile([1, 2, 3, 4], 50), 2);
    assertEquals(percentile([1, 2, 3, 4], 100), 4);
});

Deno.test("host empty: heuristic", () => {
    assert(isEmptyOutput(null));
    assert(isEmptyOutput([]));
    assert(isEmptyOutput({}));
    assert(isEmptyOutput({ results: [], total: 0, page: 1 }));
    assert(!isEmptyOutput({ results: [{ a: 1 }] }));
    assert(!isEmptyOutput({ answer: "42" }));
    assert(isEmptyOutput({ query: "echo", total_results: 5, results: [] }));
    assert(!isEmptyOutput({ query: "echo", results: [{ a: 1 }] }));
    assertEquals(emptyArrays({ a: [1], b: { c: [2] }, d: "x" }), {
        a: [],
        b: { c: [] },
        d: "x",
    });
});

Deno.test("host classify: rating maps to [0,1]; aspects map to reliability|quality", () => {
    const bad = classify({ rating: -2, aspects: ["reliability"] });
    assertEquals(bad.value, 0);
    assertEquals(bad.aspects, ["reliability"]);
    const good = classify({ rating: 2, aspects: ["correctness"] });
    assertEquals(good.value, 1);
    assertEquals(good.aspects, ["quality"]);
    assertEquals(classify({ rating: 0 }).value, 0.5);
    // latency/cost are live metrics, never scored from feedback
    assert(
        !classify({ rating: -1, aspects: ["latency", "cost"] }).aspects.some((
            a,
        ) => a !== "reliability" && a !== "quality"),
    );
});

Deno.test("host ratelimit: sliding minute", () => {
    const r = new RateLimiter(2);
    assertEquals(r.take("k", 0), 0);
    assertEquals(r.take("k", 1), 0);
    assert(r.take("k", 2) > 0);
    assertEquals(r.take("other", 2), 0);
    assertEquals(r.take("k", 60_001), 0);
});

Deno.test("host util: decay and arm assignment", () => {
    assertEquals(decay(0, 10), 1);
    assertEquals(decay(10, 10), 0.5);
    assertEquals(assignArm("ws", "v1", 0), "treatment");
    assertEquals(assignArm("ws", "v1", 100), "control");
    assertEquals(assignArm("ws", "v1", 10), assignArm("ws", "v1", 10));
});

Deno.test("host config: API keys must be in CLI format", () => {
    const m = parseApiKeys(
        "monid_local_a:ws_a,monid_local_b:ws_b",
        "monid_local_c",
        undefined,
    );
    assertEquals(m.get("monid_local_a")?.workspaceId, "ws_a");
    assertEquals(m.get("monid_local_c")?.workspaceId, "ws_local");
    assertThrows(() => parseApiKeys(undefined, "not-a-key", undefined));
});

Deno.test("host catalog: resolve, categories, wire price", async () => {
    const catalog = new Catalog(await sharedBundle());
    const entry = catalog.resolve("tinyfish", "/search");
    assertEquals(entry?.id, "tinyfish#search");
    assertEquals(catalog.resolve("tinyfish", "search")?.id, "tinyfish#search");
    assertEquals(catalog.get("tinyfish#search")?.id, "tinyfish#search");
    assertEquals(catalog.primaryCategory("tinyfish#search"), "web-search");
    const price = priceOf(entry!.doc);
    assertEquals(price.type, "PER_CALL");
    assertEquals(price.amount.value, 0);
    assert(price.notes?.[0].includes("not Monid's brokered price"));
    for (const e of catalog.entries) {
        const p = priceOf(e.doc);
        assert(["PER_CALL", "PER_RESULT", "METERED"].includes(p.type), e.id);
        assert(Number.isFinite(p.amount.value), e.id);
    }
});
