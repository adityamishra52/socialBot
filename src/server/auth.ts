import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { col, now } from "./db";
import { env } from "./env";
import { ConfigError } from "./errors";

// --- Passwords (scrypt) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(stored: string | undefined, password: string): boolean {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") {
    scryptSync(password, "dummy-salt-for-timing", 32); // Same time whether or not the user exists.
    return false;
  }
  const expected = Buffer.from(parts[3], "base64");
  const actual = scryptSync(password, Buffer.from(parts[2], "base64"), expected.length, { N: Number(parts[1]), r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

// --- Signed tokens (sessions, OAuth state, unsubscribe and file links) ---

function secretKey(): string {
  const key = env("APP_SECRET_KEY");
  if (key.length < 16) throw new ConfigError("This server's sign-in isn't set up.", "Set APP_SECRET_KEY on Vercel (32+ random characters).");
  return key;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export function sign(purpose: string, payload: Record<string, unknown>, maxAgeSeconds?: number): string {
  const body = b64(JSON.stringify({ ...payload, ...(maxAgeSeconds ? { exp: Math.floor(Date.now() / 1000) + maxAgeSeconds } : {}) }));
  const mac = createHmac("sha256", `${secretKey()}:${purpose}`).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T = any>(purpose: string, token: unknown): T | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".", 2);
  const expected = createHmac("sha256", `${secretKey()}:${purpose}`).update(body).digest("base64url");
  const a = Buffer.from(mac || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (data.exp && data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

export function pinFingerprint(pin: string): string {
  return createHmac("sha256", secretKey()).update(pin).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

// --- Token vault (AES-256-GCM) for access tokens and app secrets ---

function vaultKey(): Buffer {
  const key = env("TOKEN_ENCRYPTION_KEY");
  if (key.length < 32) throw new ConfigError("TOKEN_ENCRYPTION_KEY is missing or too short.", "Set a random value of at least 32 characters on Vercel.");
  return createHash("sha256").update(key).digest();
}

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(data)}`;
}

export function decrypt(value: string): string {
  try {
    const [version, iv, tag, data] = value.split(".");
    if (version !== "v1") throw new Error("version");
    const decipher = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ConfigError("A saved access token can't be read.", "Save your access token again on the Settings page.");
  }
}

// --- Failed sign-in counting, shared by every serverless instance (kept 15 minutes) ---

export async function blocked(key: string, limit: number): Promise<boolean> {
  const failures = await col("login_failures");
  const since = new Date(Date.now() - 15 * 60 * 1000);
  return (await failures.countDocuments({ key, at: { $gte: since } })) >= limit;
}

export async function recordFailure(key: string) {
  await (await col("login_failures")).insertOne({ key, at: now() });
}

export async function clearFailures(key: string) {
  await (await col("login_failures")).deleteMany({ key });
}
