import { setServers, getServers } from "node:dns";
import { Binary, MongoClient, ObjectId, type Collection, type Db, type Document } from "mongodb";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { env, registerEnvSecrets } from "./env";
import { ConfigError } from "./errors";

// MongoDB is the only storage: no S3, no Redis. Bulky parts of every record are saved as a ZIP
// archive (one "data.json" entry) in a BSON Binary field `z`, so Atlas's free 512 MB goes far.
// Fields used in queries and sorting stay plain next to it.

const ZIP_ENTRY = "data.json";

/** Pack a value into a real ZIP archive held in BSON Binary. Any unzip tool can open it. */
export function zipValue(value: unknown): Binary {
  const bytes = strToU8(JSON.stringify(value ?? null));
  const archive = zipSync({ [ZIP_ENTRY]: [bytes, { level: 6 }] });
  return new Binary(Buffer.from(archive));
}

export function unzipValue(binary: any): any {
  if (!binary) return null;
  const buffer: Uint8Array = binary instanceof Binary ? binary.buffer : binary.buffer ? new Uint8Array(binary.buffer) : binary;
  const files = unzipSync(buffer);
  const entry = files[ZIP_ENTRY];
  return entry ? JSON.parse(strFromU8(entry)) : null;
}

/** A document with `keep` fields plain and everything else zipped into `z`. */
export function pack(document: Record<string, any>, keep: string[]): Record<string, any> {
  const plain: Record<string, any> = {};
  const rest: Record<string, any> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === "_id" || keep.includes(key)) plain[key] = value;
    else if (key !== "z") rest[key] = value;
  }
  plain.z = zipValue(rest);
  return plain;
}

export function unpack<T = any>(document: any): T {
  if (!document) return document;
  const { z, ...plain } = document;
  return { ...(z ? unzipValue(z) : {}), ...plain };
}

// --- Connection (cached across warm serverless invocations) ---

const globalCache = globalThis as unknown as { __mongo?: { client: MongoClient; db: Db; ready?: Promise<void> } };

export async function database(): Promise<Db> {
  registerEnvSecrets();
  if (!globalCache.__mongo) {
    const uri = env("MONGODB_URI");
    if (!uri) throw new ConfigError("The database isn't set up.", "Set MONGODB_URI on Vercel (for example a free MongoDB Atlas cluster).");
    // Some home and office DNS servers refuse the SRV lookups mongodb+srv needs. Locally, try public DNS first.
    if (!process.env.VERCEL && uri.startsWith("mongodb+srv://")) {
      try {
        setServers([...new Set(["8.8.8.8", "1.1.1.1", ...getServers()])]);
      } catch {
        // Keep the system's DNS servers.
      }
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, appName: "social-autopost" });
    globalCache.__mongo = { client, db: client.db(env("MONGODB_DB", "social_autopost")) };
  }
  const cache = globalCache.__mongo;
  if (!cache.ready) cache.ready = ensureIndexes(cache.db).catch((error) => {
    cache.ready = undefined;
    throw error;
  });
  await cache.ready;
  return cache.db;
}

export async function col<T extends Document = any>(name: string): Promise<Collection<T>> {
  return (await database()).collection<T>(name);
}

// --- Retention: MongoDB deletes records and files by itself (TTL indexes) ---
// Posts, reels, campaigns, email templates, manuscripts, books, research, bot runs and every
// stored file are deleted HISTORY_DAYS (7 by default) after they were made or last changed.
// Kept for good: users and their settings, topics, bots, unsubscribes (they must always be
// honoured) and the AI cost records (ai_usage), so costs can always be shown.

export const retentionSeconds = () => Math.round(Math.max(1, Number(process.env.HISTORY_DAYS) || 7) * 86400);
/** When a stored file expires; pushed back while something kept still uses it. */
export const fileExpiry = () => new Date(Date.now() + retentionSeconds() * 1000);

async function ensureIndexes(db: Db) {
  const ttl = retentionSeconds();
  const specs: [string, Record<string, 1 | -1>, Record<string, any>?][] = [
    ["users", { email: 1 }, { unique: true }],
    ["connections", { user_id: 1 }, { unique: true }],
    ["topics", { user_id: 1 }, { unique: true }],
    ["posts", { user_id: 1, created_at: -1 }],
    ["posts", { created_at: 1 }, { expireAfterSeconds: ttl }],
    ["email_templates", { user_id: 1, updated_at: -1 }],
    ["email_templates", { updated_at: 1 }, { expireAfterSeconds: ttl }],
    ["email_campaigns", { user_id: 1, created_at: -1 }],
    ["email_campaigns", { status: 1, created_at: 1 }],
    ["email_campaigns", { updated_at: 1 }, { expireAfterSeconds: ttl }],
    ["email_unsubscribes", { user_id: 1, email: 1 }, { unique: true }],
    ["email_days", { day: 1 }, { unique: true }],
    ["ai_usage", { user_id: 1, created_at: -1 }],
    ["ai_usage", { created_at: -1 }],
    ["bots", { user_id: 1, created_at: 1 }],
    ["bots", { active: 1, next_run_at: 1 }],
    ["bot_runs", { user_id: 1, started_at: -1 }],
    ["bot_runs", { started_at: 1 }, { expireAfterSeconds: ttl }],
    ["bot_memory", { user_id: 1 }, { unique: true }],
    ["manuscripts", { user_id: 1, updated_at: -1 }],
    ["manuscripts", { updated_at: 1 }, { expireAfterSeconds: ttl }],
    ["research", { user_id: 1, created_at: -1 }],
    ["research", { created_at: 1 }, { expireAfterSeconds: ttl }],
    ["files", { user_id: 1, created_at: -1 }],
    ["files", { expires_at: 1 }, { expireAfterSeconds: 0 }],
    ["file_chunks", { file_id: 1, n: 1 }, { unique: true }],
    ["file_chunks", { expires_at: 1 }, { expireAfterSeconds: 0 }],
    ["login_failures", { key: 1 }],
    ["login_failures", { at: 1 }, { expireAfterSeconds: 900 }],
  ];
  await Promise.all(specs.map(async ([name, keys, options = {}]) => {
    try {
      await db.collection(name).createIndex(keys, options);
    } catch (error: any) {
      // The retention period changed (HISTORY_DAYS): update the existing TTL index in place.
      if ((error?.code === 85 || error?.code === 86) && options.expireAfterSeconds !== undefined) {
        const existing = (await db.collection(name).indexes()).find((i) => JSON.stringify(i.key) === JSON.stringify(keys));
        if (existing?.expireAfterSeconds !== undefined) {
          await db.command({ collMod: name, index: { keyPattern: keys, expireAfterSeconds: options.expireAfterSeconds } });
          return;
        }
        if (existing?.name) {
          await db.collection(name).dropIndex(existing.name);
          await db.collection(name).createIndex(keys, options);
          return;
        }
      }
      throw error;
    }
  }));
}

export function toObjectId(value: unknown): ObjectId | null {
  if (typeof value !== "string" || !ObjectId.isValid(value) || value.length !== 24) return null;
  return new ObjectId(value);
}

export const now = () => new Date();
export { ObjectId };
