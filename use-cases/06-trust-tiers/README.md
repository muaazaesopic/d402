# 06 trust tiers

SPEC 5.2 over time. A seller with a 1300-snippet pool (100 golden) and rate
limits raised so 60 rounds fit in two seconds. An honest agent (p = 0.95,
seeded) earns 60 bundles of 20 items worth 40 calls each. Every 10 bundles the
story prints the seller's Laplace-smoothed accuracy estimate, the golden ratio
band it puts the agent in (recomputed with `goldenRatio` from `@d402/server`),
how many goldens the next bundle will carry, and the calls earned so far. A
lazy agent that always answers the first label is interleaved: it fails every
bundle, its accuracy falls to about 0.29, and its 6th request gets `403 blocked`.

```sh
pnpm --filter d402-uc-trust-tiers run start
```

What you will see (abridged):

```
3. honest agent, every 10 bundles (lazy agent interleaved for its first attempts):
   after  0 bundles: accuracy 0.500 (0/0 goldens), band 0.4 -> 8 goldens in the next 20, calls earned 0
   lazy agent: HTTP 403 blocked on its 6th request after 5 bundles (accuracy 0.286, 0 calls earned)
   after 10 bundles: accuracy 0.939 (76/80 goldens), band 0.2 -> 4 goldens in the next 20, calls earned 400
   after 20 bundles: accuracy 0.951 (115/120 goldens), band 0.2 -> 4 goldens in the next 20, calls earned 760
   after 30 bundles: accuracy 0.957 (154/160 goldens), band 0.2 -> 4 goldens in the next 20, calls earned 1120
   after 40 bundles: accuracy 0.960 (193/200 goldens), band 0.2 -> 4 goldens in the next 20, calls earned 1480
   after 50 bundles: accuracy 0.963 (232/240 goldens), band 0.1 -> 2 goldens in the next 20, calls earned 1840
   after 60 bundles: accuracy 0.966 (252/260 goldens), band 0.1 -> 2 goldens in the next 20, calls earned 2240

RESULT: honest: 56/60 bundles passed, 2240 calls, band 0.1; lazy: blocked after 5 bundles with 0 calls
```

A note on the seed: the simulated model is consistently wrong on the same items,
so what the seller sees is how many of its 100 goldens this model gets wrong,
not p. With p = 0.95 the expectation is 5 bad goldens, which lands right at the
0.1 band's `accuracy >= 0.95` edge. `HONEST_SEED` picks a model with 4 bad
goldens so the run shows all three bands; `run({ honestSeed })` lets you try others.
