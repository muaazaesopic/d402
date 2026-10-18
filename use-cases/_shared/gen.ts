/**
 * Shared helpers for the use cases. This folder is NOT a package: it imports
 * nothing but node built-ins, so every use case can pull it in by relative path.
 *
 * - mulberry32 / hash32: seeded PRNG and a string hash, so every run is reproducible.
 * - DOMAINS: three templated classify datasets (support tickets, news, shop reviews).
 * - generateDataset / toTaskFile / truthMap: items with hidden truth, and the
 *   seller's task-file rows (a few items marked golden).
 * - noisyLookup: a per-agent "model" that answers from the truth map with a fixed
 *   accuracy p. Pass it to createLookupSolver from @d402/client.
 */

export type Rng = () => number;

/** mulberry32: small seedable 32-bit PRNG, floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

interface Templates {
  subjects: string[];
  verbs: string[];
  objects: string[];
}

export interface Domain {
  name: string;
  idPrefix: string;
  labels: string[];
  instructions: string;
  openers: string[];
  templates: Record<string, Templates>;
}

const tickets: Domain = {
  name: "support tickets",
  idPrefix: "t",
  labels: ["low", "medium", "high", "critical"],
  instructions: "Label each support ticket with its urgency: low, medium, high or critical.",
  openers: ["", "", "Ticket: ", "From the inbox: "],
  templates: {
    low: {
      subjects: ["A customer", "One user on the free plan", "A trial account", "Someone in the community forum"],
      verbs: ["asks how to", "wants to know whether they can", "is curious if it is possible to", "would like a tip on how to"],
      objects: [
        "change the avatar on their profile",
        "export last month's invoice as a PDF",
        "rename a workspace without losing history",
        "switch the interface to dark mode",
        "add a second email address for notifications",
      ],
    },
    medium: {
      subjects: ["A customer", "A team lead", "A user on the Pro plan", "An admin of a 12-seat account"],
      verbs: ["reports that", "noticed that", "says that since yesterday", "complains that"],
      objects: [
        "the CSV export is missing the 'owner' column",
        "the weekly digest email arrives twice",
        "search results ignore the date filter",
        "the mobile app shows stale comment counts",
        "two-factor codes take a minute to arrive",
      ],
    },
    high: {
      subjects: ["A paying customer", "An enterprise admin", "A customer with a demo in an hour", "The finance team of a customer"],
      verbs: ["cannot", "is unable to", "has been trying for an hour to", "urgently needs to"],
      objects: [
        "log in after the password reset email never arrived",
        "stop a duplicate charge that hit their card twice",
        "restore a project that disappeared from the dashboard",
        "invite teammates because every invite link says expired",
        "download the report they already paid for",
      ],
    },
    critical: {
      subjects: ["Every customer in the EU region", "The whole 400-seat enterprise account", "All users behind the shared API key", "Our largest customer"],
      verbs: ["is seeing", "reports", "has been hit by", "is blocked by"],
      objects: [
        "500 errors on every checkout for the last 40 minutes",
        "data loss after the overnight migration",
        "a complete API outage during their product launch",
        "other customers' records showing up in their exports",
        "a login loop that locks out every single user",
      ],
    },
  },
};

const news: Domain = {
  name: "news snippets",
  idPrefix: "n",
  labels: ["sports", "business", "tech", "world"],
  instructions: "Label each news snippet with exactly one of: sports, business, tech, world.",
  openers: ["", "", "Breaking: ", "Update: "],
  templates: {
    sports: {
      subjects: ["The home side", "A 19-year-old striker", "The defending champions", "The national relay team"],
      verbs: ["clinched", "lost", "came back to win", "set a record in"],
      objects: ["the final in extra time", "the derby after a late penalty", "the season opener in front of 60,000 fans", "the 4x100m at the championships"],
    },
    business: {
      subjects: ["The retailer", "A regional bank", "The airline", "The logistics group"],
      verbs: ["posted", "warned of", "raised", "cut"],
      objects: ["a surprise quarterly profit", "its full-year guidance after weak demand", "dividends for the third year running", "2,000 jobs to trim costs"],
    },
    tech: {
      subjects: ["The chipmaker", "A startup", "The browser vendor", "The cloud provider"],
      verbs: ["unveiled", "open-sourced", "patched", "shipped"],
      objects: ["a faster GPU for data centres", "its on-device speech model", "a zero-day in the JavaScript engine", "a new region with liquid cooling"],
    },
    world: {
      subjects: ["Negotiators", "The coalition government", "Aid agencies", "Election observers"],
      verbs: ["agreed", "collapsed over", "warned about", "reported"],
      objects: ["a ceasefire along the disputed border", "a dispute on the pension reform", "flooding in the river delta", "irregularities at a dozen polling stations"],
    },
  },
};

const reviews: Domain = {
  name: "shop reviews",
  idPrefix: "r",
  labels: ["positive", "neutral", "negative"],
  instructions: "Label each product review as positive, neutral or negative.",
  openers: ["", "", "Review: ", "Verified purchase. "],
  templates: {
    positive: {
      subjects: ["The headphones", "This kettle", "The backpack", "The desk lamp"],
      verbs: ["exceeded", "nailed", "beat", "surprised me with"],
      objects: ["every expectation, five stars", "the build quality for the price", "the battery life claims", "how fast it arrived and how well it works"],
    },
    neutral: {
      subjects: ["The headphones", "This kettle", "The backpack", "The desk lamp"],
      verbs: ["are fine,", "does the job,", "is okay,", "works as described,"],
      objects: ["nothing special either way", "though the manual is thin", "about what you would expect at this price", "no complaints and no surprises"],
    },
    negative: {
      subjects: ["The headphones", "This kettle", "The backpack", "The desk lamp"],
      verbs: ["broke after", "stopped working after", "arrived damaged after", "disappointed me after"],
      objects: ["two weeks, returning it", "one wash cycle", "a single trip, zip failed", "the first evening, flickers constantly"],
    },
  },
};

export const DOMAINS = { tickets, news, reviews } as const;
export type DomainName = keyof typeof DOMAINS;

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export interface Item {
  id: string;
  text: string;
  truth: string;
}

/** A row of the seller's JSONL task file (SPEC section 10). */
export interface TaskRow {
  id: string;
  type: "classify";
  text: string;
  golden?: string;
}

function makeText(rng: Rng, domain: Domain, label: string): string {
  const t = domain.templates[label]!;
  return `${pick(rng, domain.openers)}${pick(rng, t.subjects)} ${pick(rng, t.verbs)} ${pick(rng, t.objects)}.`;
}

/** n items with balanced, shuffled hidden truth. Ids are `<prefix>_0001` and so on. */
export function generateDataset(domainName: DomainName, n: number, seed: number): Item[] {
  const domain = DOMAINS[domainName];
  const rng = mulberry32(seed);
  const truths: string[] = [];
  for (let i = 0; i < n; i++) truths.push(domain.labels[i % domain.labels.length]!);
  shuffle(rng, truths);
  return truths.map((truth, i) => ({
    id: `${domain.idPrefix}_${String(i + 1).padStart(4, "0")}`,
    text: makeText(rng, domain, truth),
    truth,
  }));
}

/** Seller task rows: `goldenCount` random items carry their truth as `golden`, the rest are unknown. */
export function toTaskFile(items: Item[], goldenCount: number, seed: number): TaskRow[] {
  const idx = shuffle(mulberry32(seed ^ 0x9e3779b9), items.map((_, i) => i));
  const golden = new Set(idx.slice(0, goldenCount));
  return items.map((it, i) => {
    const row: TaskRow = { id: it.id, type: "classify", text: it.text };
    if (golden.has(i)) row.golden = it.truth;
    return row;
  });
}

export function truthMap(items: Item[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) out[it.id] = it.truth;
  return out;
}

/**
 * A simulated model: answers from the truth map with probability `p`, otherwise a
 * different label. The mistake for a given (seed, item) is fixed, so the same
 * "model" is consistently wrong on the same items, like a real one would be.
 * Wrap it with createLookupSolver from @d402/client.
 */
export function noisyLookup(
  truth: Record<string, string>,
  labels: readonly string[],
  p: number,
  seed: number,
): (item: { id: string }) => string {
  return (item) => {
    const right = truth[item.id];
    if (right === undefined) throw new Error(`no truth for item ${item.id}`);
    const rng = mulberry32(hash32(`${seed}:${item.id}`));
    if (rng() < p) return right;
    const wrong = labels.filter((l) => l !== right);
    return pick(rng, wrong);
  };
}

/** Compare answered rows against the truth map. */
export function scoreAgainstTruth(
  rows: { id: string; answer: string }[],
  truth: Record<string, string>,
): { correct: number; total: number; accuracy: number } {
  let correct = 0;
  for (const r of rows) if (truth[r.id] === r.answer) correct++;
  return { correct, total: rows.length, accuracy: rows.length ? correct / rows.length : 0 };
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
