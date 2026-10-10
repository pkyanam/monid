import {
    assert,
    assertAlmostEquals,
    assertEquals,
    assertStrictEquals,
} from "@std/assert";
import {
    type Candidate,
    FEEDBACK_CAP,
    policy,
    propensity,
    rerank,
    type RerankContext,
} from "./rerank.ts";
import { buildSnapshot, type EvidenceRow } from "./snapshot.ts";

const both = (endpoint: string, s: number, f: number): EvidenceRow[] => [
    { endpoint, cluster: "news", aspect: "reliability", s, f },
    { endpoint, cluster: "news", aspect: "quality", s, f },
];

// Ten ordinary endpoints at ~70% success plus a few special cases.
const rows: EvidenceRow[] = [
    ...Array.from({ length: 10 }, (_, i) => both(`ok${i}`, 70, 30)).flat(),
    ...both("hero", 1e6, 0),
    ...both("zero", 0, 1e6),
    ...both("thin", 2, 0),
    ...both("dense", 200, 0),
];
const base = buildSnapshot(rows, {
    version: 1,
    builtAt: "2026-10-10T00:00:00Z",
});
// Re-versioning only changes the seed, so tests can reuse one build.
const snap = (version = 1, flags: Record<string, number> = {}) => ({
    ...base,
    version,
    flags,
});
const ctx: RerankContext = { workspaceId: "ws1", clusterId: "news", limit: 5 };
const cands = (...endpoints: string[]): Candidate[] =>
    endpoints.map((endpoint) => ({ endpoint, baseScore: 10 }));
const termOf = (endpoint: string) =>
    rerank(cands(endpoint), snap(), { ...ctx, epsilon: 0 }).ranked[0].term;

/** First snapshot version >= from whose seeded draw does / does not explore. */
function versionWhere(
    explored: boolean,
    candidates: Candidate[],
    c = ctx,
): number {
    for (let v = 1;; v++) {
        if (policy(candidates, snap(v), c).explored === explored) return v;
    }
}

Deno.test("feedback term is capped at +-15% for extreme cells", () => {
    assertEquals(termOf("hero"), FEEDBACK_CAP);
    assertEquals(termOf("zero"), -FEEDBACK_CAP);
    for (
        const item of rerank(cands("hero", "zero"), snap(), {
            ...ctx,
            epsilon: 0,
        }).ranked
    ) {
        const ratio = item.finalScore / item.baseScore;
        assert(ratio >= 1 - FEEDBACK_CAP && ratio <= 1 + FEEDBACK_CAP);
    }
});

Deno.test("health and flags apply outside the cap", () => {
    const [item] = rerank(
        [{ endpoint: "hero", baseScore: 10, health: 0.2 }],
        snap(1, { hero: 0.5 }),
        ctx,
    ).ranked;
    assertAlmostEquals(
        item.finalScore,
        10 * 0.2 * 0.5 * (1 + FEEDBACK_CAP),
        1e-12,
    );
});

Deno.test("thin cells move the score far less than dense ones; missing cells are neutral", () => {
    const thin = termOf("thin"), dense = termOf("dense");
    assert(thin > 0 && thin < dense / 2, `thin ${thin} vs dense ${dense}`);
    assertEquals(termOf("never-seen"), 0);
    assertEquals(
        rerank(cands("ok1"), snap(), { ...ctx, clusterId: "maps", epsilon: 0 })
            .ranked[0].term,
        0,
    );
});

Deno.test("control ranks by base * health * flag with no exploration", () => {
    const candidates: Candidate[] = [
        { endpoint: "zero", baseScore: 10 },
        { endpoint: "hero", baseScore: 9.5 },
        { endpoint: "ok1", baseScore: 9, health: 0.4 },
        { endpoint: "ok2", baseScore: 8 },
        { endpoint: "never-seen", baseScore: 1 },
    ];
    const control = { ...ctx, limit: 4, arm: "control" as const, epsilon: 1 };
    const r = rerank(candidates, snap(1, { ok2: 0.5 }), control);
    assertEquals(r.ranked.map((i) => i.endpoint), [
        "zero",
        "hero",
        "ok2",
        "ok1",
    ]); // 10, 9.5, 4, 3.6
    assertEquals(r.ranked.map((i) => i.term), [0, 0, 0, 0]);
    assertEquals(r.propensities, [1, 1, 1, 1]);
    assertStrictEquals(r.explorationSlot, null);
    // Treatment flips the top two.
    assertEquals(
        rerank(candidates, snap(1), { ...ctx, limit: 2, epsilon: 0 }).ranked[0]
            .endpoint,
        "hero",
    );
    // No snapshot loaded behaves like control.
    const noSnapshot = rerank(candidates, null, { ...ctx, limit: 4 });
    assertEquals(noSnapshot.ranked.map((i) => [i.endpoint, i.term]), [
        ["zero", 0],
        ["hero", 0],
        ["ok2", 0],
        ["ok1", 0],
    ]);
    assertEquals(noSnapshot.propensities, [1, 1, 1, 1]);
});

Deno.test("seeded determinism, and the exploration rate is about epsilon", () => {
    const candidates = cands(
        "ok0",
        "ok1",
        "ok2",
        "ok3",
        "ok4",
        "ok5",
        "never-seen",
    );
    assertEquals(
        rerank(candidates, snap(7), ctx),
        rerank(candidates, snap(7), ctx),
    );
    const decisions = (vary: (i: number) => [string, number]) =>
        Array.from({ length: 20_000 }, (_, i) => {
            const [workspaceId, version] = vary(i);
            return policy(candidates, snap(version), { ...ctx, workspaceId })
                .explored;
        });
    for (
        const d of [
            decisions((i) => ["ws1", i]),
            decisions((i) => [`ws${i}`, 1]),
        ]
    ) {
        assertAlmostEquals(d.filter(Boolean).length / d.length, 0.1, 0.01);
    }
});

Deno.test("exploration swaps the last slot for the widest eligible candidate", () => {
    const candidates: Candidate[] = [
        ...cands("ok0", "ok1", "ok2", "ok3", "ok4", "ok5", "dense", "thin"),
        { endpoint: "down", baseScore: 10, health: 0 }, // widest, but not eligible
        { endpoint: "new", baseScore: 1 }, // no cell: prior width, the widest eligible
    ];
    const r = rerank(candidates, snap(versionWhere(true, candidates)), ctx);
    const exploit =
        rerank(candidates, snap(versionWhere(false, candidates)), ctx).ranked;
    assertEquals(r.explorationSlot, {
        position: 4,
        endpoint: "new",
        replaced: exploit[4].endpoint,
    });
    assertEquals(r.ranked.slice(0, 4), exploit.slice(0, 4));
    assertEquals(r.propensities, [1, 1, 1, 1, 0.1]);
});

Deno.test("propensities: closed form, per-position sums, and empirical frequency", () => {
    const candidates = cands(
        "ok0",
        "ok1",
        "ok2",
        "ok3",
        "ok4",
        "ok5",
        "thin",
        "never-seen",
    );
    const c = { ...ctx, epsilon: 0.25 };
    assertEquals(
        rerank(candidates, snap(versionWhere(false, candidates, c)), c)
            .propensities,
        [1, 1, 1, 1, 0.75],
    );

    const p = policy(candidates, snap(1), c);
    for (let pos = 0; pos < c.limit; pos++) {
        const sum = candidates.reduce(
            (acc, { endpoint }) => acc + propensity(p, endpoint, pos),
            0,
        );
        assertAlmostEquals(sum, 1, 1e-12);
    }

    const counts = new Map<string, number>();
    const runs = 20_000;
    for (let v = 0; v < runs; v++) {
        const { ranked } = rerank(candidates, snap(v), c);
        counts.set(
            ranked[4].endpoint,
            (counts.get(ranked[4].endpoint) ?? 0) + 1,
        );
    }
    for (const [endpoint, n] of counts) {
        assertAlmostEquals(n / runs, propensity(p, endpoint, 4), 0.01);
    }
});

Deno.test("no eligible candidate to explore means propensity 1 everywhere", () => {
    const candidates = [...cands("ok0", "ok1"), {
        endpoint: "down",
        baseScore: 5,
        health: 0,
    }];
    const p = policy(candidates, snap(1), { ...ctx, limit: 2, epsilon: 1 });
    assertStrictEquals(p.explore, null);
    assertEquals(
        rerank(candidates, snap(1), { ...ctx, limit: 2, epsilon: 1 })
            .propensities,
        [1, 1],
    );
    assertEquals(rerank(candidates, snap(1), { ...ctx, limit: 0 }).ranked, []);
});

Deno.test("a high-volume failing endpoint doesn't become its cluster's norm", () => {
    // Implicit evidence is lopsided: a success adds 0.05, a failure adds 1.
    const lopsided = buildSnapshot([
        {
            endpoint: "bad",
            cluster: "news",
            aspect: "reliability",
            s: 0.05 * 20,
            f: 30,
        },
        ...["a", "b", "c", "d"].map((endpoint) => ({
            endpoint,
            cluster: "news",
            aspect: "reliability" as const,
            s: 0.05 * 30,
            f: 0,
        })),
    ], { version: 1, builtAt: "2026-10-10T00:00:00Z" });
    const term = (endpoint: string) =>
        rerank(cands(endpoint), lopsided, { ...ctx, epsilon: 0 }).ranked[0]
            .term;
    assert(term("bad") < -0.05, `bad ${term("bad")}`);
    assert(term("a") > 0, `a ${term("a")}`);
});
