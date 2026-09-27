# SemIf HTTP API

`exl3_server.py` serves the exl3 bridge readout over HTTP with the request and
response shape of TypeSafe's public System One API, the API Jev is served
through ([reference](https://docs.typesafe.ai/api), read 2026-09-26). Clients
written for that API, including the TypeSafe SDKs, can point their base URL at
this server; the Python SDK (`typesafe-sdk` 0.7.1) was checked end to end.

Only the **shape** is compatible. Answers come from the bridge's quantized
model (by default `turboderp/Qwen3.8-27B-exl3`) through the same prompt and
readout as `exl3_runner.py`, not from Jev, and several limits differ; see
[Differences from TypeSafe's API](#differences-from-typesafes-api). SemIf is
not affiliated with or endorsed by TypeSafe; Jev and TypeSafe are their
owners' marks.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/systemone` | Bearer | Evaluate a state against named typed questions |
| `GET` | `/v1/models` | Bearer | List the accepted `model` names |
| `GET` | `/health` | none | Liveness: `{"status": "ok"}` |

Every response is JSON and carries an `x-request-id` header.

### `POST /v1/systemone`

Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `state` | string \| object \| array | yes | Nonempty. Sent to the model as `evidence`. |
| `model` | string | yes | `--model-name` or an `--model-alias` |
| `questions` | map&lt;string, Question&gt; | yes | 1 to `--max-questions` entries. Keys are yours; answers come back under them. Keys are not sent to the model. |

Question types (every question has `type`, `instructions`, and `criteria`):

| `type` | `instructions` | `criteria` | Answer |
|---|---|---|---|
| `noul` | string \| object \| array | optional `{"true": desc, "false": desc}` | `{"type": "noul", "noul": P(yes)}` |
| `choice` | string \| object \| array | map of option name to description or `null`, **2-255** options | `{"type": "choice", "choice", "probabilities", "confidence"}` |
| `score` | string \| object \| array | array of **2-10** level descriptions, lowest first | `{"type": "score", "score", "legend", "probabilities", "confidence"}` |

Descriptions may be strings, objects, or arrays. Unknown fields anywhere in the
body are rejected with `422`.

Example (live output from `turboderp/Qwen3.8-27B-exl3`, SC 5.00bpw H6 V6, exllamav3 1.5.1;
numbers rounded here):

```bash
curl http://127.0.0.1:8080/v1/systemone \
  -H "Authorization: Bearer $EXL3_BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Help! My payouts have been failing for 3 days.",
    "model": "semif-exl3-bridge",
    "questions": {
      "is_urgent": {"type": "noul", "instructions": "Does this convey urgency?",
                    "criteria": {"true": "Explicitly time-sensitive", "false": "No urgency expressed"}},
      "department": {"type": "choice", "instructions": "Which team should handle this?",
                     "criteria": {"billing": "Payments, invoicing, refunds",
                                  "technical": "Bugs, outages, integrations",
                                  "sales": "Pricing, upgrades, new accounts"}},
      "frustration": {"type": "score", "instructions": "How frustrated is the customer?",
                      "criteria": ["Calm", "Frustrated", "Very angry"]}
    }
  }'
```

```json
{
  "model": "semif-exl3-bridge",
  "answers": {
    "is_urgent": {"type": "noul", "noul": 0.9252},
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {"billing": 0.9137, "technical": 0.0837, "sales": 0.0026},
      "confidence": 0.8705
    },
    "frustration": {
      "type": "score",
      "score": 1.0131,
      "legend": {"0": "Calm", "1": "Frustrated", "2": "Very angry"},
      "probabilities": {"0": 0.0062, "1": 0.9745, "2": 0.0193},
      "confidence": 0.9618
    }
  },
  "usage": {"input_tokens": 362, "output_tokens": 0},
  "semif": {
    "prompt_version": "direct-options-v1-exl3-bridge",
    "question_mapping": "systemone-to-direct-options-v1",
    "readout": "native full-vocabulary last-position logits restricted to declared answer slots",
    "probability_status": "conditional option score; uncalibrated as decision confidence",
    "prompt_sha256": {"is_urgent": "0a3ed900…", "department": "8ccba043…", "frustration": "fe51d274…"},
    "model": {"source": "turboderp/Qwen3.8-27B-exl3", "revision": "f33f26d9…", "runtime": "exllamav3 1.5.1", "…": "…"}
  }
}
```

`model`, `answers`, and `usage` follow TypeSafe's response shape, and answer
fields appear in TypeSafe's order. `semif` is an extension carrying the bridge's
provenance and probability caveat; the TypeSafe SDKs ignore unknown fields.

### `GET /v1/models`

```json
{"models": [
  {"name": "semif-exl3-bridge", "description": "turboderp/Qwen3.8-27B-exl3 through the exl3 bridge direct readout; uncalibrated option scores.", "release_date": "unknown"},
  {"name": "jev-latest", "description": "Alias for semif-exl3-bridge.", "release_date": "unknown"}
]}
```

Aliases are listed only when configured with `--model-alias`.

## How questions are scored

Each question becomes one `direct-options-v1` row, built by
`semif_phase1.core.direct_messages` with `state` as `evidence` and
`instructions` as `criterion`:

| `type` | Options sent to the model, in order (letters A, B, ...) | Answer |
|---|---|---|
| `noul` | `yes` and `no`; a `criteria.true` / `criteria.false` description is appended as `yes: <desc>` / `no: <desc>` | `noul` = P(`yes`) |
| `choice` | One per criteria entry: `name` when the description is `null`, else `name: description` | `choice` = highest-probability option; first in request order on ties |
| `score` | One per level description | `score` = sum over levels of `level × P(level)`; `legend` echoes the levels |

Object and array values in `instructions` or descriptions are sent as JSON text.
The prompt is rendered with the model's chat template (`enable_thinking=False`).
The readout is `exl3_runner.py`'s: single-token letter slots validated for
round-trip and prefix stability, full-vocabulary last-position logits
restricted to the declared slots, softmax. All questions of one request are
enqueued as one exllamav3 batch, so prompts that share the state prefix can
reuse its cache pages. A choice whose option names are a runner row's
descriptions, all with `null` values, produces the runner's exact prompt and
`prompt_sha256`.

`confidence` is `(n × max(p) - 1) / (n - 1)` clamped to [0, 1], the
spread statistic TypeSafe documents for its Choice and Score answers. Noul
answers have no confidence. Probabilities here are conditional option scores
and are **not calibrated**, so neither they nor `confidence` are calibrated
decision certainties.

## Differences from TypeSafe's API

| Area | TypeSafe (Jev) | This server |
|---|---|---|
| Model | `jev-latest` and versioned IDs | `--model-name` plus any `--model-alias`; responses always report `--model-name` |
| Context | 64k per request; 32k for state plus the longest question | Each question's prompt (state + question) must fit in `--cache-size - 8` tokens; longer prompts get `422 context_length_exceeded`, never truncated |
| `usage.input_tokens` | billed input tokens | Sum of prompt tokens over all questions (the state counts once per question) |
| `usage.output_tokens` | reported | Always `0`; nothing is decoded |
| Probabilities | trained for calibration | Uncalibrated option scores |
| Rate limits | `429` | None; `529` with `Retry-After: 1` when more than `--max-pending` requests are waiting |
| Concurrency | parallel evaluation | One request scored at a time; its questions are batched |
| Error body | not published | `{"error": {"type", "message", "loc"?}}` |
| Request ID header | `x-typesafe-request-id` | `x-request-id` |

## Errors

| Status | `error.type` | When |
|---|---|---|
| `400` | `invalid_json` | Body is not valid JSON (including `NaN`/`Infinity`) |
| `401` | `authentication_error` | Key configured and the bearer token is missing or wrong |
| `404` | `not_found_error` | Unknown path |
| `405` | `method_not_allowed` | Known path, wrong method |
| `411` | `length_required` | No `Content-Length`, or a chunked body |
| `413` | `request_too_large` | Body over `--max-body-bytes` |
| `422` | `invalid_request_error` | Validation failed; `loc` is the path to the offending field, for example `["questions", "department", "criteria"]` |
| `422` | `context_length_exceeded` | A question's prompt exceeds the cache budget; `loc` names the question |
| `529` | `overloaded_error` | Scoring queue full; retry with backoff |
| `500` | `api_error` | Readout failure, for example answer-slot validation |

```json
{"error": {"type": "invalid_request_error", "message": "must be an object with 2-255 options (one single-letter answer slot per option)", "loc": ["questions", "q", "criteria"]}}
```

## Using the TypeSafe Python SDK

```bash
export TYPESAFE_BASE_URL=http://127.0.0.1:8080
export TYPESAFE_API_KEY="$EXL3_BRIDGE_API_KEY"      # any nonempty value when auth is off
export TYPESAFE_DEFAULT_MODEL=semif-exl3-bridge    # or start the server with --model-alias jev-latest
```

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

with TypeSafeClient(timeout=120) as client:
    response = client.system_one(
        state={"document": "I was charged twice. Please fix this ASAP."},
        questions={
            "billing": Noul(instructions="Is this ticket about billing?"),
            "tone": Choice(instructions="What is the customer's tone?",
                           criteria={"calm": None, "frustrated": None, "angry": None}),
            "urgency": Score(instructions="How urgent is this ticket?",
                             criteria=["can wait", "this week", "today"]),
        },
    )
print(response.nouls["billing"].noul, response.choices["tone"].choice, response.scores["urgency"].score)
```

The SDK's default timeout is 10 s. Requests with long states or many
questions can take longer on this backend, so raise `timeout` accordingly.
