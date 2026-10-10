import type { Bundle, EndpointDoc } from "@shared/core";

/**
 * Read-only view over the compiled bundle — what discover indexes, what
 * inspect returns, and how the wire's {provider, endpoint} pair maps to a
 * bundle id (`<provider>#<endpoint minus its leading slash>`).
 */
export interface CatalogEntry {
    id: string;
    provider: string;
    providerName: string;
    /** Wire spelling — the doc's `endpoint`, leading slash included. */
    endpoint: string;
    displayName: string;
    summary: string;
    description: string;
    categories: string[];
    notes: string[];
    docsUrl?: string;
    price: WirePrice;
    doc: EndpointDoc;
}

/** The stock CLI's `Price` shape (cli/src/api/types.ts), the subset we emit. */
export interface WirePrice {
    type: string;
    amount: { value: number; currency: string };
    per?: { unit: string; count: number };
    notes?: string[];
}

interface Consumes {
    credit: string;
    amount: number;
}
interface LeafModel {
    kind: "FREE" | "PER_CALL" | "PER_UNIT";
    unit?: string;
    every?: number;
    consumes?: Consumes;
    label?: string;
}
interface CompositeModel {
    kind: "COMPOSITE";
    components: Record<string, LeafModel>;
}

const PRICE_NOTE =
    "Self-hosted test host: vendor credit rates from the connector rate card, not Monid's brokered price.";

/**
 * Derive a wire price from the doc's rate card (D26). This host has no
 * Broker, so amounts are the vendor credits the card consumes; a pool
 * labelled "US dollars" is reported as USD, any other pool by its id.
 */
export function priceOf(doc: EndpointDoc): WirePrice {
    const usage = doc.usage as unknown as {
        model: LeafModel | CompositeModel;
        credits?: Record<string, { label?: string }>;
    };
    const credits = usage.credits ?? {};
    const money = (c?: Consumes) => ({
        value: c?.amount ?? 0,
        currency: c
            ? (credits[c.credit]?.label === "US dollars" ? "USD" : c.credit)
            : "USD",
    });
    const leaf = (m: LeafModel): WirePrice => {
        switch (m.kind) {
            case "FREE":
                return {
                    type: "PER_CALL",
                    amount: { value: 0, currency: "USD" },
                };
            case "PER_CALL":
                return { type: "PER_CALL", amount: money(m.consumes) };
            case "PER_UNIT":
                return m.unit === "RESULT"
                    ? { type: "PER_RESULT", amount: money(m.consumes) }
                    : {
                        type: "METERED",
                        amount: money(m.consumes),
                        per: { unit: m.unit ?? "UNIT", count: m.every ?? 1 },
                    };
        }
    };
    const model = usage.model;
    if (model.kind !== "COMPOSITE") {
        return { ...leaf(model), notes: [PRICE_NOTE] };
    }
    const parts = Object.entries(model.components);
    const base = parts.find(([, c]) => c.kind === "PER_CALL") ?? parts[0];
    const price = base ? leaf(base[1]) : leaf({ kind: "FREE" });
    const extras = parts
        .filter((p) => p !== base)
        .map(([id, c]) =>
            `+ ${c.label ?? id}: ${c.consumes?.amount ?? 0} ${
                money(c.consumes).currency
            } per ${c.unit?.toLowerCase() ?? "call"}`
        );
    return { ...price, notes: [PRICE_NOTE, ...extras] };
}

export class Catalog {
    readonly entries: CatalogEntry[];
    private readonly byId = new Map<string, CatalogEntry>();
    readonly categoryNames: Map<string, string>;

    constructor(readonly bundle: Bundle) {
        this.categoryNames = new Map(
            bundle.taxonomy.leaves.map((leaf) => [leaf.id, leaf.displayName]),
        );
        this.entries = Object.values(bundle.endpoints)
            .map((doc) => {
                const provider = bundle.providers[doc.provider];
                const meta = doc.meta as EndpointDoc["meta"] & {
                    notes?: string[];
                };
                const entry: CatalogEntry = {
                    id: doc.id,
                    provider: doc.provider,
                    providerName: provider?.meta.displayName ?? doc.provider,
                    endpoint: doc.endpoint,
                    displayName: meta.displayName,
                    summary: meta.summary,
                    description: meta.description ?? meta.summary,
                    categories: [...(meta.categories ?? [])],
                    notes: [...(meta.notes ?? [])],
                    docsUrl: meta.docsUrl,
                    price: priceOf(doc),
                    doc,
                };
                return entry;
            })
            .sort((a, b) => a.id.localeCompare(b.id));
        for (const entry of this.entries) this.byId.set(entry.id, entry);
    }

    get(id: string): CatalogEntry | undefined {
        return this.byId.get(id);
    }

    /** Wire pair → entry. Accepts the endpoint with or without its slash. */
    resolve(provider: string, endpoint: string): CatalogEntry | undefined {
        const path = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
        return this.byId.get(`${provider}#${path}`);
    }

    /** A run's default cluster when no impression links it. */
    primaryCategory(id: string): string {
        return this.byId.get(id)?.categories[0] ?? "uncategorized";
    }
}
