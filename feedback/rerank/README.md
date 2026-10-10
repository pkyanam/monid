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

- global mean `mu_g = (1 + S) / (2 + S + F)`
- cluster prior `Beta(k*mu_c, k*(1-mu_c))`,
  `mu_c = (k*mu_g + S_c) / (k + S_c + F_c)`
- cell posterior `Beta(k*mu_c + s, k*(1-mu_c) + f)`

Each cell stores `lower`, the weighted (default 0.5/0.5) sum of each aspect's
**10th percentile**, and `width`, the weighted 10-90% interval width. The Beta
quantile is computed in `beta.ts` (Halley iteration on the regularized
incomplete beta); tests check it against scipy.

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

## Caveat

This has only been tested on synthetic data. The defaults (`k = 10`,
`gain = 0.5`, `epsilon = 0.1`, the 15% cap) are reasonable starting points, not
tuned values.
