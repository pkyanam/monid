import { fromFileUrl } from "@std/path";
import type { EndpointDoc } from "@shared/core";
import {
    credentialFieldsOf,
    directTransport,
    type Transport,
} from "@monid/connector-engine";
import type { FakeProfile, TransportMode } from "../config.ts";
import { bind, type FixtureChoice, FixtureIndex } from "./fixtures.ts";

/**
 * Per-run transports. All three are the engine's own `directTransport`
 * (auth injection, egress, request timeouts) with a different `fetch`
 * underneath — so everything above the wire (decode, usage settle, output
 * mapping, output-contract validation, provider-error classification) is
 * the REAL engine (v1 decision 1).
 *
 *  - direct:  real vendors, credentials from `<PROVIDER>_CREDENTIALS_<FIELD>`.
 *  - fixture: replays the endpoint's recorded chain (method-matched, served
 *             in order, the last call repeats for extra polls).
 *  - fake:    fixture + chaos per provider/endpoint profile: 503s, emptied
 *             arrays, non-JSON bodies, added latency.
 */
export interface RunTransport {
    transport: Transport;
    /** Fast-forward lifecycle poll sleeps (replay has no real vendor). */
    sleep?: (ms: number) => Promise<void>;
    /** True once a fake profile injected a fault into THIS run (error, empty, junk). */
    injected?: () => boolean;
}

export interface TransportFactory {
    forRun(doc: EndpointDoc): Promise<RunTransport>;
    setProfiles?(profiles: Record<string, FakeProfile>): void;
    profiles?(): Record<string, FakeProfile>;
}

const CONNECTORS_DIR = fromFileUrl(
    new URL("../../connectors/", import.meta.url),
);

export function testParams(
    doc: EndpointDoc,
): () => Promise<Record<string, string>> {
    const fields = credentialFieldsOf(doc.auth.credentials);
    return () =>
        Promise.resolve(
            Object.fromEntries(fields.map((f) => [f, "fixture-key"])),
        );
}

const fastSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 10)));

export function fixtureFetch(choice: FixtureChoice | null): typeof fetch {
    let index = 0;
    return (_input, init) => {
        if (!choice) {
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        error:
                            "fixture transport: no recorded chain for this endpoint",
                    }),
                    {
                        status: 501,
                        headers: { "content-type": "application/json" },
                    },
                ),
            );
        }
        const calls = choice.fixture.calls;
        const method = init?.method ?? "GET";
        // lenient: the caller's input differs from the recording, so match
        // the METHOD at the current position, else the next call that does
        let at = index;
        while (at < calls.length && calls[at].req.method !== method) at++;
        const call = calls[Math.min(at, calls.length - 1)];
        index = Math.min(at + 1, calls.length);
        const headers: Record<string, string> = {
            "content-type": "application/json",
            ...(call.res.headers ?? {}),
        };
        if (headers.location) {
            headers.location = bind(headers.location, choice.bindings);
        }
        const isRedirect = call.res.status >= 300 && call.res.status < 400;
        return Promise.resolve(
            new Response(isRedirect ? null : JSON.stringify(call.res.body), {
                status: call.res.status,
                headers,
            }),
        );
    };
}

/** Recursively empty every array (the "no results" shape most vendors use). */
export function emptyArrays(value: unknown): unknown {
    if (Array.isArray(value)) return [];
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map((
                [k, v],
            ) => [k, emptyArrays(v)]),
        );
    }
    return value;
}

export function chaosFetch(
    inner: typeof fetch,
    profile: FakeProfile | undefined,
    rng: () => number,
    sleep: (ms: number) => Promise<void>,
    onInject: () => void = () => {},
): typeof fetch {
    if (!profile) return inner;
    return async (input, init) => {
        const latency = (profile.latencyMs ?? 0) +
            (profile.jitterMs ? (rng() * 2 - 1) * profile.jitterMs : 0);
        if (latency > 0) await sleep(latency);
        if (rng() < (profile.errorRate ?? 0)) {
            onInject();
            return new Response(
                JSON.stringify({
                    error: "fake transport: injected upstream failure",
                }),
                {
                    status: 503,
                    headers: { "content-type": "application/json" },
                },
            );
        }
        if (rng() < (profile.garbageRate ?? 0)) {
            onInject();
            // a 200 that isn't the documented shape (an error page wrapped
            // in JSON) — the engine's output-schema check turns it into
            // CONTRACT_VIOLATION wherever the doc declares output.schema
            return new Response(
                JSON.stringify({ html: "<h1>502 Bad Gateway</h1>" }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        }
        const response = await inner(input, init);
        if (rng() < (profile.emptyRate ?? 0) && response.status < 300) {
            onInject();
            const body = await response.json().catch(() => null);
            return new Response(JSON.stringify(emptyArrays(body)), {
                status: response.status,
                headers: { "content-type": "application/json" },
            });
        }
        return response;
    };
}

export function createTransportFactory(opts: {
    mode: TransportMode;
    profiles?: Record<string, FakeProfile>;
    rng?: () => number;
    /** Real-time sleep for injected latency (tests pass a fake). */
    latencySleep?: (ms: number) => Promise<void>;
    connectorsDir?: string;
}): TransportFactory {
    if (opts.mode === "direct") {
        return {
            forRun: () => Promise.resolve({ transport: directTransport() }),
        };
    }
    const index = new FixtureIndex(opts.connectorsDir ?? CONNECTORS_DIR);
    let profiles = { ...(opts.profiles ?? {}) };
    const rng = opts.rng ?? Math.random;
    const latencySleep = opts.latencySleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    return {
        async forRun(doc) {
            const base = fixtureFetch(await index.choose(doc));
            const profile = profiles[doc.id] ?? profiles[doc.provider];
            let injected = false;
            return {
                transport: directTransport({
                    params: testParams(doc),
                    fetch: chaosFetch(base, profile, rng, latencySleep, () => {
                        injected = true;
                    }),
                }),
                sleep: fastSleep,
                injected: () => injected,
            };
        },
        // fixture and fake share one path; "fake" just says faults are expected
        setProfiles(next) {
            profiles = { ...next };
        },
        profiles: () => ({ ...profiles }),
    };
}
