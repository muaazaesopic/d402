/**
 * Simulated agent solvers for the benchmark.
 *
 * A "brain" decides a label for one item given the hidden truth (the simulation
 * knows the truth; the server does not). `toSolver` adapts a brain to the
 * `@d402/client` Solver signature, and `createSimAgent` gives it a keypair and a
 * model family so the runner can drive it against a real server.
 */
import { generateKeypair, type Bundle, type Keypair } from "@d402/spec";
import { hash32, mulberry32, pick } from "./gen-dataset.js";

export type Answers = Record<string, string>;
export type Solver = (bundle: Bundle) => Promise<Answers>;

export interface Item {
  id: string;
  text: string;
}

export interface BrainContext {
  /** Hidden ground truth for the whole dataset. */
  truth: Record<string, string>;
  /** Labels offered by the bundle. */
  labels: string[];
}

export interface AgentBrain {
  kind: "honest" | "lazy" | "replay" | "monoculture";
  /** Nominal accuracy on items (undefined for agents with no fixed p). */
  p?: number;
  answer(item: Item, ctx: BrainContext): string;
  /** Called by the runner after a submit with the pass/fail verdict. */
  onResult?(bundle: Bundle, answers: Answers, passed: boolean): void;
}

function wrongLabel(rng: () => number, truth: string, labels: string[]): string {
  const others = labels.filter((l) => l !== truth);
  return others.length ? pick(rng, others) : truth;
}

/** Answers the truth with probability p, otherwise a uniformly random wrong label. */
export function honest(p: number, seed: number): AgentBrain {
  const rng = mulberry32(seed);
  return {
    kind: "honest",
    p,
    answer(item, ctx) {
      const t = ctx.truth[item.id] ?? ctx.labels[0]!;
      return rng() < p ? t : wrongLabel(rng, t, ctx.labels);
    },
  };
}

/** Always answers the first label. */
export function lazy(): AgentBrain {
  return {
    kind: "lazy",
    answer(_item, ctx) {
      return ctx.labels[0]!;
    },
  };
}

/**
 * Memorises item -> answer from bundles that PASSED and replays them when the same
 * item reappears; answers uniformly at random otherwise.
 */
export function replay(seed: number): AgentBrain {
  const rng = mulberry32(seed);
  const memory = new Map<string, string>();
  return {
    kind: "replay",
    answer(item, ctx) {
      const known = memory.get(item.id);
      if (known !== undefined) return known;
      return pick(rng, ctx.labels);
    },
    onResult(_bundle, answers, passed) {
      if (!passed) return;
      for (const [id, label] of Object.entries(answers)) memory.set(id, label);
    },
  };
}

/**
 * Like `honest`, but errors are shared: whether the agent errs on an item is a
 * deterministic draw from (seed, item id), and the wrong label comes from
 * `sharedError` (populated on first use). Two monoculture agents built with the
 * same seed and map therefore agree on the same wrong answers, which is what the
 * diversity rule (requireModelFamilies) is meant to catch.
 */
export function monoculture(p: number, seed: number, sharedError: Map<string, string>): AgentBrain {
  return {
    kind: "monoculture",
    p,
    answer(item, ctx) {
      const t = ctx.truth[item.id] ?? ctx.labels[0]!;
      const rng = mulberry32(hash32(`${seed}:${item.id}`));
      if (rng() < p) return t;
      let w = sharedError.get(item.id);
      if (w === undefined) {
        w = wrongLabel(rng, t, ctx.labels);
        sharedError.set(item.id, w);
      }
      return w;
    },
  };
}

/** Pre-fill a shared error map with one wrong label per item. */
export function buildSharedErrors(truth: Record<string, string>, labels: string[], seed: number): Map<string, string> {
  const rng = mulberry32(seed);
  const m = new Map<string, string>();
  for (const [id, t] of Object.entries(truth)) m.set(id, wrongLabel(rng, t, labels));
  return m;
}

export function toSolver(brain: AgentBrain, truth: Record<string, string>): Solver {
  return async (bundle) => {
    const ctx: BrainContext = { truth, labels: bundle.labels };
    const answers: Answers = {};
    for (const item of bundle.items) answers[item.id] = brain.answer(item, ctx);
    return answers;
  };
}

export interface SimAgent {
  name: string;
  model: string;
  keypair: Keypair;
  brain: AgentBrain;
  solver: Solver;
}

export function createSimAgent(name: string, model: string, brain: AgentBrain, truth: Record<string, string>): SimAgent {
  return { name, model, keypair: generateKeypair(), brain, solver: toSolver(brain, truth) };
}
