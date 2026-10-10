/**
 * The sim scenario: the leaf the queries target and the queries. Against a real host the candidates come from its
 * discover over the whole catalog; ENDPOINTS is only the stub host's fixed
 * candidate list.
 */

export const LEAF = "news-search";

export interface ScenarioEndpoint {
    /** Catalog id, `provider#endpoint`. */
    id: string;
    /** Base relevance the stub host uses in place of BM25. */
    stubBaseScore: number;
    /** Catalog categories, primary first (a run with no discoverId counts there). */
    categories: string[];
}

// News-search endpoints with recorded fixtures under connectors/<provider>/**/fixtures.
export const ENDPOINTS: ScenarioEndpoint[] = [
    { id: "opoint#search", stubBaseScore: 10, categories: [LEAF] },
    { id: "search1api#news", stubBaseScore: 9.4, categories: [LEAF] },
    {
        id: "akta#v1/news",
        stubBaseScore: 9,
        categories: ["company-news", LEAF, "funding-data"],
    },
    {
        id: "octen#search",
        stubBaseScore: 8.6,
        categories: ["web-search", LEAF],
    },
    {
        id: "tinyfish#search",
        stubBaseScore: 8.2,
        categories: ["web-search", LEAF],
    },
];

/** Phrased the way an agent asks for news; each should land in LEAF. */
export const QUERIES = [
    "latest news articles about Canva",
    "news search for electric vehicle tariffs this week",
    "recent headlines on the Boeing strike",
    "what is the press saying about Nvidia earnings",
    "search news coverage of the Fed rate decision",
];
