import { assert, assertEquals } from "@std/assert";
import { isEmpty, pickIndex } from "./agent.ts";
import { rng } from "./rng.ts";
import { configFromEnv, runSim } from "./sim.ts";
import { parseFaults, startStubHost } from "./stub_host.ts";

// The sim talks HTTP to a local stub; skip (not fail) under `deno task test`, which grants no net.
const net =
    (await Deno.permissions.query({ name: "net", host: "127.0.0.1" })).state ===
        "granted";
const simTest = (name: string, fn: () => Promise<void>) =>
    Deno.test({ name, ignore: !net, fn });

const env = (vars: Record<string, string>) => (k: string) => vars[k];
const KEYS = "sim-a,sim-b,sim-c,sim-d";
// Scaled down from the documented 60 s half-life / 60 s snapshots: a fast run
// takes about a second, so evidence halves a few times over the learning phase.
const FAST = {
    MONID_SNAPSHOT_INTERVAL_MS: "100",
    MONID_DECAY_HALF_LIFE_MS: "300",
};

async function simAgainstStub(
    vars: Record<string, string>,
    stub: { faults?: string; omitQuality?: boolean } = {},
) {
    const v: Record<string, string> = { ...FAST, ...vars };
    const host = startStubHost({
        ...stub,
        snapshotIntervalMs: v.MONID_SIM_FORCE_SNAPSHOT === "1"
            ? 3_600_000
            : Number(v.MONID_SNAPSHOT_INTERVAL_MS),
        halfLifeMs: Number(v.MONID_DECAY_HALF_LIFE_MS),
    });
    try {
        return await runSim(configFromEnv(env({
            MONID_API_BASE_URL: host.url,
            MONID_SIM_KEYS: KEYS,
            MONID_SIM_ARMS: "treatment,control,treatment,control",
            MONID_SIM_POLL_MS: "5",
            ...v,
        })));
    } finally {
        await host.close();
    }
}

simTest(
    "sim passes end to end against the stub host (admin fault flip)",
    async () => {
        const { passed, report } = await simAgainstStub({});
        console.log(`\n${report}`);
        assert(passed, report);
    },
);

simTest(
    "sim passes with the fault set at host start (MONID_FAKE_FAULTS)",
    async () => {
        const { passed, report } = await simAgainstStub({
            MONID_SIM_FAULT_MODE: "env",
        }, { faults: "opoint#search:error_rate=0.6" });
        assert(passed, report);
    },
);

simTest(
    "sim fails loudly when the host doesn't expose quality.term",
    async () => {
        const { passed, report } = await simAgainstStub({}, {
            omitQuality: true,
        });
        assert(!passed);
        assert(
            report.includes(
                "FAIL  treatment: opoint#search own feedback term unknown: the host must expose",
            ),
            report,
        );
    },
);

simTest("sim fails, not passes, when nothing is degraded", async () => {
    const { passed, report } = await simAgainstStub({
        MONID_SIM_ERROR_RATE: "0",
    });
    assert(!passed);
    assert(report.includes("FAIL  treatment"));
});

simTest(
    "with forced snapshots the sim is exactly reproducible for a fixed seed",
    async () => {
        // A snapshot timer and time-based decay both depend on the wall clock, so
        // exact reproducibility needs forced snapshots and no decay.
        const run = async () =>
            (await simAgainstStub({
                MONID_SIM_FORCE_SNAPSHOT: "1",
                MONID_DECAY_HALF_LIFE_MS: "0",
            })).report
                .replace(/^host .*$/m, "");
        const first = await run();
        assert(first.includes("PASS  treatment"), first);
        assertEquals(await run(), first);
    },
);

Deno.test("agent helpers", () => {
    const rand = rng(1);
    const picks = [0, 0, 0];
    for (let i = 0; i < 10_000; i++) picks[pickIndex(5, rand)]++;
    assert(picks[0] > 7000 && picks[1] > 1300 && picks[2] > 500, String(picks));
    assertEquals(pickIndex(1, rand), 0);
    assert(
        isEmpty(undefined) && isEmpty({}) && isEmpty({ articles: [] }) &&
            isEmpty([]),
    );
    assert(!isEmpty({ articles: [{ title: "x" }] }) && !isEmpty({ total: 0 }));
    assertEquals(
        parseFaults("a#b:error_rate=0.6,empty_rate=0.1; c#d/e:error_rate=1"),
        new Map([
            ["a#b", { errorRate: 0.6, emptyRate: 0.1 }],
            ["c#d/e", { errorRate: 1, emptyRate: 0 }],
        ]),
    );
});
