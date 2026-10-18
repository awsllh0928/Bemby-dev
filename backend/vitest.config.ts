import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The data dir holds the downloaded browser and its profiles: thousands of files,
    // some of them written by whichever user ran the app, which is neither worth
    // scanning nor always readable from here.
    exclude: ["**/node_modules/**", "**/dist/**", "data/**"],
    watchExclude: ["**/node_modules/**", "data/**"],
    server: { watch: { ignored: ["**/data/**"] } },

    // The data layer needs a real server, so one in-memory replica set is started for the
    // whole run instead of per file. It is a replica set rather than a standalone mongod
    // because transactions are only offered by a replica set.
    globalSetup: ["./src/__tests__/setup/globalSetup.ts"],
    setupFiles: ["./src/__tests__/setup/mongoSetup.ts"],

    // Booting a mongod and connecting 60-odd times is not instant, and a test that waits on
    // the database is not hung: the default 5s trips on cold starts.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
