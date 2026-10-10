# feedback/sim

End-to-end simulation of the feedback loop (M4). Scripted agents talk to a Monid
host **over HTTP only**, one endpoint gets degraded, and the sim checks that it
slides down the treatment ranking while control stays flat.

**This proves the loop only in a synthetic world**: scripted agents, a fake
transport, injected faults. It says nothing about how real agents or real
providers behave.

```sh
deno task feedback:test   # rerank + sim tests, including the sim against the stub host
deno task sim:stub        # TEST-ONLY stub host on 127.0.0.1:8787
MONID_API_BASE_URL=http://127.0.0.1:8787 MONID_SIM_KEYS=k1,k2,k3,k4 \
  MONID_SNAPSHOT_INTERVAL_MS=500 deno task sim   # exits 1 on a failed assertion
deno task sim:bench       # in-process rerank p50 / p99
```

## Scenario

Leaf `news-search`. Five endpoints that have fixtures in this repo:
`opoint#search`, `search1api#news`, `akta#v1/news`, `octen#search`,
`tinyfish#search` (run inputs are in `scenario.ts`). The queries are plain news
questions that should land in that leaf. `opoint#search` is degraded by default.

Phases: warm-up traffic, wait for a fresh snapshot, measure "before", turn on
the fault, learning traffic, wait for a fresh snapshot, measure "after".
Measurement windows only call discover, so they add no evidence. With
`MONID_SIM_FAULT_MODE=env` the fault is on from host start: warm-up is skipped
and "before" is measured first, which needs a fresh host with no evidence yet.

## Agent behaviour

- Seeded per key (`MONID_SIM_SEED`).
- Picks from the discover list: rank 1 75%, rank 2 17%, rank 3 8%.
- Inspects each endpoint the first time it sees it.
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

| route                     | request                                                                     | response fields read                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/discover`       | `{query, limit}`                                                            | `results[].provider`, `.endpoint`, `.score`; position = rank. Additive: `discoverId`, `clusterId`, `arm`, `snapshotVersion` |
| `POST /v1/inspect`        | `{provider, endpoint}`                                                      | any 2xx                                                                                                                     |
| `POST /v1/run`            | `{provider, endpoint, input: {body?, queryParams?}, discoverId?}`           | `runId`, `status`, `providerResponse.data`                                                                                  |
| `GET /v1/runs/:id`        |                                                                             | `status`, `output`                                                                                                          |
| `POST /v1/feedback`       | `{runId, discoverId?, target: "endpoint", rating, text, aspects, severity}` | must be **202** `{feedbackId, status: "queued"}`                                                                            |
| `POST /v1/admin/faults`   | `{target: "provider#endpoint", error_rate, empty_rate?}`                    | any 2xx (needed for `MONID_SIM_FAULT_MODE=admin`)                                                                           |
| `POST /v1/admin/snapshot` | `{}`                                                                        | any 2xx (optional, only with `MONID_SIM_FORCE_SNAPSHOT=1`)                                                                  |

- **Endpoint id** = `provider#endpoint`, with a leading `/` stripped from
  `endpoint`.
- **Arms**: the host assigns them per workspace and reports `arm` on discover.
  If it doesn't, the sim falls back to `MONID_SIM_ARMS`, sent as the
  `X-Monid-Arm` request header. The host may honour that header in test mode.
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

| var                                                    | default                 | meaning                                                                          |
| ------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------- |
| `MONID_API_BASE_URL`                                   | (required)              | host base URL                                                                    |
| `MONID_SIM_KEYS`                                       | `MONID_API_KEY`         | comma-separated keys, one per workspace (need both arms)                         |
| `MONID_SIM_ARMS`                                       |                         | optional comma-separated `treatment`/`control`, aligned with keys                |
| `MONID_ADMIN_KEY`                                      | first key               | bearer for `/v1/admin/*`                                                         |
| `MONID_SIM_FAULT_MODE`                                 | `admin`                 | `admin` flips the fault mid-run; `env` expects `MONID_FAKE_FAULTS` at host start |
| `MONID_SIM_DEGRADE` / `MONID_SIM_ERROR_RATE`           | `opoint#search` / `0.6` | what to degrade                                                                  |
| `MONID_SNAPSHOT_INTERVAL_MS`                           | `60000`                 | host snapshot interval                                                           |
| `MONID_SIM_FORCE_SNAPSHOT`                             |                         | `1` = use `POST /v1/admin/snapshot` (exactly reproducible)                       |
| `MONID_SIM_WARMUP` / `_LEARN` / `_MEASURE`             | `30` / `60` / `20`      | rounds (each round = one call per workspace)                                     |
| `MONID_SIM_LIMIT`, `_MAX_RETRIES`, `_POLL_MS`, `_SEED` | `5`, `2`, `50`, `42`    |                                                                                  |
| `MONID_SIM_MIN_RANK_DROP` / `_CONTROL_TOLERANCE`       | `1` / `0.25`            | assertion thresholds                                                             |

With timer-driven snapshots, which snapshot a request sees depends on wall-clock
timing, so the numbers can vary slightly between runs. The agent's choices are
always seeded.

## Stub host (test only)

`stub_host.ts` is a contract fixture, not a second host. It has:

- a fixed candidate list with no BM25
- synthetic run outputs
- in-memory evidence with no decay or trust (failure: reliability f+1; empty:
  quality f+1; clean success: reliability s+0.05; feedback rating r: s =
  (r+2)/4)
- a snapshot rebuilt on a timer with `@monid/feedback-rerank`
- no health signal

It implements exactly the hooks above.
