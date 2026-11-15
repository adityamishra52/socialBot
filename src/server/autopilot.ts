import type { ObjectId } from "mongodb";
import { col, now, pack, unpack } from "./db";
import { AppError, ConfigError, redact } from "./errors";
import { storeBuffer } from "./files";
import { generatePosts } from "./generator";
import { advancePublish, createPublish } from "./publish";
import { readSite } from "./reel";
import { similarity, withLink } from "./text";
import { saveUsage } from "./usage";
import { configForUser, configuredPlatforms } from "./userconfig";
import { trackUsage } from "./gemini";
import { fetchHtml, safeUrl, siteLinks } from "./web";

// Autopost bots without a server thread: Vercel Cron (or any free cron service) calls
// /api/cron/tick, which runs the most overdue bot. Each run reads one page of the bot's sites (a
// page not used before when there is one), writes the post and publishes it once. Runs need the
// administrator's server-wide switch and the user's approval. Reels need a browser to render,
// so bots make image posts; reels are made and posted from Site to Reel.

export const SETTING = "autopilot_enabled";
export const MAX_BOTS = 10;
const STALE_MS = 10 * 60 * 1000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(zone) });
    return String(zone);
  } catch {
    throw new ConfigError("Choose a valid time zone.");
  }
}

export function normalizeBot(raw: any) {
  if (!raw || typeof raw !== "object") throw new ConfigError("The bot's settings are missing.");
  const name = String(raw.name || "").split(/\s+/).join(" ").trim().slice(0, 80);
  if (!name) throw new ConfigError("Give the bot a name.");
  const urls = [...new Set((Array.isArray(raw.urls) ? raw.urls : []).map((u: unknown) => safeUrl(String(u).trim())).filter(Boolean))] as string[];
  if (!urls.length) throw new ConfigError("Add at least one website address, starting with https://.");
  if (urls.length > 10) throw new ConfigError("A bot can use up to 10 website addresses.");
  const platforms = ["linkedin", "facebook", "instagram"].filter((p) => (raw.platforms || []).includes(p));
  if (!platforms.length) throw new ConfigError("Choose at least one platform.");
  const schedule = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : {};
  const days = [...new Set((schedule.days || []).filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort() as number[];
  const times = [...new Set((schedule.times || []).filter((t: unknown) => typeof t === "string" && TIME.test(t)))].sort() as string[];
  if (!days.length) throw new ConfigError("Choose at least one day.");
  if (!times.length) throw new ConfigError("Add at least one time of day.");
  if (times.length > 6) throw new ConfigError("Up to 6 times a day.");
  return {
    name, urls, content: "post", reel_mode: "trending", platforms, instructions: String(raw.instructions || "").trim().slice(0, 1000),
    schedule: { days, times, timezone: validZone(schedule.timezone || "UTC") }, active: raw.active !== false,
  };
}

/** The UTC instant of a local date and time in a zone. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (shown - guess));
}

/** The first scheduled moment after `after`. Days are 0 = Monday. */
export function nextRun(schedule: any, after: Date): Date | null {
  const zone = schedule.timezone || "UTC";
  for (let offset = 0; offset < 8; offset += 1) {
    const probe = new Date(after.getTime() + offset * 86400_000);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(probe);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
    const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
    if (!schedule.days.includes(weekday)) continue;
    for (const time of schedule.times) {
      const [hour, minute] = time.split(":").map(Number);
      const moment = zonedInstant(Number(get("year")), Number(get("month")), Number(get("day")), hour, minute, zone);
      if (moment > after) return moment;
    }
  }
  return null;
}

const normUrl = (url: string) => {
  const parts = new URL(url);
  return `${parts.hostname.replace(/^www\./, "")}${parts.pathname.replace(/\/$/, "")}`.toLowerCase();
};

async function choosePage(bot: any, memory: any) {
  const used = new Set<string>(memory.pages || []);
  const start = (bot.runs || 0) % bot.urls.length;
  const rotated = [...bot.urls.slice(start), ...bot.urls.slice(0, start)];
  for (const url of rotated) if (!used.has(normUrl(url))) return url;
  for (const url of rotated) {
    try {
      const page = await fetchHtml(url);
      for (const link of siteLinks(page.url, page.html)) if (!used.has(normUrl(link.url))) return link.url;
    } catch {
      continue;
    }
  }
  return rotated[0];
}

export async function blockedReason(userId: ObjectId): Promise<string | null> {
  const enabled = (await (await col("settings")).findOne({ _id: SETTING as any }))?.value;
  if (!enabled) return "Auto-posting is switched off for this server by the administrator.";
  const user = await (await col("users")).findOne({ _id: userId });
  if (!user?.active) return "This account is switched off.";
  if (!user.autopost) return "Waiting for the administrator to approve auto-posting for your account.";
  return null;
}

async function runBot(bot: any, origin: string) {
  const runs = await col("bot_runs");
  const bots = await col("bots");
  const following = nextRun(bot.schedule, new Date());
  const blocked = await blockedReason(bot.user_id);
  if (blocked) {
    await bots.updateOne({ _id: bot._id }, { $set: { next_run_at: following, last_status: blocked, running: false } });
    return;
  }
  const run = { bot_id: bot._id, user_id: bot.user_id, bot_name: bot.name, kind: "post", status: "running", step: "Reading the site", started_at: now() };
  const runId = (await runs.insertOne(pack(run, ["bot_id", "user_id", "started_at", "status"]))).insertedId;
  let outcome: any;
  try {
    outcome = await makeAndPublish(bot, origin);
  } catch (error: any) {
    if (!(error instanceof AppError)) console.error("Bot failed:", redact(error));
    outcome = { status: "failed", error: error instanceof AppError ? error.message : "Something went wrong.", hint: error?.hint || null };
  }
  await runs.replaceOne({ _id: runId }, pack({ ...run, ...outcome, step: null, finished_at: now() }, ["bot_id", "user_id", "started_at", "status"]));
  const label: Record<string, string> = { posted: "Posted", partly: "Partly posted", failed: "Failed", publishing: "Publishing" };
  await bots.updateOne({ _id: bot._id }, { $set: { next_run_at: following, last_run_at: now(), running: false, last_status: `${label[outcome.status] || outcome.status}: ${outcome.title || outcome.error || ""}`.slice(0, 300) }, $inc: { runs: 1 } });
}

async function makeAndPublish(bot: any, origin: string) {
  const userId = bot.user_id;
  const cfg = await configForUser(userId);
  const platforms = configuredPlatforms(cfg, bot.platforms);
  if (!platforms.length) return { status: "failed", error: "None of the bot's platforms are connected. Connect them in Settings." };
  const memoryCol = await col("bot_memory");
  const memory = (await memoryCol.findOne({ user_id: userId })) || {};
  const page = await choosePage(bot, memory);
  const site = await readSite(page);
  const earlier: string[] = memory.titles || [];
  let topic = `${site.title} (${site.url}). ${site.description}\nKey facts from the page: ${site.text.slice(0, 1500)}\n${bot.instructions || ""}`;
  if (earlier.length) topic += `\nThis is an automatic series. Earlier posts covered: ${earlier.slice(-15).join("; ")}. Say something new, with a different angle and hook.`;
  const { result: texts, events, error } = await trackUsage(async () => {
    let posts: Record<string, string> = {};
    for (let i = 0; i < 3; i += 1) {
      posts = await generatePosts(topic.slice(0, 6000), cfg.audience, cfg.tone, platforms);
      if (!earlier.some((old) => similarity(platforms.map((p) => posts[p]).join(" "), old) >= 0.5)) break;
      topic += "\nYour previous attempt was too close to an earlier post. Write a clearly different one.";
    }
    return posts;
  });
  const usage = events.length ? await saveUsage(userId, "autopost", `Bot ${bot.name}: ${site.title}`.slice(0, 200), events, !error) : null;
  if (error) throw error;
  const captions = Object.fromEntries(platforms.map((p) => [p, withLink((texts as any)[p], site.url, p)]));
  const imageKeys: string[] = [];
  if (site.images[0]) {
    try {
      const [head, data] = site.images[0].split(",", 2);
      const mime = /data:(image\/\w+)/.exec(head)?.[1] || "image/jpeg";
      imageKeys.push(await storeBuffer(userId, "image", mime, Buffer.from(data, "base64"), "bot-image"));
    } catch (problem) {
      console.warn("Bot image couldn't be saved:", redact(problem));
    }
  }
  const postId = await createPublish(userId, { title: site.title || site.url, captions, platforms, kind: "post", imageKeys,
    usageIds: usage ? [usage._id] : [], extra: { bot: bot.name, source_url: site.url } });
  const status = await advancePublish(userId, postId, origin, 20_000);
  const posted = status.results.filter((r: any) => r.ok);
  if (posted.length || status.status === "publishing") {
    const pages = [...(memory.pages || []).filter((p: string) => p !== normUrl(page)), normUrl(page)].slice(-300);
    const titles = [...earlier, `${site.title} ${Object.values(captions).join(" ")}`.slice(0, 600)].slice(-60);
    await memoryCol.updateOne({ user_id: userId }, { $set: { pages, titles, updated_at: now() } }, { upsert: true });
  }
  return { status: status.status, title: site.title, page_url: site.url, cost_usd: usage?.cost_usd || 0, results: status.results,
    error: posted.length || status.status === "publishing" ? null : status.results.map((r: any) => `${r.platform}: ${r.error}`).join("; ").slice(0, 500), post_id: String(postId) };
}

/** Run due bots for up to `budgetMs`. With a user id, only that user's bots (the open Autopost page). */
export async function tick(origin: string, budgetMs = 45_000, userId?: ObjectId) {
  const bots = await col("bots");
  await bots.updateMany({ running: true, running_since: { $lt: new Date(Date.now() - STALE_MS) } }, { $set: { running: false, last_status: "Stopped before it finished." } });
  const started = Date.now();
  let count = 0;
  while (Date.now() - started < budgetMs - 20_000) {
    const filter: any = { active: true, running: { $ne: true }, next_run_at: { $lte: new Date() } };
    if (userId) filter.user_id = userId;
    const bot = await bots.findOneAndUpdate(filter, { $set: { running: true, running_since: new Date() } }, { sort: { next_run_at: 1 }, returnDocument: "after" });
    if (!bot) break;
    await runBot(bot, origin);
    count += 1;
  }
  // Posts still processing on Instagram or LinkedIn are moved on, whoever started them.
  const pending = await (await col("posts")).find({ status: "publishing", locked_until: { $lt: new Date() } }, { projection: { _id: 1, user_id: 1 } }).limit(3).toArray();
  for (const post of pending) {
    if (Date.now() - started > budgetMs - 8_000) break;
    try {
      await advancePublish(post.user_id, post._id, origin, 6_000);
    } catch (error) {
      console.warn("A pending post couldn't be continued:", redact(error));
    }
  }
  return count;
}

export function botJson(bot: any) {
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  return {
    id: String(bot._id), name: bot.name, urls: bot.urls, content: bot.content, reel_mode: bot.reel_mode || "trending", platforms: bot.platforms,
    instructions: bot.instructions || "", schedule: bot.schedule, active: Boolean(bot.active), runs: bot.runs || 0, running: Boolean(bot.running),
    next_run_at: iso(bot.next_run_at), last_run_at: iso(bot.last_run_at), last_status: bot.last_status || null,
  };
}

export function runJson(doc: any) {
  const run = unpack(doc);
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  return {
    id: String(run._id), bot_id: String(run.bot_id), bot_name: run.bot_name || "", kind: run.kind, status: run.status, step: run.step, title: run.title,
    page_url: run.page_url, style: null, voice: null, cost_usd: run.cost_usd, results: run.results || [], error: run.error, hint: run.hint,
    started_at: iso(run.started_at), finished_at: iso(run.finished_at),
  };
}
