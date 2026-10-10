/**
 * Scripted stand-in for an LLM agent: discover, mostly take rank 1, inspect
 * new endpoints, run, retry the next result on failure, and sometimes leave
 * feedback. All randomness comes from the seeded `rand`.
 */
import { ENDPOINTS } from "./scenario.ts";
import {
    type Arm,
    type DiscoverResult,
    endpointId,
    type FeedbackRequest,
    HttpError,
    type MonidClient,
    TERMINAL,
} from "./wire.ts";

export type Outcome = "ok" | "empty" | "failed";

export interface Episode {
    arm?: Arm;
    clusterId?: string;
    runs: number;
    ok: number;
    feedback: number;
}

export interface AgentOptions {
    limit: number;
    pollMs: number;
    maxRetries: number;
}

/** Probability of picking rank 1, 2, 3 (renormalized to the list length). */
const PICK = [0.75, 0.17, 0.08];
/** Probability of leaving feedback for each outcome. */
const FEEDBACK_P: Record<Outcome, number> = {
    failed: 0.5,
    empty: 0.4,
    ok: 0.1,
};

const FEEDBACK: Record<
    Outcome,
    Omit<FeedbackRequest, "runId" | "discoverId" | "target">
> = {
    failed: {
        rating: -2,
        aspects: ["reliability"],
        severity: "high",
        text: "Run failed with a provider error; retried on another endpoint.",
    },
    empty: {
        rating: -1,
        aspects: ["completeness"],
        severity: "medium",
        text: "Run completed but returned no articles for a common news query.",
    },
    ok: {
        rating: 2,
        aspects: ["correctness"],
        severity: "low",
        text: "Relevant, recent articles with sources and dates.",
    },
};

export function pickIndex(n: number, rand: () => number): number {
    const weights = PICK.slice(0, n);
    let u = rand() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
        if ((u -= weights[i]) < 0) return i;
    }
    return 0;
}

export async function episode(
    client: MonidClient,
    query: string,
    rand: () => number,
    opts: AgentOptions,
    inspected: Set<string>,
): Promise<Episode> {
    const d = await client.discover(query, opts.limit);
    const ep: Episode = {
        arm: d.arm,
        clusterId: d.clusterId,
        runs: 0,
        ok: 0,
        feedback: 0,
    };
    const order = d.results.map((_, i) => i);
    // Move the scripted pick to the front; retries walk the rest in rank order.
    order.unshift(...order.splice(pickIndex(d.results.length, rand), 1));

    for (const i of order.slice(0, opts.maxRetries + 1)) {
        const r = d.results[i];
        const id = endpointId(r);
        if (!inspected.has(id)) {
            await client.inspect(r.provider, r.endpoint);
            inspected.add(id);
        }
        const input = ENDPOINTS.find((e) => e.id === id)?.input(query) ??
            { body: { query } };
        const { runId, outcome } = await run(
            client,
            r,
            input,
            d.discoverId,
            opts.pollMs,
        );
        ep.runs++;
        if (outcome === "ok") ep.ok++;
        if (runId && rand() < FEEDBACK_P[outcome]) {
            const res = await client.feedback({
                runId,
                discoverId: d.discoverId,
                target: "endpoint",
                ...FEEDBACK[outcome],
            });
            if (res.status !== "queued") {
                throw new Error(`feedback not queued: ${JSON.stringify(res)}`);
            }
            ep.feedback++;
        }
        if (outcome === "ok") break;
    }
    return ep;
}

async function run(
    client: MonidClient,
    r: DiscoverResult,
    input: Record<string, unknown>,
    discoverId: string | undefined,
    pollMs: number,
): Promise<{ runId?: string; outcome: Outcome }> {
    let res;
    try {
        res = await client.run(r, input, discoverId);
    } catch (e) {
        if (e instanceof HttpError) return { outcome: "failed" };
        throw e;
    }
    let status = res.status;
    let output = res.providerResponse?.data;
    for (let i = 0; !TERMINAL.has(status) && i < 600; i++) {
        await new Promise((ok) => setTimeout(ok, pollMs));
        const detail = await client.getRun(res.runId);
        status = detail.status;
        output = detail.output;
    }
    if (status !== "COMPLETED") return { runId: res.runId, outcome: "failed" };
    return { runId: res.runId, outcome: isEmpty(output) ? "empty" : "ok" };
}

/** No output, or every top-level value is null, an empty array or an empty object. */
export function isEmpty(output: unknown): boolean {
    if (output == null) return true;
    if (Array.isArray(output)) return output.length === 0;
    if (typeof output !== "object") return false;
    const values = Object.values(output);
    return values.every((v) =>
        v == null || (typeof v === "object" && Object.keys(v).length === 0)
    );
}
