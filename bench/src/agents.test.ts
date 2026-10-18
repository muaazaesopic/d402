import { describe, expect, it } from "vitest";
import type { Bundle } from "@d402/spec";
import { buildSharedErrors, createSimAgent, honest, lazy, monoculture, replay, toSolver } from "./agents.js";
import { LABELS, generateDataset, truthMap } from "./gen-dataset.js";

const items = generateDataset(1000, 21);
const truth = truthMap(items);
const labels = [...LABELS];

function bundle(slice: { id: string; text: string }[], id = "b_1"): Bundle {
  return {
    bundleId: id,
    tier: "m",
    type: "classify",
    instructions: "label",
    labels,
    items: slice.map(({ id, text }) => ({ id, text })),
    expiresAt: 0,
  };
}

describe("honest", () => {
  it("answers the truth with probability p and otherwise a wrong label", async () => {
    const solver = toSolver(honest(0.9, 1), truth);
    const answers = await solver(bundle(items));
    let correct = 0;
    for (const it of items) {
      const a = answers[it.id]!;
      expect(labels).toContain(a);
      if (a === it.truth) correct++;
    }
    expect(correct / items.length).toBeGreaterThan(0.87);
    expect(correct / items.length).toBeLessThan(0.93);
  });

  it("is deterministic per seed", async () => {
    const a = await toSolver(honest(0.8, 5), truth)(bundle(items));
    const b = await toSolver(honest(0.8, 5), truth)(bundle(items));
    expect(a).toEqual(b);
  });
});

describe("lazy", () => {
  it("always answers the first label", async () => {
    const answers = await toSolver(lazy(), truth)(bundle(items.slice(0, 100)));
    for (const v of Object.values(answers)) expect(v).toBe("sports");
  });
});

describe("replay", () => {
  it("reuses answers from passed bundles and is random otherwise", async () => {
    const brain = replay(3);
    const solver = toSolver(brain, truth);
    const first = items.slice(0, 25);
    const b1 = bundle(first, "b_1");
    const a1 = await solver(b1);
    brain.onResult!(b1, a1, true);
    const a2 = await solver(bundle(first, "b_2"));
    expect(a2).toEqual(a1);

    // a failed bundle is not memorised
    const second = items.slice(25, 50);
    const b3 = bundle(second, "b_3");
    const a3 = await solver(b3);
    brain.onResult!(b3, a3, false);
    const a4 = await solver(bundle(second, "b_4"));
    expect(a4).not.toEqual(a3);

    // unseen items: roughly chance level
    const fresh = await solver(bundle(items.slice(100, 1000)));
    let correct = 0;
    for (const it of items.slice(100, 1000)) if (fresh[it.id] === it.truth) correct++;
    expect(correct / 900).toBeGreaterThan(0.15);
    expect(correct / 900).toBeLessThan(0.35);
  });
});

describe("monoculture", () => {
  it("two agents with the same seed and map make the same errors", async () => {
    const shared = buildSharedErrors(truth, labels, 9);
    const a = await toSolver(monoculture(0.85, 77, shared), truth)(bundle(items));
    const b = await toSolver(monoculture(0.85, 77, shared), truth)(bundle(items));
    expect(a).toEqual(b);
    let correct = 0;
    let wrongShared = 0;
    for (const it of items) {
      if (a[it.id] === it.truth) correct++;
      else {
        expect(a[it.id]).toBe(shared.get(it.id));
        wrongShared++;
      }
    }
    expect(correct / items.length).toBeGreaterThan(0.8);
    expect(correct / items.length).toBeLessThan(0.9);
    expect(wrongShared).toBeGreaterThan(50);
  });

  it("fills an empty shared map on first use", async () => {
    const shared = new Map<string, string>();
    await toSolver(monoculture(0.5, 1, shared), truth)(bundle(items.slice(0, 200)));
    expect(shared.size).toBeGreaterThan(50);
    for (const [id, w] of shared) expect(w).not.toBe(truth[id]);
  });
});

describe("createSimAgent", () => {
  it("gives each agent its own keypair and model family", () => {
    const a = createSimAgent("a", "claude", honest(0.9, 1), truth);
    const b = createSimAgent("b", "gpt", honest(0.9, 2), truth);
    expect(a.keypair.publicKey).not.toBe(b.keypair.publicKey);
    expect(a.model).toBe("claude");
    expect(b.model).toBe("gpt");
  });
});
