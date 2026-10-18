import { readFileSync } from "node:fs";
import { TaskFileItem } from "@d402/spec";
import type { PoolStats, ResolvedItem, Store } from "./store.js";

/**
 * Pool operations that only need a Store, so the CLI can drive a database
 * without the rest of the seller options.
 */

/** Insert items, ignoring ids already present. Returns the number inserted. */
export function loadItems(store: Store, items: TaskFileItem[]): number {
  return store.insertItems(items);
}

/** Parse a JSONL task file (SPEC 10). Blank lines are skipped. */
export function parseTaskFile(text: string): TaskFileItem[] {
  const out: TaskFileItem[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    const parsed = TaskFileItem.safeParse(raw);
    if (!parsed.success) throw new Error(`line ${i + 1}: ${parsed.error.message}`);
    out.push(parsed.data);
  }
  return out;
}

export function loadFile(store: Store, path: string): number {
  return store.insertItems(parseTaskFile(readFileSync(path, "utf8")));
}

export function exportResolved(store: Store): ResolvedItem[] {
  return store.exportResolved();
}

export function stats(store: Store, now: number): PoolStats {
  return store.stats(now);
}
