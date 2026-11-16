import { json, linkedinRedirect, textField, type Route } from "./app";
import { encrypt, sign, verify } from "./auth";
import { col, now, pack, toObjectId, unpack } from "./db";
import { config, env } from "./env";
import { AppError, ConfigError, HttpError, redact } from "./errors";
import { finishFile, publicFileUrl, putChunk, readFile, startFile, storeBuffer, ownsFile } from "./files";
import { currentModel, imageModel, makeImage } from "./gemini";
import { analyzePost, generatePosts, imagePrompt } from "./generator";
import { checkMetaConnection, linkedinAuthUrl, linkedinFetchToken } from "./platforms";
import { advancePublish, createPublish, publishStatus, NO_IMAGE } from "./publish";
import { imageOptions, MODES, readSite, reviseStoryboard, synthesize, writeCaptions, writeStoryboard, FORMATS, MAX_SITE_IMAGES, MAX_SUBPAGES } from "./reel";
import { LIMITS, PLATFORMS, limitViolations, withLink } from "./text";
import { aiRun, usageIdsFrom, usageJson } from "./usage";
import { configForUser, getConnection, updateConnection } from "./userconfig";
import { advanceTopic, nextTopic, parseTopics } from "./topics";
import { blockedReason, botJson, MAX_BOTS, nextRun, normalizeBot, runJson, tick } from "./autopilot";
import { imageSize, pageScreenshot, safeUrl } from "./web";
import { planShots } from "./shots";
import { campaignJson } from "./campaigns";
import { freeTier } from "./gemini";

const validLink = (data: any) => {
  const raw = data.link;
  if (raw === undefined || raw === null || raw === "") return "";
  const url = typeof raw === "string" && raw.length <= 2000 ? safeUrl(raw.trim()) : "";
  if (!url) throw new ConfigError("The link must be a web address starting with https:// or http://.");
  return url;
};

function validPlatforms(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || !raw.every((p) => (PLATFORMS as readonly string[]).includes(p))) throw new ConfigError("Choose at least one platform.");
  return [...new Set(raw as string[])];
}

function linkedinWarning(expiresAt: number | null) {
  if (!expiresAt) return null;
  const days = (expiresAt * 1000 - Date.now()) / 86400_000;
  if (days <= 0) return "Your LinkedIn sign-in has expired. Connect LinkedIn again.";
  if (days <= 7) return `Your LinkedIn sign-in expires in ${Math.floor(days)} day(s). Connect LinkedIn again soon.`;
  return null;
}

async function siteFrom(data: any) {
  const raw = data.site && typeof data.site === "object" ? data.site : {};
  const pages = (Array.isArray(raw.pages) ? raw.pages : []).slice(0, MAX_SUBPAGES).filter((p: any) => p && typeof p === "object")
    .map((p: any) => ({ label: String(p.label || "").slice(0, 60), title: String(p.title || "").slice(0, 160), description: String(p.description || "").slice(0, 300), text: String(p.text || "").slice(0, 600) }));
  const article = raw.article && typeof raw.article === "object" ? {
    title: String(raw.article.title || "").slice(0, 300), journal: String(raw.article.journal || "").slice(0, 200), doi: String(raw.article.doi || "").slice(0, 100),
    date: String(raw.article.date || "").slice(0, 20), abstract: String(raw.article.abstract || "").slice(0, 2500),
    authors: (Array.isArray(raw.article.authors) ? raw.article.authors : []).slice(0, 12).map((a: unknown) => String(a).slice(0, 100)),
    keywords: (Array.isArray(raw.article.keywords) ? raw.article.keywords : []).slice(0, 10).map((k: unknown) => String(k).slice(0, 60)),
  } : null;
  return {
    article, url: safeUrl(raw.url), title: String(raw.title || "").slice(0, 200), description: String(raw.description || "").slice(0, 500), text: String(raw.text || "").slice(0, 4000), pages,
    image_count: Number.isInteger(raw.image_count) && raw.image_count >= 0 ? raw.image_count : 0,
    images: (Array.isArray(raw.images) ? raw.images : []).slice(0, MAX_SITE_IMAGES).filter((i: unknown) => typeof i === "string" && i.startsWith("data:image/")),
  };
}

/**
 * Read a page and photograph it at the same time. The screenshots are stored for the user and given
 * to the browser as signed links (12 hours); when the page has no pictures of its own, the first
 * screen also becomes its picture. The links are relative (same origin), so the browser can draw
 * them on a canvas. `shot` is the whole-page screenshot, for the AI to look at.
 */
async function readSiteWithShots(url: string, followLinks: boolean, userId: any) {
  const [site, shots] = await Promise.all([readSite(url, followLinks), pageScreenshot(url)]);
  let shot: { data: Buffer; mime: string } | null = null;
  const stored = new Map<Buffer, string>();
  const store = async (data: Buffer) => {
    if (!stored.has(data)) stored.set(data, publicFileUrl("", await storeBuffer(userId, "image", imageSize(data)!.mime, data, "screenshot"), 12));
    return stored.get(data)!;
  };
  try {
    if (shots.page) {
      (site as any).screenshot = await store(shots.page);
      shot = { data: shots.page, mime: imageSize(shots.page)!.mime };
    }
    if (shots.first && !site.images.length) {
      const link = await store(shots.first);
      site.images.push(link);
      site.image_urls.push(site.url);
      site.image = link;
    }
  } catch {
    // Storing failed: carry on without the screenshot.
  }
  return { site, shot };
}

const imageFromDataUrl = (value: string) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(value || "");
  if (!match) throw new ConfigError("One of the chosen images couldn't be read. Choose it again.");
  return { mime: match[1], data: Buffer.from(match[2], "base64") };
};

export const routes: Route[] = [
  ["GET", "/api/me", "user", async ({ user }) => {
    const c = await getConnection(user._id);
    const hasMeta = Boolean(c.meta_token_enc);
    const ownLinkedIn = Boolean(c.linkedin_client_id && c.linkedin_client_secret_enc);
    const upcoming = await nextTopic(user._id);
    return {
      user: { email: user.email, name: user.name || "" },
      platforms: {
        linkedin: { configured: Boolean(c.linkedin_enc), app_ready: ownLinkedIn || Boolean(env("LINKEDIN_CLIENT_ID") && env("LINKEDIN_CLIENT_SECRET")), own_app: ownLinkedIn,
          expires_at: c.linkedin_expires_at || null, warning: linkedinWarning(c.linkedin_expires_at || null) },
        facebook: { configured: hasMeta && Boolean(c.fb_page_id) },
        instagram: { configured: hasMeta && Boolean(c.ig_user_id) },
      },
      services: { gemini: Boolean(config.geminiKey()), image_uploads: true, ai_images: Boolean(imageModel()) },
      versions: { linkedin: config.linkedinVersion(), graph: config.graphVersion(), gemini_model: currentModel() },
      defaults: { audience: c.audience || config.audience(), tone: c.tone || config.tone() },
      next_topic: upcoming ? { topic: upcoming[0], index: upcoming[1] } : null,
    };
  }],
  ["POST", "/api/settings/test", "user", async ({ user }) => {
    const cfg = await configForUser(user._id);
    if (!cfg.metaToken || !cfg.fbPageId) throw new ConfigError("Save your access token and Facebook Page ID first.");
    const outcome = await checkMetaConnection(cfg);
    const linked = outcome.linked_ig_user_id;
    if (linked && !cfg.igUserId && /^\d{1,32}$/.test(String(linked))) {
      await updateConnection(user._id, { ig_user_id: String(linked) });
      outcome.ig_user_id_saved = true;
    }
    return outcome;
  }],

  // --- Files (images and videos, stored in MongoDB) ---
  ["POST", "/api/files", "user", async ({ body, user }) => {
    const data = await body();
    return { id: await startFile(user._id, String(data.kind || "image"), String(data.mime || ""), Number(data.size), String(data.name || "file")) };
  }],
  ["PUT", "/api/files/:id/chunk/:n", "user", async ({ params, req, user }) => {
    const data = Buffer.from(await req.arrayBuffer());
    await putChunk(user._id, params.id, Number(params.n), data);
    return { ok: true };
  }],
  ["POST", "/api/files/:id/finish", "user", async ({ params, body, user, origin }) => {
    const data = await body();
    const result = await finishFile(user._id, params.id, Number(data.chunks));
    return { ...result, url: publicFileUrl(origin, result.key, 24), content_type: result.mime };
  }],

  // --- Compose and Analyze ---
  ["POST", "/api/generate", "user", async ({ body, user }) => {
    const data = await body();
    const platforms = validPlatforms(data.platforms);
    const cfg = await configForUser(user._id);
    let topic = textField(data, "topic");
    let topicIndex: number | null = null;
    if (!topic) {
      const upcoming = await nextTopic(user._id);
      if (!upcoming) throw new ConfigError("Enter a topic, or add some on the Topics page.");
      [topic, topicIndex] = upcoming;
    }
    const [posts, usage] = await aiRun(user._id, "compose", topic, () => generatePosts(topic!, textField(data, "audience") || cfg.audience, textField(data, "tone") || cfg.tone, platforms));
    return { topic, topic_index: topicIndex, posts: Object.fromEntries(platforms.map((p) => [p, posts[p]])), usage };
  }],
  ["POST", "/api/analyze", "user", async ({ body, user }) => {
    const data = await body();
    const draft = textField(data, "draft") || "";
    if (!draft) throw new ConfigError("Write or paste the post you want analysed.");
    if (draft.length > 5000) throw new ConfigError("The draft must be under 5,000 characters.");
    const platforms = validPlatforms(data.platforms);
    let image: any = null;
    const key = textField(data, "image_key");
    if (key) {
      const bytes = await readFile(user._id, key);
      image = { data: bytes.toString("base64"), mime: bytes[0] === 0x89 ? "image/png" : "image/jpeg" };
    }
    const cfg = await configForUser(user._id);
    const note = textField(data, "image_url") ? "The post will be published with an image from a link." : "";
    const [result, usage] = await aiRun(user._id, "analyze", draft.split("\n")[0], () => analyzePost(draft, platforms, textField(data, "goal") || "",
      textField(data, "audience") || cfg.audience, textField(data, "tone") || cfg.tone, image, note));
    return { ...result, usage };
  }],
  ["POST", "/api/preview", "user", async ({ body }) => {
    const data = await body();
    const posts = data.posts && typeof data.posts === "object" ? data.posts : {};
    return { requests: Object.entries(posts).map(([platform, text]) => ({ platform, request: JSON.stringify({ platform, text, image: data.image_url || null }, null, 2) })) };
  }],
  ["POST", "/api/image", "user", async ({ req, user, origin }) => {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") throw new ConfigError("Choose an image file to upload.");
    const key = await storeBuffer(user._id, "image", file.type || "image/jpeg", Buffer.from(await file.arrayBuffer()), file.name);
    return { key, url: publicFileUrl(origin, key, 24) };
  }],
  ["POST", "/api/image/generate", "user", async ({ body, user }) => {
    const data = await body();
    let topic = textField(data, "topic") || "";
    if (!topic) topic = (await nextTopic(user._id))?.[0] || "";
    const aspect = ["1:1", "4:5", "16:9", "9:16", "3:4", "4:3"].includes(data.aspect) ? data.aspect : "1:1";
    const [image, usage] = await aiRun(user._id, "image", `Image: ${topic.slice(0, 60)}`, () => makeImage([{ text: imagePrompt(topic, textField(data, "details") || "", data.style || "photo") }], aspect));
    return { image: image.data.toString("base64"), mime: image.mime, usage };
  }],
  ["POST", "/api/publish", "user", async ({ body, user, origin }) => {
    const data = await body();
    const posts = data.posts && typeof data.posts === "object" ? data.posts : null;
    if (!posts || !Object.keys(posts).length) throw new ConfigError("Choose at least one platform to publish to.");
    const platforms = validPlatforms(Object.keys(posts));
    if (!Object.values(posts).every((t) => typeof t === "string")) throw new ConfigError("Each post must be text.");
    const problems = limitViolations(posts, platforms);
    if (problems.length) throw new ConfigError(`${problems.join("; ")}.`);
    const link = validLink(data);
    const captions = Object.fromEntries(platforms.map((p) => [p, withLink(posts[p], link, p)]));
    const key = textField(data, "image_key");
    const imageKeys = key && (await ownsFile(user._id, key)) ? [key] : [];
    const imageUrl = imageKeys.length ? null : safeUrl(textField(data, "image_url") || "") || null;
    const topic = textField(data, "topic") || "";
    const postId = await createPublish(user._id, { title: topic, captions, platforms, kind: "post", imageKeys, imageUrl, usageIds: usageIdsFrom(data) });
    const status = await advancePublish(user._id, postId, origin, 40_000);
    if (Number.isInteger(data.topic_index) && status.results.some((r: any) => r.ok)) await advanceTopic(user._id, data.topic_index, topic);
    const warnings = status.done ? [] : ["Instagram is still processing the image. The result will appear in History."];
    return { results: status.results, warnings, id: status.id };
  }],
  ["GET", "/api/publish/job/:id", "user", async ({ params, user, origin }) => {
    const id = toObjectId(params.id);
    if (!id) throw new ConfigError("That post wasn't found.");
    return advancePublish(user._id, id, origin, 15_000);
  }],
  ["GET", "/api/reel/publish/:id", "user", async ({ params, user, origin }) => {
    const id = toObjectId(params.id);
    if (!id) throw new ConfigError("That reel wasn't found.");
    return advancePublish(user._id, id, origin, 15_000);
  }],

  // --- Topics and History ---
  ["GET", "/api/topics", "user", async ({ user }) => ({ text: (await (await col("topics")).findOne({ user_id: user._id }))?.text || "" })],
  ["PUT", "/api/topics", "user", async ({ body, user }) => {
    const text = (await body()).text;
    if (typeof text !== "string" || text.length > 100_000) throw new ConfigError("The topic list must be text under 100,000 characters.");
    await (await col("topics")).updateOne({ user_id: user._id }, { $set: { text, updated_at: now() } }, { upsert: true });
    return { count: parseTopics(text).length };
  }],
  ["GET", "/api/history", "user", async ({ user, origin }) => {
    const days = config.historyDays();
    const since = new Date(Date.now() - days * 86400_000);
    const posts = await (await col("posts")).find({ user_id: user._id }).sort({ created_at: -1, _id: -1 }).limit(200).toArray();
    for (const pending of posts.filter((p) => p.status === "publishing").slice(0, 2)) {
      try {
        await advancePublish(user._id, pending._id, origin, 4000);
      } catch (error) {
        console.warn("Couldn't continue a post:", redact(error));
      }
    }
    const fresh = posts.some((p) => p.status === "publishing") ? await (await col("posts")).find({ user_id: user._id }).sort({ created_at: -1, _id: -1 }).limit(200).toArray() : posts;
    const entries = fresh.map((doc) => {
      const post = unpack(doc);
      const link = (key: unknown) => (typeof key === "string" ? publicFileUrl(origin, key, 1) : null);
      const { _id, user_id, job, image_key, image_keys, video_key, ai_usage_ids, usage_ids, locked_until, z, image_url_external, ...rest } = post;
      return { ...rest, id: String(_id), kind: post.kind || "post", created_at: new Date(post.created_at).toISOString(), video_url: link(video_key), image_url: link(image_key) || image_url_external || null,
        image_urls: (image_keys || []).slice(0, 10).map(link).filter(Boolean) };
    });
    const campaigns = (await (await col("email_campaigns")).find({ user_id: user._id }, { projection: { z: 0 } }).sort({ created_at: -1 }).limit(200).toArray())
      .filter((c) => ["queued", "sending", "paused"].includes(c.status) || new Date(c.created_at) >= since);
    const templates = (await (await col("email_templates")).find({ user_id: user._id }).sort({ updated_at: -1 }).limit(200).toArray()).map((t) => {
      const doc = unpack(t);
      return { id: String(t._id), name: doc.name || "", kind: doc.content?.kind, subject: doc.content?.subject || "", updated_at: new Date(t.updated_at).toISOString() };
    });
    // AI cost records are kept for good, so every run's cost can still be shown.
    const runs = await (await col("ai_usage")).find({ user_id: user._id }, { projection: { z: 0 } }).sort({ created_at: -1 }).limit(200).toArray();
    const manuscripts = await (await col("manuscripts")).find({ user_id: user._id }, { projection: { z: 0 } }).sort({ updated_at: -1 }).limit(200).toArray();
    return {
      entries, campaigns: campaigns.map(campaignJson), templates, ai_runs: runs.map(usageJson), keep_days: days,
      ai_cost_total: (await (await col("ai_usage")).aggregate([{ $match: { user_id: user._id } }, { $group: { _id: null, cost: { $sum: "$cost_usd" } } }]).toArray())[0]?.cost || 0,
      manuscripts: manuscripts.map((m) => ({ id: String(m._id), title: m.title || "", status: m.status, type: m.mode, type_label: m.mode === "book" ? "Book" : m.type_label || "Manuscript",
        voice: m.voice || null, word_count: m.word_count || 0, created_at: new Date(m.created_at).toISOString(), updated_at: new Date(m.updated_at).toISOString() })),
    };
  }],

  // --- Site to Reel ---
  ["POST", "/api/reel/storyboard", "user", async ({ body, user }) => {
    const data = await body();
    const { site } = await readSiteWithShots(textField(data, "url") || "", data.follow_links === true, user._id);
    const mode = MODES.includes(data.mode) ? data.mode : "trending";
    const format = data.format in FORMATS ? data.format : "auto";
    const [storyboard, usage] = await aiRun(user._id, "reel", `Reel (${mode}): ${site.host}`, () => writeStoryboard(site, textField(data, "instructions") || "", mode, format, data.last_format in FORMATS ? data.last_format : null));
    return { site: { ...site, text: site.text.slice(0, 4000) }, storyboard, usage };
  }],
  ["POST", "/api/reel/revise", "user", async ({ body, user }) => {
    const data = await body();
    if (!data.storyboard || typeof data.storyboard !== "object") throw new ConfigError("Create a storyboard first.");
    const site = await siteFrom(data);
    const instruction = textField(data, "instruction") || "";
    const [storyboard, usage] = await aiRun(user._id, "reel", `Reel redesign: ${instruction.slice(0, 60)}`, () => reviseStoryboard(data.storyboard, instruction, site));
    return { storyboard, usage };
  }],
  ["POST", "/api/reel/voice", "user", async ({ body, user }) => {
    const data = await body();
    const [voice, usage] = await aiRun(user._id, "reel-voice", `Voiceover: ${String(data.text || "").slice(0, 60)}`, () => synthesize(textField(data, "text") || "", textField(data, "voice") || "Kore"));
    return { audio: voice.wav.toString("base64"), mime: "audio/wav", seconds: voice.seconds, usage };
  }],
  ["POST", "/api/reel/publish", "user", async ({ body, user, origin }) => {
    const data = await body();
    const key = textField(data, "video_key") || "";
    const file = toObjectId(key) ? await (await col("files")).findOne({ _id: toObjectId(key)!, user_id: user._id, status: "ready", kind: "video" }) : null;
    if (!file) throw new ConfigError("That video wasn't found. Record and upload it again.");
    if (file.mime !== "video/mp4") throw new ConfigError("Posting needs an MP4 video.", "This browser recorded WebM. Record the reel in Chrome or Edge, or download it instead.");
    const platforms = validPlatforms(data.platforms);
    const raw = data.captions && typeof data.captions === "object" ? data.captions : {};
    const link = validLink(data);
    const captions = Object.fromEntries(platforms.map((p) => [p, withLink(String(raw[p] || "").slice(0, LIMITS[p]), link, p)]));
    const postId = await createPublish(user._id, { title: (textField(data, "title") || "Reel").slice(0, 100), captions, platforms, kind: "reel", videoKey: key, usageIds: usageIdsFrom(data) });
    return advancePublish(user._id, postId, origin, 20_000);
  }],

  // --- Site to Post ---
  ["POST", "/api/sitepost/read", "user", async ({ body, user }) => {
    const data = await body();
    const { site, shot } = await readSiteWithShots(textField(data, "url") || "", data.follow_links === true, user._id);
    const direction = textField(data, "direction") || "";
    const mode = MODES.includes(data.mode) ? data.mode : "trending";
    // The captions and the screenshot plan are written at the same time; a failed plan only means
    // the browser picks the parts of the page itself.
    const [[written, plan], usage] = await aiRun(user._id, "site-post", `Site post: ${site.host}`, () => Promise.all([
      writeCaptions(site, direction, mode),
      shot ? planShots(site, shot.data, shot.mime, mode, direction).catch(() => null) : Promise.resolve(null),
    ]));
    let images: any[] = [];
    try {
      images = imageOptions(site, 0);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
    }
    return { site: { ...site, text: site.text.slice(0, 4000), pages: site.pages.map(({ shot: _s, ...p }: any) => p) }, ...written, images, shot_plan: plan, usage };
  }],
  ["POST", "/api/sitepost/captions", "user", async ({ body, user }) => {
    const data = await body();
    const site = await siteFrom(data);
    if (!site.url) throw new ConfigError("Read a site first.");
    const [written, usage] = await aiRun(user._id, "site-post", `Site post captions: ${new URL(site.url).hostname}`, () => writeCaptions(site, textField(data, "direction") || "", data.mode));
    return { ...written, usage };
  }],
  ["POST", "/api/sitepost/images", "user", async ({ body }) => {
    const data = await body();
    const round = Number.isInteger(data.round) && data.round >= 0 && data.round < 1000 ? data.round : 1;
    return { images: imageOptions(await siteFrom(data), round) };
  }],
  ["POST", "/api/sitepost/ai-image", "user", async ({ body, user }) => {
    const data = await body();
    const site = await siteFrom(data);
    const topic = site.title || site.description;
    if (!topic) throw new ConfigError("Read a site first.");
    const [image, usage] = await aiRun(user._id, "image", `Site post image: ${topic.slice(0, 50)}`, () => makeImage([{ text: imagePrompt(topic, `${site.description} ${textField(data, "details") || ""}`, "photo") }], "4:5"));
    return { image: `data:${image.mime};base64,${image.data.toString("base64")}`, usage };
  }],
  ["POST", "/api/image/enhance", "user", async ({ body, user }) => {
    const data = await body();
    const source = imageFromDataUrl(String(data.image || ""));
    const presets: Record<string, string> = {
      professional: "Make it look professional and polished: balanced exposure, true colours, crisp detail.", cinematic: "Give it a cinematic look: rich contrast, film-like colour grade.",
      original: "Make it look natural: remove heavy filters and overlays, restore true colours.", sharpen: "Make it sharper and clearer, with less noise and blur.",
      clean: "Clean it up: remove clutter, stray text and watermarks, keeping the main subject.", vibrant: "Make the colours vibrant and eye-catching, without looking fake.",
      popups: "Remove every cookie banner, pop-up, chat button and overlay from the web page shown, filling their place with the page's own plain background. Change nothing else.",
    };
    const wanted = [presets[data.preset] || "", String(data.instruction || "").slice(0, 1500)].filter(Boolean).join(" ");
    if (!wanted) throw new ConfigError("Choose an enhancement or describe the change you want.");
    const [image, usage] = await aiRun(user._id, "image", `Enhance image: ${wanted.slice(0, 50)}`, () => makeImage([
      { inlineData: { mimeType: source.mime, data: source.data.toString("base64") } },
      { text: `Edit this image. ${wanted} Keep the same subject, layout, people and any real text exactly as they are. Output one high-quality image.` },
    ], ["1:1", "4:5", "16:9", "9:16"].includes(data.aspect) ? data.aspect : "4:5"));
    return { image: `data:${image.mime};base64,${image.data.toString("base64")}`, usage };
  }],
  ["POST", "/api/sitepost/publish", "user", async ({ body, user, origin }) => {
    const data = await body();
    const chosen = data.images;
    if (!Array.isArray(chosen) || !chosen.length || !chosen.every((i) => typeof i === "string")) throw new ConfigError("Choose at least one image.");
    if (chosen.length > 10) throw new ConfigError("Choose at most 10 images: that's the most Instagram allows in one post.");
    const platforms = validPlatforms(data.platforms);
    const raw = data.captions && typeof data.captions === "object" ? data.captions : {};
    const link = validLink(data);
    const captions = Object.fromEntries(platforms.map((p) => [p, withLink(String(raw[p] || "").slice(0, LIMITS[p]), link, p)]));
    if (platforms.some((p) => !captions[p].trim())) throw new ConfigError("Write a caption for each platform.");
    const keys: string[] = [];
    for (const image of chosen) {
      if (/^[0-9a-f]{24}$/.test(image) && (await ownsFile(user._id, image))) keys.push(image);
      else {
        const { mime, data: bytes } = imageFromDataUrl(image);
        keys.push(await storeBuffer(user._id, "image", mime, bytes, "site-post.jpg"));
      }
    }
    const postId = await createPublish(user._id, { title: (textField(data, "title") || "Site post").slice(0, 100), captions, platforms, kind: "post", imageKeys: keys, usageIds: usageIdsFrom(data) });
    return advancePublish(user._id, postId, origin, 20_000);
  }],

  // --- Autopost bots ---
  ["GET", "/api/bots", "user", async ({ user }) => {
    const bots = await (await col("bots")).find({ user_id: user._id }).sort({ created_at: 1 }).toArray();
    const runs = await (await col("bot_runs")).find({ user_id: user._id }).sort({ started_at: -1 }).limit(40).toArray();
    return { bots: bots.map(botJson), runs: runs.map(runJson), blocked: await blockedReason(user._id), max_bots: MAX_BOTS,
      reels_unavailable: "Bots make image posts on Vercel. Make reels in Site to Reel, which records them in your browser.",
      voices: { trending: ["Puck", "Fenrir", "Zephyr"], academic: ["Charon", "Sadaltager", "Gacrux"] } };
  }],
  ["POST", "/api/bots", "user", async ({ body, user }) => {
    const bots = await col("bots");
    if ((await bots.countDocuments({ user_id: user._id })) >= MAX_BOTS) throw new ConfigError(`You can have up to ${MAX_BOTS} bots. Delete one first.`);
    const fields: any = normalizeBot(await body());
    fields.next_run_at = fields.active ? nextRun(fields.schedule, new Date()) : null;
    const doc = { ...fields, user_id: user._id, runs: 0, running: false, created_at: now(), updated_at: now() };
    const result = await bots.insertOne(doc);
    return json({ bot: botJson({ ...doc, _id: result.insertedId }) }, 201);
  }],
  ["PUT", "/api/bots/:id", "user", async ({ params, body, user }) => {
    const fields: any = normalizeBot(await body());
    fields.next_run_at = fields.active ? nextRun(fields.schedule, new Date()) : null;
    const updated = await (await col("bots")).findOneAndUpdate({ _id: toObjectId(params.id)!, user_id: user._id }, { $set: { ...fields, updated_at: now() } }, { returnDocument: "after" });
    if (!updated) throw new ConfigError("That bot wasn't found.");
    return { bot: botJson(updated) };
  }],
  ["DELETE", "/api/bots/:id", "user", async ({ params, user }) => {
    await (await col("bots")).deleteOne({ _id: toObjectId(params.id)!, user_id: user._id });
    return { deleted: true };
  }],
  ["POST", "/api/bots/:id/run", "user", async ({ params, user, origin }) => {
    const bots = await col("bots");
    const bot = await bots.findOne({ _id: toObjectId(params.id)!, user_id: user._id });
    if (!bot) throw new ConfigError("That bot wasn't found.");
    const blocked = await blockedReason(user._id);
    if (blocked) throw new ConfigError(blocked);
    if (!bot.active) throw new ConfigError("Turn the bot on first.");
    if (bot.running) return json({ error: "This bot is already running." }, 409);
    await bots.updateOne({ _id: bot._id }, { $set: { next_run_at: new Date() } });
    await tick(origin, 50_000, user._id);
    return json({ bot: botJson(await bots.findOne({ _id: bot._id })) }, 202);
  }],
  ["POST", "/api/bots/tick", "user", async ({ user, origin }) => ({ ran: await tick(origin, 45_000, user._id) })],

  // --- LinkedIn sign-in ---
  ["GET", "/api/linkedin/start", "user", async ({ user, origin }) => {
    const cfg = await configForUser(user._id);
    if (!cfg.linkedinClientId || !cfg.linkedinClientSecret) {
      throw new ConfigError("Add your LinkedIn app's Client ID and Client secret first.", "Settings > LinkedIn. Create an app at linkedin.com/developers and copy them from its Auth tab.");
    }
    const state = sign("linkedin-oauth", { uid: String(user._id), n: Math.random().toString(36).slice(2) }, 600);
    return { url: linkedinAuthUrl(cfg, linkedinRedirect(origin), state) };
  }],
  ["GET", "/api/linkedin/callback", "public", async ({ url, origin }) => {
    let outcome = "connected";
    try {
      const state = verify<{ uid: string }>("linkedin-oauth", url.searchParams.get("state"));
      const userId = toObjectId(state?.uid);
      const user = userId ? await (await col("users")).findOne({ _id: userId }) : null;
      const code = url.searchParams.get("code");
      if (!user?.active || !code) throw new AppError("LinkedIn sign-in couldn't be completed.");
      const token = await linkedinFetchToken(await configForUser(userId!), linkedinRedirect(origin), code);
      await updateConnection(userId!, { linkedin_enc: encrypt(token.access_token), linkedin_expires_at: token.expires_at, linkedin_member_id: token.member_id });
    } catch (error) {
      console.warn("LinkedIn sign-in failed:", redact(error));
      outcome = "error";
    }
    return Response.redirect(`${origin}/settings?linkedin=${outcome}`, 302);
  }],
  ["DELETE", "/api/linkedin", "user", async ({ user }) => {
    await updateConnection(user._id, {}, ["linkedin_enc", "linkedin_expires_at", "linkedin_member_id"]);
    return { removed: true };
  }],
];

export { NO_IMAGE, HttpError, freeTier, pack, publishStatus };
