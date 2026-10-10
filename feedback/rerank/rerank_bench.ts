import { rerank } from "./rerank.ts";
import { buildSnapshot, type EvidenceRow } from "./snapshot.ts";

// 701 endpoints x 61 category leaves, sparse: each endpoint has evidence in 3 leaves, both aspects.
const rows: EvidenceRow[] = [];
for (let e = 0; e < 701; e++) {
    for (let j = 0; j < 3; j++) {
        const cluster = `leaf${(e * 7 + j * 13) % 61}`;
        const n = 1 + ((e * 31 + j * 17) % 400);
        const rate = 0.4 + ((e * 13 + j) % 50) / 100;
        for (const aspect of ["reliability", "quality"] as const) {
            rows.push({
                endpoint: `ep${e}`,
                cluster,
                aspect,
                s: n * rate,
                f: n * (1 - rate),
            });
        }
    }
}
const snapshot = buildSnapshot(rows, {
    version: 1,
    builtAt: "2026-10-10T00:00:00Z",
});

// Candidates from leaf0 plus endpoints with no cell there, like a real BM25 shortlist.
const inLeaf = Object.keys(snapshot.cells.leaf0);
const candidates = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        endpoint: i < inLeaf.length ? inLeaf[i] : `ep${i}`,
        baseScore: 20 - i * 0.3,
        health: i % 9 === 0 ? 0.6 : 1,
    }));
const c20 = candidates(20), c40 = candidates(40);
let ws = 0;

Deno.bench("rerank 20 candidates, limit 10", () => {
    rerank(c20, snapshot, {
        workspaceId: `ws${ws++}`,
        clusterId: "leaf0",
        limit: 10,
    });
});
Deno.bench("rerank 40 candidates, limit 10", () => {
    rerank(c40, snapshot, {
        workspaceId: `ws${ws++}`,
        clusterId: "leaf0",
        limit: 10,
    });
});
Deno.bench(
    `buildSnapshot, ${rows.length} rows (701 endpoints x 61 leaves, sparse)`,
    () => {
        buildSnapshot(rows, { version: 2, builtAt: "2026-10-10T00:00:00Z" });
    },
);
