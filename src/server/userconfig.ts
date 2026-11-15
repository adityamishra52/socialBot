import type { ObjectId } from "mongodb";
import { decrypt } from "./auth";
import { col, now } from "./db";
import { config, env } from "./env";
import { registerSecret } from "./errors";
import type { UserConfig } from "./platforms";

export async function getConnection(userId: ObjectId): Promise<any> {
  return (await (await col("connections")).findOne({ user_id: userId })) || { user_id: userId };
}

export async function updateConnection(userId: ObjectId, set: Record<string, any> = {}, unset: string[] = []) {
  const update: any = { $set: { ...set, updated_at: now() } };
  if (unset.length) update.$unset = Object.fromEntries(unset.map((name) => [name, ""]));
  await (await col("connections")).updateOne({ user_id: userId }, update, { upsert: true });
}

const open = (value: unknown) => {
  if (!value) return "";
  const text = decrypt(String(value));
  registerSecret(text);
  return text;
};

/** Only this user's own credentials. Server-level Meta credentials never reach a user's posts. */
export async function configForUser(userId: ObjectId): Promise<UserConfig> {
  const c = await getConnection(userId);
  const ownLinkedIn = Boolean(c.linkedin_client_id && c.linkedin_client_secret_enc);
  const appSecret = open(c.meta_app_secret_enc);
  return {
    linkedinToken: c.linkedin_enc ? { access_token: open(c.linkedin_enc), expires_at: c.linkedin_expires_at, member_id: c.linkedin_member_id } : null,
    linkedinClientId: ownLinkedIn ? c.linkedin_client_id : env("LINKEDIN_CLIENT_ID"),
    linkedinClientSecret: ownLinkedIn ? open(c.linkedin_client_secret_enc) : env("LINKEDIN_CLIENT_SECRET"),
    linkedinVersion: config.linkedinVersion(),
    graphVersion: config.graphVersion(),
    fbPageId: c.fb_page_id || "",
    metaToken: open(c.meta_token_enc),
    igUserId: c.ig_user_id || "",
    appId: appSecret ? c.meta_app_id || "" : "",
    appSecret,
    audience: c.audience || config.audience(),
    tone: c.tone || config.tone(),
  };
}

export function configuredPlatforms(cfg: UserConfig, wanted: string[]) {
  const ready: Record<string, boolean> = {
    linkedin: Boolean(cfg.linkedinToken?.member_id),
    facebook: Boolean(cfg.fbPageId && cfg.metaToken),
    instagram: Boolean(cfg.igUserId && cfg.metaToken),
  };
  return wanted.filter((p) => ready[p]);
}
