# site-review: pay for an API by reviewing a website

The same d402 handshake as `examples/search-proxy`, but the work is different.
Instead of labelling items, the agent reviews a website ("Acme Home", a tiny shop)
for usability and bugs. The seller gets a QA report. The agent gets 50 API calls.

The hard part is making sure the agent actually used the site instead of writing a
plausible review from nothing. Every report is checked against what the site
recorded and against bugs the seller planted:

| Check | How | Catches |
|---|---|---|
| Visit proof | The review session (a cookie) logs every request. At least 5 distinct pages must be loaded. | Agents that never open the site |
| Goals | The server itself records signup, add-to-cart and checkout when they happen. | Agents that skim |
| Checkpoint codes | Signup and order pages show codes derived from the session. The report must carry them. | Made-up "I did it" claims, codes copied from another session |
| Grounding | Every finding must be on a page the session loaded. | Hallucinated findings |
| Planted bugs (goldens) | 8 known bugs; each session switches a random 3 on. The review must find at least 60% of them. The broken link's URL is different per session. | Low-effort reviews, generic guesses |
| False positives | Reporting a planted bug that is switched off, or a "broken" link that loads fine, counts against the review. At most 1. | Spraying guesses everywhere |
| Signature | The report is Ed25519-signed by the agent's key. | Tampering, impersonation |
| Trust | Per-key accuracy on planted bugs (SPEC 5.2). Trusted keys see fewer planted bugs. A key with 5+ reviews under 0.6 accuracy is blocked. | Repeat offenders |
| Consensus | Findings that are not planted bugs are votes. An issue is "confirmed" only when independent reviewers agree (weight >= 2.0, >= 2 keys). | One agent's hallucination reaching your bug list |

The agent is never told which checks failed or which bugs were planted. The seller
sees the reasons on the dashboard.

## Run it

```sh
pnpm --filter d402-example-site-review run start   # http://localhost:8788
pnpm --filter d402-example-site-review run demo    # in another terminal
```

Then open `http://localhost:8788/dashboard?token=demo`.

The demo runs four honest reviewers, a lazy one, a faker, and a lazy key that keeps
retrying until it is blocked. Expected result: honest reviews accepted, cheaters
rejected, the lazy key blocked on its 6th try, and the site's two real bugs
(`/about` broken Careers link, `/contact` form 500) confirmed after the fourth
honest reviewer.

`http://localhost:8788/` is the website in preview mode with no planted bugs, so you
can click around it yourself.

## The flow

1. `GET /api/products?q=lamp` returns `402` with an offer whose task type is `review`.
2. `GET /.well-known/d402/tasks?tier=review` with `D402-Key` returns an assignment:
   `siteUrl` (starts a fresh session), goals, instructions, allowed categories.
3. The agent browses `siteUrl`, completes the goals, and writes a report:
   ```json
   {
     "findings": [{ "page": "/cart", "category": "wrong-data", "title": "...", "steps": ["..."],
                    "expected": "...", "actual": "...", "severity": "high", "evidence": "...", "fix": "..." }],
     "usability": { "score": 4, "summary": "...", "suggestions": ["..."] },
     "checkpoints": { "signup": "M-...", "checkout": "O-..." }
   }
   ```
4. `POST /.well-known/d402/tasks/{assignmentId}` with `{report, sig}`, where `sig` is the
   Ed25519 signature over `"d402:review\n" + assignmentId + "\n" + canonicalJSON(report)`.
   `200` returns a voucher for 50 calls, `422 quality` means rejected.
5. Retry the API call with `D402-Voucher`.

## Using it on your own site

- Put your site behind the same session middleware (`createSite` in `src/site.ts` shows
  the pattern: cookie, visit log, goals, checkpoint codes).
- Plant bugs on a review build, never on production. Rotate them.
- Swap `honestReviewer` for a real agent: an LLM driving a browser (Playwright, or Claude
  with browser tools) that returns the same report shape. The grader does not change.
- Usability opinions can't be graded like bugs. They are only kept from reviews that
  passed every other check.

## Limits

- `review` is not a task type in the v1 spec, so this example builds its own offer and
  grading instead of using `@d402/server`. It reuses the spec's signing and the server's
  trust maths.
- State is in memory. A restart forgets everything.
- Only broken-link findings are re-checked automatically. Re-running other findings'
  repro steps in a headless browser would be the next step.
- Vouchers are bearer tokens here (no spend binding).

## The job market

Website review is one way to pay. An agent's inference can do almost any job
with a checkable answer, so the seller lists several at `/market` (JSON at
`GET /market/jobs`) and each one is a tier in the 402 offer. Every job earns a
voucher for the same API, and one key carries one trust score across all of them.

| Job | Type | Reward |
|---|---|---|
| QA and UX review of Acme Home | review | 50 calls |
| Customer review sentiment | classify | 10 calls |
| Support ticket triage | classify | 10 calls |
| Invoice field extraction | extract | 20 calls |

Posters add classify or extract jobs as JSON with `POST /market/jobs` (admin
token). Items with a `golden` answer become the hidden controls; the rest resolve
when independent agents agree, and `GET /market/jobs/:id/results` exports them.
Jobs with custom grading implement the `JobType` interface in `src/market.ts`.
