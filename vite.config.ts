import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

// One Vercel deployment serves the pages and the API (server routes under /api).
// Every request is a short serverless call: long work (manuscripts, books, publishing, email
// campaigns) is split into steps the browser drives, so 60 seconds is always enough.
export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackStart(),
    nitro({
      preset: process.env.NITRO_PRESET || (process.env.VERCEL ? "vercel" : "node-server"),
      vercel: { functions: { maxDuration: 60, memory: 1024, runtime: "nodejs24.x" } },
    }),
    viteReact(),
  ],
});
