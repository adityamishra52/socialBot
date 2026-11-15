import { json, originOf, textField, type Route } from "./app";
import { verify } from "./auth";
import { col, now, pack, toObjectId, unpack } from "./db";
import { config } from "./env";
import { ConfigError } from "./errors";
import { publicFileUrl, storeBuffer } from "./files";
import { readRows } from "../shared/sheets";
import {
  articlesFromJson, articlesFromRows, DEFAULT_NAME, esc, generateContent, MAX_RECIPIENTS, normalizeContent, readIssue, RecipientList,
  recipientsFromRows, recipientsFromText, renderHtml, renderText, TOC_ISSUE_NOTE, validEmail, fetchPageText,
} from "./emailer";
import { attachFigures, buildMessage, campaignJson, createCampaign, dailyLimit, reserveEmail, sendBatch, sentToday, unsubscribeUrl } from "./campaigns";
import { requireSmtp, sendHtml, smtpSettings, transport } from "./mail";
import { aiRun } from "./usage";
import { getConnection, updateConnection } from "./userconfig";
import { fetchImage, safeUrl } from "./web";

const TEMPLATE_PLAIN = ["user_id", "name", "created_at", "updated_at", "figure_keys"];

async function emailSettings(user: any) {
  const c = await getConnection(user._id);
  return { from_name: c.email_from_name || user.name || "", reply_to: c.email_reply_to || user.email, footer: c.email_footer || "" };
}

async function uploaded(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw new ConfigError("Choose a file to upload.");
  return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
}

function rows(name: string, data: Uint8Array) {
  try {
    return readRows(name, data);
  } catch (error: any) {
    throw new ConfigError(error.message);
  }
}

const templateJson = (doc: any) => {
  const t = unpack(doc);
  return { id: String(t._id), name: t.name || "", content: t.content, created_at: new Date(t.created_at).toISOString(), updated_at: new Date(t.updated_at).toISOString() };
};

function unsubscribePage(title: string, message: string, token?: string) {
  const button = token ? `<form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Unsubscribe</button></form>` : "";
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,Segoe UI,sans-serif;background:linear-gradient(135deg,#ecfeff,#f5f3ff);color:#0e1117}main{max-width:420px;margin:16px;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 18px 50px rgba(15,23,42,.1)}h1{margin:0 0 8px;font-size:22px}p{color:#52525b;line-height:1.5}button{margin-top:12px;padding:12px 22px;border:0;border-radius:10px;font:inherit;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(90deg,#06b6d4,#8b5cf6,#f97316)}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${button}</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
}

async function unsubscribeToken(req: Request, url: URL) {
  let token = url.searchParams.get("t") || "";
  if (!token && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    token = String(form?.get("t") || "");
  }
  const data = verify<{ u: string; e: string }>("email-unsubscribe", token);
  const userId = toObjectId(data?.u);
  return userId && typeof data?.e === "string" ? { userId, email: data.e, token } : null;
}

function campaignFields(data: any, content: any, settings: any, origin: string) {
  return {
    name: (textField(data, "name") || content.subject).slice(0, 120), content, subject: content.subject, from_name: settings.from_name, reply_to: settings.reply_to,
    footer: settings.footer, unsubscribe_base: `${origin}/api/email/unsubscribe`,
  };
}

export const routes: Route[] = [
  ["GET", "/api/email/status", "user", async ({ user }) => ({
    smtp_ready: Boolean(smtpSettings()), gemini: Boolean(config.geminiKey()), daily_limit: dailyLimit(), sent_today: await sentToday(),
    unsubscribed: await (await col("email_unsubscribes")).countDocuments({ user_id: user._id }), max_recipients: MAX_RECIPIENTS, settings: await emailSettings(user),
  })],
  ["PUT", "/api/email/settings", "user", async ({ body, user }) => {
    const data = await body();
    const replyTo = (textField(data, "reply_to") || "").toLowerCase();
    if (replyTo && !validEmail(replyTo)) throw new ConfigError("The reply-to address isn't a valid email address.");
    const values: Record<string, string> = {
      email_from_name: (textField(data, "from_name") || "").split(/\s+/).join(" ").slice(0, 100), email_reply_to: replyTo, email_footer: (textField(data, "footer") || "").slice(0, 600),
    };
    await updateConnection(user._id, Object.fromEntries(Object.entries(values).filter(([, v]) => v)), Object.keys(values).filter((k) => !values[k]));
    return { settings: await emailSettings(user) };
  }],
  ["POST", "/api/email/articles/parse", "user", async ({ req }) => {
    const file = await uploaded(req);
    return { articles: articlesFromRows(rows(file.name, file.data)) };
  }],
  ["POST", "/api/email/recipients/parse", "user", async ({ req, user }) => {
    let result;
    if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
      const file = await uploaded(req);
      result = recipientsFromRows(rows(file.name, file.data));
    } else {
      const text = (await req.json().catch(() => ({}))).text;
      if (typeof text !== "string" || !text.trim()) throw new ConfigError("Paste some email addresses, or upload a CSV or Excel file.");
      if (text.length > 1_000_000) throw new ConfigError("That list is too long to paste. Upload it as a file instead.");
      result = recipientsFromText(text);
    }
    const emails = result.recipients.map((r) => r.email);
    const found = emails.length ? await (await col("email_unsubscribes")).find({ user_id: user._id, email: { $in: emails } }, { projection: { email: 1 } }).toArray() : [];
    return { ...result, unsubscribed: found.map((f) => f.email).sort() };
  }],
  ["POST", "/api/email/images/import", "user", async ({ body, user, origin }) => {
    const url = safeUrl(textField(await body(), "url"));
    if (!url) throw new ConfigError("Enter the image's web address, starting with https://.");
    const image = await fetchImage(url);
    const key = await storeBuffer(user._id, "image", image.mime, image.data, "imported");
    return { key, url: publicFileUrl(origin, key, 24) };
  }],
  ["POST", "/api/email/generate", "user", async ({ body, user, origin }) => {
    const data = await body();
    const kind = data.kind;
    const description = textField(data, "description") || "";
    let text = "";
    let articles: any[] | null = null;
    let issue: any = null;
    let instructions = description;
    if (kind === "toc") {
      if (data.source === "issue") {
        issue = await readIssue(textField(data, "url") || "");
        text = issue.text;
        instructions = `${description}\n${TOC_ISSUE_NOTE}`.trim();
      } else if (data.source === "url") text = await fetchPageText(textField(data, "url") || "");
      else if (data.source === "file") {
        articles = articlesFromJson(data.articles);
        if (!articles.length) throw new ConfigError("Upload a file with at least one article first.");
      } else text = (textField(data, "text") || "").slice(0, 60_000);
    } else if (kind === "banner" && !description) throw new ConfigError("Describe what the banner is for.");
    const label = `${kind === "toc" ? "Table of contents" : "Banner"} email: ${description.slice(0, 80)}`.replace(/: $/, "");
    const [content, usage] = await aiRun(user._id, "email", label, () => generateContent(kind, instructions, text, articles));
    if (!issue) return { content, usage };
    const suggestions: string[] = [];
    let coverSaved = false;
    if (issue.cover) {
      const figure: any = { caption: "", alt: `Cover of ${content.issue || "this issue"}`.slice(0, 200) };
      try {
        const image = await fetchImage(issue.cover);
        figure.key = await storeBuffer(user._id, "image", image.mime, image.data, "cover");
        coverSaved = true;
      } catch {
        figure.url = issue.cover;
        suggestions.push("The cover image was found but couldn't be copied, so the email links to it. For a reliable email, download the cover and upload it under Figures.");
      }
      content.figures = [figure, ...(content.figures || [])].slice(0, 6);
      suggestions.push("Check the cover is the right one. You can replace it by uploading your own under Figures.");
    } else suggestions.push("No cover image was found on the issue page. Upload the issue cover under Figures: it is shown at the top.");
    suggestions.push(issue.images.length ? "Other images from the page are shown below. Add any of them as figures, or upload your own." : "You can add other images, such as graphical abstracts, by uploading them under Figures.");
    const count = (content.sections || []).reduce((n: number, s: any) => n + s.articles.length, 0);
    suggestions.push(`${count} article${count === 1 ? " was" : "s were"} found. Compare them with the issue page before sending: some sites load more articles with JavaScript.`);
    void origin;
    return { content, usage, issue: { url: issue.url, cover: issue.cover, cover_saved: coverSaved, images: issue.images, suggestions } };
  }],
  ["POST", "/api/email/render", "user", async ({ body, user, origin }) => {
    const content = normalizeContent((await body()).content);
    const settings = await emailSettings(user);
    const source = (figure: any) => (figure.key ? publicFileUrl(origin, figure.key, 2) : figure.url || "");
    return { content, html: renderHtml(content, source, DEFAULT_NAME, settings.footer, "#unsubscribe"), text: renderText(content, DEFAULT_NAME, settings.footer, "(your unsubscribe link)") };
  }],
  ["GET", "/api/email/templates", "user", async ({ user }) => {
    const items = await (await col("email_templates")).find({ user_id: user._id }).sort({ updated_at: -1 }).limit(200).toArray();
    return { templates: items.map((doc) => {
      const t = unpack(doc);
      return { id: String(t._id), name: t.name || "", kind: t.content?.kind, subject: t.content?.subject || "", updated_at: new Date(t.updated_at).toISOString() };
    }) };
  }],
  ["POST", "/api/email/templates", "user", async ({ body, user }) => {
    const data = await body();
    const content = normalizeContent(data.content);
    const doc = { user_id: user._id, name: (textField(data, "name") || content.subject).slice(0, 120), content, figure_keys: content.figures.map((f: any) => f.key).filter(Boolean), created_at: now(), updated_at: now() };
    const result = await (await col("email_templates")).insertOne(pack(doc, TEMPLATE_PLAIN));
    return json({ template: { ...templateJson({ ...pack(doc, TEMPLATE_PLAIN), _id: result.insertedId }) } }, 201);
  }],
  ["GET", "/api/email/templates/:id", "user", async ({ params, user }) => {
    const doc = await (await col("email_templates")).findOne({ _id: toObjectId(params.id)!, user_id: user._id });
    if (!doc) return json({ error: "That template wasn't found." }, 404);
    return { template: templateJson(doc) };
  }],
  ["PUT", "/api/email/templates/:id", "user", async ({ params, body, user }) => {
    const data = await body();
    const content = normalizeContent(data.content);
    const templates = await col("email_templates");
    const existing = await templates.findOne({ _id: toObjectId(params.id)!, user_id: user._id });
    if (!existing) return json({ error: "That template wasn't found." }, 404);
    const doc = { ...unpack(existing), name: (textField(data, "name") || content.subject).slice(0, 120), content, figure_keys: content.figures.map((f: any) => f.key).filter(Boolean), updated_at: now() };
    await templates.replaceOne({ _id: existing._id }, pack(doc, TEMPLATE_PLAIN));
    return { template: templateJson(pack(doc, TEMPLATE_PLAIN)) };
  }],
  ["DELETE", "/api/email/templates/:id", "user", async ({ params, user }) => {
    const result = await (await col("email_templates")).deleteOne({ _id: toObjectId(params.id)!, user_id: user._id });
    if (!result.deletedCount) return json({ error: "That template wasn't found." }, 404);
    return { removed: true };
  }],
  ["POST", "/api/email/test", "user", async ({ body, user, origin }) => {
    const settings = requireSmtp();
    const data = await body();
    const content = normalizeContent(data.content);
    if (!(await reserveEmail())) throw new ConfigError(`Today's limit of ${dailyLimit()} emails for this server is reached.`);
    const campaign: any = { ...campaignFields(data, content, await emailSettings(user), origin), user_id: user._id };
    campaign.subject = `[Test] ${content.subject}`;
    const { source, images } = await attachFigures(content, user._id);
    const transporter = transport(settings);
    try {
      await sendHtml(transporter, settings, buildMessage(campaign, { email: user.email, name: user.name || "" }, source, images, unsubscribeUrl(campaign, user.email)));
    } finally {
      transporter.close();
    }
    return { sent_to: user.email };
  }],
  ["GET", "/api/email/campaigns", "user", async ({ user }) => {
    const items = await (await col("email_campaigns")).find({ user_id: user._id }, { projection: { z: 0 } }).sort({ created_at: -1 }).limit(30).toArray();
    return { campaigns: items.map(campaignJson) };
  }],
  ["POST", "/api/email/campaigns", "user", async ({ body, user, origin }) => {
    requireSmtp();
    const data = await body();
    const content = normalizeContent(data.content);
    if (!Array.isArray(data.recipients) || !data.recipients.length) throw new ConfigError("Add at least one recipient.");
    const found = new RecipientList();
    for (const item of data.recipients) if (item && typeof item.email === "string") found.add(item.email, typeof item.name === "string" ? item.name : "");
    if (!found.recipients.length) throw new ConfigError("None of the recipients has a valid email address.");
    if (data.confirm !== true) throw new ConfigError("Confirm that you want to send this email.");
    const id = await createCampaign(user._id, { ...campaignFields(data, content, await emailSettings(user), origin), recipients: found.recipients, total: found.recipients.length });
    await sendBatch(25_000, id, user._id);
    return json({ campaign: campaignJson(await (await col("email_campaigns")).findOne({ _id: id }, { projection: { z: 0 } })) }, 202);
  }],
  ["POST", "/api/email/campaigns/:id/step", "user", async ({ params, user }) => {
    const id = toObjectId(params.id);
    if (!id) throw new ConfigError("That campaign wasn't found.");
    await sendBatch(40_000, id, user._id);
    const campaign = await (await col("email_campaigns")).findOne({ _id: id, user_id: user._id }, { projection: { z: 0 } });
    if (!campaign) throw new ConfigError("That campaign wasn't found.");
    return { campaign: campaignJson(campaign) };
  }],
  ["POST", "/api/email/campaigns/:id/:action", "user", async ({ params, user }) => {
    const id = toObjectId(params.id);
    const campaigns = await col("email_campaigns");
    let updated = null;
    if (params.action === "cancel") {
      updated = id ? await campaigns.findOneAndUpdate({ _id: id, user_id: user._id, status: { $in: ["queued", "sending", "paused"] } }, { $set: { status: "cancelled", error: null, updated_at: now() } }, { returnDocument: "after", projection: { z: 0 } }) : null;
    } else if (params.action === "resume") {
      requireSmtp();
      updated = id ? await campaigns.findOneAndUpdate({ _id: id, user_id: user._id, status: "paused" }, { $set: { status: "queued", error: null, updated_at: now(), locked_until: new Date(0) } }, { returnDocument: "after", projection: { z: 0 } }) : null;
    } else return json({ error: "Unknown action." }, 404);
    if (!updated) return json({ error: "That campaign can't be changed now." }, 409);
    return { campaign: campaignJson(updated) };
  }],
  ["GET", "/api/email/unsubscribe", "public", async ({ req, url }) => {
    const details = await unsubscribeToken(req, url);
    if (!details) return unsubscribePage("Link not valid", "This unsubscribe link isn't valid. Reply to the email instead.");
    return unsubscribePage("Unsubscribe?", `Stop receiving these emails at ${details.email}.`, details.token);
  }],
  ["POST", "/api/email/unsubscribe", "public", async ({ req, url }) => {
    const details = await unsubscribeToken(req, url);
    if (!details) return unsubscribePage("Link not valid", "This unsubscribe link isn't valid. Reply to the email instead.");
    await (await col("email_unsubscribes")).updateOne({ user_id: details.userId, email: details.email }, { $setOnInsert: { created_at: now() } }, { upsert: true });
    return unsubscribePage("You're unsubscribed", `${details.email} won't receive these emails any more.`);
  }],
];

export { originOf };
