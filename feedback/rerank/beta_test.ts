import { assertAlmostEquals } from "@std/assert";
import { betaQuantile, regularizedBeta } from "./beta.ts";

// Reference values from scipy.stats.beta.ppf(p, a, b), scipy 1.18.1.
const SCIPY: [p: number, a: number, b: number, x: number][] = [
    [0.1, 0.5, 0.5, 0.024471741852423214],
    [0.1, 2, 3, 0.14255931671003072],
    [0.1, 5, 5, 0.3009687635932147],
    [0.9, 5, 5, 0.6990312364067853],
    [0.1, 0.3, 4, 8.843870482363649e-05],
    [0.1, 20, 180, 0.0738421321450173],
    [0.1, 105, 5, 0.9280017429600144],
    [0.9, 3.7, 96.3, 0.0622844336750619],
    [0.1, 5000, 5000, 0.49359234508768945],
    [0.1, 1e6 + 5, 5, 0.9999920064983169],
    [0.1, 5, 1e6 + 5, 2.4325710392423703e-06],
    [0.1, 1e6, 1e6, 0.49954690313516387],
];

Deno.test("betaQuantile matches scipy reference values", () => {
    for (const [p, a, b, x] of SCIPY) {
        assertAlmostEquals(
            betaQuantile(p, a, b),
            x,
            Math.max(1e-12, x * 1e-9),
            `Beta(${a}, ${b}) at ${p}`,
        );
    }
});

Deno.test("betaQuantile matches closed forms", () => {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
        assertAlmostEquals(betaQuantile(p, 1, 1), p, 1e-12);
        assertAlmostEquals(betaQuantile(p, 3, 1), p ** (1 / 3), 1e-12); // CDF x^a
        assertAlmostEquals(
            betaQuantile(p, 1, 4),
            1 - (1 - p) ** (1 / 4),
            1e-12,
        ); // CDF 1-(1-x)^b
    }
});

Deno.test("betaQuantile inverts regularizedBeta", () => {
    for (const [a, b] of [[0.7, 2.5], [10, 3], [50, 450], [2.5, 0.4]]) {
        for (const p of [0.05, 0.1, 0.5, 0.9]) {
            assertAlmostEquals(
                regularizedBeta(betaQuantile(p, a, b), a, b),
                p,
                1e-10,
            );
        }
    }
});
