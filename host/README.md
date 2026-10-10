# host — self-hosted Monid test host (feedback-host)

A thin Deno host over the engine that speaks the stock CLI wire contract
(`cli/src/api/types.ts`) plus `POST /v1/feedback`, and runs the feedback loop
in-process: implicit run signals and explicit feedback → decayed aggregates →
`@monid/feedback-rerank` snapshots → discover reranking. **Test host**: fixture/
fake transports by default; no billing, no real accounts.

```sh
MONID_HOST_API_KEY=monid_local_<secret> deno task host:serve      # :8080
MONID_API_BASE_URL=http://localhost:8080 monid keys add -k monid_local_<secret> -l local
MONID_API_BASE_URL=http://localhost:8080 monid discover -q "web search"
```

Docker (build context = repo root; the catalog is baked at build time):

```sh
docker build -f host/Dockerfile -t monid-host .
docker run --rm -p 8080:8080 -e MONID_HOST_API_KEY=monid_local_<secret> monid-host
```

## Routes

Stock CLI: `POST /v1/discover`, `POST /v1/inspect`, `POST /v1/run`,
`GET /v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/stop`, plus stubs for
whoami, workspaces, balance, resources and the skill-setup telemetry ping.
Additive fields on discover: `discoverId`, `clusterId`, `arm`,
`snapshotVersion`, `results[].quality {term, n}`; on run: `discoverId`.

Feedback: `POST /v1/feedback` (202 `{feedbackId, status:"queued"}`),
`GET /v1/feedback/:id`, `DELETE /v1/feedback` (whole workspace). See
`feedback/TOOL.md`.

Admin (`Authorization: Bearer $MONID_ADMIN_KEY` or `x-admin-key`):
`POST /v1/admin/faults {target, error_rate, empty_rate?, garbage_rate?}`,
`GET /v1/admin/faults`, `POST /v1/admin/snapshot`, and
`GET|PUT /v1/_admin/fake-profiles` (full profile map).

## Env

| var                                                         | default                                | meaning                                                                              |
| ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `MONID_HOST_API_KEY` / `MONID_HOST_WORKSPACE`               | — / `ws_local`                         | one key (CLI format `monid_<stage>_<secret>`)                                        |
| `MONID_HOST_API_KEYS`                                       |                                        | `key:workspace,...`                                                                  |
| `MONID_HOST_TRANSPORT`                                      | `fixture`                              | `fixture` \| `fake` (fixture + faults) \| `direct` (real vendors, needs credentials) |
| `MONID_FAKE_FAULTS`                                         |                                        | `provider#endpoint:error_rate=0.6[,empty_rate=0.1][;...]`                            |
| `MONID_HOST_FAKE_PROFILES`                                  | `{}`                                   | JSON profiles (`errorRate`, `emptyRate`, `garbageRate`, `latencyMs`, `jitterMs`)     |
| `MONID_ADMIN_KEY` (`MONID_HOST_ADMIN_KEY`)                  |                                        | enables admin routes                                                                 |
| `MONID_SNAPSHOT_INTERVAL_MS`                                | `60000`                                | snapshot publish interval                                                            |
| `MONID_SNAPSHOT_OPTIONS`                                    | `{}`                                   | JSON `buildSnapshot` overrides (`gain`, `k`, `weights`)                              |
| `MONID_DECAY_HALF_LIFE_MS`                                  | unset = no decay                       | evidence half-life, `0.5^(age/halfLife)`                                             |
| `MONID_DECAY_HALF_LIFE_EXPLICIT_MS`                         | = above                                | separate half-life for explicit feedback                                             |
| `MONID_HEALTH_IGNORE_FAULTS`                                | off                                    | injected faults don't touch live health or severe flags (both act on BOTH arms)      |
| `MONID_HOST_HONOR_ARM_HEADER`                               | on unless `direct`                     | honour `X-Monid-Arm: control\|treatment`                                             |
| `MONID_HOST_CONTROL_PERCENT` / `MONID_HOST_EXPERIMENT_SALT` | `10` / `v1`                            | hashed per-workspace arm                                                             |
| `MONID_HOST_DISCOVER_ALLOW`                                 |                                        | test mode: discover only these endpoint ids/providers                                |
| `MONID_HOST_RETRY_WINDOW_MS`                                | `120000`                               | retry-elsewhere / success-no-retry window                                            |
| `MONID_HOST_SYNC_WAIT_MS`                                   | `25000`                                | `/v1/run` waits this long before answering RUNNING                                   |
| `MONID_HOST_FEEDBACK_RPM` / `_RETENTION_DAYS`               | `60` / `90`                            | per-key rate limit / free-text redaction                                             |
| `MONID_HOST_TRUST`                                          |                                        | fixed `ws:weight,...`                                                                |
| `MONID_HOST_DB` / `MONID_HOST_CATALOG` / `PORT`             | `./.output/host.db` / compile / `8080` |                                                                                      |

## M4 sim against this host (Docker)

```sh
docker run -d --name monid-sim-host -p 8789:8080 \
  -e MONID_HOST_API_KEYS=monid_sim_alpha:ws_a,monid_sim_beta:ws_b -e MONID_ADMIN_KEY=monid_admin_sim \
  -e MONID_HOST_TRANSPORT=fake -e MONID_HEALTH_IGNORE_FAULTS=1 \
  -e MONID_SNAPSHOT_INTERVAL_MS=60000 -e MONID_DECAY_HALF_LIFE_MS=60000 -e MONID_HOST_RETRY_WINDOW_MS=5000 \
  monid-host
MONID_API_BASE_URL=http://localhost:8789 MONID_SIM_KEYS=monid_sim_alpha,monid_sim_beta \
  MONID_SIM_ARMS=treatment,control MONID_ADMIN_KEY=monid_admin_sim \
  MONID_SNAPSHOT_INTERVAL_MS=60000 MONID_DECAY_HALF_LIFE_MS=60000 deno task sim
```

The sim runs over the full catalog. Endpoints without recorded fixtures fail
under the fake transport (501), so live health hides them after three failed
runs, in both arms. `MONID_SIM_ARMS` is needed because two hashed workspaces
rarely land in different arms at 10% control. `MONID_HOST_DISCOVER_ALLOW` is
still there for narrowing discover in tests.

## Discover ranking

BM25F over each endpoint's title (×3), provider (×2), summary (×2), category
names (×2), description and notes (×1); each field is length-normalized against
its own average, so a long description does not dilute a title match. The leaf
(`clusterId`) is a score-weighted category vote over the top 10 of 100 recalled
hits; endpoints in that leaf then get up to +30% relevance, scaled by the vote's
margin over the runner-up leaf. `test/discover_quality.test.ts` checks leaf and
top-5 topicality for queries across news, funding, people, scraping, SEO and
video/image generation.
