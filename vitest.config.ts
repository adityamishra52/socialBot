import { defineConfig } from "vitest/config";

// Tests run without the app's Vite plugins and never touch the network or a database.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
