/**
 * Build a run input from an inspect response the way an agent would: put the
 * query in the endpoint's search-like field and fill whatever else the
 * schema requires with the smallest valid value. Endpoints that need ids
 * from an earlier call get placeholders and will usually fail, as they would
 * for an agent that skipped the lookup.
 */
type Schema = Record<string, unknown>;

const QUERY_FIELD =
    /^(q|query|keywords?|searchterm|search|search_?query|prompt|text|topic)$/i;
const LOCATIONS = ["pathParams", "queryParams", "body"] as const;

export function buildInput(
    input: Record<string, unknown> | undefined,
    query: string,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const loc of LOCATIONS) {
        const schema = input?.[loc] as Schema | undefined;
        if (schema) {
            const value = fillObject(objectBranch(schema), query);
            if (Object.keys(value).length > 0) out[loc] = value;
        }
    }
    return out;
}

/** First object-shaped `anyOf`/`oneOf` branch, else the schema itself. */
function objectBranch(schema: Schema): Schema {
    const branches = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
    return branches?.find((b) => b.type === "object" || b.properties) ?? schema;
}

function fillObject(schema: Schema, query: string): Record<string, unknown> {
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const required = new Set((schema.required ?? []) as string[]);
    const out: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(props)) {
        if (required.has(name) || QUERY_FIELD.test(name)) {
            out[name] = fill(prop, query, QUERY_FIELD.test(name));
        }
    }
    return out;
}

function fill(schema: Schema, query: string, isQuery: boolean): unknown {
    if ("const" in schema) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    if (schema.default !== undefined && !isQuery) return schema.default;
    const branch = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
    if (branch?.length) return fill(branch[0], query, isQuery);
    switch (schema.type) {
        case "string": {
            const max = typeof schema.maxLength === "number"
                ? schema.maxLength
                : Infinity;
            return isQuery ? query.slice(0, max) : "x".repeat(
                Math.max(1, Number(schema.minLength ?? 1)),
            );
        }
        case "integer":
        case "number":
            return Math.max(Number(schema.minimum ?? 1), 1);
        case "boolean":
            return false;
        case "array": {
            const items = (schema.items ?? {}) as Schema;
            const n = Math.max(1, Number(schema.minItems ?? 1));
            return Array.from(
                { length: n },
                () => items.type ? fill(items, query, isQuery) : query,
            );
        }
        case "object":
            return fillObject(schema, query);
        default:
            return query;
    }
}
