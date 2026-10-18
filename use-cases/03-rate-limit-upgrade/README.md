# 03 rate limit upgrade

A public weather API allows 5 requests per minute per IP. The limiter is ten
lines of in-memory code in front of the d402 gate: under the limit it serves the
route with `X-Tier: free`; over it, it hands the request to `d402.gate`, which
answers 402 with the offer (no voucher) or spends a call (voucher). The agent is
an ordinary `client.fetch` loop over 12 cities. Request 6 gets the 402 instead of
a 429, the client labels one bundle of 5 snippets, retries, and the remaining
requests ride the voucher. A logging transport records every request on the wire
so you can see the whole sequence.

```sh
pnpm --filter d402-uc-rate-limit-upgrade run start
```

What you will see (abridged):

```
3. request log:
   # 1 GET  /forecast?city=Oslo                200  free tier (4 left this minute)
   ...
   # 5 GET  /forecast?city=Perth               200  free tier (0 left this minute)
   # 6 GET  /forecast?city=Quito               402  free tier used up -> 402 with the d402 offer (not a 429)
   # 7 GET  /.well-known/d402/tasks?tier=s     200  bundle: 5 snippets to label
   # 8 POST /.well-known/d402/tasks/b_...      200  answers signed and submitted -> voucher for 10 calls
   # 9 GET  /forecast?city=Quito               200  paid tier, voucher spent (9 calls left)
   ...
   #15 GET  /forecast?city=Kyiv                200  paid tier, voucher spent (3 calls left)

RESULT: 5 free requests, 1 x 402 offer, 1 bundle labelled, 7 paid requests; no 429, no key, no card
```
