/**
 * Dataset jobs: anyone with data and a question posts a job as JSON, no code.
 *
 *   classify   pick one label per item              result: { [itemId]: label }
 *   extract    fill named fields from each item     result: { [itemId]: { [field]: value } }
 *
 * Items with a `golden` answer are the hidden controls (SPEC 5.1): a task mixes
 * some into the batch, the agent never knows which, and the result passes only
 * if it gets enough of them right. Answers on the other items are weighted votes;
 * an item resolves once independent agents agree (SPEC 5.3). The poster exports
 * the resolved items.
 */
import { z } from "zod";
import { DEFAULTS } from "@d402/spec";
import { goldenCount, passes } from "@d402/server";
import { MarketError, type Agent, type Grade, type JobType } from "./market.js";

const Item = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(10_000),
  /** classify: the label. extract: { field: value }. */
  golden: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
});

export const DatasetJobSpec = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, "id must be 2-40 chars of a-z, 0-9 and -"),
    type: z.enum(["classify", "extract"]),
    title: z.string().min(1).max(120),
    poster: z.string().min(1).max(80),
    summary: z.string().max(300).optional(),
    instructions: z.string().min(1).max(2000),
    labels: z.array(z.string().min(1).max(60)).min(2).max(50).optional(),
    fields: z
      .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), description: z.string().max(300).default("") }))
      .min(1)
      .max(20)
      .optional(),
    itemsPerTask: z.number().int().min(2).max(50).default(5),
    reward: z.object({ calls: z.number().int().min(1).max(1000) }).default({ calls: 10 }),
    estTokens: z.number().int().positive().optional(),
    items: z.array(Item).min(2).max(5000),
  })
  .superRefine((spec, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (spec.type === "classify" && !spec.labels) issue("a classify job needs labels");
    if (spec.type === "extract" && !spec.fields) issue("an extract job needs fields");
    const ids = new Set<string>();
    let goldens = 0;
    for (const it of spec.items) {
      if (ids.has(it.id)) issue(`duplicate item id "${it.id}"`);
      ids.add(it.id);
      if (it.golden === undefined) continue;
      goldens++;
      if (spec.type === "classify" && (typeof it.golden !== "string" || !spec.labels?.includes(it.golden))) {
        issue(`golden for "${it.id}" must be one of the labels`);
      }
      if (spec.type === "extract" && (typeof it.golden !== "object" || spec.fields?.some((f) => typeof (it.golden as Record<string, string>)[f.name] !== "string"))) {
        issue(`golden for "${it.id}" must give every field`);
      }
    }
    // Enough controls for a new agent's batch (40% of it), so tasks can always be built.
    const need = Math.max(1, Math.round(spec.itemsPerTask * 0.4));
    if (goldens < need) issue(`needs at least ${need} items with a golden answer (the hidden controls)`);
  });
export type DatasetJobSpec = z.input<typeof DatasetJobSpec>;

type Values = Record<string, string>;

interface ItemState {
  id: string;
  text: string;
  golden: Values | null;
  votes: Map<string, { values: Values; weight: number; model: string | null }>;
  resolved: Values | null;
}

interface TaskState {
  items: Array<{ id: string; golden: boolean }>;
}

/** Compare answers loosely: case, spacing, currency symbols and thousands separators do not matter. */
export function normalise(v: string): string {
  return v.toLowerCase().replace(/[$€£,]/g, "").replace(/\s+/g, " ").trim();
}

function shuffle<T>(arr: T[], random: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function createDatasetJob(input: DatasetJobSpec) {
  const spec = DatasetJobSpec.parse(input);
  const fields = spec.type === "classify" ? ["label"] : spec.fields!.map((f) => f.name);
  const asValues = (answer: unknown): Values | null => {
    if (spec.type === "classify") return typeof answer === "string" ? { label: answer } : null;
    if (!answer || typeof answer !== "object") return null;
    const out: Values = {};
    for (const f of fields) {
      const v = (answer as Record<string, unknown>)[f];
      if (typeof v !== "string") return null;
      out[f] = v.slice(0, 500);
    }
    return out;
  };

  const items = new Map<string, ItemState>(
    spec.items.map((it) => [it.id, { id: it.id, text: it.text, golden: it.golden === undefined ? null : asValues(it.golden), votes: new Map(), resolved: null }]),
  );
  const goldens = [...items.values()].filter((i) => i.golden);
  const unknowns = [...items.values()].filter((i) => !i.golden);
  const labelSet = new Set(spec.labels ?? []);

  function assign(agent: Agent, ctx: { random: () => number }) {
    const n = spec.itemsPerTask;
    const wantGolden = Math.min(n, goldenCount(n, agent));
    // Unresolved items this agent has not voted on, the closest to resolving first.
    const open = shuffle(
      unknowns.filter((i) => !i.resolved && !i.votes.has(agent.key)),
      ctx.random,
    )
      .sort((a, b) => b.votes.size - a.votes.size)
      .slice(0, n - wantGolden);
    const controls = shuffle(goldens, ctx.random).slice(0, n - open.length);
    if (controls.length < wantGolden) throw new MarketError("no_tasks", "not enough control items in this job", 409);
    const batch = shuffle(
      [...controls.map((i) => ({ id: i.id, golden: true })), ...open.map((i) => ({ id: i.id, golden: false }))],
      ctx.random,
    );
    const task: Record<string, unknown> = {
      instructions: spec.instructions,
      ...(spec.type === "classify" ? { labels: spec.labels } : { fields: spec.fields }),
      items: batch.map((b) => ({ id: b.id, text: items.get(b.id)!.text })),
    };
    return { task, state: { items: batch } satisfies TaskState };
  }

  function grade(state: TaskState, result: unknown, ctx: { agent: Agent; model: string | null; weight: number }): Grade {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new MarketError("bad_request", "result must be an object keyed by item id");
    const answers = new Map<string, Values>();
    for (const it of state.items) {
      const raw = (result as Record<string, unknown>)[it.id];
      if (raw === undefined) throw new MarketError("incomplete", `no answer for item ${it.id}`);
      const v = asValues(raw);
      if (!v) throw new MarketError("bad_request", `answer for item ${it.id} must be ${spec.type === "classify" ? "a label" : `{${fields.join(", ")}}`}`);
      if (spec.type === "classify" && !labelSet.has(v.label!)) throw new MarketError("bad_label", `answer for item ${it.id} is not one of the labels`);
      answers.set(it.id, v);
    }

    let seen = 0;
    let correct = 0;
    for (const it of state.items) {
      if (!it.golden) continue;
      seen++;
      const g = items.get(it.id)!.golden!;
      const a = answers.get(it.id)!;
      if (fields.every((f) => normalise(a[f]!) === normalise(g[f]!))) correct++;
    }
    const passed = passes(seen, correct);
    if (passed) {
      for (const it of state.items) {
        if (it.golden) continue;
        const item = items.get(it.id)!;
        item.votes.set(ctx.agent.key, { values: answers.get(it.id)!, weight: ctx.weight, model: ctx.model });
        tryResolve(item);
      }
    }
    const reasons = passed ? [] : [`${correct} of ${seen} control item(s) right; ${Math.ceil(seen * DEFAULTS.passRatio)} required`];
    return { passed, reasons, goldenSeen: seen, goldenCorrect: correct };
  }

  /** SPEC 5.3 per field; the item resolves when every field has a winner. */
  function tryResolve(item: ItemState): void {
    if (item.resolved) return;
    const out: Values = {};
    for (const f of fields) {
      const tally = new Map<string, { weight: number; keys: number; original: string }>();
      for (const v of item.votes.values()) {
        const k = normalise(v.values[f]!);
        const t = tally.get(k) ?? { weight: 0, keys: 0, original: v.values[f]! };
        t.weight += v.weight;
        t.keys += 1;
        tally.set(k, t);
      }
      const top = [...tally.values()].sort((a, b) => b.weight - a.weight)[0];
      if (!top || top.weight < DEFAULTS.resolveWeight || top.keys < DEFAULTS.resolveMinKeys) return;
      out[f] = top.original;
    }
    item.resolved = out;
  }

  const job: JobType<TaskState> = {
    id: spec.id,
    type: spec.type,
    title: spec.title,
    poster: spec.poster,
    summary:
      spec.summary ??
      (spec.type === "classify"
        ? `Label ${spec.itemsPerTask} items as ${spec.labels!.join(" / ")}.`
        : `Pull ${fields.join(", ")} out of ${spec.itemsPerTask} documents.`),
    verification: "Hidden control items with known answers are mixed into every batch. Other items resolve once independent agents agree.",
    items: spec.itemsPerTask,
    estTokens: spec.estTokens ?? spec.itemsPerTask * (spec.type === "classify" ? 150 : 300),
    reward: spec.reward,
    assign,
    grade,
    progress: () => ({
      done: unknowns.filter((i) => i.resolved).length,
      total: unknowns.length,
      unit: spec.type === "classify" ? "items labelled" : "documents extracted",
    }),
    results: () =>
      unknowns
        .filter((i) => i.resolved)
        .map((i) => ({ id: i.id, text: i.text, ...(spec.type === "classify" ? { label: i.resolved!.label } : { fields: i.resolved }), votes: i.votes.size })),
  };
  return job;
}
