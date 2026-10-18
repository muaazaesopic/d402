# d402 protocol, version 1

d402 ("data 402") is an HTTP payment scheme where an agent pays for API access by
labelling data instead of sending money. It uses the same `402 Payment Required`
handshake and `accepts` array shape as x402, so a seller can offer USDC and d402
side by side and the agent picks.

The model is reCAPTCHA for agents:

1. Gate. No access without a voucher.
2. The challenge is useful work. The seller gets labelled data.
3. Verification by control items. Every bundle mixes in "golden" items with known
   answers. The agent is never told which. Pass the goldens, get the voucher.
   Answers on unknown items become weighted votes.
4. Trust. Keys with a clean history see fewer goldens and bigger rewards.

## 1. Roles

- Seller: runs an HTTP API, gates routes, owns a task pool, mints vouchers.
- Agent: holds an Ed25519 keypair, earns vouchers by answering bundles, spends them.
- Solver: the code inside the agent that turns a bundle into answers (usually an LLM call).

## 2. Headers

| Header | Direction | Value |
|---|---|---|
| `D402-Key` | agent -> seller | base64url Ed25519 public key (32 raw bytes). Required on task endpoints. Optional on spend. |
| `D402-Voucher` | agent -> seller | the voucher JWT. Required on spend. |
| `D402-Model` | agent -> seller | optional model family string, e.g. `claude`, `gpt`, `gemini`, `llama`. Used for the diversity rule. |
| `D402-Timestamp` | agent -> seller | unix seconds. Required only when the seller binds spend to the key. |
| `D402-Sig` | agent -> seller | base64url Ed25519 signature. Required only when the seller binds spend to the key. |
| `D402-Calls-Remaining` | seller -> agent | integer, on every successful spend. |

## 3. Discovery and the 402 offer

A gated route without a valid voucher returns `402` with this JSON body. The same
body is served on `GET /.well-known/d402` so agents can earn ahead of time.

```json
{
  "d402": "1",
  "accepts": [
    {
      "scheme": "d402",
      "sellerId": "api.example.com",
      "taskUrl": "https://api.example.com/.well-known/d402/tasks",
      "taskTypes": ["classify"],
      "scope": ["/search"],
      "voucherTtl": 86400,
      "tiers": [
        { "id": "s", "items": 5,  "est_tokens": 1000,  "reward": { "calls": 10 } },
        { "id": "m", "items": 25, "est_tokens": 5000,  "reward": { "calls": 60 } },
        { "id": "l", "items": 50, "est_tokens": 10000, "reward": { "calls": 150 } }
      ]
    }
  ]
}
```

- `taskUrl` is absolute.
- `scope` is a list of path prefixes the voucher is valid for.
- `tiers[].items` is the number of items in a bundle. `est_tokens` is advisory,
  so the agent can budget in its own unit. The seller grades in items.
- Other schemes (for example x402's `exact`) may appear in `accepts`.

## 4. Earning a bundle

```
GET {taskUrl}?tier=m
    D402-Key: <pubkey>
    D402-Model: claude            (optional)
```

Response `200`:

```json
{
  "bundleId": "b_01J...",
  "tier": "m",
  "type": "classify",
  "instructions": "Label each item with exactly one of the labels.",
  "labels": ["sports", "business", "tech", "world"],
  "items": [ { "id": "i_1", "text": "..." }, { "id": "i_2", "text": "..." } ],
  "expiresAt": 1760000000
}
```

Errors (`4xx`, JSON `{ "error": code, "message": string }`):

- `bad_tier`: unknown tier id.
- `no_tasks`: the pool has nothing to hand out.
- `rate_limited`: too many bundles for this key or IP. `Retry-After` header is set.
- `blocked`: the key's trust is below the floor (status `403`).
- `missing_key` / `bad_key`: `D402-Key` absent or not a valid key.

Bundles expire. Default 600 seconds. An expired bundle gets `expired_bundle` on submit.

## 5. Submitting answers

```
POST {taskUrl}/{bundleId}
    D402-Key: <pubkey>
    Content-Type: application/json

{
  "answers": { "i_1": "tech", "i_2": "sports" },
  "model": "claude",
  "sig": "<base64url ed25519 signature>"
}
```

`sig` is over the UTF-8 bytes of:

```
"d402:submit\n" + bundleId + "\n" + canonicalJSON(answers)
```

`canonicalJSON` is JSON with object keys sorted recursively and no whitespace.

Response `200` (bundle passed):

```json
{ "voucher": "<jwt>", "calls": 60, "scope": ["/search"], "expiresAt": 1760086400 }
```

Response `422` (bundle failed): `{ "error": "quality", "message": "..." }`.
The seller never reveals which items were golden or which were wrong.

Other errors: `unknown_bundle`, `expired_bundle`, `bad_signature`, `already_submitted`,
`incomplete` (an item has no answer), `bad_label` (answer not in `labels`).

### 5.1 Grading rule (v1)

- Let `g` be the number of golden items in the bundle, `c` the number answered correctly.
- Every bundle contains at least 1 golden item.
- The bundle passes when `c / g >= 0.8`, and when `g == 1` it passes only when `c == 1`.
- On pass: mint a voucher, record every answer on unknown items as a vote with weight
  equal to the agent's current accuracy estimate.
- On fail: no voucher. The bundle's unknown answers are discarded.
- Either way the agent's golden counters are updated.

### 5.2 Trust and golden ratio

Per key, the seller keeps `goldenSeen`, `goldenCorrect`, `bundles`.

- `accuracy = (goldenCorrect + 1) / (goldenSeen + 2)` (Laplace prior).
- Golden ratio for the next bundle:
  - `bundles < 5`: 0.4
  - `bundles >= 50` and `accuracy >= 0.95`: 0.1
  - `bundles >= 10` and `accuracy >= 0.9`: 0.2
  - otherwise 0.4
- Golden count per bundle: `max(1, round(items * ratio))`.
- A key with `bundles >= 5` and `accuracy < 0.6` is blocked. Task endpoints return
  `403 blocked`. Existing vouchers keep working until they expire.

### 5.3 Resolving unknown items

An unknown item is resolved when, for its top answer:

- the sum of vote weights is `>= 2.0`, and
- at least 2 distinct keys voted for it, and
- if the seller enables `requireModelFamilies`, at least 2 distinct declared model
  families voted for it.

Resolved items leave the pool. The seller can export them.

### 5.4 Golden rotation

A golden item is retired after `goldenMaxExposures` (default 200) bundles.

## 6. The voucher

An HS256 JWT minted and verified by the seller. Claims:

```json
{ "iss": "api.example.com", "sub": "<agent pubkey>", "scope": ["/search"],
  "jti": "v_01J...", "iat": 1760000000, "exp": 1760086400 }
```

Remaining calls are stored server-side keyed by `jti`. The token is stateless, the
counter is not.

## 7. Spending

```
GET /search?q=...
    D402-Voucher: <jwt>
```

Seller checks: signature, `exp`, path matches a `scope` prefix, `jti` known,
calls remaining `> 0`. Decrements by 1 and serves the route. Response carries
`D402-Calls-Remaining`.

Failures return `402` with the offer body and an extra top-level `"error"` field:
`voucher_invalid`, `voucher_expired`, `voucher_exhausted`, `scope_mismatch`.

### 7.1 Bound spending (optional)

When the seller sets `bindVouchers: true`, spend requests must also carry
`D402-Key`, `D402-Timestamp` and `D402-Sig`, where the signature is over:

```
"d402:spend\n" + method + "\n" + path + "\n" + jti + "\n" + timestamp
```

`path` is the request path without query. `D402-Key` must equal the voucher's `sub`.
Timestamps older than 300 seconds are rejected (`stale_timestamp`). A leaked voucher
is then useless without the private key.

## 8. Task types

v1 defines `classify`:

- bundle fields: `labels: string[]`, `items: { id, text }[]`
- answer: one of `labels` per item id

Reserved for later: `extract`, `pairwise`, `telemetry`.

## 9. Rate limits (defaults)

- 60 bundles per key per hour
- 120 bundles per IP per hour
- At most 5 open (unsubmitted, unexpired) bundles per key

## 10. Seller task file format

JSONL, one item per line:

```json
{ "id": "i_1", "type": "classify", "text": "...", "golden": "tech" }
{ "id": "i_2", "type": "classify", "text": "..." }
```

`golden` present means the item is a control item with that answer.

## 11. Security notes

- Per-item results are never revealed.
- Goldens are sampled uniformly from the live golden pool and retired after N exposures.
- Vouchers are bearer tokens unless `bindVouchers` is on. Sellers that care should turn it on.
- Key and IP rate limits are the only Sybil defence in v1. A coordinated farm with many
  keys sharing golden answers is out of scope for v1.
