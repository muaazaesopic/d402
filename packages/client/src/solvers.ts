import type { Answers, Bundle, ClassifyItem } from "@d402/spec";
import { D402Error } from "./errors.js";

export type Solver = (bundle: Bundle) => Promise<Answers>;

/**
 * A solver backed by a static map (item id -> label) or a function that
 * answers one item at a time. Useful for tests, benchmarks and oracles.
 */
export function createLookupSolver(
  lookup: Record<string, string> | ((item: ClassifyItem, bundle: Bundle) => string),
): Solver {
  return async (bundle) => {
    const answers: Answers = {};
    for (const item of bundle.items) {
      const answer = typeof lookup === "function" ? lookup(item, bundle) : lookup[item.id];
      if (typeof answer !== "string") {
        throw new D402Error("solver_missing_answer", `lookup solver has no answer for item ${item.id}`);
      }
      answers[item.id] = answer;
    }
    return answers;
  };
}

/** Build the prompt for a classify bundle. The model must answer with one JSON object. */
export function buildClassifyPrompt(bundle: Bundle): string {
  const lines: string[] = [];
  lines.push("You are labelling data for a classification task.");
  lines.push("");
  lines.push("Instructions:");
  lines.push(bundle.instructions.trim() || "Label each item with exactly one of the labels.");
  lines.push("");
  lines.push("Allowed labels (use these exact strings):");
  for (const label of bundle.labels) lines.push(`- ${label}`);
  lines.push("");
  lines.push(`Items (${bundle.items.length}):`);
  bundle.items.forEach((item, i) => {
    lines.push(`${i + 1}. [id: ${item.id}] ${JSON.stringify(item.text)}`);
  });
  lines.push("");
  lines.push(
    "Respond with ONLY a JSON object mapping each item id to one of the allowed labels, " +
      "with no prose, no markdown and no code fences. Every item id must appear exactly once.",
  );
  lines.push("Example shape:");
  const exampleIds = bundle.items.slice(0, 2).map((it) => it.id);
  const example: Record<string, string> = {};
  exampleIds.forEach((id, i) => {
    example[id] = bundle.labels[i % bundle.labels.length]!;
  });
  lines.push(JSON.stringify(example));
  return lines.join("\n");
}

/** Find the first balanced {...} block in `text` that parses as a JSON object. */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  // Prefer fenced blocks when present.
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = tryParseObject(m[1]!.trim());
    if (inner) return inner;
  }

  // Otherwise scan for balanced braces from each "{".
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = tryParseObject(text.slice(start, i + 1));
          if (candidate) return candidate;
          break;
        }
      }
    }
  }
  return undefined;
}

function tryParseObject(s: string): Record<string, unknown> | undefined {
  if (!s.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * Parse an LLM reply into answers for `bundle`. Tolerates code fences and prose
 * around the JSON, and matches labels case-insensitively. Throws D402Error
 * "solver_bad_output" when no JSON object is found, an item is missing, or an
 * answer is not one of the bundle's labels.
 */
export function parseClassifyAnswers(text: string, bundle: Bundle): Answers {
  const obj = extractJsonObject(text);
  if (!obj) {
    throw new D402Error("solver_bad_output", "no JSON object found in solver output", { body: text });
  }
  const byLower = new Map<string, string>();
  for (const label of bundle.labels) byLower.set(label.toLowerCase(), label);

  const answers: Answers = {};
  const missing: string[] = [];
  const bad: Array<{ id: string; value: unknown }> = [];
  for (const item of bundle.items) {
    const raw = obj[item.id];
    if (raw === undefined || raw === null) {
      missing.push(item.id);
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : String(raw);
    const label = bundle.labels.includes(value) ? value : byLower.get(value.toLowerCase());
    if (!label) {
      bad.push({ id: item.id, value: raw });
      continue;
    }
    answers[item.id] = label;
  }
  if (missing.length || bad.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing answers for: ${missing.join(", ")}`);
    if (bad.length) {
      parts.push(
        `answers not in labels: ${bad.map((b) => `${b.id}=${JSON.stringify(b.value)}`).join(", ")}`,
      );
    }
    throw new D402Error("solver_bad_output", parts.join("; "), { body: { missing, bad } });
  }
  return answers;
}

export interface LlmSolverOptions {
  /** Send a prompt to the model and return its text reply. */
  complete: (prompt: string) => Promise<string>;
  /** Extra attempts after the first when the reply cannot be parsed. Default 2. */
  maxRetries?: number;
}

/** A solver that asks an LLM and parses its JSON reply, retrying with a correction on bad output. */
export function createLlmSolver(opts: LlmSolverOptions): Solver {
  const maxRetries = opts.maxRetries ?? 2;
  return async (bundle) => {
    const base = buildClassifyPrompt(bundle);
    let prompt = base;
    let lastError: D402Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const text = await opts.complete(prompt);
      try {
        return parseClassifyAnswers(text, bundle);
      } catch (err) {
        if (!(err instanceof D402Error) || err.code !== "solver_bad_output") throw err;
        lastError = err;
        prompt =
          base +
          "\n\nYour previous reply could not be used (" +
          err.message +
          "). Reply again with ONLY the JSON object, covering every item id, " +
          "using only the allowed labels.";
      }
    }
    throw new D402Error(
      "solver_bad_output",
      `solver output could not be parsed after ${maxRetries + 1} attempts: ${lastError?.message ?? ""}`,
      { body: lastError?.body, cause: lastError },
    );
  };
}
