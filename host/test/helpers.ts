import type { Bundle } from "@shared/core";
import { testBundle } from "@shared/testing";
import { createHost, type Host, type HostConfig, testConfig } from "../mod.ts";
import { createTransportFactory } from "../transport/factory.ts";
import type { FakeProfile } from "../config.ts";

let bundle: Promise<Bundle> | undefined;
/** Compiled once per test process. */
export function sharedBundle(): Promise<Bundle> {
    return bundle ??= testBundle();
}

export interface FakeClock {
    (): number;
    advance(ms: number): void;
    set(ms: number): void;
}

export function fakeClock(start = Date.UTC(2026, 9, 10, 12)): FakeClock {
    let now = start;
    const clock = (() => now) as FakeClock;
    clock.advance = (ms) => void (now += ms);
    clock.set = (ms) => void (now = ms);
    return clock;
}

export async function makeHost(opts: {
    config?: Partial<HostConfig>;
    clock?: FakeClock;
    profiles?: Record<string, FakeProfile>;
    rng?: () => number;
} = {}): Promise<Host & { clock: FakeClock }> {
    const clock = opts.clock ?? fakeClock();
    const config = testConfig({
        transport: opts.profiles ? "fake" : "fixture",
        ...opts.config,
    });
    const transports = createTransportFactory({
        mode: config.transport,
        profiles: opts.profiles,
        rng: opts.rng ?? (() => 0.5),
        latencySleep: () => Promise.resolve(),
    });
    const host = createHost({
        config,
        bundle: await sharedBundle(),
        clock,
        transports,
    });
    return Object.assign(host, { clock });
}

export const ALPHA = "monid_test_alpha";
export const BETA = "monid_test_beta";

export async function call(
    host: Host,
    method: string,
    path: string,
    body?: unknown,
    opts: { key?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = { ...opts.headers };
    const key = opts.key === undefined ? ALPHA : opts.key;
    if (key) headers.authorization = `Bearer ${key}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await host.handle(
        new Request(`http://host${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
    const text = await res.text();
    return {
        status: res.status,
        body: text ? JSON.parse(text) : null,
        headers: res.headers,
    };
}

export const SEARCH_QUERY = { query: "deno sqlite" };

export function runSearch(
    host: Host,
    extra: Record<string, unknown> = {},
    key?: string,
) {
    return call(host, "POST", "/v1/run", {
        provider: "tinyfish",
        endpoint: "/search",
        input: { queryParams: SEARCH_QUERY },
        ...extra,
    }, { key });
}
