import { assert } from "@std/assert";
import { evaluateQuality } from "./discover_quality.ts";

Deno.test("discover quality: full catalog, leaf inferred and top 5 on topic", async () => {
    const rows = await evaluateQuality();
    const bad = rows.filter((r) => !r.leafOk || r.inTop5 < r.minInTop5);
    assert(
        bad.length === 0,
        bad.map((r) =>
            `"${r.query}": leaf ${r.clusterId} (want ${r.leaf}), ${r.inTop5}/5 on topic (min ${r.minInTop5}): ${
                r.top5.join(", ")
            }`
        ).join("\n"),
    );
});
