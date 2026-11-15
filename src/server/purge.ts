import { col } from "./db";
import { config, envNumber } from "./env";
import { redact } from "./errors";
import { deleteFiles } from "./files";
import { unpack } from "./db";

// History is kept HISTORY_DAYS (7 by default). Manuscripts and books are kept MANUSCRIPT_DAYS
// (30 by default) after their last change. Email templates, the images they use, and
// unsubscribes are always kept. Runs at most once an hour (from the cron tick or History).

export async function purgeHistory(force: boolean) {
  const settings = await col("settings");
  const last = await settings.findOne({ _id: "purged_at" as any });
  if (!force && last?.value && Date.now() - new Date(last.value).getTime() < 3600_000) return;
  await settings.updateOne({ _id: "purged_at" as any }, { $set: { value: new Date() } }, { upsert: true });
  try {
    const cutoff = new Date(Date.now() - config.historyDays() * 86400_000);
    const posts = await col("posts");
    const expired = await posts.find({ created_at: { $lt: cutoff }, status: { $ne: "publishing" } }).limit(500).toArray();
    const keys = new Set<string>();
    for (const doc of expired) {
      const post = unpack(doc);
      for (const key of [post.image_key, post.video_key, ...(post.image_keys || [])]) if (typeof key === "string") keys.add(key);
    }
    if (expired.length) await posts.deleteMany({ _id: { $in: expired.map((d) => d._id) } });
    const templates = await (await col("email_templates")).find({}, { projection: { figure_keys: 1 } }).toArray();
    const kept = new Set(templates.flatMap((t) => t.figure_keys || []));
    await deleteFiles([...keys].filter((k) => !kept.has(k)));
    await (await col("email_campaigns")).deleteMany({ status: { $in: ["done", "cancelled"] }, updated_at: { $lt: cutoff } });
    await (await col("bot_runs")).deleteMany({ started_at: { $lt: cutoff }, status: { $ne: "running" } });
    await (await col("research")).deleteMany({ created_at: { $lt: new Date(Date.now() - 3 * 86400_000) } });
    const manuscriptCutoff = new Date(Date.now() - envNumber("MANUSCRIPT_DAYS", 30, 1) * 86400_000);
    const oldManuscripts = await (await col("manuscripts")).find({ updated_at: { $lt: manuscriptCutoff } }, { projection: { figure_keys: 1 } }).toArray();
    if (oldManuscripts.length) {
      await deleteFiles(oldManuscripts.flatMap((m) => m.figure_keys || []));
      await (await col("manuscripts")).deleteMany({ _id: { $in: oldManuscripts.map((m) => m._id) } });
    }
    // Unfinished uploads go after a day; other files after HISTORY_DAYS unless a template or a
    // kept manuscript uses them.
    const files = await col("files");
    const stale = await files.find({ status: "uploading", created_at: { $lt: new Date(Date.now() - 86400_000) } }, { projection: { _id: 1 } }).limit(200).toArray();
    await deleteFiles(stale.map((f) => String(f._id)));
    const inManuscripts = new Set((await (await col("manuscripts")).find({}, { projection: { figure_keys: 1 } }).toArray()).flatMap((m) => m.figure_keys || []));
    const old = await files.find({ created_at: { $lt: cutoff } }, { projection: { _id: 1 } }).limit(500).toArray();
    await deleteFiles(old.map((f) => String(f._id)).filter((id) => !kept.has(id) && !inManuscripts.has(id)));
  } catch (error) {
    console.error("Couldn't delete old history:", redact(error));
  }
}
