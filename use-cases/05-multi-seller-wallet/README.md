# 05 multi-seller wallet

Three sellers that have never heard of each other run in one process: a news
site (`/headlines`, 4 labels, 5 items -> 10 calls), a helpdesk (`/tickets`, 4
urgency labels, 8 items -> 20 calls) and a shop (`/reviews`, 3 sentiment
labels, 6 items -> 15 calls). One agent keeps its keypair and a
`FileVoucherCache` in one directory and fetches from all three; each first
contact is a 402 and one bundle, so the cache ends up holding 3 vouchers. Then a
second client is built from the same directory with no solver at all: it
discovers each seller (so it knows which voucher an origin maps to) and spends
the cached vouchers. `client.status()` is printed from the second client; the
sellers confirm no new bundles were issued.

```sh
pnpm --filter d402-uc-multi-seller-wallet run start
```

What you will see (abridged):

```
2. agent A (key ..., FileVoucherCache at /tmp/d402-uc05-wallet-...) fetches from all three:
   GET /headlines?region=eu         -> 200, earned a voucher, calls remaining 9
   GET /tickets/stats               -> 200, earned a voucher, calls remaining 19
   GET /reviews/summary?sku=kettle  -> 200, earned a voucher, calls remaining 14
   client.status(): 3 vouchers -> news.example:9  helpdesk.example:19  shop.example:14
3. agent B: a second client from the same directory, no solver, so it cannot earn:
   GET /headlines?region=eu         -> 200, spent a cached voucher, calls remaining 8
   ...
4. client.status() from agent B:
   news.example       jti v_...  calls  8  scope /headlines  expires in 24 h
   helpdesk.example   jti v_...  calls 18  scope /tickets    expires in 24 h
   shop.example       jti v_...  calls 13  scope /reviews    expires in 24 h

RESULT: 3 vouchers in one file, earned with 3 bundles, spent by a solver-less client (no new bundles); balances 8/18/13
```
