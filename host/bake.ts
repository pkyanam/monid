/**
 * Compile the catalog once and write it as JSON for MONID_HOST_CATALOG
 * (the Docker image bakes one at build time so boot needs no compiler).
 *
 *   deno run --allow-read --allow-write --allow-env --allow-run=git host/bake.ts out/catalog.json
 */
import { compileToOutput } from "../scripts/lib.ts";

const out = Deno.args[0] ?? "catalog.json";
const { bundle } = await compileToOutput();
await Deno.writeTextFile(out, JSON.stringify(bundle));
console.error(`[bake] wrote ${out}`);
