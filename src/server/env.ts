import { existsSync } from "node:fs";
import { registerSecret } from "./errors";

// Local runs read .env (git-ignored). On Vercel the project's Environment Variables are used.
// Values already set in the environment always win.
if (!process.env.VERCEL && !process.env.VITEST && existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // A damaged .env is ignored; the app reports the missing settings instead.
  }
}

/** A setting, treating an empty value like an unset one. */
export function env(name: string, fallback = ""): string {
  return (process.env[name] || "").trim() || fallback;
}

export function envNumber(name: string, fallback: number, minimum = 0): number {
  const value = Number(env(name));
  return Number.isFinite(value) && env(name) !== "" ? Math.max(minimum, value) : fallback;
}

const SECRET_NAMES = [
  "GEMINI_API_KEY", "LINKEDIN_CLIENT_SECRET", "APP_SECRET_KEY", "TOKEN_ENCRYPTION_KEY", "MONGODB_URI",
  "SMTP_PASSWORD", "CRON_SECRET", "GOOGLE_BOOKS_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "NCBI_API_KEY",
];
let registered = false;
export function registerEnvSecrets() {
  if (registered) return;
  registered = true;
  for (const name of SECRET_NAMES) registerSecret(env(name));
  try {
    const password = new URL(env("MONGODB_URI")).password;
    registerSecret(password ? decodeURIComponent(password) : "");
  } catch {
    // Not a URL yet: nothing to register.
  }
}

export const DEFAULTS = {
  audience: "professionals interested in this topic",
  tone: "friendly and professional",
  linkedinVersion: "202609",
  graphVersion: "v26.0",
};

export const config = {
  audience: () => env("POST_AUDIENCE", DEFAULTS.audience),
  tone: () => env("POST_TONE", DEFAULTS.tone),
  linkedinVersion: () => env("LINKEDIN_VERSION", DEFAULTS.linkedinVersion),
  graphVersion: () => env("META_GRAPH_VERSION", DEFAULTS.graphVersion),
  historyDays: () => Math.round(envNumber("HISTORY_DAYS", 7, 1)),
  geminiKey: () => env("GEMINI_API_KEY"),
};
