# Qwen3-Embedding-8B HTTP API

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/embeddings` | Bearer | Embed one or more texts |
| `GET` | `/v1/models` | Bearer | The served model, its dimensions, token limit, and revision |
| `GET` | `/health` | none | Liveness: `{"status": "ok"}` |

When `EMBED_API_KEY` is set (it is, on the box), `/v1/*` requires
`Authorization: Bearer <key>`. A missing or wrong key gets `401
authentication_error` with `WWW-Authenticate: Bearer`. The key is compared in
constant time. `/health` is always open. Every response is JSON and carries an
`x-request-id` header.

### `POST /v1/embeddings`

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | `Qwen/Qwen3-Embedding-8B` or `Qwen3-Embedding-8B` (case-insensitive), or a `--model-alias`. Responses always report `Qwen/Qwen3-Embedding-8B`. |
| `input` | string \| string[] | yes | 1 to 2048 non-empty strings. Token-ID arrays are rejected; text is tokenized with the model's own tokenizer. |
| `dimensions` | integer | no | 32 to 4096, default 4096. Matryoshka truncation: the first `dimensions` values, re-normalized. |
| `encoding_format` | `"float"` \| `"base64"` | no | Default `float`. `base64` is little-endian float32, which the OpenAI SDKs request and decode by default. |
| `instruction` | string | no | **Extension.** Task instruction for queries; see below. |
| `user` | string | no | Accepted and ignored. |

Unknown fields are rejected with `400`. Embeddings are L2-normalized, so the dot
product is the cosine similarity. The model card uses cosine similarity too.

### Instructions: queries versus documents

Qwen3-Embedding is instruction-aware. For retrieval, embed **queries** with a
one-sentence task instruction and **documents** without one. The model card
reports a 1-5% gain from instructions and recommends writing them in English.
With `instruction`, each input is embedded as

```
Instruct: {instruction}
Query:{input}
```

This is the model card's `get_detailed_instruct` format. A client that cannot send
extra fields can prepend that text to each input itself; the result is the same.
The model's default retrieval instruction is `Given a web search query, retrieve
relevant passages that answer the query`.

### `GET /v1/models`

```json
{"object": "list", "data": [{"id": "Qwen/Qwen3-Embedding-8B", "object": "model", "created": 0, "owned_by": "Qwen",
  "dimensions": 4096, "max_input_tokens": 32768, "revision": "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af"}]}
```

## Using the OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8889/v1", api_key=KEY)
task = "Given a web search query, retrieve relevant passages that answer the query"

queries = client.embeddings.create(model="Qwen/Qwen3-Embedding-8B",
                                   input=["What is the capital of China?", "Explain gravity"],
                                   extra_body={"instruction": task})
documents = client.embeddings.create(model="Qwen/Qwen3-Embedding-8B",
                                     input=["The capital of China is Beijing.",
                                            "Gravity is a force that attracts two bodies towards each other. ..."])
```

Clients that hard-code an OpenAI model name, such as `text-embedding-3-small`,
need that name added with `--model-alias` in the unit's `ExecStart`.
LangChain's `OpenAIEmbeddings` sends token IDs unless you pass
`check_embedding_ctx_length=False`.

## How embeddings are computed

This follows the model card. The shipped `tokenizer.json` appends `<|endoftext|>`
(the server refuses to start if it does not). The final-layer hidden state at
that token is the embedding (last-token pooling), computed in bf16 with SDPA
attention and then normalized in float32. Inputs are sorted by length and
left-padded into batches of at most `--batch-tokens` padded tokens. Each row
gets its own position IDs, so an embedding does not depend on the other inputs
in its batch, apart from bf16 kernel noise (see below). Inputs longer than
`--max-tokens` are **refused, never truncated**. `usage.prompt_tokens` counts
every token fed to the model, including the instruction and `<|endoftext|>`.

## Errors

The error body uses OpenAI's shape: `{"error": {"message", "type", "param", "code"}}`.

| Status | `type` / `code` | When |
|---|---|---|
| `400` | `invalid_request_error` | Validation failed; `param` names the field, for example `input[3]` or `dimensions` |
| `400` | `invalid_request_error` / `context_length_exceeded` | An input exceeds `--max-tokens` |
| `400` | `invalid_request_error` / `max_tokens_per_request` | The request exceeds `--max-request-tokens` |
| `400` | `invalid_json` | Body is not valid JSON (including `NaN`/`Infinity`) |
| `401` | `authentication_error` / `invalid_api_key` | Bearer token missing or wrong |
| `404` | `invalid_request_error` / `model_not_found` | Unknown `model` |
| `404` / `405` | `not_found_error` / `method_not_allowed` | Unknown path / wrong method |
| `411`, `413` | `length_required`, `request_too_large` | No `Content-Length` or a chunked body; body too large |
| `503` | `overloaded_error` / `overloaded` | Queue full; `Retry-After: 1`, and the OpenAI SDKs retry this automatically |
| `500` | `server_error` | Model failure |
