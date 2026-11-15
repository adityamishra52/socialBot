import { createFileRoute } from "@tanstack/react-router";
import { handle } from "../../server/app";

// All of /api/* goes through one small dispatcher (src/server/app.ts), so the whole API is a
// single Vercel function: one cold start, one MongoDB connection pool.
const run = ({ request }: { request: Request }) => handle(request);

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: { GET: run, POST: run, PUT: run, PATCH: run, DELETE: run, OPTIONS: run },
  },
});
