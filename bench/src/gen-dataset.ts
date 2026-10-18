/**
 * Deterministic synthetic classify dataset with hidden ground truth.
 *
 * Items are built from per-label templates (subject + verb + object). A share of
 * items are "crossover" items that borrow a subject or object from a neighbouring
 * label, so the text is ambiguous enough that a simulated agent with p = 0.9 is a
 * realistic stand-in for an LLM rather than a trivially separable toy.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TaskFileItem } from "@d402/spec";

export const LABELS = ["sports", "business", "tech", "world"] as const;
export type Label = (typeof LABELS)[number];

export interface DatasetItem {
  id: string;
  text: string;
  truth: Label;
}

/** mulberry32: small, fast, seedable 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit string hash (FNV-1a), used to derive per-item seeds. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Fisher-Yates shuffle (in place) driven by the given PRNG. */
export function shuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

interface Templates {
  subjects: string[];
  verbs: string[];
  objects: string[];
  tails: string[];
}

const T: Record<Label, Templates> = {
  sports: {
    subjects: [
      "The home side",
      "The league leaders",
      "A rookie striker",
      "The national team",
      "The defending champions",
      "The marathon favourite",
      "The relegation-threatened club",
      "The veteran goalkeeper",
      "The Olympic sprint squad",
      "The tennis top seed",
    ],
    verbs: [
      "won",
      "lost",
      "drew",
      "clinched",
      "edged",
      "thrashed",
      "rallied past",
      "stumbled against",
      "set a record against",
      "beat",
    ],
    objects: [
      "the visitors in extra time",
      "their rivals in the cup final",
      "a weakened lineup on Saturday",
      "the title holders in a penalty shootout",
      "a stubborn defence in the second half",
      "the tournament's dark horse",
      "an injury-hit squad at home",
      "the top seed in straight sets",
      "a tough field at the championships",
      "the host nation in the semi-final",
    ],
    tails: [
      "after a late goal.",
      "despite a first-half red card.",
      "in front of a sold-out stadium.",
      "to go top of the table.",
      "as the coach watched from the stands.",
      "",
    ],
  },
  business: {
    subjects: [
      "The retailer",
      "A regional bank",
      "The airline",
      "The carmaker",
      "The private equity firm",
      "The supermarket chain",
      "A logistics company",
      "The insurer",
      "The energy group",
      "The pharmaceutical giant",
    ],
    verbs: [
      "reported",
      "posted",
      "forecast",
      "cut",
      "raised",
      "announced",
      "warned of",
      "booked",
      "disclosed",
      "projected",
    ],
    objects: [
      "a surprise quarterly profit",
      "weaker margins on rising costs",
      "a dividend increase for shareholders",
      "a merger with its closest competitor",
      "record annual revenue",
      "job losses across its branch network",
      "a share buyback worth billions",
      "a downgrade from analysts",
      "a drop in consumer demand",
      "guidance below market expectations",
    ],
    tails: [
      "sending its stock lower.",
      "ahead of the earnings call.",
      "as interest rates stayed high.",
      "according to its annual report.",
      "citing supply chain costs.",
      "",
    ],
  },
  tech: {
    subjects: [
      "The chipmaker",
      "A startup",
      "The open-source project",
      "The cloud provider",
      "The smartphone maker",
      "The social network",
      "The AI lab",
      "The browser team",
      "The database vendor",
      "The robotics company",
    ],
    verbs: [
      "released",
      "shipped",
      "open-sourced",
      "patched",
      "unveiled",
      "deprecated",
      "launched",
      "benchmarked",
      "rolled out",
      "rewrote",
    ],
    objects: [
      "a new large language model",
      "a critical security fix for its kernel",
      "a faster GPU for data centres",
      "an API for on-device inference",
      "a beta of its next operating system",
      "a compiler for its custom silicon",
      "end-to-end encryption for group chats",
      "a smaller transformer for edge devices",
      "a vector search feature",
      "a low-latency streaming protocol",
    ],
    tails: [
      "to developers this week.",
      "with support for Rust and Python.",
      "after months of testing.",
      "under a permissive licence.",
      "claiming a 2x speedup.",
      "",
    ],
  },
  world: {
    subjects: [
      "The prime minister",
      "The parliament",
      "The UN envoy",
      "Protesters",
      "The coalition government",
      "The foreign ministry",
      "Rescue teams",
      "The election commission",
      "The border agency",
      "The regional governor",
    ],
    verbs: [
      "condemned",
      "approved",
      "negotiated",
      "evacuated",
      "declared",
      "postponed",
      "brokered",
      "suspended",
      "reopened",
      "marched against",
    ],
    objects: [
      "a ceasefire along the disputed border",
      "a state of emergency after the floods",
      "sanctions on the neighbouring regime",
      "the general election amid unrest",
      "aid corridors into the besieged city",
      "a new constitution after the referendum",
      "talks with the opposition leader",
      "the embassy following the attack",
      "a peace deal after years of conflict",
      "the capital's curfew",
    ],
    tails: [
      "as diplomats gathered in Geneva.",
      "in a televised address.",
      "after weeks of demonstrations.",
      "according to state media.",
      "drawing international criticism.",
      "",
    ],
  },
};

/** Fraction of items that borrow a subject or object from another label. */
const CROSSOVER = 0.2;

function labelAfter(l: Label, offset: number): Label {
  return LABELS[(LABELS.indexOf(l) + offset) % LABELS.length]!;
}

function makeText(rng: () => number, truth: Label): string {
  const t = T[truth];
  let subject = pick(rng, t.subjects);
  let object = pick(rng, t.objects);
  const verb = pick(rng, t.verbs);
  const tail = pick(rng, t.tails);
  if (rng() < CROSSOVER) {
    // Borrow one slot from a neighbouring label; the verb and the other slot keep
    // the item on-topic, so `truth` remains the defensible label.
    const other = T[labelAfter(truth, 1 + Math.floor(rng() * 3))];
    if (rng() < 0.5) subject = pick(rng, other.subjects);
    else object = pick(rng, other.objects);
  }
  return `${subject} ${verb} ${object}${tail ? " " + tail : ""}`.trim();
}

/**
 * Generate `n` items with perfectly balanced labels (n % 4 extra items go to the
 * first labels). Output order is shuffled so ids do not leak the label.
 */
export function generateDataset(n: number, seed: number): DatasetItem[] {
  const rng = mulberry32(seed);
  const truths: Label[] = [];
  for (let i = 0; i < n; i++) truths.push(LABELS[i % LABELS.length]!);
  shuffle(rng, truths);
  const items: DatasetItem[] = [];
  for (let i = 0; i < n; i++) {
    const truth = truths[i]!;
    items.push({ id: `i_${String(i + 1).padStart(5, "0")}`, text: makeText(rng, truth), truth });
  }
  return items;
}

/** Convert to the seller task file shape; `goldenFraction` of items carry `golden`. */
export function toTaskFile(items: DatasetItem[], goldenFraction: number, seed: number): TaskFileItem[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const idx = shuffle(
    rng,
    items.map((_, i) => i),
  );
  const goldenCount = Math.round(items.length * goldenFraction);
  const golden = new Set(idx.slice(0, goldenCount));
  return items.map((it, i) => {
    const row: TaskFileItem = { id: it.id, type: "classify", text: it.text };
    if (golden.has(i)) row.golden = it.truth;
    return row;
  });
}

export function truthMap(items: DatasetItem[]): Record<string, Label> {
  const out: Record<string, Label> = {};
  for (const it of items) out[it.id] = it.truth;
  return out;
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** CLI: `tsx src/gen-dataset.ts [n] [seed] [goldenFraction] [outDir]`. */
function main(): void {
  const n = Number(process.argv[2] ?? 2000);
  const seed = Number(process.argv[3] ?? 42);
  const goldenFraction = Number(process.argv[4] ?? 0.15);
  const outDir = process.argv[5] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  const items = generateDataset(n, seed);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "dataset.jsonl"), toJsonl(toTaskFile(items, goldenFraction, seed)));
  writeFileSync(join(outDir, "truth.json"), JSON.stringify(truthMap(items), null, 2) + "\n");
  console.log(`wrote ${n} items (${Math.round(n * goldenFraction)} golden) to ${outDir}`);
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (isMain) main();
