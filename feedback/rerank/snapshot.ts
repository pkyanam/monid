/**
 * Snapshot scorer: aggregated, decayed evidence in, immutable ranking snapshot out.
 *
 * Shrinkage is hierarchical empirical Bayes, global(aspect) -> cluster(aspect)
 * -> (endpoint, cluster, aspect). Each level's prior is Beta(k*mu, k*(1-mu))
 * where mu is the parent's posterior mean, so thin cells lean on their cluster
 * and dense cells speak for themselves.
 */
import { betaQuantile } from "./beta.ts";

export const ASPECTS = ["reliability", "quality"] as const;
export type Aspect = typeof ASPECTS[number];

/** Lower quantile used for deterministic scoring, and the band used for uncertainty. */
export const LOWER_Q = 0.1;
export const UPPER_Q = 0.9;

export interface BetaParams {
    readonly alpha: number;
    readonly beta: number;
}

/** A posterior (or prior) per aspect plus the two numbers the reranker needs. */
export interface Cell {
    readonly reliability: BetaParams;
    readonly quality: BetaParams;
    /** Weighted sum over aspects of the Beta 10th percentile. */
    readonly lower: number;
    /** Weighted sum over aspects of the 10%-90% interval width. */
    readonly width: number;
}

export interface SnapshotParams {
    /** Prior strength, in pseudo-observations. */
    readonly k: number;
    /** Aspect weights for the composite, normalized to sum to 1. */
    readonly weights: Readonly<Record<Aspect, number>>;
    /** Feedback term = gain * (cell.lower - prior.lower), clamped later by the reranker. */
    readonly gain: number;
}

export interface Snapshot {
    readonly version: number;
    readonly builtAt: string;
    readonly params: SnapshotParams;
    readonly priors: {
        readonly global: Cell;
        readonly clusters: Readonly<Record<string, Cell>>;
    };
    /** cells[clusterId][endpoint]. Only cells with evidence are present. */
    readonly cells: Readonly<Record<string, Readonly<Record<string, Cell>>>>;
    /** Endpoint -> multiplier (e.g. 0.5 for a severe flag). Applied outside the feedback cap. */
    readonly flags: Readonly<Record<string, number>>;
}

/** Decayed, trust-weighted success/failure mass for one (endpoint, cluster, aspect). */
export interface EvidenceRow {
    endpoint: string;
    cluster: string;
    aspect: Aspect;
    s: number;
    f: number;
}

export interface BuildOptions {
    version: number;
    builtAt: string;
    k?: number;
    weights?: Partial<Record<Aspect, number>>;
    gain?: number;
    flags?: Record<string, number>;
}

type Mass = Record<Aspect, { s: number; f: number }>;

const emptyMass = (): Mass => ({
    reliability: { s: 0, f: 0 },
    quality: { s: 0, f: 0 },
});

export function buildSnapshot(
    rows: Iterable<EvidenceRow>,
    opts: BuildOptions,
): Snapshot {
    const k = opts.k ?? 10;
    const raw = { reliability: 0.5, quality: 0.5, ...opts.weights };
    const total = raw.reliability + raw.quality;
    if (!(k > 0 && raw.reliability >= 0 && raw.quality >= 0 && total > 0)) {
        throw new RangeError("k and aspect weights must be positive");
    }
    const weights = {
        reliability: raw.reliability / total,
        quality: raw.quality / total,
    };

    const global = emptyMass();
    const clusters = new Map<
        string,
        { mass: Mass; endpoints: Map<string, Mass> }
    >();
    for (const { endpoint, cluster, aspect, s, f } of rows) {
        if (!(s >= 0 && f >= 0 && Number.isFinite(s + f))) {
            throw new RangeError(
                `bad evidence for ${endpoint}/${cluster}/${aspect}`,
            );
        }
        let c = clusters.get(cluster);
        if (!c) {
            clusters.set(
                cluster,
                c = { mass: emptyMass(), endpoints: new Map() },
            );
        }
        let e = c.endpoints.get(endpoint);
        if (!e) c.endpoints.set(endpoint, e = emptyMass());
        for (const m of [global, c.mass, e]) {
            m[aspect].s += s;
            m[aspect].f += f;
        }
    }

    const cell = (beta: (a: Aspect) => BetaParams): Cell => {
        const params = {
            reliability: beta("reliability"),
            quality: beta("quality"),
        };
        let lower = 0, width = 0;
        for (const a of ASPECTS) {
            const lo = betaQuantile(LOWER_Q, params[a].alpha, params[a].beta);
            lower += weights[a] * lo;
            width += weights[a] *
                (betaQuantile(UPPER_Q, params[a].alpha, params[a].beta) - lo);
        }
        return { ...params, lower, width };
    };
    const priorCell = (mu: (a: Aspect) => number) =>
        cell((a) => ({ alpha: k * mu(a), beta: k * (1 - mu(a)) }));
    const shrunk = (
        mu: number,
        strength: number,
        m: { s: number; f: number },
    ) => (strength * mu + m.s) / (strength + m.s + m.f);

    // The global mean starts from a uniform Beta(1, 1), so it is 0.5 with no evidence.
    const globalMean = (a: Aspect) => shrunk(0.5, 2, global[a]);
    const globalPrior = priorCell(globalMean);
    // Built with Object.fromEntries so ids like "__proto__" become plain own keys.
    const clusterPriors: [string, Cell][] = [];
    const cells: [string, Record<string, Cell>][] = [];
    for (const [clusterId, c] of clusters) {
        const prior = priorCell((a) => shrunk(globalMean(a), k, c.mass[a]));
        clusterPriors.push([clusterId, prior]);
        cells.push([
            clusterId,
            Object.fromEntries(
                [...c.endpoints].map(([endpoint, m]) => [
                    endpoint,
                    cell((a) => ({
                        alpha: prior[a].alpha + m[a].s,
                        beta: prior[a].beta + m[a].f,
                    })),
                ]),
            ),
        ]);
    }

    return deepFreeze({
        version: opts.version,
        builtAt: opts.builtAt,
        params: { k, weights, gain: opts.gain ?? 0.5 },
        priors: {
            global: globalPrior,
            clusters: Object.fromEntries(clusterPriors),
        },
        cells: Object.fromEntries(cells),
        flags: { ...opts.flags },
    });
}

/** The evidence cell for (endpoint, cluster), if any, and the prior it shrinks toward. */
export function lookup(
    snapshot: Snapshot,
    endpoint: string,
    clusterId: string,
): { cell: Cell | undefined; prior: Cell } {
    const prior = own(snapshot.priors.clusters, clusterId) ??
        snapshot.priors.global;
    const cluster = own(snapshot.cells, clusterId);
    return { cell: cluster && own(cluster, endpoint), prior };
}

/** Own-property read, so ids like "constructor" never hit Object.prototype (also after JSON.parse). */
export function own<T>(
    record: Readonly<Record<string, T>>,
    key: string,
): T | undefined {
    return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
}
