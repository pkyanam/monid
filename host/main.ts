/**
 * deno task host:serve — the self-hosted Monid test host.
 *
 *   MONID_HOST_API_KEY=monid_local_<secret> deno task host:serve
 *
 * Env: see host/README.md. Serves the stock CLI's /v1 contract plus
 * /v1/feedback, and runs the feedback worker on an interval in-process.
 */
import { createHost, loadBundle, loadConfigFromEnv } from "./mod.ts";

const config = loadConfigFromEnv();
const bundle = await loadBundle(config.catalogPath);
const host = createHost({ config, bundle });

let ticking = false;
const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    try {
        host.worker.fastLane();
        host.worker.tick();
    } catch (error) {
        console.error("[monid-host] worker tick failed", error);
    } finally {
        ticking = false;
    }
}, config.workerIntervalMs);

// M3: publish a scorer snapshot now, then every MONID_SNAPSHOT_INTERVAL_MS
const logBuild = (why: string) => {
    try {
        const s = host.snapshotBuilder.build();
        console.error(
            `[monid-host] snapshot v${s.version} (${why}): ${s.rows} evidence rows, ${s.flags} flags, ${s.ms}ms`,
        );
    } catch (error) {
        console.error("[monid-host] snapshot build failed", error);
    }
};
logBuild("boot");
const snapshotTimer = setInterval(
    () => logBuild("timer"),
    config.snapshotIntervalMs,
);

const server = Deno.serve({
    port: config.port,
    onListen: ({ hostname, port }) =>
        console.error(
            `[monid-host] listening on http://${hostname}:${port} — ${host.catalog.entries.length} endpoints, ` +
                `transport=${config.transport}, db=${config.dbPath}, snapshot every ${config.snapshotIntervalMs}ms` +
                (config.healthIgnoreFaults
                    ? ", health ignores injected faults"
                    : ""),
        ),
}, host.handle);

const shutdown = async () => {
    clearInterval(timer);
    clearInterval(snapshotTimer);
    await server.shutdown();
    await host.close();
    Deno.exit(0);
};
Deno.addSignalListener("SIGTERM", shutdown);
Deno.addSignalListener("SIGINT", shutdown);
