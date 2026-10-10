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
counts don't work here: traffic is uneven (agents mostly take rank 1), and
quality evidence is lopsided. With pooling, one busy failing endpoint became its
cluster's norm, and its own term came out near zero. The M4 sim found this.

Each cell stores `lower`, the weighted (default reliability 0.7, quality 0.3)
sum of each aspect's **10th percentile**, and `width`, the weighted 10-90%
interval width. The Beta quantile is computed in `beta.ts` (Halley iteration on
the regularized incomplete beta); tests check it against scipy.

```
term  = clamp(gain * (cell.lower - clusterPrior.lower), -0.15, +0.15)   gain = 0.6
final = baseScore * health * flag * (1 + term)
```

A missing cell means `term = 0`. **Health and flag multipliers are outside the
cap**: an outage or a severe flag can demote an endpoint by more than 15%; crowd
feedback cannot. Latency and cost don't enter feedback cells; they come from
live metrics.

Because `lower` is pessimistic, a well-measured endpoint that performs at its
cluster's average earns a small bonus over an unmeasured one (about +6-9% at n =
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

**Signal weights** (implicit, per run; the sim stub uses these and the host's
aggregation should match):

| event                | reliability | quality  |
| -------------------- | ----------- | -------- |
| run failed           | f + 1       |          |
| run completed, empty | s + 1       | f + 1    |
| run completed, clean | s + 1       | s + 0.05 |

So reliability is an honest per-run success rate. A clean success is only a weak
quality positive, and failures never count against quality, which would count
the same evidence twice. Aspect weights are reliability 0.7 and quality 0.3.

**Gain sweep** (`tuning_test.ts`): a news-search cluster with 5 endpoints at 60%
failures (a), 10% failures (b) and three healthy (c), using implicit signals
only. Each entry is a / b / c:

| gain | 50 runs each                 | 200 runs each                | 1000 runs each               |
| ---- | ---------------------------- | ---------------------------- | ---------------------------- |
| 0.5  | -0.0967 / +0.065 / +0.104    | -0.1012 / +0.078 / +0.119    | -0.0995 / +0.079 / +0.117    |
| 0.6  | -0.116 / +0.078 / +0.125     | -0.121 / +0.093 / +0.143     | -0.119 / +0.095 / +0.141     |
| 0.75 | -0.145 / +0.097 / +0.150 cap | -0.150 / +0.116 / +0.150 cap | -0.149 / +0.118 / +0.150 cap |
| 1.0  | -0.150 / +0.129 / +0.150 cap | -0.150 / +0.150 / +0.150 cap | -0.150 / +0.150 / +0.150 cap |

**Rule**: take the lowest gain where, at every volume, (a) is in [-0.15, -0.10],
(b) >= -0.03, and (c) < 0.15.

**Default: 0.6**, the lowest swept gain that passes at every volume. At 0.5, (a)
misses -0.10 by 0.003 at 50 runs and 0.0005 at 1000 runs. At 0.75 and 1.0,
healthy endpoints hit the cap. `tuning_test.ts` pins the table and asserts all
three criteria at the default.

(b) comes out positive because the cluster average includes the 60%-failure
endpoint, so a 10%-failure endpoint is above average.

## Caveat

This has only been tested on synthetic data. The defaults (`k = 10`,
`gain = 0.6`, `epsilon = 0.1`, the 15% cap) are reasonable starting points, not
tuned values.
