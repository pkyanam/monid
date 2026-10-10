/**
 * Gain sweep behind the default `gain` (see README, "Tuning"). A dense,
 * sim-like news-search cluster: 5 endpoints with RUNS runs each (the sim's
 * dense endpoints saw roughly 180-255), implicit signals only, weighted like
 * the sim: failure 1, clean success 0.05.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { rerank } from "./rerank.ts";
import { buildSnapshot, type EvidenceRow } from "./snapshot.ts";

const RUNS = 200;
const GAINS = [0.5, 0.75, 1.0];

const row = (endpoint: string, failRate: number): EvidenceRow => ({
    endpoint,
    cluster: "news-search",
    aspect: "reliability",
    s: 0.05 * RUNS * (1 - failRate),
    f: RUNS * failRate,
});
const rows = [
    row("fail60", 0.6),
    row("fail10", 0.1),
    row("ok1", 0),
    row("ok2", 0),
    row("ok3", 0),
];

function terms(gain?: number) {
    const snapshot = buildSnapshot(rows, {
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
    return { a: term("fail60"), b: term("fail10"), c: term("ok1") };
}

/** (a) 60% failures lands in [-15%, -10%]; (b) 10% failures stays >= -3%; (c) healthy stays below the cap. */
const meets = ({ a, b, c }: ReturnType<typeof terms>) =>
    a >= -0.15 && a <= -0.10 && b >= -0.03 && c < 0.15;

Deno.test("gain sweep table (README, Tuning)", () => {
    const expected: Record<number, [number, number, number]> = {
        0.5: [-0.1160, -0.0337, 0.1017],
        0.75: [-0.15, -0.0505, 0.15],
        1.0: [-0.15, -0.0673, 0.15],
    };
    for (const gain of GAINS) {
        const { a, b, c } = terms(gain);
        const [ea, eb, ec] = expected[gain];
        assertAlmostEquals(a, ea, 5e-5, `gain ${gain} (a)`);
        assertAlmostEquals(b, eb, 5e-5, `gain ${gain} (b)`);
        assertAlmostEquals(c, ec, 5e-5, `gain ${gain} (c)`);
    }
});

Deno.test("selection rule: no gain in the set meets all three, so the default stays 0.5", () => {
    assertEquals(GAINS.find((g) => meets(terms(g))), undefined);
    const atDefault = terms();
    assertEquals(atDefault, terms(0.5));
    // Closest option: (a) and (c) hold; (b) misses -3% by under half a point.
    assert(atDefault.a >= -0.15 && atDefault.a <= -0.10 && atDefault.c < 0.15);
    assert(atDefault.b < -0.03 && atDefault.b > -0.035);
});
