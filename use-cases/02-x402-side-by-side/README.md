# 02 x402 side by side

A quote API wants to be paid, and does not care in what. Its 402 lists two
entries in `accepts`: an x402-style exact scheme
(`{ scheme: "exact", network: "base", asset: "USDC", amount: "7000", payTo }`,
via `otherAccepts`) and d402. Two agents hit `GET /quote?symbol=ACME`. The one
with a wallet inspects the 402, finds the exact entry and prints what it would
pay (0.007 USDC on base); x402 settlement is not implemented in this demo, so it
stops there. The one without a wallet lets `client.fetch` earn: 402, one bundle
of 5 news snippets, signed submit, retry, 200 with 9 calls left. Both paths are
printed side by side with timings.

```sh
pnpm --filter d402-uc-x402-side-by-side run start
```

What you will see (abridged):

```
1. seller up at http://127.0.0.1:41917; GET /quote answers 402 with accepts = [d402, exact]
2. wallet agent: HTTP 402 in 3 ms, picks scheme "exact": would pay 0.007 USDC on base to 0x7f3c0a9e...
   (x402 settlement is not implemented in this demo; the wallet agent stops here)
3. no-wallet agent: 402 -> labelled 1 bundle of 5 snippets -> HTTP 200 in 31 ms, calls remaining 9
4. side by side:
                  | wallet agent (x402 exact)        | no-wallet agent (d402)
   pays with      | 0.007 USDC on base               | 1 bundle of 5 labelled snippets
   needs          | a funded wallet, a chain, ...    | an Ed25519 key and a model
   gets the data  | after settlement (not run here)  | HTTP 200 in 31 ms, 9 calls left

RESULT: same 402, two currencies: 0.007 USDC (not settled) or 5 labels -> data in 32 ms with no wallet
```
