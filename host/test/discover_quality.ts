import { call, makeHost } from "./helpers.ts";

/**
 * Discover quality over the full catalog: queries an agent would plausibly
 * send, the leaf they belong to, and how many of the top 5 should come from
 * that leaf. Relevance is leaf membership, so no case names an endpoint.
 */
export interface QualityCase {
    query: string;
    leaf: string;
    /** Sibling leaves that are an equally fair answer (overlapping taxonomy). */
    alsoOk?: string[];
    /** Minimum top-5 results tagged with an accepted leaf. */
    minInTop5: number;
}

export const QUALITY_CASES: QualityCase[] = [
    {
        query: "latest news articles about Canva",
        leaf: "news-search",
        minInTop5: 4,
    },
    {
        query: "news search for electric vehicle tariffs this week",
        leaf: "news-search",
        minInTop5: 4,
    },
    {
        query: "recent headlines on the Boeing strike",
        leaf: "news-search",
        minInTop5: 4,
    },
    {
        query: "what is the press saying about Nvidia earnings",
        leaf: "news-search",
        minInTop5: 4,
    },
    {
        query: "how much funding has Stripe raised and from which investors",
        leaf: "funding-data",
        minInTop5: 3,
    },
    {
        query: "recent venture deals and valuations for fintech startups",
        leaf: "funding-data",
        minInTop5: 3,
    },
    {
        query: "find the work email and phone number of a person",
        leaf: "people-enrichment",
        minInTop5: 3,
    },
    {
        query: "contact lookup for a sales lead by name and company",
        leaf: "people-enrichment",
        minInTop5: 3,
    },
    {
        query: "scrape the content of a web page url",
        leaf: "web-scraping",
        alsoOk: ["web-extraction"],
        minInTop5: 3,
    },
    {
        query: "backlinks and keyword rankings for a domain",
        leaf: "seo",
        minInTop5: 3,
    },
    {
        query: "generate a short video from a text prompt",
        leaf: "video-generation",
        minInTop5: 3,
    },
    {
        query: "create an image from a text description",
        leaf: "image-generation",
        minInTop5: 3,
    },
];

export interface QualityRow extends QualityCase {
    clusterId: string;
    leafOk: boolean;
    inTop5: number;
    top5: string[];
}

export async function evaluateQuality(
    cases = QUALITY_CASES,
): Promise<QualityRow[]> {
    const host = await makeHost();
    const rows: QualityRow[] = [];
    for (const c of cases) {
        const res = await call(host, "POST", "/v1/discover", {
            query: c.query,
            limit: 5,
        }, { headers: { "x-monid-arm": "control" } });
        const results = res.body.results as {
            provider: string;
            endpoint: string;
            tags: string[];
        }[];
        const accepted = [c.leaf, ...(c.alsoOk ?? [])];
        rows.push({
            ...c,
            clusterId: res.body.clusterId,
            leafOk: accepted.includes(res.body.clusterId),
            inTop5: results.filter((r) =>
                r.tags.some((t) => accepted.includes(t))
            ).length,
            top5: results.map((r) =>
                `${r.provider}#${r.endpoint.replace(/^\//, "")}`
            ),
        });
    }
    await host.close();
    return rows;
}
