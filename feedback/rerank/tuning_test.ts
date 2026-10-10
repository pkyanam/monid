/**
 * Gain sweep behind the default `gain` (README, "Tuning"). A news-search
 * cluster with 5 endpoints (60% failures, 10% failures, three healthy) at
 * 50, 200 and 1000 runs each, implicit signals only, with the agreed weights:
 * every run is one reliability trial (s = 1 or f = 1) and a clean success also
 * adds 0.05 to quality.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { rerank } from "./rerank.ts";
import { buildSnapshot, type EvidenceRow } from "./snapshot.ts";

const GAINS = [0.5, 0.6, 0.75, 1.0];
const VOLUMES = [50, 200, 1000];

function evidence(runs: number): EvidenceRow[] {
    const endpoints: [string, number][] = [
        ["fail60", 0.6],
        ["fail10", 0.1],
        ["ok1", 0],
        ["ok2", 0],
        ["ok3", 0],
    ];
    return endpoints.flatMap(([endpoint, failRate]) => {
        const ok = runs * (1 - failRate);
        return [
            {
                endpoint,
                cluster: "news-search",
                aspect: "reliability",
                s: ok,
                f: runs - ok,
            },
            {
                endpoint,
                cluster: "news-search",
                aspect: "quality",
                s: 0.05 * ok,
                f: 0,
            },
        ];
    });
}

function terms(runs: number, gain?: number) {
    const snapshot = buildSnapshot(evidence(runs), {
        version: 1,
        builtAt: "2026-10-10T00:00:00Z",
        gain,
    });
    const term = (endpoint: string) =>
        rerank([{ endpoint, baseScore: 1 }], snapshot, {
            workspaceId: "ws",
            clusterId: "news-search",
            limit: 1,
            epsilon: 0,
        }).ranked[0].term;
    return [term("fail60"), term("fail10"), term("ok1")];
}

/** (a) 60% failures in [-0.15, -0.10]; (b) 10% failures >= -0.03; (c) healthy below the +0.15 cap. */
const meets = ([a, b, c]: number[]) =>
    a >= -0.15 && a <= -0.10 && b >= -0.03 && c < 0.15;

// TABLE[gain][volume] = [(a), (b), (c)]
const TABLE: Record<number, Record<number, number[]>> = {
    0.5: {
        50: [-0.0967, 0.0647, 0.1039],
        200: [-0.1012, 0.0776, 0.1187],
        1000: [-0.0995, 0.0787, 0.1173],
    },
    0.6: {
        50: [-0.1161, 0.0776, 0.1246],
        200: [-0.1214, 0.0931, 0.1425],
        1000: [-0.1194, 0.0945, 0.1408],
    },
    0.75: {
        50: [-0.1451, 0.0970, 0.15],
        200: [-0.15, 0.1164, 0.15],
        1000: [-0.1492, 0.1181, 0.15],
    },
    1.0: {
        50: [-0.15, 0.1293, 0.15],
        200: [-0.15, 0.15, 0.15],
        1000: [-0.15, 0.15, 0.15],
    },
};

Deno.test("gain x volume sweep table (README, Tuning)", () => {
    for (const gain of GAINS) {
        for (const runs of VOLUMES) {
            terms(runs, gain).forEach((t, i) =>
                assertAlmostEquals(
                    t,
                    TABLE[gain][runs][i],
                    5e-5,
                    `gain ${gain}, ${runs} runs, (${"abc"[i]})`,
                )
            );
        }
    }
});

Deno.test("selection rule: 0.6 is the lowest swept gain that passes at every volume, and the default", () => {
    const passing = GAINS.filter((g) =>
        VOLUMES.every((runs) => meets(terms(runs, g)))
    );
    assertEquals(passing, [0.6]); // 0.5 misses (a) at 50 and 1000 runs; 0.75 and 1.0 pin (c) at the cap
    for (const runs of VOLUMES) {
        const [a, b, c] = terms(runs); // default gain
        assertEquals([a, b, c], terms(runs, 0.6));
        assert(a >= -0.15 && a <= -0.10, `${runs} runs (a): ${a}`);
        assert(b >= -0.03, `${runs} runs (b): ${b}`);
        assert(c < 0.15, `${runs} runs (c): ${c}`);
    }
});
