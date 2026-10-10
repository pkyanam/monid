/**
 * Host configuration — env only (the repo's config.yml stays the CONTRACT
 * file; host knobs are tooling and never touch bundle bytes).
 */
export type TransportMode = "direct" | "fixture" | "fake";

export interface ApiKeyEntry {
    /** Stable, non-secret id for logs/rate limits (never the key itself). */
    keyId: string;
    workspaceId: string;
}

export interface HostConfig {
    port: number;
    dbPath: string;
    /** Optional precompiled catalog.json; absent ⇒ compile via .output cache. */
    catalogPath?: string;
    /** api key → workspace. */
    apiKeys: Map<string, ApiKeyEntry>;
    /** Enables the /v1/_admin routes (fake-transport profiles). */
    adminKey?: string;
    transport: TransportMode;
    /** Fake-transport chaos profiles (JSON), keyed by provider or endpoint id. */
    fakeProfiles: Record<string, FakeProfile>;
    /** How long POST /v1/run waits before answering RUNNING. */
    syncWaitMs: number;
    /** Retry-elsewhere / success-no-retry window (v1 decision 4). */
    retryWindowMs: number;
    feedbackRatePerMinute: number;
    feedbackRetentionDays: number;
    /** Percent of workspaces in the control arm (no feedback term). */
    controlPercent: number;
    experimentSalt: string;
    /** Fixed per-workspace trust weights (v1 decision 6); default 1. */
    trust: Record<string, number>;
    workerIntervalMs: number;
}

export interface FakeProfile {
    /** P(answer 503) per upstream call. */
    errorRate?: number;
    /** P(empty the recorded body's arrays) per upstream call. */
    emptyRate?: number;
    /** P(answer a non-JSON body) per upstream call. */
    garbageRate?: number;
    /** Added latency per upstream call (ms), ± jitterMs. */
    latencyMs?: number;
    jitterMs?: number;
}

/** monid_<stage>_<secret> is the stock CLI's required key format. */
export function isCliKeyFormat(key: string): boolean {
    const parts = key.split("_");
    return parts.length >= 3 && parts[0] === "monid";
}

/**
 * MONID_HOST_API_KEYS="monid_local_abc:ws_a,monid_local_def:ws_b" or a
 * single MONID_HOST_API_KEY (+ MONID_HOST_WORKSPACE, default ws_local).
 */
export function parseApiKeys(
    multi: string | undefined,
    single: string | undefined,
    singleWorkspace: string | undefined,
): Map<string, ApiKeyEntry> {
    const map = new Map<string, ApiKeyEntry>();
    const add = (key: string, workspaceId: string) => {
        if (!isCliKeyFormat(key)) {
            throw new Error(
                "API keys must look like monid_<stage>_<secret> (the stock CLI rejects anything else)",
            );
        }
        map.set(key, { keyId: `key_${map.size + 1}`, workspaceId });
    };
    for (const pair of (multi ?? "").split(",").map((s) => s.trim())) {
        if (!pair) continue;
        const idx = pair.lastIndexOf(":");
        if (idx <= 0) throw new Error(`bad MONID_HOST_API_KEYS entry`);
        add(pair.slice(0, idx), pair.slice(idx + 1));
    }
    if (single) add(single, singleWorkspace ?? "ws_local");
    return map;
}

function num(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
    return n;
}

export function loadConfigFromEnv(
    env: (name: string) => string | undefined = (n) => Deno.env.get(n),
): HostConfig {
    const transport =
        (env("MONID_HOST_TRANSPORT") ?? "fixture") as TransportMode;
    if (!["direct", "fixture", "fake"].includes(transport)) {
        throw new Error(`MONID_HOST_TRANSPORT must be direct|fixture|fake`);
    }
    const apiKeys = parseApiKeys(
        env("MONID_HOST_API_KEYS"),
        env("MONID_HOST_API_KEY"),
        env("MONID_HOST_WORKSPACE"),
    );
    if (apiKeys.size === 0) {
        throw new Error("set MONID_HOST_API_KEY (or MONID_HOST_API_KEYS)");
    }
    const trust: Record<string, number> = {};
    for (const pair of (env("MONID_HOST_TRUST") ?? "").split(",")) {
        const [ws, w] = pair.split(":");
        if (ws && w) trust[ws.trim()] = Number(w);
    }
    return {
        port: num(env("PORT") ?? env("MONID_HOST_PORT"), 8080),
        dbPath: env("MONID_HOST_DB") ?? "./.output/host.db",
        catalogPath: env("MONID_HOST_CATALOG") || undefined,
        apiKeys,
        adminKey: env("MONID_HOST_ADMIN_KEY") || undefined,
        transport,
        fakeProfiles: JSON.parse(env("MONID_HOST_FAKE_PROFILES") ?? "{}"),
        syncWaitMs: num(env("MONID_HOST_SYNC_WAIT_MS"), 25_000),
        retryWindowMs: num(env("MONID_HOST_RETRY_WINDOW_MS"), 120_000),
        feedbackRatePerMinute: num(env("MONID_HOST_FEEDBACK_RPM"), 60),
        feedbackRetentionDays: num(
            env("MONID_HOST_FEEDBACK_RETENTION_DAYS"),
            90,
        ),
        controlPercent: num(env("MONID_HOST_CONTROL_PERCENT"), 10),
        experimentSalt: env("MONID_HOST_EXPERIMENT_SALT") ?? "v1",
        trust,
        workerIntervalMs: num(env("MONID_HOST_WORKER_INTERVAL_MS"), 1000),
    };
}

/** Defaults for tests: fixture transport, in-memory db, one key. */
export function testConfig(overrides: Partial<HostConfig> = {}): HostConfig {
    return {
        port: 0,
        dbPath: ":memory:",
        apiKeys: new Map([
            ["monid_test_alpha", { keyId: "key_1", workspaceId: "ws_alpha" }],
            ["monid_test_beta", { keyId: "key_2", workspaceId: "ws_beta" }],
        ]),
        adminKey: "admin-test",
        transport: "fixture",
        fakeProfiles: {},
        syncWaitMs: 25_000,
        retryWindowMs: 120_000,
        feedbackRatePerMinute: 60,
        feedbackRetentionDays: 90,
        controlPercent: 10,
        experimentSalt: "v1",
        trust: {},
        workerIntervalMs: 1000,
        ...overrides,
    };
}
