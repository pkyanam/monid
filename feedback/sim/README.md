# feedback/sim

End-to-end simulation of the feedback loop (M4). Scripted agents talk to a Monid
host **over HTTP only**, one endpoint gets degraded, and the sim checks that it
slides down the treatment ranking while control stays flat.

**This proves the loop only in a synthetic world**: scripted agents, a fake
transport, injected faults. It says nothing about how real agents or real
providers behave.

```sh
deno task feedback:test   # rerank + sim tests, including the sim against the stub host
MONID_DECAY_HALF_LIFE_MS=60000 deno task sim:stub   # TEST-ONLY stub host on 127.0.0.1:8787
MONID_API_BASE_URL=http://127.0.0.1:8787 MONID_SIM_KEYS=k1,k2,k3,k4 \
  MONID_DECAY_HALF_LIFE_MS=60000 deno task sim   # exits 1 on a failed assertion
deno task sim:bench       # in-process rerank p50 / p99
```

## Scenario

Leaf `news-search`; the queries are news requests phrased the way an agent asks
("latest news articles about Canva", "news search for electric vehicle tariffs
this week", ...). Against a real host the candidates are whatever its discover
returns over the whole catalog. The degraded endpoint defaults to `auto`: the
one with the most successful warm-up runs, i.e. the endpoint the agents actually
depend on. An endpoint the agents rarely pick gathers too little evidence in one
learning phase to move; `MONID_SIM_DEGRADE` pins one. The sim checks the
degraded endpoint was in the top `MONID_SIM_LIMIT` before the fault in both
arms, so a target discover never shows fails instead of passing vacuously.

Phases: warm-up traffic, wait for a fresh snapshot, measure "before", turn on
the fault, learning traffic, wait for a fresh snapshot, measure "after".
Measurement windows only call discover, so they add no evidence. With
`MONID_SIM_FAULT_MODE=env` the fault is on from host start: warm-up is skipped
and "before" is measured first, which needs a fresh host with no evidence yet.

## Agent behaviour

- Seeded per key (`MONID_SIM_SEED`).
- Picks from the discover list: rank 1 75%, rank 2 17%, rank 3 8%.
- Inspects each endpoint the first time it sees it and builds the run input from
  the inspected schema (`input.ts`): the query goes in the search-like field
  (`q`, `query`, `keywords`, `searchterm`, ...), other required fields get the
  smallest valid value (first enum, `const`, minimum). Endpoints that need an id
  from an earlier call get a placeholder and usually fail, as they would for an
  agent that skipped the lookup.
- Runs with `discoverId` and polls `GET /v1/runs/:id` while the run is not
  terminal.
- On a failure or empty result, it retries the next result with the same
  `discoverId`, up to `MONID_SIM_MAX_RETRIES` (default 2) retries.
- Feedback (only with a `runId`):
  - failed: 50%, rating -2, `reliability`, `high`
  - empty: 40%, rating -1, `completeness`, `medium`
  - ok: 10%, rating 2, `correctness`, `low`
- An output counts as empty when it is missing or every top-level value is null,
  `[]` or `{}`.

## Host hooks the sim expects

Auth: `Authorization: Bearer <key>` on every call, one key per workspace.

| route                     | request                                                                     | response fields read                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/discover`       | `{query, limit}`                                                            | `results[].provider`, `.endpoint`, `.score`; position = rank. Additive: `discoverId`, `clusterId`, **`results[].quality.term` (required)**, `results[].quality.n`, `arm`, `snapshotVersion` |
| `POST /v1/inspect`        | `{provider, endpoint}`                                                      | `input` (`{pathParams?, queryParams?, body?}` JSON schemas; optional)                                                                                                                       |
| `POST /v1/run`            | `{provider, endpoint, input: {body?, queryParams?}, discoverId?}`           | `runId`, `status`, `providerResponse.data`                                                                                                                                                  |
| `GET /v1/runs/:id`        |                                                                             | `status`, `output`                                                                                                                                                                          |
| `POST /v1/feedback`       | `{runId, discoverId?, target: "endpoint", rating, text, aspects, severity}` | must be **202** `{feedbackId, status: "queued"}`                                                                                                                                            |
| `POST /v1/admin/faults`   | `{target: "provider#endpoint", error_rate, empty_rate?}`                    | any 2xx (needed for `MONID_SIM_FAULT_MODE=admin`)                                                                                                                                           |
| `POST /v1/admin/snapshot` | `{}`                                                                        | any 2xx (optional, only with `MONID_SIM_FORCE_SNAPSHOT=1`)                                                                                                                                  |

- **Endpoint id** = `provider#endpoint`, with a leading `/` stripped from
  `endpoint`.
- **Arms**: the host assigns them per workspace and reports `arm` on discover.
  If it doesn't, the sim falls back to `MONID_SIM_ARMS`, sent as the
  `X-Monid-Arm` request header. The host may honour that header in test mode.
- **`results[].quality: {term, n?}`** (REQUIRED): `term` is the clamped rerank
  feedback term actually applied to that result (0 in control); `n` is the
  evidence behind it. The sim asserts the degraded endpoint's own term goes
  negative in treatment after the fault. Without the field that assertion FAILS
  with "the host must expose results[].quality.term"; it is never skipped.
- **`MONID_DECAY_HALF_LIFE_MS`** (REQUIRED for a meaningful sim): the host's
  evidence half-life, applied as `0.5^(age / halfLife)`. Without decay the
  pre-fault successes never fade and the drop is mostly washed out. Use about
  `60000` with the default 60 s snapshots; the fast tests use 300 ms with 100 ms
  snapshots. Set the same value in the sim's env so the report shows it (the sim
  can't set it on a remote host).
- **Snapshots**: if discover carries `snapshotVersion`, the sim waits until it
  increases. Otherwise it sleeps 1.5 x `MONID_SNAPSHOT_INTERVAL_MS`.
- **Faults at start**:
  `MONID_FAKE_FAULTS='provider#endpoint:error_rate=0.6[,empty_rate=0.1][;...]'`.
- **Health**: the host's live health multiplier must not react to injected
  faults during the sim, or control will move too. Health applies to both arms
  by design.
- **Admin key**: admin calls use `MONID_ADMIN_KEY` if set, else the first sim
  key.

## Sim env

| var                                                    | default              | meaning                                                                          |
| ------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| `MONID_API_BASE_URL`                                   | (required)           | host base URL                                                                    |
| `MONID_SIM_KEYS`                                       | `MONID_API_KEY`      | comma-separated keys, one per workspace (need both arms)                         |
| `MONID_SIM_ARMS`                                       |                      | optional comma-separated `treatment`/`control`, aligned with keys                |
| `MONID_ADMIN_KEY`                                      | first key            | bearer for `/v1/admin/*`                                                         |
| `MONID_SIM_FAULT_MODE`                                 | `admin`              | `admin` flips the fault mid-run; `env` expects `MONID_FAKE_FAULTS` at host start |
| `MONID_SIM_DEGRADE` / `MONID_SIM_ERROR_RATE`           | `auto` / `0.6`       | what to degrade (`auto` = most successful warm-up runs; `env` mode needs an id)  |
| `MONID_SNAPSHOT_INTERVAL_MS`                           | `60000`              | host snapshot interval                                                           |
| `MONID_DECAY_HALF_LIFE_MS`                             |                      | the host's half-life, for the report (set it on the host too)                    |
| `MONID_SIM_FORCE_SNAPSHOT`                             |                      | `1` = use `POST /v1/admin/snapshot` (exactly reproducible)                       |
| `MONID_SIM_WARMUP` / `_LEARN` / `_MEASURE`             | `30` / `60` / `20`   | rounds (each round = one call per workspace)                                     |
| `MONID_SIM_LIMIT`, `_MAX_RETRIES`, `_POLL_MS`, `_SEED` | `5`, `2`, `50`, `42` |                                                                                  |
| `MONID_SIM_MIN_RANK_DROP` / `_CONTROL_TOLERANCE`       | `1` / `0.25`         | assertion thresholds                                                             |

Timer-driven snapshots, time-based decay and retry windows depend on the wall
clock, so the numbers can vary slightly between runs. The agent's choices are
always seeded. Exact reproducibility needs `MONID_SIM_FORCE_SNAPSHOT=1`, no
decay, and a retry window longer than the run.

## Stub host (test only)

`stub_host.ts` is a contract fixture, not a second host. It has:

- a fixed candidate list with no BM25
- synthetic run outputs
- in-memory evidence with decay (`MONID_DECAY_HALF_LIFE_MS`, kept per row as
  `S <- S * 0.5^(dt/halfLife) + new` and decayed to "now" at each snapshot), no
  trust weighting and no severe flags, following `host/feedback/worker.ts`:
  - every run: reliability s+1 (f+1 on failure); an empty result also quality
    f+1
  - when a run's window closes (completion + `MONID_HOST_RETRY_WINDOW_MS`,
    default 120000): quality f+0.5 if the workspace re-ran on another endpoint
    in the window (same `discoverId`, or this run failed/was empty and the retry
    is in the same cluster); otherwise a clean run earns quality s+0.05, once
    per (workspace, endpoint, cluster, window bucket)
  - feedback with rating r: s = (r+2)/4, f = 1-s on each scored aspect named
    (`reliability`; `correctness`/`completeness`/`schema`/`docs` -> quality); no
    aspects -> quality; `latency`, `cost`, `other` score nothing
  - a run's cluster is its `discoverId`'s cluster, else the endpoint's primary
    category (first in `scenario.ts`)
- a snapshot rebuilt on a timer with `@monid/feedback-rerank`
- `results[].quality: {term, n}` on discover
- no health signal

It implements exactly the hooks above.
