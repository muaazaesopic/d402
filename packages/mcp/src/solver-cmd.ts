import { spawn } from "node:child_process";
import { Answers, type Bundle } from "@d402/spec";
import type { SolverLike } from "./types.js";

export interface CommandSolverOptions {
  /** Kill the command after this many milliseconds. Default 120000. */
  timeoutMs?: number;
  /** Environment for the child. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child. */
  cwd?: string;
}

/**
 * Builds a solver that runs a shell command: the bundle JSON is written to the
 * command's stdin and the answers JSON (`{ itemId: label }`) is read from stdout.
 * This is what `D402_SOLVER_CMD` turns into for `d402_fetch { autoEarn: true }`.
 */
export function createCommandSolver(command: string, opts: CommandSolverOptions = {}): SolverLike {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return (bundle: Bundle) =>
    new Promise<Answers>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "pipe", "inherit"],
        env: opts.env ?? process.env,
        cwd: opts.cwd,
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`solver command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`solver command failed to start: ${err.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString("utf8");
        if (code !== 0) {
          reject(new Error(`solver command exited with code ${code}: ${command}`));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          reject(new Error(`solver command did not print JSON answers on stdout: ${out.slice(0, 200)}`));
          return;
        }
        // Accept either `{ "i_1": "label" }` or `{ "answers": { ... } }`.
        const candidate =
          parsed && typeof parsed === "object" && "answers" in (parsed as Record<string, unknown>)
            ? (parsed as { answers: unknown }).answers
            : parsed;
        const res = Answers.safeParse(candidate);
        if (!res.success) {
          reject(new Error("solver command printed JSON that is not a { itemId: label } object"));
          return;
        }
        resolve(res.data);
      });

      child.stdin.on("error", () => {
        /* child exited before reading stdin; the close handler reports it */
      });
      child.stdin.end(JSON.stringify(bundle));
    });
}
