# search-proxy: a d402-gated search API

A small Hono server with one gated route. Agents pay for `GET /search` by labelling
news snippets (the d402 flow from `spec/SPEC.md`), not with money.

```
GET  /health                              open
GET  /search?q=...                        gated: needs D402-Voucher
GET  /.well-known/d402                    the offer
GET  /.well-known/d402/tasks?tier=s|m|l   get a bundle   (D402-Key header)
POST /.well-known/d402/tasks/:bundleId    submit answers (D402-Key header, signed body)
```

The task pool is `tasks.jsonl` (300 classify items, 20% golden, generated with the bench
dataset generator and committed as a static file). `answer-key.json` is the hidden truth for
those items; it exists only so the demo agent can "solve" bundles without an LLM.

## Run it

```sh
pnpm --filter @d402/server run build && pnpm --filter @d402/client run build   # once
pnpm --filter d402-example-search-proxy run start      # http://localhost:8787 (env PORT)
```

Set `D402_SECRET` in a real deployment; without it the server uses a dev secret and warns.

## The flow with curl

### 1. Hit the gated route: 402 with the offer

```sh
curl -i "http://localhost:8787/search?q=ceasefire"
```

```
HTTP/1.1 402 Payment Required
{"d402":"1","accepts":[{"scheme":"d402","sellerId":"d402-example-search-proxy",
  "taskUrl":"http://localhost:8787/.well-known/d402/tasks","taskTypes":["classify"],
  "scope":["/search"],"voucherTtl":86400,
  "tiers":[{"id":"s","items":5,"est_tokens":1000,"reward":{"calls":10}},
           {"id":"m","items":25,"est_tokens":5000,"reward":{"calls":60}},
           {"id":"l","items":50,"est_tokens":10000,"reward":{"calls":150}}]}]}
```

The same body is at `GET /.well-known/d402`.

### 2. Make a keypair

```sh
node -e '
  const { generateKeypair } = await import("@d402/spec");
  require("fs").writeFileSync("key.json", JSON.stringify(generateKeypair()));
' --input-type=module
PUB=$(node -p 'require("./key.json").publicKey')
```

(Run from this directory so `@d402/spec` resolves; `packages/spec` must be built.)

### 3. Get a bundle

```sh
curl -s "http://localhost:8787/.well-known/d402/tasks?tier=s" \
  -H "D402-Key: $PUB" -H "D402-Model: claude" | tee bundle.json
```

```json
{"bundleId":"b_...","tier":"s","type":"classify",
 "instructions":"Label each news snippet with exactly one of: sports, business, tech, world.",
 "labels":["sports","business","tech","world"],
 "items":[{"id":"i_00042","text":"The chipmaker unveiled a faster GPU for data centres ..."}, ...],
 "expiresAt":1760000600}
```

You are not told which items are golden. Label all of them.

### 4. Answer, sign and submit

Write your answers (an LLM would do this; here we type them), then sign
`"d402:submit\n" + bundleId + "\n" + canonicalJSON(answers)` with the private key.
`signSubmit` from `@d402/spec` does exactly that:

```sh
cat > answers.json <<'EOF'
{"i_00042":"tech","i_00017":"sports","i_00203":"world","i_00118":"business","i_00077":"tech"}
EOF

node --input-type=module -e '
  import { signSubmit } from "@d402/spec";
  import { readFileSync, writeFileSync } from "node:fs";
  const key = JSON.parse(readFileSync("key.json", "utf8"));
  const bundle = JSON.parse(readFileSync("bundle.json", "utf8"));
  const answers = JSON.parse(readFileSync("answers.json", "utf8"));
  const sig = signSubmit(key.privateKey, bundle.bundleId, answers);
  writeFileSync("submit.json", JSON.stringify({ answers, model: "claude", sig }));
  console.log(bundle.bundleId);
'
BUNDLE=$(node -p 'require("./bundle.json").bundleId')

curl -s -X POST "http://localhost:8787/.well-known/d402/tasks/$BUNDLE" \
  -H "D402-Key: $PUB" -H "Content-Type: application/json" \
  --data @submit.json | tee voucher.json
```

Pass (enough goldens right):

```json
{"voucher":"eyJhbGciOiJIUzI1NiJ9...","calls":10,"scope":["/search"],"expiresAt":1760086400}
```

Fail: `422 {"error":"quality","message":"..."}`. The seller never says which items were
golden or which were wrong. Get a new bundle and try again.

### 5. Spend

```sh
VOUCHER=$(node -p 'require("./voucher.json").voucher')
curl -i "http://localhost:8787/search?q=ceasefire" -H "D402-Voucher: $VOUCHER"
```

```
HTTP/1.1 200 OK
D402-Calls-Remaining: 9
{"hits":[{"title":"Ceasefire agreed along disputed border","url":"https://example.com/world/ceasefire-border","snippet":"..."}]}
```

When the counter hits zero the route returns `402` again with `"error":"voucher_exhausted"`
and the same offer, so the agent knows to earn another voucher.

## The demo agent

`src/agent-demo.ts` does all of the above with `@d402/client` in about 30 lines: a client
with a solver, `client.fetch(url)` attaches a cached voucher or earns one on 402. Its solver is
a lookup into `answer-key.json`, which is cheating and only works because this is a demo; a
real agent plugs in `createLlmSolver`.

```sh
pnpm --filter d402-example-search-proxy run start   # terminal 1
pnpm --filter d402-example-search-proxy run demo    # terminal 2 (env BASE_URL to point elsewhere)
```

```
q="ceasefire" -> HTTP 200, calls remaining 9, hits: Ceasefire agreed along disputed border
q="gpu" -> HTTP 200, calls remaining 8, hits: Chipmaker unveils faster data centre GPU
q="quarterly profit" -> HTTP 200, calls remaining 7, hits: Retailer posts surprise quarterly profit
```

## Tests

```sh
pnpm exec vitest run examples
```

Covers: health is open, `/search` 402s with a valid offer, the well-known offer, bad vouchers,
a full earn-and-spend round trip through the real `@d402/client`, and a failing solver.
