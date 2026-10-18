# 07 paid crawl

A magazine with 10 articles behind `GET /articles/:id`. The gate covers scope
`["/articles"]` and the only tier pays 12 calls for 5 labelled news snippets, so
one bundle is enough for the whole crawl. The crawler is a plain loop over
`client.fetch` with `maxEarnAttempts: 3`: the first request is a 402, the
client earns, retries, and the other nine spend from the same voucher. The
output prints the calls remaining after every fetch and the number of vouchers
earned (1) and bundles attempted.

```sh
pnpm --filter d402-uc-paid-crawl run start
```

What you will see (abridged):

```
1. site up at http://127.0.0.1:34983: 10 articles under /articles, tier "crawl": 5 items -> 12 calls
2. crawler fetches every article with client.fetch:
   GET /articles/a1  -> 200, calls remaining 11  "The coalition government warned about a ceasefire ..." (earned a voucher first: 1 bundle labelled)
   GET /articles/a2  -> 200, calls remaining 10  "The retailer posted dividends for the third year running"
   ...
   GET /articles/a10 -> 200, calls remaining  2  "A 19-year-old striker clinched the final in extra time"

RESULT: 10/10 articles fetched, 1 voucher earned (1 bundle attempt), 2 calls left over
```
