# d402 with curl

`walkthrough.sh` runs the whole protocol from `spec/SPEC.md` against the example seller
(`examples/search-proxy`) using only `curl` for HTTP. The one thing curl cannot do, the
Ed25519 signature over the answers, is done with the Python client in `clients/python`
(stdlib + `cryptography`); no TypeScript toolchain is needed on the agent side. `jq` is
used for pretty printing when installed, otherwise `python3`.

```sh
bash clients/curl/walkthrough.sh      # from the repo root; needs node + node_modules for the seller
```

The script starts the seller on a free port in the background, walks through steps 1-7
below, and stops it on exit.

## What happens

| Step | Spec | Request | What you get |
|---|---|---|---|
| 1 | 3 | `GET /search?q=...` with no voucher | `402` with the offer: `taskUrl`, `scope`, `tiers` (same body at `/.well-known/d402`) |
| 2 | 2 | generate an Ed25519 keypair | `D402-Key` is the base64url public key |
| 3 | 4 | `GET {taskUrl}?tier=s` + `D402-Key` | a bundle: 5 items to label; some are hidden goldens |
| 4 | 8 | label every item | `{itemId: label}` (the demo reads `answer-key.json`; a real agent asks an LLM) |
| 5 | 5 | `POST {taskUrl}/{bundleId}` with `{answers, model, sig}` | `200` with the voucher (an HS256 JWT) and `calls`, or `422 quality` |
| 6 | 7 | `GET /search?q=...` + `D402-Voucher` | `200`, `D402-Calls-Remaining` counts down |
| 7 | 7.1, 7.2 | the same with `D402-Key`, `D402-Timestamp`, `D402-Nonce`, `D402-Sig` | what a seller with `bindVouchers` (+ `requireSpendNonce`) requires |

The signed strings are exactly:

```
"d402:submit\n" + bundleId + "\n" + canonicalJSON(answers)                       # step 5
"d402:spend\n"  + METHOD + "\n" + path + "\n" + jti + "\n" + timestamp [+ "\n" + nonce]   # step 7 (nonce: SPEC 7.2)
```

`canonicalJSON` is JSON with keys sorted recursively and no whitespace; in Python that is
`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.

## Transcript of a real run

Output of `bash clients/curl/walkthrough.sh` (unedited; keys, ids and tokens are from that run).

```text

## 0. Start the example seller (examples/search-proxy) on port 50005
$ PORT=50005 D402_SECRET=walkthrough node --import tsx examples/search-proxy/src/server.ts &
$ curl -s http://localhost:50005/health
{
  "ok": true,
  "total": 300,
  "golden": 60,
  "unknownOpen": 240,
  "resolved": 0,
  "retiredGolden": 0,
  "agents": 0,
  "blockedAgents": 0,
  "openBundles": 0,
  "vouchers": 0
}

## 1. Hit the gated route with no voucher: 402 Payment Required with the offer (SPEC 3)
$ curl -si "http://localhost:50005/search?q=ceasefire"
HTTP/1.1 402 Payment Required
{
  "d402": "1",
  "accepts": [
    {
      "scheme": "d402",
      "sellerId": "d402-example-search-proxy",
      "taskUrl": "http://localhost:50005/.well-known/d402/tasks",
      "taskTypes": [
        "classify"
      ],
      "scope": [
        "/search"
      ],
      "voucherTtl": 86400,
      "tiers": [
        {
          "id": "s",
          "items": 5,
          "est_tokens": 1000,
          "reward": {
            "calls": 10
          }
        },
        {
          "id": "m",
          "items": 25,
          "est_tokens": 5000,
          "reward": {
            "calls": 60
          }
        },
        {
          "id": "l",
          "items": 50,
          "est_tokens": 10000,
          "reward": {
            "calls": 150
          }
        }
      ]
    }
  ],
  "error": "missing_voucher",
  "message": "D402-Voucher header is required"
}
taskUrl = http://localhost:50005/.well-known/d402/tasks
(the same body is at GET http://localhost:50005/.well-known/d402)

## 2. Make an Ed25519 keypair (D402-Key is the base64url public key)
$ python3 -c 'from d402 import Keypair; Keypair.generate().save("key.json")'
D402-Key: _SQ38g0-LOB6Z0dqnzLix4fDSGt2UkQ6PPzSxZjNXpQ

## 3. Get a bundle (SPEC 4): tier s = 5 items -> 10 calls
$ curl -s "http://localhost:50005/.well-known/d402/tasks?tier=s" -H "D402-Key: $PUB" -H "D402-Model: curl"
HTTP/1.1 200 OK
{
  "bundleId": "b_qZc60Px-mLxUXlQf",
  "tier": "s",
  "type": "classify",
  "instructions": "Label each news snippet with exactly one of: sports, business, tech, world.",
  "labels": [
    "sports",
    "business",
    "tech",
    "world"
  ],
  "items": [
    {
      "id": "i_00004",
      "text": "The home side drew the host nation in the semi-final after a late goal."
    },
    {
      "id": "i_00002",
      "text": "The marathon favourite deprecated a beta of its next operating system claiming a 2x speedup."
    },
    {
      "id": "i_00003",
      "text": "The election commission condemned a peace deal after years of conflict according to state media."
    },
    {
      "id": "i_00143",
      "text": "A regional bank warned of a drop in consumer demand citing supply chain costs."
    },
    {
      "id": "i_00117",
      "text": "The insurer reported a dividend increase for shareholders citing supply chain costs."
    }
  ],
  "expiresAt": 1792310531
}
bundleId = b_qZc60Px-mLxUXlQf   (you are not told which items are golden; label all of them)

## 4. Answer every item (here: look them up in the demo's answer-key.json; a real agent asks an LLM)
$ python3 -c '...build {itemId: label} from examples/search-proxy/answer-key.json...' > answers.json
{
  "i_00004": "sports",
  "i_00002": "tech",
  "i_00003": "world",
  "i_00143": "business",
  "i_00117": "business"
}

## 5. Sign and submit (SPEC 5): sig = Ed25519("d402:submit\n" + bundleId + "\n" + canonicalJSON(answers))
$ python3 -c 'from d402 import sign_submit, canonical_json; ...' > submit.json
signed message:
  d402:submit\nb_qZc60Px-mLxUXlQf\n{"i_00002":"tech","i_00003":"world","i_00004":"sports","i_00117":"business","i_00143":"business"}
sig = yy71BYX7OJVr19FHB_uee3ycXtL_jE4Q7Z9xdYzVaf-cf36yJMSJHbsALuZ1Hf5oIm5c9koTpGZuJg5__eUuDw
$ curl -s -X POST "http://localhost:50005/.well-known/d402/tasks/$BUNDLE_ID" -H "D402-Key: $PUB" -H 'Content-Type: application/json' --data @submit.json
HTTP/1.1 200 OK
{
  "voucher": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6WyIvc2VhcmNoIl0sImlzcyI6ImQ0MDItZXhhbXBsZS1zZWFyY2gtcHJveHkiLCJzdWIiOiJfU1EzOGcwLUxPQjZaMGRxbnpMaXg0ZkRTR3QyVWtRNlBQelN4WmpOWHBRIiwianRpIjoidl9zdTdWamFPaEVScW9vMU5vIiwiaWF0IjoxNzkyMzA5OTMxLCJleHAiOjE3OTIzOTYzMzF9.RCHuIneC4Y-Xtb85UYDIrtYUWL8FeUBcVf30Tr2K7fs",
  "calls": 10,
  "scope": [
    "/search"
  ],
  "expiresAt": 1792396331
}
voucher claims (SPEC 6, HS256 JWT minted by the seller):
  {"scope": ["/search"], "iss": "d402-example-search-proxy", "sub": "_SQ38g0-LOB6Z0dqnzLix4fDSGt2UkQ6PPzSxZjNXpQ", "jti": "v_su7VjaOhERqoo1No", "iat": 1792309931, "exp": 1792396331}

## 6. Spend (SPEC 7): D402-Voucher on the gated route; D402-Calls-Remaining counts down
$ curl -si "http://localhost:50005/search?q=ceasefire" -H "D402-Voucher: $VOUCHER"
HTTP/1.1 200 OK
D402-Calls-Remaining: 9
{
  "hits": [
    {
      "title": "Ceasefire agreed along disputed border",
      "url": "https://example.com/world/ceasefire-border",
      "snippet": "Ceasefire agreed along disputed border The UN envoy brokered a ceasefire along the disputed border as diplomats gathered in Geneva."
    }
  ]
}
$ curl -si "http://localhost:50005/search?q=gpu" -H "D402-Voucher: $VOUCHER"
HTTP/1.1 200 OK
D402-Calls-Remaining: 8
{
  "hits": [
    {
      "title": "Chipmaker unveils faster data centre GPU",
      "url": "https://example.com/tech/gpu-launch",
      "snippet": "Chipmaker unveils faster data centre GPU The chipmaker unveiled a faster GPU for data centres, claiming a 2x speedup on transformer training..."
    }
  ]
}

## 7. Bound spend headers (SPEC 7.1 + 7.2): sig over "d402:spend\n" + METHOD + "\n" + path + "\n" + jti + "\n" + timestamp + "\n" + nonce
This seller does not set bindVouchers, so it ignores these headers; a seller that does requires them
(and with requireSpendNonce the D402-Nonce line too; without a nonce the signed string has 5 lines).
signed message:
  d402:spend\nGET\n/search\nv_su7VjaOhERqoo1No\n1792309931\ntVKLah2bgAJm2xAPvDotpA
$ curl -si "http://localhost:50005/search?q=profit" -H "D402-Voucher: $VOUCHER" -H "D402-Key: $PUB" -H "D402-Timestamp: 1792309931" -H "D402-Nonce: tVKLah2bgAJm2xAPvDotpA" -H "D402-Sig: $SIG"
HTTP/1.1 200 OK
D402-Calls-Remaining: 7
{
  "hits": [
    {
      "title": "Retailer posts surprise quarterly profit",
      "url": "https://example.com/business/retailer-profit",
      "snippet": "Retailer posts surprise quarterly profit The retailer reported a surprise quarterly profit as consumer demand held up despite high interest..."
    }
  ]
}

## 8. Stop the seller
$ kill 17902
```

Notes on the output:

- Step 1's 402 carries `"error": "missing_voucher"` on top of the offer. After a voucher runs
  out, the same route answers `402` with `"error": "voucher_exhausted"`, which is how an agent
  knows to earn again.
- Step 3: the bundle is tier `s` (5 items). With a fresh key the golden ratio is 0.4, so 2 of
  the 5 are controls and both must be right (`c / g >= 0.8`). The seller never says which.
- Step 5: the printed `signed message` is the exact byte string the signature covers; note the
  answers are re-serialised with sorted keys even though `answers.json` was not sorted.
- Step 6: each spend decrements the counter stored server-side under the voucher's `jti`; the
  JWT itself never changes.
- Step 7: the example seller does not bind vouchers, so it serves the request without checking
  the extra headers. With `bindVouchers: true` a missing key, stale timestamp or bad signature gets
  `402 bad_key` / `stale_timestamp` / `bad_signature`, and re-sending the same nonce gets
  `402 replayed_spend` (the Python test suite covers this against a binding seller).
