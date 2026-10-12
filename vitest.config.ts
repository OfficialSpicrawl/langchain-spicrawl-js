import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    testTimeout: mode === "int" ? 100_000 : 30_000,
    // *.int.test.ts call the live API and spend credits: only `npm run test:int` runs them
    include: mode === "int" ? ["**/*.int.test.ts"] : configDefaults.include,
    exclude: mode === "int" ? configDefaults.exclude : ["**/*.int.test.ts", ...configDefaults.exclude],
  },
}));
