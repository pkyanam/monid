/**
 * End-to-end feedback-loop simulation against a Monid host over HTTP.
 *
 *   warm-up -> measure "before" -> degrade one endpoint -> learning traffic
 *   -> wait for a fresh snapshot -> measure "after" -> assertions + report
 *
 * Measurement windows only call discover, so they don't add evidence.
 * Exit code 1 when an assertion fails.
 */
import { type AgentOptions, episode } from "./agent.ts";
import { hash, rng } from "./rng.ts";
import { DEFAULT_DEGRADE, ENDPOINTS, LEAF, QUERIES } from "./scenario.ts";
import { type Arm, endpointId, MonidClient } from "./wire.ts";

export interface SimConfig extends AgentOptions {
    baseUrl: string;
    keys: string[];
    /** Optional forced arm per key (X-Monid-Arm). */
    arms?: (Arm | undefined)[];
    adminKey?: string;
    degrade: string;
    errorRate: number;
    /** "admin": flip the fault mid-run. "env": host was started with MONID_FAKE_FAULTS. */
    faultMode: "admin" | "env";
    snapshotIntervalMs: number;
    /** Call POST /v1/admin/snapshot instead of waiting for the timer (deterministic). */
    forceSnapshot: boolean;
    seed: number;
    warmupEpisodes: number;
    learnEpisodes: number;
    measureQueries: number;
    minRankDrop: number;
    controlTolerance: number;
}

interface Workspace {
    client: MonidClient;
    rand: () => number;
    arm?: Arm;
    inspected: Set<string>;
}

interface Window {
    ranks: number[];
    scores: number[];
}

interface Traffic {
    runs: number;
    ok: number;
    feedback: number;
}

export function configFromEnv(
    env: (k: string) => string | undefined = Deno.env.get,
): SimConfig {
    const num = (k: string, d: number) => (env(k) ? Number(env(k)) : d);
    const list = (k: string) =>
        env(k)?.split(",").map((s) => s.trim()).filter(Boolean);
    const baseUrl = env("MONID_API_BASE_URL");
    if (!baseUrl) throw new Error("MONID_API_BASE_URL is required");
    const keys = list("MONID_SIM_KEYS") ??
        (env("MONID_API_KEY") ? [env("MONID_API_KEY")!] : []);
    return {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        keys,
        arms: list("MONID_SIM_ARMS")?.map((
            a,
        ) => (a === "control" || a === "treatment" ? a : undefined)),
        adminKey: env("MONID_ADMIN_KEY"),
        degrade: env("MONID_SIM_DEGRADE") ?? DEFAULT_DEGRADE,
        errorRate: num("MONID_SIM_ERROR_RATE", 0.6),
        faultMode: env("MONID_SIM_FAULT_MODE") === "env" ? "env" : "admin",
        snapshotIntervalMs: num("MONID_SNAPSHOT_INTERVAL_MS", 60_000),
        forceSnapshot: env("MONID_SIM_FORCE_SNAPSHOT") === "1",
        seed: num("MONID_SIM_SEED", 42),
        limit: num("MONID_SIM_LIMIT", 5),
        warmupEpisodes: num("MONID_SIM_WARMUP", 30),
        learnEpisodes: num("MONID_SIM_LEARN", 60),
        measureQueries: num("MONID_SIM_MEASURE", 20),
        pollMs: num("MONID_SIM_POLL_MS", 50),
        maxRetries: num("MONID_SIM_MAX_RETRIES", 2),
        minRankDrop: num("MONID_SIM_MIN_RANK_DROP", 1),
        controlTolerance: num("MONID_SIM_CONTROL_TOLERANCE", 0.25),
    };
}

export async function runSim(
    cfg: SimConfig,
): Promise<{ passed: boolean; report: string }> {
    const workspaces: Workspace[] = cfg.keys.map((key, i) => ({
        client: new MonidClient(cfg.baseUrl, key, cfg.arms?.[i]),
        rand: rng(hash(`${cfg.seed}:${key}`)),
        arm: cfg.arms?.[i],
        inspected: new Set(),
    }));
    const queryFor = (w: Workspace) =>
        QUERIES[Math.floor(w.rand() * QUERIES.length)];
    const clusters = new Set<string>();

    /** The host's arm wins; a forced arm is the fallback. */
    const armOf = (w: Workspace, reported?: Arm): Arm => {
        w.arm = reported ?? w.arm;
        if (!w.arm) {
            throw new Error(
                "host sent no arm and none was forced (MONID_SIM_ARMS)",
            );
        }
        return w.arm;
    };

    const traffic = async (episodes: number): Promise<Record<Arm, Traffic>> => {
        const t = {
            control: { runs: 0, ok: 0, feedback: 0 },
            treatment: { runs: 0, ok: 0, feedback: 0 },
        };
        for (let n = 0; n < episodes; n++) {
            for (const w of workspaces) {
                const ep = await episode(
                    w.client,
                    queryFor(w),
                    w.rand,
                    cfg,
                    w.inspected,
                );
                const arm = armOf(w, ep.arm);
                if (ep.clusterId) clusters.add(ep.clusterId);
                t[arm].runs += ep.runs;
                t[arm].ok += ep.ok;
                t[arm].feedback += ep.feedback;
            }
        }
        return t;
    };

    const measure = async (): Promise<Record<Arm, Window>> => {
        const m = {
            control: { ranks: [], scores: [] },
            treatment: { ranks: [], scores: [] },
        } as Record<Arm, Window>;
        for (let n = 0; n < cfg.measureQueries; n++) {
            for (const w of workspaces) {
                const d = await w.client.discover(
                    QUERIES[n % QUERIES.length],
                    cfg.limit,
                );
                const arm = armOf(w, d.arm);
                if (d.clusterId) clusters.add(d.clusterId);
                const i = d.results.findIndex((r) =>
                    endpointId(r) === cfg.degrade
                );
                m[arm].ranks.push(i < 0 ? cfg.limit + 1 : i + 1); // not shown counts as limit + 1
                if (i >= 0) m[arm].scores.push(d.results[i].score);
            }
        }
        return m;
    };

    const snapshotVersion = async () =>
        (await workspaces[0].client.discover(QUERIES[0], cfg.limit))
            .snapshotVersion;

    /** Wait until the host has built a snapshot newer than the current one (or ~1.5 intervals if it doesn't say). */
    const admin = new MonidClient(cfg.baseUrl, cfg.adminKey ?? cfg.keys[0]);
    const freshSnapshot = async () => {
        if (cfg.forceSnapshot) return void (await admin.rebuildSnapshot());
        const start = await snapshotVersion();
        const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
        if (start === undefined) return sleep(cfg.snapshotIntervalMs * 1.5);
        const deadline = Date.now() + cfg.snapshotIntervalMs * 10;
        while (((await snapshotVersion()) ?? 0) <= start) {
            if (Date.now() > deadline) {
                throw new Error(`snapshot stuck at v${start}`);
            }
            await sleep(Math.max(10, cfg.snapshotIntervalMs / 4));
        }
    };

    if (!ENDPOINTS.some((e) => e.id === cfg.degrade)) {
        throw new Error(`${cfg.degrade} is not in the scenario`);
    }
    if (workspaces.length < 2) {
        throw new Error(
            "need at least two keys (one per arm) in MONID_SIM_KEYS",
        );
    }

    const warm = cfg.faultMode === "admin"
        ? await traffic(cfg.warmupEpisodes)
        : undefined;
    if (warm) await freshSnapshot();
    const before = await measure();
    if (cfg.faultMode === "admin") {
        await admin.setFault(cfg.degrade, cfg.errorRate);
    }
    const learn = await traffic(cfg.learnEpisodes);
    await freshSnapshot();
    const after = await measure();

    const mean = (
        xs: number[],
    ) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const rank = (w: Window) => mean(w.ranks);
    const drop = rank(after.treatment) - rank(before.treatment);
    const drift = Math.abs(rank(after.control) - rank(before.control));
    const armCount = (a: Arm) => workspaces.filter((w) => w.arm === a).length;

    const checks: [boolean, string][] = [
        [
            armCount("treatment") > 0 && armCount("control") > 0,
            `both arms present (${armCount("treatment")} treatment, ${
                armCount("control")
            } control workspaces)`,
        ],
        [
            clusters.size === 0 || (clusters.size === 1 && clusters.has(LEAF)),
            `queries land in ${LEAF} (host said: ${
                [...clusters].join(", ") || "no clusterId"
            })`,
        ],
        [
            learn.treatment.feedback + learn.control.feedback > 0,
            "feedback calls were accepted (202 queued)",
        ],
        [
            drop >= cfg.minRankDrop,
            `treatment: ${cfg.degrade} mean rank fell by >= ${cfg.minRankDrop} (${
                fmt(rank(before.treatment))
            } -> ${fmt(rank(after.treatment))})`,
        ],
        [
            drift <= cfg.controlTolerance,
            `control: ${cfg.degrade} mean rank moved <= ${cfg.controlTolerance} (${
                fmt(rank(before.control))
            } -> ${fmt(rank(after.control))})`,
        ],
    ];

    const pct = (
        x: number,
    ) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
    const r1 = (w: Window) =>
        w.ranks.filter((r) => r === 1).length / w.ranks.length;
    const row = (a: Arm) =>
        [
            a.padEnd(10),
            fmt(rank(before[a])).padStart(6),
            fmt(rank(after[a])).padStart(6),
            pct(r1(before[a])).padStart(6),
            pct(r1(after[a])).padStart(6),
            fmt(mean(before[a].scores)).padStart(7),
            fmt(mean(after[a].scores)).padStart(7),
            pct(warm ? warm[a].ok / warm[a].runs : NaN).padStart(6),
            pct(learn[a].ok / learn[a].runs).padStart(6),
            String((warm?.[a].feedback ?? 0) + learn[a].feedback).padStart(5),
        ].join(" ");

    const report = [
        "Monid feedback-loop simulation (SYNTHETIC WORLD ONLY)",
        "Scripted agents, fake transport and injected faults. A pass shows the loop",
        "works mechanically; it says nothing about real agents or real providers.",
        "",
        `host ${cfg.baseUrl}  leaf ${LEAF}  degraded ${cfg.degrade} (error_rate ${cfg.errorRate}, via ${cfg.faultMode})`,
        `seed ${cfg.seed}  limit ${cfg.limit}  warm-up ${
            warm ? cfg.warmupEpisodes : 0
        }  learning ${cfg.learnEpisodes}  measure ${cfg.measureQueries} queries/workspace`,
        "",
        "                 mean rank      rank-1 share   mean score     run success",
        "arm        before  after  before  after  before   after   warm  learn  fdbk",
        row("treatment"),
        row("control"),
        "",
        ...checks.map(([ok, msg]) => `${ok ? "PASS" : "FAIL"}  ${msg}`),
    ].join("\n");
    return { passed: checks.every(([ok]) => ok), report };
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

if (import.meta.main) {
    const { passed, report } = await runSim(configFromEnv());
    console.log(report);
    Deno.exit(passed ? 0 : 1);
}
