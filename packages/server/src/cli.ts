#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "./store.js";
import { exportResolved, loadFile, stats } from "./pool.js";

const USAGE = `usage:
  d402-tasks load <db> <file.jsonl>   insert items from a JSONL task file (SPEC 10)
  d402-tasks export <db>              print resolved unknown items as JSONL
  d402-tasks stats <db>               print pool statistics as JSON`;

export function main(argv: string[], out: (line: string) => void = (l) => process.stdout.write(l + "\n")): number {
  const [cmd, db, file] = argv;
  if (!cmd || !db) {
    out(USAGE);
    return 2;
  }
  const store = new SqliteStore(db);
  try {
    switch (cmd) {
      case "load": {
        if (!file) {
          out(USAGE);
          return 2;
        }
        const n = loadFile(store, file);
        out(`loaded ${n} item(s) into ${db}`);
        return 0;
      }
      case "export": {
        for (const item of exportResolved(store)) out(JSON.stringify(item));
        return 0;
      }
      case "stats": {
        out(JSON.stringify(stats(store, Math.floor(Date.now() / 1000)), null, 2));
        return 0;
      }
      default:
        out(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    return !!entry && import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`d402-tasks: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
