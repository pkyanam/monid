/**
 * The sim scenario: one category leaf, the endpoints in it that have recorded
 * fixtures in this repo, and queries that should land in that leaf.
 */

export const LEAF = "news-search";

export interface ScenarioEndpoint {
    /** Catalog id, `provider#endpoint`. */
    id: string;
    /** Base relevance the stub host uses in place of BM25. */
    stubBaseScore: number;
    /** Run input for a query, in the CLI's EndpointInput shape. */
    input: (query: string) => Record<string, unknown>;
}

// All five have fixtures under connectors/<provider>/**/fixtures.
export const ENDPOINTS: ScenarioEndpoint[] = [
    {
        id: "opoint#search",
        stubBaseScore: 10,
        input: (q) => ({ body: { searchterm: q } }),
    },
    {
        id: "search1api#news",
        stubBaseScore: 9.4,
        input: (q) => ({ body: { query: q, max_results: 5 } }),
    },
    {
        id: "akta#v1/news",
        stubBaseScore: 9,
        input: (q) => ({ queryParams: { query: q, limit: 5 } }),
    },
    {
        id: "octen#search",
        stubBaseScore: 8.6,
        input: (q) => ({ body: { query: q } }),
    },
    {
        id: "tinyfish#search",
        stubBaseScore: 8.2,
        input: (q) => ({ queryParams: { query: q } }),
    },
];

/** Degraded in phase 2 unless MONID_SIM_DEGRADE says otherwise. It is rank 1 on base score. */
export const DEFAULT_DEGRADE = "opoint#search";

export const QUERIES = [
    "latest news about Canva",
    "news coverage of the OpenAI funding round",
    "recent headlines on electric vehicle tariffs",
    "news articles about Nvidia earnings this week",
    "what is the press saying about the Boeing strike",
];
