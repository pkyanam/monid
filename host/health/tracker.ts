import { percentile } from "../util.ts";

/**
 * Live endpoint health from OUR runs — the `EndpointMetrics` projection the
 * stock CLI renders on discover and inspect:
 *   severity order outage > degraded > healthy > stable > unknown;
 *   absent block = no data (never "healthy").
 * In memory (per-endpoint ring buffer), hydrated from the runs table at boot.
 */
export interface EndpointMetrics {
    status: "healthy" | "stable" | "degraded" | "outage" | "unknown";
    runTimeMs?: { p50?: number; p95?: number };
}

export interface HealthEvent {
    ts: number;
    ok: boolean;
    /** providerTotalMs — absent when the run never reached the vendor. */
    ms?: number;
}

export interface HealthPolicy {
    freshWindowMs: number;
    longWindowMs: number;
    freshMinRuns: number;
    longMinRuns: number;
    timingMinRuns: number;
    maxEvents: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
    freshWindowMs: 15 * 60_000,
    longWindowMs: 24 * 60 * 60_000,
    freshMinRuns: 3,
    longMinRuns: 10,
    timingMinRuns: 5,
    maxEvents: 500,
};

export class HealthTracker {
    private readonly events = new Map<string, HealthEvent[]>();

    constructor(
        private readonly policy: HealthPolicy = DEFAULT_HEALTH_POLICY,
    ) {}

    record(endpointId: string, event: HealthEvent): void {
        let list = this.events.get(endpointId);
        if (!list) this.events.set(endpointId, list = []);
        list.push(event);
        if (list.length > this.policy.maxEvents) {
            list.splice(0, list.length - this.policy.maxEvents);
        }
    }

    metrics(endpointId: string, now: number): EndpointMetrics | undefined {
        const all = this.events.get(endpointId);
        if (!all || all.length === 0) return undefined;
        const p = this.policy;
        const long = all.filter((e) => now - e.ts <= p.longWindowMs);
        if (long.length === 0) return undefined;
        const fresh = long.filter((e) => now - e.ts <= p.freshWindowMs);
        const errRate = (xs: HealthEvent[]) =>
            xs.filter((e) => !e.ok).length / xs.length;

        let status: EndpointMetrics["status"] = "unknown";
        if (fresh.length >= p.freshMinRuns) {
            const r = errRate(fresh);
            status = r >= 0.8 ? "outage" : r >= 0.25 ? "degraded" : "healthy";
        } else if (long.length >= p.longMinRuns) {
            status = errRate(long) >= 0.25 ? "degraded" : "stable";
        }
        const timed = long
            .filter((e) => e.ms !== undefined)
            .map((e) => e.ms as number)
            .sort((a, b) => a - b);
        const out: EndpointMetrics = { status };
        if (timed.length >= p.timingMinRuns) {
            out.runTimeMs = {
                p50: percentile(timed, 50),
                p95: percentile(timed, 95),
            };
        }
        return out;
    }

    /** Recent failure rate for fast-lane corroboration (undefined = too little data). */
    freshFailureRate(endpointId: string, now: number): number | undefined {
        const fresh = (this.events.get(endpointId) ?? [])
            .filter((e) => now - e.ts <= this.policy.freshWindowMs);
        if (fresh.length < this.policy.freshMinRuns) return undefined;
        return fresh.filter((e) => !e.ok).length / fresh.length;
    }
}
