/**
 * Beta distribution quantile, self-contained (no dependencies).
 *
 * `betaQuantile` inverts the regularized incomplete beta function with
 * Halley steps from the Numerical Recipes (3rd ed., §6.4) starting guess.
 * `regularizedBeta` evaluates I_x(a, b) with the Lentz continued fraction.
 */

const EPS = 1e-12;
const MAX_CF_ITER = 10_000;

const LANCZOS = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lnGamma(x: number): number {
    if (x < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    }
    x -= 1;
    let sum = LANCZOS[0];
    for (let i = 1; i < 9; i++) sum += LANCZOS[i] / (x + i);
    const t = x + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t +
        Math.log(sum);
}

function lnBeta(a: number, b: number): number {
    return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/** Continued fraction for I_x(a, b), modified Lentz. Converges fast for x < (a+1)/(a+b+2). */
function betaContinuedFraction(a: number, b: number, x: number): number {
    const tiny = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAX_CF_ITER; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) return h;
    }
    return h;
}

/** Regularized incomplete beta I_x(a, b), the Beta(a, b) CDF at x. */
export function regularizedBeta(x: number, a: number, b: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lnBeta(a, b));
    return x < (a + 1) / (a + b + 2)
        ? (front * betaContinuedFraction(a, b, x)) / a
        : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Inverse CDF of Beta(a, b) at probability p. Requires a, b > 0. */
export function betaQuantile(p: number, a: number, b: number): number {
    if (!(a > 0 && b > 0)) throw new RangeError(`invalid Beta(${a}, ${b})`);
    if (p <= 0) return 0;
    if (p >= 1) return 1;

    let x: number;
    if (a >= 1 && b >= 1) {
        const pp = p < 0.5 ? p : 1 - p;
        const t = Math.sqrt(-2 * Math.log(pp));
        let z = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
        if (p < 0.5) z = -z;
        const al = (z * z - 3) / 6;
        const h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1));
        const w = (z * Math.sqrt(al + h)) / h -
            (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h));
        x = a / (a + b * Math.exp(2 * w));
    } else {
        const t = Math.exp(a * Math.log(a / (a + b))) / a;
        const u = Math.exp(b * Math.log(b / (a + b))) / b;
        const w = t + u;
        x = p < t / w
            ? Math.pow(a * w * p, 1 / a)
            : 1 - Math.pow(b * w * (1 - p), 1 / b);
    }

    const a1 = a - 1, b1 = b - 1, lnB = lnBeta(a, b);
    for (let j = 0; j < 20; j++) {
        if (x <= 0 || x >= 1) return Math.min(1, Math.max(0, x));
        const err = regularizedBeta(x, a, b) - p;
        const pdf = Math.exp(a1 * Math.log(x) + b1 * Math.log1p(-x) - lnB);
        const u = err / pdf;
        const step = u / (1 - 0.5 * Math.min(1, u * (a1 / x - b1 / (1 - x))));
        x -= step;
        if (x <= 0) x = 0.5 * (x + step);
        if (x >= 1) x = 0.5 * (x + step + 1);
        if (Math.abs(step) < 1e-10 * x && j > 0) break;
    }
    return x;
}
