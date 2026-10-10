/**
 * "Empty" = the vendor answered successfully but with nothing in it: null,
 * an empty string/array/object, or an object whose every array is empty
 * and that carries no other non-empty payload besides counters/metadata.
 * Heuristic by design (v1 implicit signal, weight 0.25): a legitimately
 * empty answer ("no such company") reads the same, hence the low weight.
 */
const META_KEYS = new Set([
    "total",
    "count",
    "page",
    "pages",
    "limit",
    "offset",
    "next",
    "cursor",
    "status",
    "success",
    "requestid",
    "request_id",
    "took",
    "credits",
    "cost",
    "message",
]);

const META_PREFIX = /^(total|num|count|has_more|next_)/i;

export function isEmptyOutput(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value !== "object") return false;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return true;
    // Scalars beside a container are echoes/metadata ({query, total_results,
    // results: []}); without any container, only all-meta objects are empty.
    let sawContainer = false;
    let sawPayloadScalar = false;
    for (const [key, v] of entries) {
        if (META_KEYS.has(key.toLowerCase()) || META_PREFIX.test(key)) continue;
        if (Array.isArray(v)) {
            sawContainer = true;
            if (v.length > 0) return false;
        } else if (v && typeof v === "object") {
            sawContainer = true;
            if (!isEmptyOutput(v)) return false;
        } else if (v !== null && v !== "" && v !== undefined) {
            sawPayloadScalar = true;
        }
    }
    return sawContainer || !sawPayloadScalar;
}
