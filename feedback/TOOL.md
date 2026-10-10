# feedback

Tell Monid how an endpoint (or discover itself) actually worked out for you.
Feedback returns immediately and nudges future `discover` rankings for every
agent. It never changes the result of a run you already made.

## When to call it

Call `feedback` once, right after you know how a run went, when:

- the output was **wrong**, **outdated**, **incomplete**, or **off-contract**
  (didn't match the endpoint's documented output schema),
- the run was **surprisingly slow or expensive** for what it returned,
- the endpoint was **notably good**, better than you expected or than an
  alternative you tried,
- **nothing in a discover list fit** your task (use `target: "discover"` and say
  what you were looking for).

Don't call it for routine runs that were fine; successful runs already count.
Don't call it to report your own input mistakes.

## Fields

| field        | type                                              | notes                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`      | string                                            | The run you're rating. Strongly recommended: **feedback without a `runId` is stored but does not influence ranking.**                                                                                                                                           |
| `endpoint`   | string                                            | The endpoint you're rating, as an id (`exa#search`) or as the path shown by discover (`/search`) together with `provider`. **Required when `target` is `"endpoint"` and there is no `runId`.** With a `runId` it is optional and must match the run's endpoint. |
| `provider`   | string                                            | Provider slug (`exa`). Only needed when `endpoint` is a path rather than an id.                                                                                                                                                                                 |
| `discoverId` | string                                            | The discover response you picked from, if any. Lets Monid tell "bad endpoint" apart from "bad ranking".                                                                                                                                                         |
| `target`     | `"endpoint"` \| `"discover"` \| `"platform"`      | What the feedback is about. Default `"endpoint"`.                                                                                                                                                                                                               |
| `rating`     | integer -2..2                                     | -2 unusable, -1 poor, 0 mixed, 1 good, 2 excellent. Required.                                                                                                                                                                                                   |
| `aspects`    | array of enum                                     | Any of `correctness`, `completeness`, `schema`, `latency`, `reliability`, `cost`, `docs`, `other`.                                                                                                                                                              |
| `severity`   | `"low"` \| `"medium"` \| `"high"` \| `"critical"` | For negative feedback. `critical` = wrong data that could cause harm, or a broken endpoint.                                                                                                                                                                     |
| `text`       | string, max 4 KB                                  | What happened, in plain language. Be specific; no secrets or personal data.                                                                                                                                                                                     |
| `expected`   | string                                            | Optional. What you expected (a value, a field, a shape).                                                                                                                                                                                                        |
| `observed`   | string                                            | Optional. What you got instead.                                                                                                                                                                                                                                 |

## Response

`202 Accepted`

```json
{ "feedbackId": "fb_01J9...", "status": "queued" }
```

Feedback is processed asynchronously; there is nothing to poll.
`GET /v1/feedback/{feedbackId}` returns what was stored, if you need to check.

Errors use the usual shape `{ "error": { "code", "message" } }`: `400` for
invalid fields (including endpoint feedback with neither `runId` nor
`endpoint`), `404` for an unknown `runId`, `discoverId`, or `endpoint`, and
`429` (with `Retry-After`) beyond the rate limit. Send an `Idempotency-Key`
header to make retries safe; the same key returns the same `feedbackId`.

## Limits

- 60 calls per minute per API key (`429` beyond that).
- Free text (`text`, `expected`, `observed`) is redacted after 90 days. Ratings
  and aspects are kept.
- `DELETE /v1/feedback` deletes all feedback from your workspace, along with its
  effect on rankings.

## Example

```json
{
    "runId": "run_8f2c1a",
    "discoverId": "dsc_41b7e0",
    "target": "endpoint",
    "rating": -1,
    "aspects": ["correctness", "completeness"],
    "severity": "medium",
    "text": "Asked for Q3 2026 revenue for ACME; the response returned Q3 2025 figures and no 'segments' field.",
    "expected": "fiscal_period = 2026-Q3, segments[] present",
    "observed": "fiscal_period = 2025-Q3, segments missing"
}
```
