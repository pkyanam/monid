import type { Bundle } from "@shared/core";
import { Catalog } from "./catalog/catalog.ts";
import type { HostConfig } from "./config.ts";
import { DiscoverService } from "./discover/service.ts";
import { FeedbackService } from "./feedback/service.ts";
import { FeedbackWorker } from "./feedback/worker.ts";
import { HealthTracker } from "./health/tracker.ts";
import { createApp } from "./http/app.ts";
import {
    defaultReranker,
    type FeedbackReranker,
    SnapshotHolder,
} from "./rerank/port.ts";
import { RunService } from "./runs/service.ts";
import { SnapshotBuilder } from "./rerank/builder.ts";
import { type Db, openDb } from "./store/db.ts";
import {
    createTransportFactory,
    type TransportFactory,
} from "./transport/factory.ts";
import { type Clock, systemClock } from "./util.ts";

export { loadConfigFromEnv, testConfig } from "./config.ts";
export type { HostConfig } from "./config.ts";
export { loadBundle } from "./catalog/load.ts";
export { SnapshotBuilder } from "./rerank/builder.ts";
export {
    readAggregates,
    readEvidence,
    readFlags,
} from "./feedback/aggregates.ts";

/** Everything wired, nothing listening — main.ts serves it, tests call `handle`. */
export interface Host {
    config: HostConfig;
    db: Db;
    catalog: Catalog;
    health: HealthTracker;
    snapshots: SnapshotHolder;
    snapshotBuilder: SnapshotBuilder;
    transports: TransportFactory;
    discover: DiscoverService;
    runs: RunService;
    feedback: FeedbackService;
    worker: FeedbackWorker;
    handle: (req: Request) => Promise<Response>;
    close(): Promise<void>;
}

export function createHost(opts: {
    config: HostConfig;
    bundle: Bundle;
    clock?: Clock;
    transports?: TransportFactory;
    reranker?: FeedbackReranker;
}): Host {
    const { config } = opts;
    const clock = opts.clock ?? systemClock;
    const db = openDb({ path: config.dbPath });
    const catalog = new Catalog(opts.bundle);
    const health = new HealthTracker();
    const snapshots = new SnapshotHolder();
    const transports = opts.transports ??
        createTransportFactory({
            mode: config.transport,
            profiles: config.fakeProfiles,
        });
    const discover = new DiscoverService({
        db,
        catalog,
        health,
        reranker: opts.reranker ?? defaultReranker,
        snapshots,
        clock,
        controlPercent: config.controlPercent,
        experimentSalt: config.experimentSalt,
        allow: config.discoverAllow,
    });
    const runs = new RunService({
        db,
        catalog,
        health,
        transports,
        clock,
        syncWaitMs: config.syncWaitMs,
        healthIgnoreFaults: config.healthIgnoreFaults,
    });
    runs.hydrateHealth(clock() - 24 * 60 * 60_000);
    const feedback = new FeedbackService({
        db,
        clock,
        ratePerMinute: config.feedbackRatePerMinute,
        halfLives: config.halfLives,
        resolveEndpoint: (endpoint, provider) =>
            (provider
                ? catalog.resolve(provider, endpoint)
                : catalog.get(endpoint))?.id,
    });
    const worker = new FeedbackWorker({
        db,
        clock,
        health,
        retryWindowMs: config.retryWindowMs,
        retentionDays: config.feedbackRetentionDays,
        trust: config.trust,
        halfLives: config.halfLives,
        flagsIgnoreFaults: config.healthIgnoreFaults,
    });
    const snapshotBuilder = new SnapshotBuilder({
        db,
        clock,
        holder: snapshots,
        options: config.snapshotOptions,
    });
    const handle = createApp({
        snapshotBuilder,
        config,
        catalog,
        discover,
        runs,
        feedback,
        health,
        snapshots,
        transports,
        clock,
    });
    return {
        config,
        db,
        catalog,
        health,
        snapshots,
        snapshotBuilder,
        transports,
        discover,
        runs,
        feedback,
        worker,
        handle,
        async close() {
            await runs.drain();
            db.close();
        },
    };
}
