# 01 dataset builder

A helpdesk has 500 support tickets it wants labelled by urgency and 60 it
labelled by hand. It has no API worth selling, so it gates a trivial
`GET /thanks` and prices a 50-item bundle at one call to it. The labels are the
product. Three agents (claude, gpt, gemini; p = 0.90 / 0.88 / 0.92, seeded)
label until the seller hands them nothing new. The seller then calls
`d402.tasks.exportResolved()`: tickets where enough weight from at least two
distinct keys agreed (in practice three agents), writes them to
`out/labels.jsonl`, and this demo scores them against the hidden truth.
Tickets where any of the three disagreed stay open for a fourth opinion.

```sh
pnpm --filter d402-uc-dataset-builder run start
```

What you will see (abridged):

```
1. seller up at http://127.0.0.1:42869: 560 tickets in the pool (60 golden, 500 unknown), 1 tier: 50 items -> 1 call to /thanks
2. three agents label until the seller has nothing new for them:
   claude (p=0.9): 17 bundles, 17 passed, 0 failed quality, seller's accuracy estimate 0.912, GET /thanks -> 200
   gpt    (p=0.88): 18 bundles, 17 passed, 1 failed quality, seller's accuracy estimate 0.841, GET /thanks -> 200
   gemini (p=0.92): 17 bundles, 17 passed, 0 failed quality, seller's accuracy estimate 0.906, GET /thanks -> 200
3. seller exports resolved labels with d402.tasks.exportResolved():
   319 of 500 tickets resolved (181 still need a 4th opinion), 52 bundles in total
   accuracy vs hidden truth: 319/319 = 100.0%
   written to .../use-cases/01-dataset-builder/out/labels.jsonl
     t_0068 medium   w=2.60 voters=3  "A user on the Pro plan noticed that the weekly digest email arrives twice."

RESULT: 319/500 tickets labelled at 100.0% accuracy from 52 bundles, no money moved; export at .../out/labels.jsonl
```

Each line of `out/labels.jsonl` is `{"id","text","label","weight","voters"}`.
