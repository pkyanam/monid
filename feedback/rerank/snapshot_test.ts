import {
    assert,
    assertEquals,
    assertStrictEquals,
    assertThrows,
} from "@std/assert";
import { buildSnapshot, type EvidenceRow, lookup } from "./snapshot.ts";

const opts = { version: 1, builtAt: "2026-10-10T00:00:00Z" };
const mean = (b: { alpha: number; beta: number }) =>
    b.alpha / (b.alpha + b.beta);

Deno.test("snapshot is deeply frozen", () => {
    const snap = buildSnapshot([{
        endpoint: "a",
        cluster: "news",
        aspect: "quality",
        s: 3,
        f: 1,
    }], opts);
    for (
        const obj of [
            snap,
            snap.params,
            snap.priors,
            snap.cells.news,
            snap.cells.news.a,
            snap.cells.news.a.quality,
        ]
    ) {
        assert(Object.isFrozen(obj));
    }
    assertThrows(() => {
        (snap.cells.news.a.quality as { alpha: number }).alpha = 99;
    }, TypeError);
});

Deno.test("shrinkage is ordered global -> cluster -> cell -> raw rate", () => {
    const rows: EvidenceRow[] = [
        { endpoint: "low", cluster: "other", aspect: "quality", s: 20, f: 80 },
        { endpoint: "mid", cluster: "news", aspect: "quality", s: 30, f: 30 },
        { endpoint: "top", cluster: "news", aspect: "quality", s: 18, f: 2 },
    ];
    const snap = buildSnapshot(rows, opts);
    const g = mean(snap.priors.global.quality);
    const c = mean(snap.priors.clusters.news.quality);
    const cell = mean(snap.cells.news.top.quality);
    const clusterRate = 48 / 80, topRate = 0.9;
    assert(
        g < c && c < clusterRate,
        `global ${g} < cluster ${c} < raw ${clusterRate}`,
    );
    assert(
        c < cell && cell < topRate,
        `cluster ${c} < cell ${cell} < raw ${topRate}`,
    );

    // Same rate, ten times the evidence: much closer to the raw rate.
    const dense = buildSnapshot([...rows.slice(0, 2), {
        ...rows[2],
        s: 180,
        f: 20,
    }], opts);
    assert(topRate - mean(dense.cells.news.top.quality) < (topRate - cell) / 2);
});

Deno.test("a cell's missing aspect equals its cluster prior; unknown cluster falls back to global", () => {
    const snap = buildSnapshot([{
        endpoint: "a",
        cluster: "news",
        aspect: "reliability",
        s: 9,
        f: 1,
    }], opts);
    assertEquals(snap.cells.news.a.quality, snap.priors.clusters.news.quality);
    const { cell, prior } = lookup(snap, "a", "maps");
    assertStrictEquals(cell, undefined);
    assertStrictEquals(prior, snap.priors.global);
});

Deno.test("lookup ignores prototype keys, also after a JSON round trip", () => {
    const snap = JSON.parse(JSON.stringify(buildSnapshot([], opts)));
    assertStrictEquals(lookup(snap, "constructor", "toString").cell, undefined);
});

Deno.test("weights are normalized and bad input is rejected", () => {
    const snap = buildSnapshot([], {
        ...opts,
        weights: { reliability: 3, quality: 1 },
    });
    assertEquals(snap.params.weights, { reliability: 0.75, quality: 0.25 });
    assertThrows(() =>
        buildSnapshot([{
            endpoint: "a",
            cluster: "c",
            aspect: "quality",
            s: -1,
            f: 0,
        }], opts)
    );
    assertThrows(() => buildSnapshot([], { ...opts, k: 0 }));
    assertThrows(() =>
        buildSnapshot([], { ...opts, weights: { reliability: -1, quality: 3 } })
    );
});

Deno.test("ids like __proto__ are stored as plain keys", () => {
    const snap = buildSnapshot(
        [{
            endpoint: "__proto__",
            cluster: "__proto__",
            aspect: "quality",
            s: 5,
            f: 0,
        }],
        opts,
    );
    assert(Object.hasOwn(snap.cells, "__proto__"));
    assert(lookup(snap, "__proto__", "__proto__").cell !== undefined);
});
