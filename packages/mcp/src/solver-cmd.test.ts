import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Bundle } from "@d402/spec";
import { createCommandSolver } from "./solver-cmd.js";

const bundle: Bundle = {
  bundleId: "b_1",
  tier: "s",
  type: "classify",
  instructions: "label",
  labels: ["a", "b"],
  items: [
    { id: "i_1", text: "x" },
    { id: "i_2", text: "y" },
  ],
  expiresAt: 0,
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "d402-solver-"));
  tempDirs.push(dir);
  const p = join(dir, "solver.cjs");
  writeFileSync(p, body);
  return `node ${JSON.stringify(p)}`;
}

const READ_STDIN = `let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d);`;

describe("createCommandSolver", () => {
  it("pipes the bundle to stdin and parses answers from stdout", async () => {
    const cmd = script(`${READ_STDIN}const a={};for(const i of b.items)a[i.id]=b.labels[1];console.log(JSON.stringify(a));});`);
    const solver = createCommandSolver(cmd);
    await expect(solver(bundle)).resolves.toEqual({ i_1: "b", i_2: "b" });
  });

  it("accepts an { answers } wrapper", async () => {
    const cmd = script(`${READ_STDIN}console.log(JSON.stringify({answers:{i_1:"a",i_2:"a"}, bundleId:b.bundleId}));});`);
    await expect(createCommandSolver(cmd)(bundle)).resolves.toEqual({ i_1: "a", i_2: "a" });
  });

  it("rejects on a non-zero exit code", async () => {
    const cmd = script(`process.exit(3)`);
    await expect(createCommandSolver(cmd)(bundle)).rejects.toThrow(/exited with code 3/);
  });

  it("rejects when stdout is not JSON", async () => {
    const cmd = script(`console.log("not json")`);
    await expect(createCommandSolver(cmd)(bundle)).rejects.toThrow(/did not print JSON/);
  });

  it("rejects on timeout", async () => {
    const cmd = script(`setTimeout(()=>{}, 10000)`);
    await expect(createCommandSolver(cmd, { timeoutMs: 200 })(bundle)).rejects.toThrow(/timed out/);
  });
});
