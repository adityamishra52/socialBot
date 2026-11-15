import { createHmac, createHash } from "node:crypto";
import { AppError, ApiError, ConfigError, registerSecret } from "./errors";
import { httpCall, jsonOf } from "./http";

// LinkedIn, a Facebook Page and Instagram (through graph.facebook.com with the same Page token).
// Each call is made once. Slow work (video processing) is split into steps that a later request
// continues, so a serverless call never waits more than a few seconds.

export interface UserConfig {
  linkedinToken: { access_token: string; expires_at: number; member_id: string } | null;
  linkedinClientId: string;
  linkedinClientSecret: string;
  linkedinVersion: string;
  graphVersion: string;
  fbPageId: string;
  metaToken: string;
  igUserId: string;
  appId: string;
  appSecret: string;
  audience: string;
  tone: string;
}

export interface PostResult {
  platform: string;
  ok: boolean;
  skipped?: boolean;
  pending?: boolean;
  post_id?: string | null;
  url?: string | null;
  error?: string | null;
  hint?: string | null;
}

export const failed = (platform: string, error: unknown): PostResult => {
  if (error instanceof AppError) return { platform, ok: false, error: error.message, hint: error.hint };
  return { platform, ok: false, error: "Something went wrong while posting." };
};

// --- LinkedIn ---

const LI_POSTS = "https://api.linkedin.com/rest/posts";
const LI_VIDEOS = "https://api.linkedin.com/rest/videos";
const LI_IMAGES = "https://api.linkedin.com/rest/images";
export const LI_SCOPES = "openid profile w_member_social";

const RESERVED = new Set("\\|{}@[]()<>#*_~".split(""));
const escapeLittle = (text: string) => [...text].map((ch) => (RESERVED.has(ch) ? `\\${ch}` : ch)).join("");

/** Plain text to LinkedIn "little text": escaped, with #hashtags kept clickable. */
export function toLittleText(text: string): string {
  const pattern = /(?<![^\s(\[{"'])#(\w*[^\W\d_]\w*)/gu;
  let out = "";
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    out += escapeLittle(text.slice(position, match.index));
    out += `{hashtag|\\#|${escapeLittle(match[1])}}`;
    position = (match.index || 0) + match[0].length;
  }
  return out + escapeLittle(text.slice(position));
}

function liToken(config: UserConfig) {
  const token = config.linkedinToken;
  if (!token?.member_id) throw new ConfigError("LinkedIn is not connected.", "Connect LinkedIn on the Settings page.");
  if (Number(token.expires_at || 0) * 1000 <= Date.now()) throw new ApiError("Your LinkedIn sign-in has expired.", "Connect LinkedIn again on the Settings page.");
  return token;
}

function liHeaders(config: UserConfig, token: { access_token: string }) {
  return { Authorization: `Bearer ${token.access_token}`, "LinkedIn-Version": config.linkedinVersion, "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json" };
}

const liHost = (url: string) => {
  try {
    const parts = new URL(url);
    return parts.protocol === "https:" && (parts.hostname === "linkedin.com" || parts.hostname.endsWith(".linkedin.com"));
  } catch {
    return false;
  }
};

async function liPost(config: UserConfig, token: any, text: string, content?: any): Promise<PostResult> {
  const response = await httpCall("POST", LI_POSTS, "linkedin", {
    headers: liHeaders(config, token),
    json: {
      author: `urn:li:person:${token.member_id}`, commentary: toLittleText(text), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content ? { content } : {}), lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    },
  });
  const id = response.headers.get("x-restli-id");
  return { platform: "linkedin", ok: true, post_id: id, url: id ? `https://www.linkedin.com/feed/update/${id}` : null };
}

export async function linkedinText(text: string, config: UserConfig) {
  try {
    return await liPost(config, liToken(config), text);
  } catch (error) {
    return failed("linkedin", error);
  }
}

async function liUploadImage(config: UserConfig, token: any, image: Buffer): Promise<string> {
  const started = (await jsonOf(await httpCall("POST", `${LI_IMAGES}?action=initializeUpload`, "linkedin", {
    headers: liHeaders(config, token), json: { initializeUploadRequest: { owner: `urn:li:person:${token.member_id}` } },
  }), "linkedin")).value || {};
  if (!started.uploadUrl || !started.image) throw new ApiError("LinkedIn didn't return upload instructions for the image.");
  if (!liHost(started.uploadUrl)) throw new ApiError("LinkedIn returned an upload address outside linkedin.com, so the upload was stopped.");
  await httpCall("PUT", started.uploadUrl, "linkedin", { headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(image), timeoutMs: 45_000 });
  return started.image;
}

export async function linkedinImages(images: Buffer[], text: string, config: UserConfig): Promise<PostResult> {
  try {
    if (!images.length) throw new ConfigError("Choose at least one image.");
    const token = liToken(config);
    const urns: string[] = [];
    for (const image of images.slice(0, 20)) urns.push(await liUploadImage(config, token, image));
    const content = urns.length === 1 ? { media: { id: urns[0] } } : { multiImage: { images: urns.map((id) => ({ id, altText: "" })) } };
    return await liPost(config, token, text, content);
  } catch (error) {
    return failed("linkedin", error);
  }
}

/** Step 1 of a LinkedIn video: upload it and return the video URN to wait for. */
export async function linkedinVideoStart(video: Buffer, config: UserConfig): Promise<string> {
  const token = liToken(config);
  const headers = liHeaders(config, token);
  const started = (await jsonOf(await httpCall("POST", `${LI_VIDEOS}?action=initializeUpload`, "linkedin", {
    headers, json: { initializeUploadRequest: { owner: `urn:li:person:${token.member_id}`, fileSizeBytes: video.length, uploadCaptions: false, uploadThumbnail: false } },
  }), "linkedin")).value || {};
  const instructions = started.uploadInstructions || [];
  if (!started.video || !instructions.length) throw new ApiError("LinkedIn didn't return upload instructions for the video.");
  const etags: string[] = [];
  for (const part of instructions) {
    if (!liHost(part.uploadUrl || "")) throw new ApiError("LinkedIn returned an upload address outside linkedin.com, so the upload was stopped.");
    const first = Number(part.firstByte || 0);
    const last = Number(part.lastByte ?? video.length - 1);
    const response = await httpCall("PUT", part.uploadUrl, "linkedin", {
      headers: { Authorization: headers.Authorization, "Content-Type": "application/octet-stream" }, body: new Uint8Array(video.subarray(first, last + 1)), timeoutMs: 50_000,
    });
    const etag = response.headers.get("etag");
    if (!etag) throw new ApiError("LinkedIn didn't confirm a video upload part.");
    etags.push(etag);
  }
  await httpCall("POST", `${LI_VIDEOS}?action=finalizeUpload`, "linkedin", {
    headers, json: { finalizeUploadRequest: { video: started.video, uploadToken: started.uploadToken || "", uploadedPartIds: etags } },
  });
  return started.video;
}

/** Later steps: "processing" until LinkedIn has the video, then the post itself. */
export async function linkedinVideoContinue(urn: string, text: string, title: string, config: UserConfig): Promise<PostResult | "processing"> {
  const token = liToken(config);
  const status = (await jsonOf(await httpCall("GET", `${LI_VIDEOS}/${encodeURIComponent(urn)}`, "linkedin", { headers: liHeaders(config, token) }), "linkedin")).status;
  if (status === "PROCESSING_FAILED") throw new ApiError("LinkedIn couldn't process the video.", "LinkedIn needs an MP4 between 3 seconds and 30 minutes.");
  if (status !== "AVAILABLE") return "processing";
  return liPost(config, token, text, { media: { title: title.slice(0, 200), id: urn } });
}

export function linkedinAuthUrl(config: UserConfig, redirectUri: string, state: string) {
  const query = new URLSearchParams({ response_type: "code", client_id: config.linkedinClientId, redirect_uri: redirectUri, state, scope: LI_SCOPES });
  return `https://www.linkedin.com/oauth/v2/authorization?${query}`;
}

export async function linkedinFetchToken(config: UserConfig, redirectUri: string, code: string) {
  const data = await jsonOf(await httpCall("POST", "https://www.linkedin.com/oauth/v2/accessToken", "linkedin", {
    form: { grant_type: "authorization_code", code, client_id: config.linkedinClientId, client_secret: config.linkedinClientSecret, redirect_uri: redirectUri },
  }), "linkedin");
  if (!data.access_token) throw new ApiError("LinkedIn's token response did not include an access token.");
  registerSecret(data.access_token);
  const info = await jsonOf(await httpCall("GET", "https://api.linkedin.com/v2/userinfo", "linkedin", { headers: { Authorization: `Bearer ${data.access_token}` } }), "linkedin");
  if (!info.sub) throw new ApiError("LinkedIn's userinfo response did not include a member id.", "Add 'Sign In with LinkedIn using OpenID Connect' to your LinkedIn app.");
  return { access_token: data.access_token as string, expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in || 60 * 86400), member_id: info.sub as string };
}

// --- Meta (Facebook Page and Instagram) ---

const graph = (config: UserConfig) => `https://graph.facebook.com/${config.graphVersion}`;
const pageTokens = new Map<string, { token: string; until: number }>();

function proof(config: UserConfig, token: string): Record<string, string> {
  if (!config.appSecret || !token) return {};
  return { appsecret_proof: createHmac("sha256", config.appSecret).update(token).digest("hex") };
}

async function meta(method: string, url: string, config: UserConfig, token: string, service: string, extra: { params?: Record<string, string>; form?: Record<string, string>; json?: any; timeoutMs?: number } = {}) {
  const response = await httpCall(method, url, service, {
    headers: { Authorization: `Bearer ${token}` }, params: { ...(extra.params || {}), ...proof(config, token) },
    form: extra.form, json: extra.json, timeoutMs: extra.timeoutMs,
  });
  return jsonOf(response, service);
}

/** The Page's own token. Users often save a user or system-user token, which Facebook refuses for Page posts. */
export async function pageToken(config: UserConfig): Promise<string> {
  const key = createHash("sha256").update(`${config.fbPageId}:${config.metaToken}`).digest("hex");
  const cached = pageTokens.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  try {
    const data = await meta("GET", `${graph(config)}/${config.fbPageId}`, config, config.metaToken, "facebook", { params: { fields: "access_token" } });
    if (typeof data.access_token === "string" && data.access_token) {
      registerSecret(data.access_token);
      pageTokens.set(key, { token: data.access_token, until: Date.now() + 50 * 60 * 1000 });
      return data.access_token;
    }
  } catch {
    // Use the saved token as it is: it may already be the Page's token.
  }
  return config.metaToken;
}

const USER_TOKEN_HINT = (page: string) => `Facebook received a personal or system-user token and didn't give back a Page token for Page ${page}. `
  + "Check the Page ID, that the account behind the token is an admin of the Page, and that the token has pages_manage_posts and pages_read_engagement.";

async function asPage(config: UserConfig, method: string, url: string, form: Record<string, string>, timeoutMs = 30_000) {
  const token = await pageToken(config);
  try {
    return await meta(method, url, config, token, "facebook", { form, timeoutMs });
  } catch (error: any) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("publish_actions") || (message.includes("(#200)") && message.includes("page token")) || message.includes("no permission to publish")) {
      error.hint = USER_TOKEN_HINT(config.fbPageId);
    }
    throw error;
  }
}

const fbReady = (config: UserConfig) => {
  if (!config.fbPageId || !config.metaToken) throw new ConfigError("Facebook is not connected.", "Save your Page token and Page ID on the Settings page.");
};

export async function facebookPost(text: string, imageUrl: string | null, config: UserConfig): Promise<PostResult> {
  try {
    fbReady(config);
    const data = imageUrl
      ? await asPage(config, "POST", `${graph(config)}/${config.fbPageId}/photos`, { url: imageUrl, caption: text })
      : await asPage(config, "POST", `${graph(config)}/${config.fbPageId}/feed`, { message: text });
    const id = data.post_id || data.id;
    return { platform: "facebook", ok: true, post_id: id, url: id ? `https://www.facebook.com/${id}` : null };
  } catch (error) {
    return failed("facebook", error);
  }
}

export async function facebookPhotos(urls: string[], text: string, config: UserConfig): Promise<PostResult> {
  if (urls.length === 1) return facebookPost(text, urls[0], config);
  try {
    fbReady(config);
    const ids: string[] = [];
    for (const url of urls.slice(0, 10)) {
      const data = await asPage(config, "POST", `${graph(config)}/${config.fbPageId}/photos`, { url, published: "false" });
      if (!data.id) throw new ApiError("Facebook didn't return an id for an uploaded photo.");
      ids.push(data.id);
    }
    const form: Record<string, string> = { message: text };
    ids.forEach((id, index) => (form[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id })));
    const data = await asPage(config, "POST", `${graph(config)}/${config.fbPageId}/feed`, form);
    return { platform: "facebook", ok: true, post_id: data.id, url: data.id ? `https://www.facebook.com/${data.id}` : null };
  } catch (error) {
    return failed("facebook", error);
  }
}

export async function facebookVideo(videoUrl: string, text: string, title: string, config: UserConfig): Promise<PostResult> {
  try {
    fbReady(config);
    const data = await asPage(config, "POST", `https://graph-video.facebook.com/${config.graphVersion}/${config.fbPageId}/videos`,
      { file_url: videoUrl, description: text, title: title.slice(0, 100) }, 55_000);
    return { platform: "facebook", ok: true, post_id: data.id, url: data.id ? `https://www.facebook.com/${config.fbPageId}/videos/${data.id}` : null };
  } catch (error) {
    return failed("facebook", error);
  }
}

const igReady = (config: UserConfig) => {
  if (!config.igUserId || !config.metaToken) throw new ConfigError("Instagram is not connected.", "Save your Instagram user ID on the Settings page.");
};

async function igQuota(config: UserConfig) {
  const data = (await meta("GET", `${graph(config)}/${config.igUserId}/content_publishing_limit`, config, config.metaToken, "instagram", { params: { fields: "quota_usage,config" } })).data || [];
  if (!data.length) return;
  const used = Number(data[0].quota_usage || 0);
  const total = Number(data[0].config?.quota_total || 100);
  if (used >= total) throw new ApiError(`Instagram's publishing limit is reached (${used} of ${total} posts in 24 hours).`, "Try again later: the limit is a rolling 24-hour window.");
}

/** Step 1 for Instagram: create the container(s). Returns the ids to wait for. */
export async function instagramStart(kind: "image" | "carousel" | "reel", urls: string[], caption: string, config: UserConfig) {
  igReady(config);
  await igQuota(config);
  const base = `${graph(config)}/${config.igUserId}/media`;
  if (kind === "reel") {
    const data = await meta("POST", base, config, config.metaToken, "instagram", { json: { media_type: "REELS", video_url: urls[0], caption, share_to_feed: true } });
    if (!data.id) throw new ApiError("Instagram did not return a media container id.");
    return { container: data.id as string, children: [] as string[] };
  }
  if (kind === "image" || urls.length === 1) {
    const data = await meta("POST", base, config, config.metaToken, "instagram", { json: { image_url: urls[0], caption } });
    if (!data.id) throw new ApiError("Instagram did not return a media container id.");
    return { container: data.id as string, children: [] as string[] };
  }
  const children: string[] = [];
  for (const url of urls.slice(0, 10)) {
    const item = await meta("POST", base, config, config.metaToken, "instagram", { json: { image_url: url, is_carousel_item: true } });
    if (!item.id) throw new ApiError("Instagram did not return a container id for a carousel image.");
    children.push(item.id);
  }
  return { container: "", children };
}

async function igStatus(config: UserConfig, id: string): Promise<string> {
  return (await meta("GET", `${graph(config)}/${id}`, config, config.metaToken, "instagram", { params: { fields: "status_code" } })).status_code;
}

/** Later steps: wait for processing, make the carousel container, then publish. */
export async function instagramContinue(state: { container: string; children: string[]; caption: string; video?: boolean }, config: UserConfig): Promise<PostResult | "processing"> {
  const check = async (id: string) => {
    const status = await igStatus(config, id);
    if (status === "ERROR" || status === "EXPIRED") {
      throw new ApiError(`Instagram could not process the ${state.video ? "video" : "image"} (status ${status}).`, state.video
        ? "Reels must be MP4 (H.264 video, AAC audio), 9:16, 3-90 seconds. Record it in Chrome or Edge."
        : "The image must be a JPEG up to 8 MB with an aspect ratio from 4:5 to 1.91:1.");
    }
    return status === "FINISHED";
  };
  if (!state.container) {
    for (const child of state.children) if (!(await check(child))) return "processing";
    const data = await meta("POST", `${graph(config)}/${config.igUserId}/media`, config, config.metaToken, "instagram", {
      json: { media_type: "CAROUSEL", children: state.children.join(","), caption: state.caption },
    });
    if (!data.id) throw new ApiError("Instagram did not return a carousel container id.");
    state.container = data.id;
    return "processing";
  }
  if (!(await check(state.container))) return "processing";
  const published = await meta("POST", `${graph(config)}/${config.igUserId}/media_publish`, config, config.metaToken, "instagram", { json: { creation_id: state.container } });
  let url: string | null = null;
  try {
    url = (await meta("GET", `${graph(config)}/${published.id}`, config, config.metaToken, "instagram", { params: { fields: "permalink" } })).permalink || null;
  } catch {
    url = null; // The post is live; only its link is missing.
  }
  return { platform: "instagram", ok: true, post_id: published.id, url };
}

export async function checkMetaConnection(config: UserConfig) {
  const outcome: any = { facebook: { ok: false }, instagram: { ok: false }, linked_ig_user_id: null };
  const page = await meta("GET", `${graph(config)}/${config.fbPageId}`, config, config.metaToken, "facebook", { params: { fields: "id,name,instagram_business_account" } });
  outcome.facebook = { ok: true, name: page.name, id: page.id };
  outcome.token = await tokenInfo(config);
  if (outcome.token.type && outcome.token.type !== "PAGE") {
    const swapped = (await pageToken(config)) !== config.metaToken;
    outcome.facebook.page_token = swapped;
    if (!swapped) outcome.facebook = { ok: false, name: page.name, id: page.id, error: "This token can read the Page but can't get the Page's own token, so posts would fail.", hint: USER_TOKEN_HINT(config.fbPageId) };
  }
  outcome.linked_ig_user_id = page.instagram_business_account?.id || null;
  const igId = config.igUserId || outcome.linked_ig_user_id;
  if (igId) {
    try {
      const account = await meta("GET", `${graph(config)}/${igId}`, config, config.metaToken, "instagram", { params: { fields: "id,username" } });
      outcome.instagram = { ok: true, username: account.username, id: account.id };
    } catch (error: any) {
      outcome.instagram = { ok: false, error: error.message, hint: error.hint };
    }
  }
  return outcome;
}

async function tokenInfo(config: UserConfig) {
  if (!config.appId || !config.appSecret) return {};
  try {
    const response = await httpCall("GET", `${graph(config)}/debug_token`, "facebook", {
      headers: { Authorization: `Bearer ${config.appId}|${config.appSecret}` }, params: { input_token: config.metaToken },
    });
    const info = (await jsonOf(response, "facebook")).data || {};
    if (info.app_id && String(info.app_id) !== config.appId) return { error: "This token was made with a different Meta app than the App ID you saved." };
    const scopes: string[] = info.scopes || [];
    const needed = ["pages_manage_posts", "pages_manage_metadata", "pages_read_engagement", "pages_show_list", "instagram_basic", "instagram_content_publish"];
    return { valid: Boolean(info.is_valid), type: info.type, expires: info.expires_at ? new Date(info.expires_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never", missing: needed.filter((p) => !scopes.includes(p)) };
  } catch (error: any) {
    return { error: error.message, hint: "Check the App ID and App secret: they must belong to the app the token was made with." };
  }
}
