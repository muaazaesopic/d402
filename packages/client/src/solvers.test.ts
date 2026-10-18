import { describe, expect, it } from "vitest";
import type { Bundle } from "@d402/spec";
import { D402Error, buildClassifyPrompt, createLlmSolver, createLookupSolver, parseClassifyAnswers } from "./index.js";

const bundle: Bundle = {
  bundleId: "b_1",
  tier: "s",
  type: "classify",
  instructions: "Label each item with exactly one of the labels.",
  labels: ["sports", "tech"],
  items: [
    { id: "i_1", text: "The match ended 2-1" },
    { id: "i_2", text: "A new chip was announced" },
  ],
  expiresAt: 0,
};

describe("buildClassifyPrompt", () => {
  it("includes instructions, labels, numbered items with ids, and asks for JSON only", () => {
    const p = buildClassifyPrompt(bundle);
    expect(p).toContain("Label each item with exactly one of the labels.");
    expect(p).toContain("- sports");
    expect(p).toContain("- tech");
    expect(p).toContain('1. [id: i_1] "The match ended 2-1"');
    expect(p).toContain('2. [id: i_2] "A new chip was announced"');
    expect(p).toMatch(/ONLY a JSON object/);
    expect(p).toContain("item id");
  });
});

describe("parseClassifyAnswers", () => {
  it("parses plain JSON", () => {
    expect(parseClassifyAnswers('{"i_1":"sports","i_2":"tech"}', bundle)).toEqual({ i_1: "sports", i_2: "tech" });
  });

  it("parses fenced JSON", () => {
    const text = 'Here you go:\n```json\n{\n  "i_1": "sports",\n  "i_2": "tech"\n}\n```\n';
    expect(parseClassifyAnswers(text, bundle)).toEqual({ i_1: "sports", i_2: "tech" });
  });

  it("parses JSON surrounded by prose", () => {
    const text = 'Sure! The answers are {"i_1": "sports", "i_2": "tech"} as requested. Let me know {if} you need more.';
    expect(parseClassifyAnswers(text, bundle)).toEqual({ i_1: "sports", i_2: "tech" });
  });

  it("ignores extra keys and normalises label case", () => {
    expect(parseClassifyAnswers('{"i_1":"Sports","i_2":" tech ","i_9":"x"}', bundle)).toEqual({
      i_1: "sports",
      i_2: "tech",
    });
  });

  it("throws solver_bad_output when an item is missing", () => {
    const err = (() => {
      try {
        parseClassifyAnswers('{"i_1":"sports"}', bundle);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(D402Error);
    expect((err as D402Error).code).toBe("solver_bad_output");
    expect((err as D402Error).message).toContain("i_2");
  });

  it("throws solver_bad_output on a label outside the set", () => {
    expect(() => parseClassifyAnswers('{"i_1":"sports","i_2":"politics"}', bundle)).toThrowError(
      expect.objectContaining({ code: "solver_bad_output" }),
    );
  });

  it("throws solver_bad_output when there is no JSON at all", () => {
    expect(() => parseClassifyAnswers("I cannot do that.", bundle)).toThrowError(
      expect.objectContaining({ code: "solver_bad_output" }),
    );
  });
});

describe("createLlmSolver", () => {
  it("returns parsed answers on the first good reply", async () => {
    const prompts: string[] = [];
    const solver = createLlmSolver({
      complete: async (p) => {
        prompts.push(p);
        return '{"i_1":"sports","i_2":"tech"}';
      },
    });
    expect(await solver(bundle)).toEqual({ i_1: "sports", i_2: "tech" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(buildClassifyPrompt(bundle));
  });

  it("retries with a correction on bad output", async () => {
    const prompts: string[] = [];
    const replies = ["no idea", '{"i_1":"sports"}', '{"i_1":"sports","i_2":"tech"}'];
    const solver = createLlmSolver({
      complete: async (p) => {
        prompts.push(p);
        return replies[prompts.length - 1]!;
      },
    });
    expect(await solver(bundle)).toEqual({ i_1: "sports", i_2: "tech" });
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("previous reply could not be used");
    expect(prompts[2]).toContain("missing answers for: i_2");
    expect(prompts[1]!.startsWith(buildClassifyPrompt(bundle))).toBe(true);
  });

  it("gives up after maxRetries", async () => {
    let n = 0;
    const solver = createLlmSolver({
      complete: async () => {
        n++;
        return "garbage";
      },
      maxRetries: 1,
    });
    await expect(solver(bundle)).rejects.toMatchObject({ code: "solver_bad_output" });
    expect(n).toBe(2);
  });

  it("rethrows non-parse errors from complete without retrying", async () => {
    let n = 0;
    const solver = createLlmSolver({
      complete: async () => {
        n++;
        throw new Error("rate limited");
      },
    });
    await expect(solver(bundle)).rejects.toThrow("rate limited");
    expect(n).toBe(1);
  });
});

describe("createLookupSolver", () => {
  it("answers from a record", async () => {
    const solver = createLookupSolver({ i_1: "sports", i_2: "tech", i_other: "x" });
    expect(await solver(bundle)).toEqual({ i_1: "sports", i_2: "tech" });
  });

  it("answers from a function given item and bundle", async () => {
    const solver = createLookupSolver((item, b) => (item.text.includes("chip") ? b.labels[1]! : b.labels[0]!));
    expect(await solver(bundle)).toEqual({ i_1: "sports", i_2: "tech" });
  });

  it("throws when the record lacks an item", async () => {
    const solver = createLookupSolver({ i_1: "sports" });
    await expect(solver(bundle)).rejects.toMatchObject({ code: "solver_missing_answer" });
  });
});
