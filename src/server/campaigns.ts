import type { ObjectId } from "mongodb";
import { sign } from "./auth";
import { col, now, pack, unpack } from "./db";
import { envNumber } from "./env";
import { redact } from "./errors";
import { readFile } from "./files";
import { DEFAULT_NAME, personalize, renderHtml, renderText } from "./emailer";
import { MailError, sendHtml, smtpSettings, transport } from "./mail";

// Bulk email without a background thread: each request (the open Send page, or the cron tick)
// sends a batch for up to ~40 seconds and saves progress after every email. A failed address is
// recorded and never retried, so nobody gets the same email twice.

export const STALE_SECONDS = 600;
const MAX_CONSECUTIVE_FAILURES = 5;
const PLAIN = ["user_id", "status", "created_at", "updated_at", "next_index", "sent", "failed", "skipped", "total", "locked_until", "error", "name", "subject", "failures"];

export const dailyLimit = () => Math.round(envNumber("EMAIL_DAILY_LIMIT", 450, 1));
const delayMs = () => envNumber("EMAIL_SEND_DELAY_SECONDS", 1.5, 0) * 1000;

export async function createCampaign(userId: ObjectId, fields: Record<string, any>) {
  const document = {
    ...fields, user_id: userId, status: "queued", next_index: 0, sent: 0, failed: 0, skipped: 0, failures: [], error: null,
    created_at: now(), updated_at: now(), locked_until: new Date(0),
  };
  const result = await (await col("email_campaigns")).insertOne(pack(document, PLAIN));
  return result.insertedId;
}

export function campaignJson(c: any) {
  return {
    id: String(c._id), name: c.name || "", subject: c.subject || "", status: c.status, total: c.total || 0, sent: c.sent || 0,
    failed: c.failed || 0, skipped: c.skipped || 0, remaining: Math.max(0, (c.total || 0) - (c.next_index || 0)),
    failures: (c.failures || []).slice(-50), error: c.error || null,
    created_at: new Date(c.created_at).toISOString(), updated_at: c.updated_at ? new Date(c.updated_at).toISOString() : null,
  };
}

export async function reserveEmail(limit = dailyLimit()): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const days = await col("email_days");
  try {
    const document = await days.findOneAndUpdate({ day, count: { $lt: limit } }, { $inc: { count: 1 } }, { upsert: true, returnDocument: "after" });
    return Boolean(document && document.count <= limit);
  } catch (error: any) {
    if (error?.code === 11000) return false; // Today's counter exists and is at the limit.
    throw error;
  }
}

export async function sentToday() {
  return Number((await (await col("email_days")).findOne({ day: new Date().toISOString().slice(0, 10) }))?.count || 0);
}

export function unsubscribeUrl(campaign: any, email: string) {
  if (!campaign.unsubscribe_base) return "";
  return `${campaign.unsubscribe_base}?t=${sign("email-unsubscribe", { u: String(campaign.user_id), e: email })}`;
}

/** Load uploaded figures once per batch, as inline attachments shown with cid: links. */
export async function attachFigures(content: any, userId: ObjectId) {
  const sources = new Map<string, string>();
  const images: { cid: string; data: Buffer; mime: string }[] = [];
  for (const [index, figure] of (content.figures || []).entries()) {
    if (!figure.key) continue;
    try {
      const data = await readFile(userId, figure.key);
      const cid = `figure${index}.${figure.key}@social-autopost`;
      sources.set(figure.key, `cid:${cid}`);
      images.push({ cid, data, mime: data[0] === 0x89 ? "image/png" : "image/jpeg" });
    } catch (error) {
      console.warn("Leaving out a figure:", redact(error));
    }
  }
  return { source: (figure: any) => (figure.key ? sources.get(figure.key) || "" : figure.url || ""), images };
}

export function buildMessage(campaign: any, recipient: { email: string; name: string }, source: (f: any) => string, images: any[], unsubscribe: string) {
  const content = campaign.content;
  const name = recipient.name || DEFAULT_NAME;
  const headers: Record<string, string> = unsubscribe ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  return {
    to: recipient.email, subject: personalize(campaign.subject || content.subject, recipient.name || ""),
    text: renderText(content, name, campaign.footer || "", unsubscribe), html: renderHtml(content, source, name, campaign.footer || "", unsubscribe),
    fromName: campaign.from_name || "", replyTo: campaign.reply_to || "", images, headers,
  };
}

async function finish(id: ObjectId, status: string, error: string | null = null) {
  await (await col("email_campaigns")).updateOne({ _id: id, status: "sending" }, { $set: { status, error, updated_at: now(), locked_until: new Date(0) } });
}

/** Send part of one campaign (the given one, or the oldest queued). Returns how many were sent. */
export async function sendBatch(budgetMs = 40_000, campaignId?: ObjectId, userId?: ObjectId): Promise<number> {
  const campaigns = await col("email_campaigns");
  const filter: any = { status: { $in: ["queued", "sending"] }, locked_until: { $lt: new Date() } };
  if (campaignId) filter._id = campaignId;
  if (userId) filter.user_id = userId;
  const claimed = await campaigns.findOneAndUpdate(filter, { $set: { status: "sending", locked_until: new Date(Date.now() + budgetMs + 15_000), updated_at: now() } },
    { sort: { created_at: 1 }, returnDocument: "after" });
  if (!claimed) return 0;
  const campaign = unpack(claimed);
  const settings = smtpSettings();
  if (!settings) {
    await finish(claimed._id, "paused", "Email isn't set up on this server.");
    return 0;
  }
  const started = Date.now();
  const { source, images } = await attachFigures(campaign.content, campaign.user_id);
  const unsubscribes = await col("email_unsubscribes");
  const transporter = transport(settings);
  let index = Number(campaign.next_index || 0);
  let consecutive = 0;
  let sent = 0;
  try {
    while (index < campaign.recipients.length) {
      if (Date.now() - started > budgetMs) {
        await campaigns.updateOne({ _id: claimed._id, status: "sending" }, { $set: { locked_until: new Date(0) } });
        return sent;
      }
      const recipient = campaign.recipients[index];
      const progress = async (outcome: string, failure?: any) => {
        const update: any = { $inc: { next_index: 1, [outcome]: 1 }, $set: { updated_at: now() } };
        if (failure) update.$push = { failures: { $each: [failure], $slice: -200 } };
        const after = await campaigns.findOneAndUpdate({ _id: claimed._id }, update, { returnDocument: "after", projection: { status: 1 } });
        return after?.status;
      };
      if (await unsubscribes.findOne({ user_id: campaign.user_id, email: recipient.email }, { projection: { _id: 1 } })) {
        index += 1;
        if ((await progress("skipped")) !== "sending") return sent;
        continue;
      }
      if (!(await reserveEmail())) {
        await finish(claimed._id, "paused", `Today's limit of ${dailyLimit()} emails for this server is reached. It continues tomorrow.`);
        return sent;
      }
      let status: string | undefined;
      try {
        await sendHtml(transporter, settings, buildMessage(campaign, recipient, source, images, unsubscribeUrl(campaign, recipient.email)));
        status = await progress("sent");
        consecutive = 0;
        sent += 1;
      } catch (error) {
        status = await progress("failed", { email: recipient.email, error: error instanceof MailError ? error.message : "Sending failed." });
        consecutive += 1;
      }
      index += 1;
      if (status !== "sending") return sent;
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        await finish(claimed._id, "paused", `${MAX_CONSECUTIVE_FAILURES} emails in a row failed, so sending was paused. Check the failures, then resume.`);
        return sent;
      }
      if (index < campaign.recipients.length && delayMs()) await new Promise((r) => setTimeout(r, delayMs()));
    }
    await finish(claimed._id, "done");
    return sent;
  } catch (error) {
    console.error("Campaign batch failed:", redact(error));
    await finish(claimed._id, "paused", "Sending stopped because of an unexpected error. You can resume it.");
    return sent;
  } finally {
    transporter.close();
  }
}
