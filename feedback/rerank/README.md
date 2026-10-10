# feedback/rerank

Pure, deterministic re-ranking of `discover` candidates from agent feedback. No
I/O, no dependencies, no randomness at request time.

```ts
import { buildSnapshot, rerank } from "@monid/feedback-rerank";

// Worker, every ~60 s: decayed, trust-weighted evidence -> immutable snapshot.
const snapshot = buildSnapshot(rows, { version: 42, builtAt: new Date().toISOString(), flags });

// Request path: BM25 shortlist -> re-ranked top `limit`.
const { ranked, propensities, explorationSlot } = rerank(
    [{ endpoint: "acme/news-search", baseScore: 7.1, health: 1 }, ...],
    snapshot, // or null when none is loaded: behaves like control
    { workspaceId, clusterId: "news", limit: 10, arm: "treatment" },
);
```

## Scoring

Evidence rows are `{endpoint, cluster, aspect, s, f}` with aspect
`reliability | quality`. Shrinkage is hierarchical empirical Bayes with prior
strength `k` (default 10):

- global mean `mu_g = avg(0.5, (1 + s_i) / (2 + s_i + f_i) for every cell i)`
- cluster mean
  `mu_c = avg(mu_g, (k*mu_g + s_e) / (k + s_e + f_e) for every endpoint e in c)`
- cluster prior `Beta(k*mu_c, k*(1-mu_c))`
- cell posterior `Beta(k*mu_c + s, k*(1-mu_c) + f)`

`avg(parent, children)` counts the parent as one extra child. Each endpoint
counts once toward its cluster's mean, however much traffic it has. Pooled raw
counts don't work here because implicit evidence is lopsided (a clean success
adds 0.05, a failure adds 1): one failing endpoint became its cluster's norm,
and its own term came out near zero. The M4 sim found this.

Each cell stores `lower`, the weighted (default reliability 0.7, quality 0.3)
sum of each aspect's **10th percentile**, and `width`, the weighted 10-90%
interval width. The Beta quantile is computed in `beta.ts` (Halley iteration on
the regularized incomplete beta); tests check it against scipy.

```
term  = clamp(gain * (cell.lower - clusterPrior.lower), -0.15, +0.15)   gain = 0.5
final = baseScore * health * flag * (1 + term)
```

A missing cell means `term = 0`. **Health and flag multipliers are outside the
cap**: an outage or a severe flag can demote an endpoint by more than 15%; crowd
feedback cannot. Latency and cost don't enter feedback cells; they come from
live metrics.

Because `lower` is pessimistic, a well-measured endpoint that performs at its
cluster's average earns a small bonus over an unmeasured one (about +5-7% at n =
100-1000 in a synthetic example). Unmeasured endpoints are neutral, not
penalized, and exploration is what gives them traffic.

## Exploration and propensities

Treatment only. `u = uniform(FNV-1a(workspaceId, clusterId, snapshot.version))`.
If `u < epsilon` (default 0.1), the **last** shown slot is replaced by the
eligible candidate below the cut with the widest interval (eligible: final score

> 0, i.e. health and flag > 0). Same inputs, same output; the decision changes
> when the snapshot version does.

Propensity of endpoint `e` at position `i`, with `eps = 0` when nothing is
eligible to explore:

```
P(e, i) = (1 - eps) * [exploit[i] = e] + eps * [explore[i] = e]
```

So positions above the last are 1, and the last slot is `1 - eps` for the
exploit pick and `eps` for the explore pick. `policy()` returns both branches
for logging.

## Tuning

Weights are reliability 0.7 and quality 0.3. Failures count against reliability
only; counting them against quality too would count the same evidence twice.

The gain is checked by `tuning_test.ts`. The test cluster is a dense news-search
cluster with 5 endpoints and 200 runs each (the sim's dense endpoints saw
roughly 180-255). It uses implicit signals only, weighted like the sim: failure
1, clean success 0.05. Each cell is the feedback term:

| gain | (a) 60% failures | (b) 10% failures | (c) healthy  |
| ---- | ---------------- | ---------------- | ------------ |
| 0.5  | -0.116           | -0.034           | +0.102       |
| 0.75 | -0.150 (cap)     | -0.051           | +0.150 (cap) |
| 1.0  | -0.150 (cap)     | -0.067           | +0.150 (cap) |

Rule: take the lowest gain where (a) is in [-0.15, -0.10], (b) >= -0.03, and (c)
< 0.15. **No gain in the set meets all three**, so the default stays at 0.5, the
closest option: (a) and (c) hold, and (b) misses by 0.004.

(b) can't be fixed with gain. With successes worth 0.05, an endpoint failing 10%
of the time has a reliability mean of about 0.31 (0.045 / 0.145), and more
traffic only pushes its lower bound down. At gain 0.5 it passes up to about 150
runs per endpoint and fails beyond that. Fixing it means changing the signal
weights (the 0.05 success weight), not the gain.

## Caveat

This has only been tested on synthetic data. The defaults (`k = 10`,
`gain = 0.5`, `epsilon = 0.1`, the 15% cap) are reasonable starting points, not
tuned values.
