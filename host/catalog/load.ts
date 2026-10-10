import type { Bundle } from "@shared/core";

/**
 * Bundle source: a precompiled catalog.json (Docker bakes one at build
 * time) or the repo's own .output compile cache.
 */
export async function loadBundle(catalogPath?: string): Promise<Bundle> {
    if (catalogPath) {
        return JSON.parse(await Deno.readTextFile(catalogPath)) as Bundle;
    }
    const { compileToOutput } = await import("../../scripts/lib.ts");
    const { bundle } = await compileToOutput();
    return bundle;
}
