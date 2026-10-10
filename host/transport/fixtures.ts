import { join } from "@std/path";
import { exists } from "@std/fs";
import type { EndpointDoc } from "@shared/core";
import { type Fixture, loadFixture } from "@shared/testing";

/**
 * Fixture lookup for the FIXTURE transport: the connectors' own recorded
 * chains (`connectors/<p>/endpoints/<e>/fixtures/*.json` and the
 * provider-level shared chains `connectors/<p>/fixtures/*.json`).
 *
 * The doc does not carry its source folder, so a chain is matched to an
 * endpoint by its FIRST call's url (after `{{request.url}}`/
 * `{{request.origin}}` binding) against the doc's compiled request url,
 * query ignored, `{param}` segments as wildcards. Preference: endpoint-level
 * over provider-level, recorded over `synthetic-`, a 2xx final call over an
 * error chain, `happy` names first.
 */
export interface FixtureChoice {
    fixture: Fixture;
    bindings: Record<string, string>;
    path: string;
}

interface IndexedFixture {
    path: string;
    level: "endpoint" | "provider";
    fixture: Fixture;
}

export class FixtureIndex {
    private readonly byProvider = new Map<string, Promise<IndexedFixture[]>>();
    private readonly choice = new Map<string, FixtureChoice | null>();

    constructor(private readonly connectorsDir: string) {}

    private load(provider: string): Promise<IndexedFixture[]> {
        let pending = this.byProvider.get(provider);
        if (!pending) {
            pending = this.scan(provider);
            this.byProvider.set(provider, pending);
        }
        return pending;
    }

    private async scan(provider: string): Promise<IndexedFixture[]> {
        const root = join(this.connectorsDir, provider);
        const out: IndexedFixture[] = [];
        const readDir = async (dir: string, level: IndexedFixture["level"]) => {
            if (!(await exists(dir))) return;
            for await (const file of Deno.readDir(dir)) {
                if (!file.isFile || !file.name.endsWith(".json")) continue;
                const path = join(dir, file.name);
                try {
                    out.push({ path, level, fixture: await loadFixture(path) });
                } catch { /* not a fixture chain */ }
            }
        };
        await readDir(join(root, "fixtures"), "provider");
        const endpointsDir = join(root, "endpoints");
        if (await exists(endpointsDir)) {
            for await (const dir of Deno.readDir(endpointsDir)) {
                if (dir.isDirectory) {
                    await readDir(
                        join(endpointsDir, dir.name, "fixtures"),
                        "endpoint",
                    );
                }
            }
        }
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    async choose(doc: EndpointDoc): Promise<FixtureChoice | null> {
        const cached = this.choice.get(doc.id);
        if (cached !== undefined) return cached;
        const requestUrl = doc.request.url;
        const bindings = {
            "request.url": requestUrl,
            "request.origin":
                new URL(requestUrl.replace(/\{[^}]+\}/g, "x")).origin,
        };
        const target = pathPattern(requestUrl);
        const scored = (await this.load(doc.provider))
            .filter((f) => f.fixture.calls.length > 0)
            .filter((f) =>
                target.test(
                    stripQuery(bind(f.fixture.calls[0].req.url, bindings)),
                )
            )
            .map((f) => ({ f, rank: rankOf(f) }))
            .sort((a, b) =>
                a.rank - b.rank || a.f.path.localeCompare(b.f.path)
            );
        const best = scored[0]?.f;
        const picked = best
            ? { fixture: best.fixture, bindings, path: best.path }
            : null;
        this.choice.set(doc.id, picked);
        return picked;
    }
}

function rankOf(f: IndexedFixture): number {
    const name = f.path.split("/").pop() ?? "";
    const last = f.fixture.calls[f.fixture.calls.length - 1];
    let rank = 0;
    if (f.level === "provider") rank += 8;
    if (name.startsWith("synthetic-")) rank += 4;
    if (last.res.status >= 400) rank += 2;
    if (!name.includes("happy")) rank += 1;
    return rank;
}

export function bind(
    template: string,
    bindings: Record<string, string>,
): string {
    return template.replace(
        /\{\{([A-Za-z_][\w.-]*)\}\}/g,
        (whole, key: string) => bindings[key] ?? whole,
    );
}

function stripQuery(url: string): string {
    const q = url.indexOf("?");
    return (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, "");
}

function pathPattern(requestUrl: string): RegExp {
    const base = stripQuery(requestUrl);
    const escaped = base
        .split(/\{[^}]+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
    return new RegExp(`^${escaped}$`);
}
