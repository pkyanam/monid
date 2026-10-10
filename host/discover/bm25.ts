/**
 * BM25 over the catalog (v1 decision 1: no embeddings), with BM25F field
 * weighting (see Bm25Index). Scoring the whole corpus is a few hundred
 * microseconds; no ANN index, no external service.
 */
const STOPWORDS = new Set(
    ("a an and are as at be by for from get i in into is it its me my of on " +
        "or that the their this to via was what when where which who will " +
        "with you your find lookup look up data api endpoint tool " +
        // recency / chatter words: every live endpoint is "latest", so they
        // only add noise when matched against descriptions
        "about latest recent recently current currently new newest today " +
        "week weeks month this these those saying say said tell show give " +
        "please some any all")
        .split(" "),
);

/**
 * Query-side synonyms (one-way, applied to the query only): words agents
 * use for an intent that endpoint docs phrase differently.
 */
const QUERY_SYNONYMS: Record<string, string[]> = {
    press: ["news"],
    headline: ["news"],
    headlines: ["news"],
    article: ["news"],
    articles: ["news"],
    coverage: ["news"],
    media: ["news"],
    journalist: ["news"],
    stories: ["news"],
    story: ["news"],
    google: ["serp"],
    forecast: ["weather"],
};

let stemmedCache: Map<string, string[]> | undefined;
/** Synonym keys/values run through the same stemmer as the index (lazy: NO_STEM is declared below). */
function stemmedSynonyms(): Map<string, string[]> {
    return stemmedCache ??= new Map(
        Object.entries(QUERY_SYNONYMS).map((
            [k, v],
        ) => [stem(k), v.map(stem)]),
    );
}

/** Tokenize a query and append its synonyms (each once). */
export function tokenizeQuery(text: string): string[] {
    const out = tokenize(text);
    const extra = new Set<string>();
    const synonyms = stemmedSynonyms();
    for (const t of out) {
        for (const syn of synonyms.get(t) ?? []) {
            if (!out.includes(syn)) extra.add(syn);
        }
    }
    return [...out, ...extra];
}

/** Lowercase, split on non-alphanumerics, drop stopwords, light stemming. */
export function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 2 || STOPWORDS.has(raw)) continue;
        out.push(stem(raw));
    }
    return out;
}

/** Words the suffix rules would mangle into something else ("news" ≠ "new"). */
const NO_STEM = new Set([
    "news",
    "series",
    "species",
    "status",
    "census",
    "analysis",
    "gas",
    "bus",
    "yes",
]);

function stem(word: string): string {
    if (NO_STEM.has(word)) return word;
    if (word.length > 5 && word.endsWith("ies")) return word.slice(0, -3) + "y";
    if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("es") && !word.endsWith("ses")) {
        return word.slice(0, -2);
    }
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
        return word.slice(0, -1);
    }
    return word;
}

export interface Bm25Doc {
    id: string;
    fields: { text: string; weight: number }[];
}

export interface Bm25Hit {
    id: string;
    score: number;
}

/**
 * BM25F: each field's term frequency is length-normalized against that
 * field's own average before the weighted sum is saturated, so a long
 * description does not dilute a match in a short title.
 */
export class Bm25Index {
    private readonly ids: string[] = [];
    /** term → (docIndex → weighted, per-field normalized tf) */
    private readonly postings = new Map<string, Map<number, number>>();

    constructor(
        docs: Bm25Doc[],
        private readonly k1 = 1.2,
        b = 0.75,
    ) {
        const tokenized = docs.map((doc) =>
            doc.fields.map((f) => ({
                tokens: tokenize(f.text),
                weight: f.weight,
            }))
        );
        // average length per field position (docs share a field layout)
        const sums: number[] = [];
        const counts: number[] = [];
        for (const fields of tokenized) {
            fields.forEach((f, i) => {
                sums[i] = (sums[i] ?? 0) + f.tokens.length;
                counts[i] = (counts[i] ?? 0) + 1;
            });
        }
        tokenized.forEach((fields, index) => {
            this.ids.push(docs[index].id);
            fields.forEach((f, i) => {
                const avg = sums[i] / counts[i] || 1;
                const norm = 1 - b + b * f.tokens.length / avg;
                for (const token of f.tokens) {
                    let posting = this.postings.get(token);
                    if (!posting) this.postings.set(token, posting = new Map());
                    posting.set(
                        index,
                        (posting.get(index) ?? 0) + f.weight / norm,
                    );
                }
            });
        });
    }

    get size(): number {
        return this.ids.length;
    }

    search(query: string, limit: number): Bm25Hit[] {
        const terms = [...new Set(tokenizeQuery(query))];
        const scores = new Map<number, number>();
        const n = this.ids.length;
        for (const term of terms) {
            const posting = this.postings.get(term);
            if (!posting) continue;
            const idf = Math.log(
                1 + (n - posting.size + 0.5) / (posting.size + 0.5),
            );
            for (const [doc, tf] of posting) {
                const sat = tf * (this.k1 + 1) / (tf + this.k1);
                scores.set(doc, (scores.get(doc) ?? 0) + idf * sat);
            }
        }
        return [...scores.entries()]
            .sort((a, b) =>
                b[1] - a[1] || this.ids[a[0]].localeCompare(this.ids[b[0]])
            )
            .slice(0, limit)
            .map(([doc, score]) => ({ id: this.ids[doc], score }));
    }
}

/** Saturating 0..1 relevance for the wire's `score` / `minScore`. */
export function normalizeScore(raw: number, k = 8): number {
    return raw <= 0 ? 0 : Math.round((raw / (raw + k)) * 1e4) / 1e4;
}
