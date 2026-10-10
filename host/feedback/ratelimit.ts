/** Sliding one-minute window per key (v1: 60 feedback calls/min/key). In memory. */
export class RateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly perMinute: number) {}

    /** Returns 0 when allowed, else ms until the next slot frees. */
    take(key: string, now: number): number {
        const windowStart = now - 60_000;
        const list = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
        if (list.length >= this.perMinute) {
            this.hits.set(key, list);
            return list[0] + 60_000 - now;
        }
        list.push(now);
        this.hits.set(key, list);
        return 0;
    }
}
