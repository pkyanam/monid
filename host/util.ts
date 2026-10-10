/** Small shared helpers: ids, clock, hashing. */

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/** `<prefix>_<26 hex>`: time-ordered prefix + random tail. */
export function newId(prefix: string, now: number = Date.now()): string {
    const time = now.toString(16).padStart(12, "0");
    const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 14);
    return `${prefix}_${time}${rand}`;
}

/** FNV-1a 32-bit — stable, dependency-free bucketing (arms, seeds). */
export function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export type Arm = "treatment" | "control";

/** Workspace-level assignment (one agent never straddles arms). */
export function assignArm(
    workspaceId: string,
    salt: string,
    controlPercent: number,
): Arm {
    return fnv1a(`${salt}:${workspaceId}`) % 100 < controlPercent
        ? "control"
        : "treatment";
}

export function percentile(sorted: number[], p: number): number | undefined {
    if (sorted.length === 0) return undefined;
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Deterministic Response helpers. */
export function json(
    body: unknown,
    status = 200,
    headers: HeadersInit = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly headers: Record<string, string> = {},
    ) {
        super(message);
    }
}

export function errorResponse(error: HttpError): Response {
    return json(
        { error: { code: error.code, message: error.message } },
        error.status,
        error.headers,
    );
}
