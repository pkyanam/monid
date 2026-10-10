/**
 * In-process latency of rerank per call: p50 / p99 over many iterations,
 * after a warm-up. Separate from `deno bench` on purpose: this is the number
 * to quote for "the feedback loop adds < 0.5 ms to discover".
 *
 *   deno task sim:bench   (MONID_BENCH_ITERS, default 100000)
 */
import {
    buildSnapshot,
    type EvidenceRow,
    rerank,
} from "@monid/feedback-rerank";

// Same shape as production: 701 endpoints x 61 leaves, ~3 leaves per endpoint, both aspects.
const rows: EvidenceRow[] = [];
for (let e = 0; e < 701; e++) {
    for (let j = 0; j < 3; j++) {
        const n = 1 + ((e * 31 + j * 17) % 400);
        const rate = 0.4 + ((e * 13 + j) % 50) / 100;
        for (const aspect of ["reliability", "quality"] as const) {
            rows.push({
                endpoint: `ep${e}`,
                cluster: `leaf${(e * 7 + j * 13) % 61}`,
                aspect,
                s: n * rate,
                f: n * (1 - rate),
            });
        }
    }
}
const snapshot = buildSnapshot(rows, {
    version: 1,
    builtAt: new Date().toISOString(),
});
const inLeaf = Object.keys(snapshot.cells.leaf0);
const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        endpoint: i < inLeaf.length ? inLeaf[i] : `ep${600 + i}`, // some with no cell, like a real shortlist
        baseScore: 20 - i * 0.3,
        health: i % 9 === 0 ? 0.6 : 1,
    }));

const iters = Number(Deno.env.get("MONID_BENCH_ITERS") ?? 100_000);
const quantile = (sorted: Float64Array, q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

for (const n of [20, 40]) {
    const list = candidates(n);
    const call = (i: number) =>
        rerank(list, snapshot, {
            workspaceId: `ws${i % 1000}`,
            clusterId: "leaf0",
            limit: 10,
        });
    for (let i = 0; i < 10_000; i++) call(i); // warm-up (JIT)
    const t = new Float64Array(iters);
    for (let i = 0; i < iters; i++) {
        const start = performance.now();
        call(i);
        t[i] = performance.now() - start;
    }
    t.sort();
    const us = (ms: number) => `${(ms * 1000).toFixed(1)} µs`;
    console.log(
        `rerank ${n} candidates, limit 10: p50 ${us(quantile(t, 0.5))}  p99 ${
            us(quantile(t, 0.99))
        }  (${iters} calls)`,
    );
}
