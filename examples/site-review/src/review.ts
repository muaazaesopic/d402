/**
 * The `review` job: the agent pays for API access by reviewing a website instead
 * of labelling items. It is one listing on the marketplace (market.ts), which
 * runs the handshake, trust and vouchers; this file builds the assignment and
 * grades the report.
 *
 * Grading never trusts the report on its own. It checks it against what the
 * site recorded and against bugs the seller planted:
 *
 *   1. Visit proof      the session log shows >= MIN_PAGES distinct pages loaded
 *   2. Goals            the server saw signup, add-to-cart and checkout happen
 *   3. Checkpoints      the report carries the codes those pages showed
 *   4. Grounding        every finding is on a page the agent actually loaded
 *   5. Planted bugs     it found enough of the bugs switched on for this session (the goldens)
 *   6. False positives  it did not report planted bugs that were switched off, or broken links that load fine
 *
 * Findings that are not planted bugs become weighted votes. A finding is
 * confirmed once independent reviewers agree on it (SPEC 5.3 thresholds), so
 * one agent's hallucination never reaches the confirmed list.
 */
import { z } from "zod";
import { DEFAULTS } from "@d402/spec";
import { goldenCount } from "@d402/server";
import { BUG_CATALOG, CATEGORIES, GOALS, pageKey, type Category, type SessionStore } from "./site.js";
import { MarketError, resultMessage, signResult, type Agent, type Grade, type JobType } from "./market.js";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export const Finding = z.object({
  page: z.string().min(1).max(500),
  category: z.enum(CATEGORIES),
  title: z.string().min(1).max(200),
  steps: z.array(z.string().max(500)).max(20).default([]),
  expected: z.string().max(1000).default(""),
  actual: z.string().max(1000).default(""),
  severity: z.enum(["low", "medium", "high"]),
  /** URL, status code, selector or quoted text that backs the finding up. */
  evidence: z.string().max(2000).default(""),
  fix: z.string().max(1000).default(""),
});
export type Finding = z.infer<typeof Finding>;

export const Report = z.object({
  findings: z.array(Finding).max(50),
  usability: z.object({
    score: z.number().int().min(1).max(5),
    summary: z.string().min(1).max(2000),
    suggestions: z.array(z.string().max(500)).max(20).default([]),
  }),
  /** goal id -> code the site showed after that goal. */
  checkpoints: z.record(z.string(), z.string()).default({}),
});
export type Report = z.infer<typeof Report>;
export type ReportInput = z.input<typeof Report>;

export interface Assignment {
  assignmentId: string;
  type: "review";
  tier: string;
  siteUrl: string;
  instructions: string;
  goals: Array<{ id: string; description: string }>;
  categories: readonly string[];
  expiresAt: number;
}

export const REVIEW_TIER = { id: "review", items: BUG_CATALOG.length, est_tokens: 30000, reward: { calls: 50 } };

/** Message the agent signs: "d402:review\n{assignmentId}\n{canonical JSON of report}". */
export function reviewMessage(assignmentId: string, report: unknown): string {
  return resultMessage("review", assignmentId, report);
}
export function signReview(privateKey: string, assignmentId: string, report: unknown): string {
  return signResult(privateKey, "review", assignmentId, report);
}

// ---------------------------------------------------------------------------
// Grading constants
// ---------------------------------------------------------------------------

/** Distinct pages the session must have loaded. */
export const MIN_PAGES = 5;
/** Share of the session's planted bugs the review has to find. Lower than SPEC 5.1's 0.8: finding bugs is harder than labelling. */
export const PLANTED_PASS_RATIO = 0.6;
/** Reported planted bugs that were switched off, plus refuted broken links. */
export const MAX_FALSE_POSITIVES = 1;

const INSTRUCTIONS = [
  "Review the website at siteUrl like a careful QA tester and UX reviewer.",
  "Open siteUrl first: it starts your review session (a cookie). Use that session for everything.",
  "Complete every goal. Pages show a code after signup and after an order: put them in report.checkpoints as {\"signup\": \"...\", \"checkout\": \"...\"}.",
  "Report each real problem as a finding with the page path, a category, the steps to reproduce, expected vs actual, severity, evidence (URL, status code, selector or quoted text) and a suggested fix.",
  "Only report what you observed. Findings on pages you never opened, and problems that are not there, count against you.",
  "Finish with a usability score from 1 (unusable) to 5 (excellent), a summary and suggestions.",
].join(" ");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AssignmentState {
  id: string;
  sessionId: string;
  planted: string[];
}

export interface ReviewRecord {
  assignmentId: string;
  agent: string;
  model: string | null;
  at: number;
  passed: boolean;
  /** Why it was rejected. Seller-side only: the agent just gets "quality". */
  reasons: string[];
  planted: number;
  plantedFound: number;
  falsePositives: number;
  pagesVisited: string[];
  goalsDone: string[];
  findings: number;
  voteWeight: number;
  usability: Report["usability"];
}

interface Vote {
  weight: number;
  model: string | null;
  title: string;
  actual: string;
  fix: string;
  severity: Finding["severity"];
}

export interface IssueSummary {
  key: string;
  page: string;
  category: Category;
  title: string;
  fix: string;
  severity: Finding["severity"];
  reporters: number;
  weight: number;
  models: string[];
  confirmed: boolean;
}

function shuffle<T>(arr: T[], random: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Pull a site path out of evidence like "http://host/careers -> 404" or "/careers". */
export function evidencePath(evidence: string): string | undefined {
  for (const token of evidence.split(/\s+/)) {
    try {
      const u = new URL(token);
      if (u.protocol === "http:" || u.protocol === "https:") return u.pathname;
    } catch {
      // not a URL
    }
  }
  return /(?:^|[\s"'(=])(\/[^\s"'<>)]*)/.exec(evidence)?.[1];
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export interface ReviewJobOptions {
  /** Public origin, e.g. http://localhost:8788. */
  baseUrl: string;
  sessions: SessionStore;
  /** GET a site path with no session and return the status. Used to re-check reported broken links. */
  probe: (path: string) => Promise<number>;
  /** Seconds a review assignment stays open. Default 1800. */
  assignmentTtl?: number;
  now?: () => number;
}

export function createReviewJob(opts: ReviewJobOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const { sessions } = opts;

  const reviews: ReviewRecord[] = [];
  const issues = new Map<string, { page: string; category: Category; votes: Map<string, Vote>; confirmed: boolean }>();

  function assign(agent: Agent, ctx: { assignmentId: string; ttl: number; random: () => number }) {
    // Trusted reviewers get fewer planted bugs, like SPEC 5.2's golden ratio.
    const planted = shuffle(BUG_CATALOG, ctx.random)
      .slice(0, goldenCount(BUG_CATALOG.length, agent))
      .map((b) => b.id);
    const session = sessions.create(planted, ctx.ttl);
    const task = {
      siteUrl: `${opts.baseUrl}/r/${session.id}`,
      instructions: INSTRUCTIONS,
      goals: GOALS.map((g) => ({ id: g.id, description: g.description })),
      categories: CATEGORIES,
    };
    return { task, state: { id: ctx.assignmentId, sessionId: session.id, planted } };
  }

  async function grade(a: AssignmentState, raw: unknown, ctx: { agent: Agent; model: string | null; weight: number }): Promise<Grade> {
    const parsed = Report.safeParse(raw);
    if (!parsed.success) throw new MarketError("bad_request", `report is malformed: ${parsed.error.issues[0]?.message ?? ""}`);
    const report = parsed.data;
    const s = sessions.get(a.sessionId);
    if (!s) throw new MarketError("expired_bundle", "the review session has expired", 410);
    const reasons: string[] = [];

    // 1-3: did it actually use the site?
    const visited = new Set(sessions.pagesVisited(s));
    if (visited.size < MIN_PAGES) reasons.push(`loaded ${visited.size} distinct page(s); ${MIN_PAGES} required`);
    for (const g of GOALS) {
      if (!s.goals.has(g.id)) reasons.push(`goal "${g.id}" never happened on the site`);
      else if (g.checkpoint && report.checkpoints[g.id] !== sessions.checkpoint(s, g.id)) {
        reasons.push(`checkpoint code for "${g.id}" is missing or wrong`);
      }
    }

    // 4: every finding must be on a page it loaded.
    const ungrounded = report.findings.filter((f) => !visited.has(pageKey(f.page)));
    if (ungrounded.length > 0) {
      const pages = [...new Set(ungrounded.map((f) => pageKey(f.page)))].join(", ");
      reasons.push(`${ungrounded.length} finding(s) on pages it never loaded (${pages})`);
    }

    // 5-6: planted bugs.
    const active = BUG_CATALOG.filter((b) => a.planted.includes(b.id));
    const sameSpot = (f: Finding, b: { page: string; category: Category }) => pageKey(f.page) === b.page && f.category === b.category;
    const brokenHref = sessions.brokenHref(s);
    const provesPlanted = (f: Finding, b: (typeof BUG_CATALOG)[number]) =>
      sameSpot(f, b) && (b.id !== "broken-shipping-link" || f.evidence.includes(brokenHref));

    const found = active.filter((b) => report.findings.some((f) => provesPlanted(f, b))).length;
    let falsePositives = 0;
    const candidates: Finding[] = [];
    for (const f of report.findings) {
      if (active.some((b) => provesPlanted(f, b))) continue;
      const catalog = BUG_CATALOG.find((b) => sameSpot(f, b));
      if (catalog && !a.planted.includes(catalog.id)) {
        falsePositives++; // known to be absent in this session
        continue;
      }
      if (f.category === "broken-link") {
        const path = evidencePath(f.evidence);
        if (!path || (await opts.probe(path)) < 400) {
          falsePositives++; // the link it calls broken loads fine (or it gave no link)
          continue;
        }
      }
      if (catalog) continue; // a planted spot without the session's proof: not a vote either
      if (visited.has(pageKey(f.page))) candidates.push(f);
    }
    const needed = Math.ceil(active.length * PLANTED_PASS_RATIO);
    if (found < needed) reasons.push(`found ${found} of ${active.length} planted bug(s); ${needed} required`);
    if (falsePositives > MAX_FALSE_POSITIVES) reasons.push(`${falsePositives} false positive(s); at most ${MAX_FALSE_POSITIVES} allowed`);

    const passed = reasons.length === 0;
    if (passed) for (const f of candidates) vote(ctx.agent.key, ctx.model, ctx.weight, f);

    reviews.unshift({
      assignmentId: a.id,
      agent: ctx.agent.key,
      model: ctx.model,
      at: now(),
      passed,
      reasons,
      planted: active.length,
      plantedFound: found,
      falsePositives,
      pagesVisited: [...visited],
      goalsDone: [...s.goals],
      findings: report.findings.length,
      voteWeight: ctx.weight,
      usability: report.usability,
    });
    if (reviews.length > 500) reviews.length = 500;
    return { passed, reasons, goldenSeen: active.length, goldenCorrect: found };
  }

  /** One vote per agent per (page, category); resolved with SPEC 5.3's thresholds. */
  function vote(agent: string, model: string | null, weight: number, f: Finding): void {
    const page = pageKey(f.page);
    const key = `${page}|${f.category}`;
    let issue = issues.get(key);
    if (!issue) {
      issue = { page, category: f.category, votes: new Map(), confirmed: false };
      issues.set(key, issue);
    }
    const prev = issue.votes.get(agent);
    if (!prev || prev.weight < weight) {
      issue.votes.set(agent, { weight, model, title: f.title, actual: f.actual, fix: f.fix, severity: f.severity });
    }
    const votes = [...issue.votes.values()];
    const total = votes.reduce((sum, v) => sum + v.weight, 0);
    if (total >= DEFAULTS.resolveWeight && issue.votes.size >= DEFAULTS.resolveMinKeys) issue.confirmed = true;
  }

  function issueList(): IssueSummary[] {
    return [...issues.entries()]
      .map(([key, i]) => {
        const votes = [...i.votes.values()];
        const best = votes.slice().sort((x, y) => y.weight - x.weight)[0]!;
        return {
          key,
          page: i.page,
          category: i.category,
          title: best.title,
          fix: best.fix,
          severity: best.severity,
          reporters: votes.length,
          weight: Math.round(votes.reduce((s, v) => s + v.weight, 0) * 100) / 100,
          models: [...new Set(votes.map((v) => v.model).filter((m): m is string => !!m))],
          confirmed: i.confirmed,
        };
      })
      .sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.weight - a.weight);
  }

  // -- seller view ------------------------------------------------------------

  function state() {
    const passed = reviews.filter((r) => r.passed);
    const scores = passed.map((r) => r.usability.score);
    const list = issueList();
    return {
      stats: {
        reviews: reviews.length,
        passed: passed.length,
        rejected: reviews.length - passed.length,
        confirmedIssues: list.filter((i) => i.confirmed).length,
        candidateIssues: list.filter((i) => !i.confirmed).length,
        avgUsability: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      },
      reviews: reviews.slice(0, 50),
      issues: list,
    };
  }

  const job: JobType<AssignmentState> = {
    id: REVIEW_TIER.id,
    type: "review",
    title: "QA and UX review of Acme Home",
    poster: "Acme Home",
    summary: "Browse a small shop, complete signup, add-to-cart and checkout, and report every bug and usability problem you hit.",
    verification: "Graded against the site's own request log, checkpoint codes and bugs planted per session. Real bugs count once independent reviewers agree.",
    items: REVIEW_TIER.items,
    estTokens: REVIEW_TIER.est_tokens,
    reward: REVIEW_TIER.reward,
    ttl: opts.assignmentTtl ?? 1800,
    assign,
    grade,
    progress: () => {
      const list = issueList();
      return { done: list.filter((i) => i.confirmed).length, total: list.length, unit: "issues confirmed" };
    },
    results: () => ({ issues: issueList().filter((i) => i.confirmed), usability: state().stats.avgUsability }),
  };

  return { job, state };
}

export type ReviewJob = ReturnType<typeof createReviewJob>;
