/**
 * BM25 over the catalog (v1 decision 1: no embeddings). Field weighting is
 * done the BM25F-lite way — a field's tokens are repeated `weight` times
 * into one bag — which is plenty for ~700 short documents. Scoring the whole
 * corpus is a few hundred microseconds; no ANN index, no external service.
 */
const STOPWORDS = new Set(
    ("a an and are as at be by for from get i in into is it its me my of on " +
        "or that the their this to via was what when where which who will " +
        "with you your find search lookup look up data api endpoint tool")
        .split(" "),
);

/** Lowercase, split on non-alphanumerics, drop stopwords, light stemming. */
export function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 2 || STOPWORDS.has(raw)) continue;
        out.push(stem(raw));
    }
    return out;
}

function stem(word: string): string {
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

export class Bm25Index {
    private readonly ids: string[] = [];
    private readonly lengths: number[] = [];
    /** term → (docIndex → tf) */
    private readonly postings = new Map<string, Map<number, number>>();
    private avgLength = 0;

    constructor(
        docs: Bm25Doc[],
        private readonly k1 = 1.2,
        private readonly b = 0.75,
    ) {
        let total = 0;
        docs.forEach((doc, index) => {
            this.ids.push(doc.id);
            let length = 0;
            for (const field of doc.fields) {
                const tokens = tokenize(field.text);
                const reps = Math.max(1, Math.round(field.weight));
                for (const token of tokens) {
                    let posting = this.postings.get(token);
                    if (!posting) this.postings.set(token, posting = new Map());
                    posting.set(index, (posting.get(index) ?? 0) + reps);
                    length += reps;
                }
            }
            this.lengths.push(length);
            total += length;
        });
        this.avgLength = docs.length ? total / docs.length : 0;
    }

    get size(): number {
        return this.ids.length;
    }

    search(query: string, limit: number): Bm25Hit[] {
        const terms = [...new Set(tokenize(query))];
        const scores = new Map<number, number>();
        const n = this.ids.length;
        for (const term of terms) {
            const posting = this.postings.get(term);
            if (!posting) continue;
            const idf = Math.log(
                1 + (n - posting.size + 0.5) / (posting.size + 0.5),
            );
            for (const [doc, tf] of posting) {
                const norm = tf * (this.k1 + 1) /
                    (tf +
                        this.k1 *
                            (1 - this.b +
                                this.b * this.lengths[doc] / this.avgLength));
                scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
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
