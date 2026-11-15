import { MongoServerError, type ObjectId } from "mongodb";
import { blocked, checkPassword, clearFailures, encrypt, hashPassword, pinFingerprint, recordFailure, safeEqual, sign, verify } from "./auth";
import { col, now, pack, toObjectId, unpack } from "./db";
import { config, env, registerEnvSecrets } from "./env";
import { AppError, ConfigError, HttpError, redact, registerSecret } from "./errors";
import { routes as manuscriptRoutes } from "./routes-manuscript";
import { routes as socialRoutes } from "./routes-social";
import { routes as emailRoutes } from "./routes-email";
import { routes as adminRoutes } from "./routes-admin";
import { routes as bannerRoutes } from "./routes-banner";
import { routes as shareRoutes } from "./routes-share";
import { fileFromToken, streamFile } from "./files";
import { tick } from "./autopilot";
import { sendBatch } from "./campaigns";

// The whole API in one serverless function. Each route says who may call it.

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  origin: string;
  user: any;
  body: <T = any>() => Promise<T>;
}
export type Handler = (ctx: Ctx) => Promise<any>;
export type Route = [method: string, path: string, access: "user" | "admin" | "public", handler: Handler];

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

export const SESSION_SECONDS = 12 * 3600;
export const ADMIN_SESSION_SECONDS = 2 * 3600;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

export function validPassword(value: unknown) {
  if (typeof value !== "string" || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD) {
    throw new ConfigError(`The password must be ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  }
  return value;
}

export const textField = (data: any, name: string) => (typeof data?.[name] === "string" ? data[name].trim() || null : null);

export function originOf(req: Request) {
  const configured = env("PUBLIC_URL").replace(/\/$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function bearer(req: Request) {
  const header = req.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function sessionUser(req: Request) {
  const session = verify<{ uid: string; ver: number }>("user-session", bearer(req));
  const userId = toObjectId(session?.uid);
  const user = userId ? await (await col("users")).findOne({ _id: userId }) : null;
  if (!user || !user.active || user.session_version !== session!.ver) throw new HttpError(401, "Please sign in again.");
  return user;
}

function adminSession(req: Request) {
  const pin = env("ADMIN_PIN");
  if (pin.length < 6) throw new HttpError(401, "Please sign in again.");
  const session = verify<{ pin: string }>("admin-session", bearer(req));
  if (!session || !safeEqual(String(session.pin || ""), pinFingerprint(pin))) throw new HttpError(401, "Please sign in again.");
}

// --- Sign-in, account and settings ---

const NUMERIC = /^\d{1,32}$/;
const APP_SECRET = /^[A-Za-z0-9]{16,64}$/;
const LI_ID = /^[A-Za-z0-9]{8,64}$/;
const LI_SECRET = /^[A-Za-z0-9._=+/-]{8,200}$/;

const accountRoutes: Route[] = [
  ["GET", "/api/health", "public", async () => ({ ok: true })],
  ["POST", "/api/login", "public", async ({ body }) => {
    const data = await body();
    const email = (textField(data, "email") || "").toLowerCase().slice(0, 254);
    const password = typeof data.password === "string" && data.password.length <= MAX_PASSWORD ? data.password : "";
    if (await blocked(`user:${email}`, 10)) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    const user = email ? await (await col("users")).findOne({ email }) : null;
    const correct = checkPassword(user?.password_hash, password);
    if (!user || !correct || !user.active) {
      await recordFailure(`user:${email}`);
      return json({ error: "That email or password isn't correct." }, 401);
    }
    await clearFailures(`user:${email}`);
    await (await col("users")).updateOne({ _id: user._id }, { $set: { last_login_at: now() } });
    return { token: sign("user-session", { uid: String(user._id), ver: user.session_version }, SESSION_SECONDS) };
  }],
  ["PUT", "/api/me/password", "user", async ({ body, user }) => {
    const data = await body();
    if (typeof data.current_password !== "string" || !checkPassword(user.password_hash, data.current_password)) throw new ConfigError("Your current password isn't correct.");
    const updated = await (await col("users")).findOneAndUpdate({ _id: user._id }, { $set: { password_hash: hashPassword(validPassword(data.new_password)) }, $inc: { session_version: 1 } }, { returnDocument: "after" });
    return { token: sign("user-session", { uid: String(updated!._id), ver: updated!.session_version }, SESSION_SECONDS) };
  }],
  ["GET", "/api/settings", "user", async ({ user, origin }) => {
    const c = (await (await col("connections")).findOne({ user_id: user._id })) || {};
    return {
      has_meta_token: Boolean(c.meta_token_enc), has_meta_app_secret: Boolean(c.meta_app_secret_enc), meta_app_id: c.meta_app_id || "",
      linkedin_client_id: c.linkedin_client_id || "", has_linkedin_client_secret: Boolean(c.linkedin_client_secret_enc),
      linkedin_redirect_uri: linkedinRedirect(origin), fb_page_id: c.fb_page_id || "", ig_user_id: c.ig_user_id || "", audience: c.audience || "", tone: c.tone || "",
    };
  }],
  ["PUT", "/api/settings", "user", async ({ body, user }) => {
    const data = await body();
    const fields: Record<string, any> = {};
    const unset: string[] = [];
    const token = textField(data, "meta_access_token");
    if (token) {
      if (token.length > 4096 || /\s/.test(token)) throw new ConfigError("That access token doesn't look right. Paste only the token.");
      fields.meta_token_enc = encrypt(token);
      registerSecret(token);
    }
    const appSecret = textField(data, "meta_app_secret");
    if (appSecret) {
      if (!APP_SECRET.test(appSecret)) throw new ConfigError("That app secret doesn't look right.", "Copy the App secret from your Meta app's Settings > Basic page.");
      fields.meta_app_secret_enc = encrypt(appSecret);
    }
    const liSecret = textField(data, "linkedin_client_secret");
    if (liSecret) {
      if (!LI_SECRET.test(liSecret)) throw new ConfigError("That LinkedIn client secret doesn't look right.", "Copy the Primary Client Secret from your LinkedIn app's Auth tab.");
      fields.linkedin_client_secret_enc = encrypt(liSecret);
    }
    if ("linkedin_client_id" in data) {
      const value = textField(data, "linkedin_client_id") || "";
      if (value && !LI_ID.test(value)) throw new ConfigError("That LinkedIn Client ID doesn't look right.");
      if (value) fields.linkedin_client_id = value;
      else unset.push("linkedin_client_id");
    }
    for (const [name, label] of [["fb_page_id", "Facebook Page ID"], ["ig_user_id", "Instagram user ID"], ["meta_app_id", "Meta App ID"]]) {
      if (!(name in data)) continue;
      const value = textField(data, name) || "";
      if (value && !NUMERIC.test(value)) throw new ConfigError(`The ${label} must contain only numbers.`);
      if (value) fields[name] = value;
      else unset.push(name);
    }
    for (const name of ["audience", "tone"]) {
      if (!(name in data)) continue;
      const value = (textField(data, name) || "").slice(0, 200);
      if (value) fields[name] = value;
      else unset.push(name);
    }
    const { updateConnection } = await import("./userconfig");
    await updateConnection(user._id, fields, unset);
    return { saved: true };
  }],
  ...(["meta-token:meta_token_enc", "meta-app-secret:meta_app_secret_enc", "linkedin-app:linkedin_client_id,linkedin_client_secret_enc"].map((spec): Route => {
    const [path, fields] = spec.split(":");
    return ["DELETE", `/api/settings/${path}`, "user", async ({ user }) => {
      const { updateConnection } = await import("./userconfig");
      await updateConnection(user._id, {}, fields.split(","));
      return { removed: true };
    }];
  })),
  ["GET", "/api/files/:id", "user", async ({ params, user, req }) => {
    const { ownsFile } = await import("./files");
    if (!(await ownsFile(user._id, params.id))) throw new HttpError(404, "That file wasn't found.");
    return streamFile(params.id, req.headers.get("range"));
  }],
  ["GET", "/api/public/file/:token", "public", async ({ params, req }) => {
    const id = fileFromToken(params.token);
    if (!id) return new Response("This link has expired.", { status: 403 });
    return streamFile(id, req.headers.get("range"));
  }],
  ["GET", "/api/cron/tick", "public", async ({ req, origin }) => cronTick(req, origin)],
  ["POST", "/api/cron/tick", "public", async ({ req, origin }) => cronTick(req, origin)],
];

async function cronTick(req: Request, origin: string) {
  const secret = env("CRON_SECRET");
  if (!secret) throw new HttpError(503, "CRON_SECRET isn't set on this server.", "Add CRON_SECRET in Vercel > Settings > Environment Variables, then redeploy.");
  if (!safeEqual(bearer(req) || new URL(req.url).searchParams.get("key") || "", secret)) throw new HttpError(401, "Not allowed.");
  const started = Date.now();
  const bots = await tick(origin, 30_000);
  const emails = Date.now() - started < 30_000 ? await sendBatch(Math.max(5_000, 45_000 - (Date.now() - started))) : 0;
  return { ok: true, bots, emails };
}

export function linkedinRedirect(origin: string) {
  return env("LINKEDIN_REDIRECT_URI") || `${origin}/api/linkedin/callback`;
}

// --- Dispatch ---

const ALL: Route[] = [...accountRoutes, ...socialRoutes, ...manuscriptRoutes, ...emailRoutes, ...adminRoutes, ...bannerRoutes, ...shareRoutes];
const COMPILED = ALL.map(([method, path, access, handler]) => {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, key) => {
    keys.push(key);
    return "([^/]+)";
  })}$`);
  return { method, pattern, keys, access, handler };
});

export async function handle(req: Request): Promise<Response> {
  registerEnvSecrets();
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  let bodyCache: Promise<any> | null = null;
  const body = <T,>() => (bodyCache ||= req.json().then((d) => (d && typeof d === "object" ? d : {})).catch(() => ({}))) as Promise<T>;
  let matched = false;
  try {
    for (const route of COMPILED) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      matched = true;
      if (route.method !== req.method) continue;
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      let user = null;
      if (route.access === "user") user = await sessionUser(req);
      else if (route.access === "admin") adminSession(req);
      const result = await route.handler({ req, url, params, origin: originOf(req), user, body });
      return result instanceof Response ? result : json(result);
    }
    return json({ error: matched ? "Method not allowed." : "Not found." }, matched ? 405 : 404);
  } catch (error: any) {
    if (error instanceof AppError) return json({ error: error.message, hint: error.hint || undefined }, error.httpStatus || 502);
    if (error instanceof MongoServerError || error?.name?.startsWith?.("Mongo")) {
      if (error?.code === 11000) return json({ error: "That already exists." }, 409);
      console.error("Database error:", redact(error?.message));
      return json({ error: "The database can't be reached right now.", hint: "Try again in a moment. On Atlas, allow access from 0.0.0.0/0 for Vercel." }, 503);
    }
    console.error("Unexpected error:", redact(error?.stack || error));
    return json({ error: "The server hit an unexpected error." }, 500);
  }
}

export { config, pack, unpack, toObjectId, col, now };
export type { ObjectId };
