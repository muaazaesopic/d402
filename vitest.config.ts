import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@d402/spec": r("./packages/spec/src/index.ts"),
      "@d402/server": r("./packages/server/src/index.ts"),
      "@d402/client": r("./packages/client/src/index.ts"),
      "@d402/mcp": r("./packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts", "examples/**/*.test.ts", "bench/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
