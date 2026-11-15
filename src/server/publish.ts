import type { ObjectId } from "mongodb";
import { col, now, pack, toObjectId, unpack } from "./db";
import { AppError, redact } from "./errors";
import { publicFileUrl, readFile } from "./files";
import {
  facebookPhotos, facebookPost, facebookVideo, failed, instagramContinue, instagramStart, linkedinImages, linkedinText,
  linkedinVideoContinue, linkedinVideoStart, type PostResult,
} from "./platforms";
import { linkUsage } from "./usage";
import { configForUser } from "./userconfig";

// A publish job is a History record that posts to each platform once. Work that has to wait
// (Instagram processing an image, LinkedIn processing a video) is saved and continued by the next
// request that looks at the job, so no serverless call runs long and nothing is posted twice.

const POST_PLAIN = ["user_id", "created_at", "kind", "status", "locked_until"];
const WAIT_LIMIT_MS = 20 * 60 * 1000;
export const NO_IMAGE = "Instagram needs an image. Add one to post there.";

export interface PublishInput {
  title: string;
  captions: Record<string, string>;
  platforms: string[];
  kind: "post" | "reel";
  imageKeys?: string[];
  imageUrl?: string | null;
  videoKey?: string;
  usageIds?: ObjectId[];
  extra?: Record<string, any>;
}

export async function createPublish(userId: ObjectId, input: PublishInput): Promise<ObjectId> {
  const record = {
    user_id: userId, created_at: now(), kind: input.kind, status: "publishing", locked_until: new Date(0),
    timestamp: new Date().toISOString(), topic: input.title,
    platforms: Object.fromEntries(input.platforms.map((p) => [p, { ok: false, pending: true, text: input.captions[p] }])),
    job: Object.fromEntries(input.platforms.map((p) => [p, { stage: "start", data: {}, started: Date.now() }])),
    image_key: input.imageKeys?.[0], image_keys: input.imageKeys || [], image_url_external: input.imageUrl || null,
    video_key: input.videoKey, usage_ids: (input.usageIds || []).map(String), ...(input.extra || {}),
  };
  const result = await (await col("posts")).insertOne(pack(record, POST_PLAIN));
  return result.insertedId;
}

async function step(platform: string, post: any, state: any, origin: string, cfg: any): Promise<PostResult | "processing"> {
  const text = post.platforms[platform]?.text || "";
  const keys: string[] = post.image_keys || [];
  const links = () => keys.map((key) => publicFileUrl(origin, key));
  if (post.kind === "reel") {
    if (platform === "facebook") return facebookVideo(publicFileUrl(origin, post.video_key), text, post.topic, cfg);
    if (platform === "linkedin") {
      if (state.stage === "start") {
        state.data.urn = await linkedinVideoStart(await readFile(post.user_id, post.video_key), cfg);
        state.stage = "wait";
        return "processing";
      }
      return linkedinVideoContinue(state.data.urn, text, post.topic, cfg);
    }
    if (state.stage === "start") {
      Object.assign(state.data, await instagramStart("reel", [publicFileUrl(origin, post.video_key)], text, cfg), { caption: text, video: true });
      state.stage = "wait";
      return "processing";
    }
    return instagramContinue(state.data, cfg);
  }
  if (platform === "linkedin") {
    if (!keys.length) return linkedinText(text, cfg);
    const images: Buffer[] = [];
    for (const key of keys) images.push(await readFile(post.user_id, key));
    return linkedinImages(images, text, cfg);
  }
  if (platform === "facebook") {
    if (keys.length) return facebookPhotos(links(), text, cfg);
    return facebookPost(text, post.image_url_external || null, cfg);
  }
  const urls = keys.length ? links() : post.image_url_external ? [post.image_url_external] : [];
  if (!urls.length) return { platform, ok: false, skipped: true, error: NO_IMAGE };
  if (state.stage === "start") {
    Object.assign(state.data, await instagramStart(urls.length > 1 ? "carousel" : "image", urls, text, cfg), { caption: text });
    state.stage = "wait";
    return "processing";
  }
  return instagramContinue(state.data, cfg);
}

function friendly(result: PostResult): PostResult {
  if (result.error && /not (connected|configured)/i.test(result.error)) return { ...result, hint: result.hint || "Connect it on the Settings page." };
  return result;
}

/** Continue the job for up to `budgetMs`, then report where it stands. */
export async function advancePublish(userId: ObjectId, postId: ObjectId, origin: string, budgetMs = 25_000) {
  const posts = await col("posts");
  const until = new Date(Date.now() + 55_000);
  const claimed = await posts.findOneAndUpdate(
    { _id: postId, user_id: userId, status: "publishing", locked_until: { $lt: new Date() } },
    { $set: { locked_until: until } }, { returnDocument: "after" },
  );
  if (claimed) {
    const post = unpack(claimed);
    const cfg = await configForUser(userId);
    const started = Date.now();
    let waiting = true;
    while (waiting && Date.now() - started < budgetMs) {
      waiting = false;
      for (const platform of Object.keys(post.job || {})) {
        const state = post.job[platform];
        if (!post.platforms[platform]?.pending) continue;
        let outcome: PostResult | "processing";
        try {
          outcome = await step(platform, post, state, origin, cfg);
        } catch (error) {
          if (!(error instanceof AppError)) console.error(`Publishing to ${platform} crashed:`, redact(error));
          outcome = failed(platform, error);
        }
        if (outcome === "processing") {
          if (Date.now() - state.started > WAIT_LIMIT_MS) {
            outcome = { platform, ok: false, error: `${platform} was still processing after 20 minutes.`, hint: "Nothing was published there. Try again later." };
          } else {
            waiting = true;
            continue;
          }
        }
        const result = friendly(outcome);
        post.platforms[platform] = { ok: result.ok, skipped: Boolean(result.skipped), post_id: result.post_id || null, url: result.url || null,
          error: result.error || null, hint: result.hint || null, text: post.platforms[platform].text };
      }
      if (waiting) await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    const entries = Object.values<any>(post.platforms);
    if (!entries.some((e) => e.pending)) {
      const posted = Object.entries<any>(post.platforms).filter(([, e]) => e.ok).map(([p]) => p);
      post.status = posted.length === entries.length ? "posted" : posted.length ? "partly" : "failed";
      try {
        const ids = (post.usage_ids || []).map(toObjectId).filter(Boolean) as ObjectId[];
        Object.assign(post, await linkUsage(userId, ids, posted, post.topic || ""));
      } catch (error) {
        console.error("Could not link AI usage:", redact(error));
      }
    }
    post.locked_until = new Date(0);
    await posts.replaceOne({ _id: postId, user_id: userId }, pack(post, POST_PLAIN));
  }
  return publishStatus(userId, postId);
}

export async function publishStatus(userId: ObjectId, postId: ObjectId) {
  const document = await (await col("posts")).findOne({ _id: postId, user_id: userId });
  if (!document) throw new AppError("That post wasn't found.");
  const post = unpack(document);
  const results = Object.entries<any>(post.platforms || {}).map(([platform, entry]) => ({ platform, ...entry }));
  return { id: String(postId), status: post.status || "posted", done: post.status !== "publishing", results, warnings: [] as string[] };
}
