/**
 * HTTP client for the Monid host API, following the CLI wire contract
 * (monid-ai/cli src/api/types.ts and client.ts) plus the feedback additions:
 * discover returns `discoverId`, `clusterId`, `arm`, `snapshotVersion`;
 * run accepts `discoverId`; POST /v1/feedback; POST /v1/admin/faults and
 * (optional) POST /v1/admin/snapshot.
 */

export type Arm = "control" | "treatment";

export type RunStatus =
    | "READY"
    | "RUNNING"
    | "STOPPING"
    | "COMPLETED"
    | "FAILED"
    | "BLOCKED"
    | "STOPPED"
    | "TIMED_OUT";

export const TERMINAL: ReadonlySet<RunStatus> = new Set([
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "STOPPED",
    "TIMED_OUT",
]);

export interface DiscoverResult {
    provider: string;
    providerName: string;
    endpoint: string;
    description: string;
    price: { type: string; amount: unknown };
    score: number;
    tags: string[];
    /** Feedback-host addition: the applied rerank term (0 in control) and the evidence behind it. */
    quality?: { term: number; n?: number };
}

export interface DiscoverResponse {
    results: DiscoverResult[];
    query: string;
    count: number;
    // Feedback-host additions. discoverId and clusterId are expected; arm and
    // snapshotVersion are optional (see README).
    discoverId?: string;
    clusterId?: string;
    arm?: Arm;
    snapshotVersion?: number;
}

export interface RunResponse {
    runId: string;
    provider: string;
    endpoint: string;
    status: RunStatus;
    providerResponse?: { httpStatus: number; data?: Record<string, unknown> };
}

export interface RunDetailResponse {
    runId: string;
    provider: string;
    endpoint: string;
    status: RunStatus;
    output?: Record<string, unknown>;
    error?: { source: "provider" | "platform"; message: string } | string;
}

export type Aspect =
    | "correctness"
    | "completeness"
    | "schema"
    | "latency"
    | "reliability"
    | "cost"
    | "docs"
    | "other";

export interface FeedbackRequest {
    runId: string;
    discoverId?: string;
    target: "endpoint";
    rating: -2 | -1 | 0 | 1 | 2;
    text: string;
    aspects: Aspect[];
    severity: "low" | "medium" | "high" | "critical";
}

export interface FeedbackResponse {
    feedbackId: string;
    status: "queued";
}

export class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/** `provider#endpoint`, tolerating a leading slash on the wire endpoint. */
export const endpointId = (r: { provider: string; endpoint: string }) =>
    `${r.provider}#${r.endpoint.replace(/^\/+/, "")}`;

export class MonidClient {
    constructor(
        readonly baseUrl: string,
        readonly apiKey: string,
        /** Sent as X-Monid-Arm to force an arm, if the host honours it. */
        readonly forceArm?: Arm,
    ) {}

    async request<T>(
        method: string,
        path: string,
        body?: unknown,
        expectStatus?: number,
    ): Promise<T> {
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-Monid-Client": "feedback-sim",
        };
        if (this.forceArm) headers["X-Monid-Arm"] = this.forceArm;
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok || (expectStatus && res.status !== expectStatus)) {
            throw new HttpError(
                res.status,
                `${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`,
            );
        }
        return JSON.parse(text) as T;
    }

    discover(query: string, limit: number) {
        return this.request<DiscoverResponse>("POST", "/v1/discover", {
            query,
            limit,
        });
    }

    inspect(provider: string, endpoint: string) {
        return this.request<{ input?: Record<string, unknown> }>(
            "POST",
            "/v1/inspect",
            { provider, endpoint },
        );
    }

    run(
        r: DiscoverResult,
        input: Record<string, unknown>,
        discoverId?: string,
    ) {
        return this.request<RunResponse>("POST", "/v1/run", {
            provider: r.provider,
            endpoint: r.endpoint,
            input,
            ...(discoverId && { discoverId }),
        });
    }

    getRun(runId: string) {
        return this.request<RunDetailResponse>(
            "GET",
            `/v1/runs/${encodeURIComponent(runId)}`,
        );
    }

    feedback(body: FeedbackRequest) {
        return this.request<FeedbackResponse>(
            "POST",
            "/v1/feedback",
            body,
            202,
        );
    }

    /** Optional test hook: build a snapshot now instead of waiting for the timer. */
    rebuildSnapshot() {
        return this.request<{ snapshotVersion: number }>(
            "POST",
            "/v1/admin/snapshot",
            {},
        );
    }

    setFault(target: string, errorRate: number) {
        return this.request<unknown>("POST", "/v1/admin/faults", {
            target,
            error_rate: errorRate,
        });
    }
}
