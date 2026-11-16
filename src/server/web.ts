import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Parser } from "htmlparser2";
import { env } from "./env";
import { ApiError, ConfigError } from "./errors";
import { cleanText } from "./text";

// Reads public web pages for posts, reels, emails and manuscripts. There is no headless browser on
// Vercel, so a page built only by JavaScript is reported clearly ("paste its text instead").

export const USER_AGENT = "Mozilla/5.0 (compatible; SocialAutopost/2.0; page reader)";
const BLOCKED = [401, 403, 429, 503];
const MAX_REDIRECTS = 3;
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;

/** An http(s) URL, or "" for anything else (javascript:, data:, relative...). */
export function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (/\s/.test(url)) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) return "";
  } catch {
    return "";
  }
  return url.slice(0, 1000);
}

export function joinUrl(base: string, href: string): string {
  try {
    return safeUrl(new URL(href, base).toString());
  } catch {
    return "";
  }
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return privateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** Refuse addresses on private networks, so the server can't be used to reach them. */
export async function checkPublicHost(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new ConfigError(`The address ${host} couldn't be found.`);
  }
  if (!addresses.length || addresses.some(privateAddress)) throw new ConfigError("That web address isn't on the public internet.");
}

/** GET a public address, following redirects only to other public addresses. */
export async function safeGet(url: string, accept: string, maxBytes: number, timeoutMs = 15_000) {
  let current = safeUrl(url);
  if (!current) throw new ConfigError("Enter a web address starting with https:// or http://.");
  let response: Response | null = null;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    await checkPublicHost(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(current, {
        headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
        redirect: "manual", signal: controller.signal,
      });
    } catch {
      throw new ApiError("The page couldn't be loaded.", "Check the address, or copy the page's text and paste it instead.");
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = joinUrl(current, location);
      if (!current) throw new ApiError("The page redirected somewhere that can't be read.");
      continue;
    }
    break;
  }
  if (!response || (response.status >= 300 && response.status < 400)) throw new ApiError("The page redirected too many times.");
  if (response.status >= 400) {
    const refused = BLOCKED.includes(response.status);
    throw new ApiError(refused ? `The site refused the request (${response.status}).` : `The page returned an error (${response.status}).`,
      refused ? "Some sites block automated readers. Copy the page's text and paste it instead, or upload the PDF."
        : "Check the address is right and the page is public.", response.status);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks).subarray(0, maxBytes);
  return { url: current, contentType: (response.headers.get("content-type") || "text/html").toLowerCase(), body };
}

export async function fetchHtml(url: string) {
  const { url: finalUrl, contentType, body } = await safeGet(url, "text/html,application/xhtml+xml,text/plain", MAX_PAGE_BYTES);
  if (!contentType.includes("html") && !contentType.includes("text") && !contentType.includes("xml")) {
    throw new ConfigError("That address isn't a web page.", "For a PDF, upload the file instead.");
  }
  const charset = /charset=([\w-]+)/.exec(contentType)?.[1] || "utf-8";
  let html: string;
  try {
    html = new TextDecoder(charset).decode(body);
  } catch {
    html = body.toString("utf8");
  }
  return { url: finalUrl, html };
}

// --- Parsing ---

const SKIP_TEXT = new Set(["script", "style", "noscript", "svg", "head", "template", "iframe"]);
const BLOCKS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "br", "section", "article", "td", "dd", "dt", "blockquote", "figcaption", "main"]);

function parse(html: string, handlers: { open?: (tag: string, attrs: Record<string, string>) => void; close?: (tag: string) => void; text?: (t: string) => void }) {
  const parser = new Parser({
    onopentag: (name, attrs) => handlers.open?.(name.toLowerCase(), attrs as Record<string, string>),
    onclosetag: (name) => handlers.close?.(name.toLowerCase()),
    ontext: (text) => handlers.text?.(text),
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
}

const joinLines = (raw: string) => raw.split("\n").map((line) => line.split(/\s+/).filter(Boolean).join(" ")).filter(Boolean).join("\n");

/** A page's readable text. allLinks keeps "[link: …]" after long link texts (article titles). */
export function pageText(baseUrl: string, html: string, allLinks = false): string {
  const parts: string[] = [];
  let skipping = 0;
  let anchor: { href: string; index: number } | null = null;
  parse(html, {
    open(tag, attrs) {
      if (SKIP_TEXT.has(tag)) skipping += 1;
      else if (BLOCKS.has(tag)) parts.push("\n");
      if (tag === "a" && !skipping) {
        const href = attrs.href || "";
        if (href.toLowerCase().includes("doi")) parts.push(` [${joinUrl(baseUrl, href)}] `);
        else if (allLinks && href && !/^(#|javascript:|mailto:)/i.test(href)) anchor = { href, index: parts.length };
      }
    },
    close(tag) {
      if (tag === "a" && anchor) {
        const label = parts.slice(anchor.index).join("").split(/\s+/).filter(Boolean).join(" ");
        const link = label.length >= 15 ? joinUrl(baseUrl, anchor.href) : "";
        if (link) parts.push(` [link: ${link}] `);
        anchor = null;
      }
      if (SKIP_TEXT.has(tag) && skipping) skipping -= 1;
      else if (BLOCKS.has(tag)) parts.push("\n");
    },
    text(t) {
      if (!skipping) parts.push(t);
    },
  });
  return joinLines(parts.join(""));
}

export interface PageMeta { title: string; meta: Record<string, string>; authors: string[]; keywords: string[] }

export function pageMeta(html: string): PageMeta {
  const result: PageMeta = { title: "", meta: {}, authors: [], keywords: [] };
  let inTitle = false;
  parse(html.slice(0, 400_000), {
    open(tag, attrs) {
      if (tag === "title") inTitle = true;
      else if (tag === "meta") {
        const name = (attrs.property || attrs.name || "").toLowerCase();
        const content = (attrs.content || "").trim();
        if (!name || !content) return;
        if (["citation_author", "dc.creator"].includes(name) && result.authors.length < 30) {
          const author = content.split(/\s+/).join(" ").slice(0, 100);
          if (!result.authors.includes(author)) result.authors.push(author);
        }
        if (["citation_keywords", "dc.subject"].includes(name) && result.keywords.length < 20) {
          result.keywords.push(...content.split(/[;,]/).map((k) => k.trim()).filter(Boolean));
        }
        if (!(name in result.meta)) result.meta[name] = content;
      } else if (tag === "link" && (attrs.rel || "").toLowerCase().includes("icon") && !result.meta.icon) {
        result.meta.icon = attrs.href || "";
      }
    },
    close(tag) {
      if (tag === "title") inTitle = false;
    },
    text(t) {
      if (inTitle && result.title.length < 300) result.title += t;
    },
  });
  result.title = result.title.split(/\s+/).filter(Boolean).join(" ");
  return result;
}

export const SKIP_IMAGE_WORDS = ["logo", "icon", "sprite", "avatar", "badge", "pixel", "spacer", "loading", "orcid", "creativecommons",
  "facebook", "twitter", "linkedin", "share", "flag", "button", "banner-ad", "advert", "gravatar"];
const COVER_WORDS = ["cover", "issue-image", "issue_image", "issueimage", "journal-image", "thumbnail-issue"];

function imageSource(attrs: Record<string, string>): string {
  let src = attrs["data-src"] || attrs["data-original"] || attrs.src || "";
  if (!src && attrs.srcset) src = attrs.srcset.split(",")[0].trim().split(/\s+/)[0];
  return src && !src.startsWith("data:") ? src : "";
}

/** A page's images, marking ones that look like a journal issue's cover. */
export function pageImages(baseUrl: string, html: string): { url: string; alt: string; cover: boolean }[] {
  const images: { url: string; alt: string; cover: boolean }[] = [];
  const context: string[] = [];
  const containers = new Set(["div", "section", "figure", "a", "aside", "span", "picture", "li", "header"]);
  parse(html, {
    open(tag, attrs) {
      const marker = `${attrs.class || ""} ${attrs.id || ""}`.toLowerCase();
      if (containers.has(tag)) {
        context.push(marker);
        if (context.length > 12) context.shift();
      }
      if (tag !== "img") return;
      const src = imageSource(attrs);
      const url = src ? joinUrl(baseUrl, src) : "";
      if (!url || /\.(svg|gif|ico)$/i.test(url.split("?")[0])) return;
      const own = `${url} ${attrs.alt || ""}`.toLowerCase();
      if (SKIP_IMAGE_WORDS.some((w) => own.includes(w)) && !own.includes("cover")) return;
      const sizes = [attrs.width, attrs.height].filter((v) => /^\d+$/.test(v || "")).map(Number);
      if (sizes.length && Math.min(...sizes) < 80) return;
      const words = `${own} ${marker} ${context.slice(-3).join(" ")}`;
      if (!images.some((i) => i.url === url)) images.push({ url, alt: cleanText(attrs.alt || "").slice(0, 200), cover: COVER_WORDS.some((w) => words.includes(w)) });
    },
    close(tag) {
      if (containers.has(tag)) context.pop();
    },
  });
  return images;
}

const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg", "template", "iframe", "nav", "aside", "footer", "header", "form", "button", "select", "textarea", "dialog", "head"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP_MARKS = ["related", "recommend", "sidebar", "side-bar", "breadcrumb", "comment", "share", "social", "cookie", "newsletter", "subscribe",
  "advert", "promo", "popular", "trending-", "more-from", "you-may", "read-next", "next-article", "prev-article", "pagination", "menu", "navbar",
  "toc", "footer", "modal", "banner"];
const END_OF_CONTENT = /^(references?|bibliography|works cited|literature cited|cite this article|how to cite( this article)?|related articles|similar articles|recommended articles|you may also like|more from this (journal|issue)|read next)\b/i;

/** A page's own text and images: <article> if it has enough text, else <main>, else the body. Menus, sidebars and "related" blocks are left out. */
export function mainContent(baseUrl: string, html: string): { text: string; images: string[] } {
  const stack: { tag: string; skip: boolean; region: string }[] = [];
  const chunks: [string, string][] = [];
  const images: [string, string][] = [];
  const state = () => {
    const skipped = stack.some((e) => e.skip);
    const regions = new Set(stack.map((e) => e.region));
    return { skipped, region: regions.has("article") ? "article" : regions.has("main") ? "main" : "body" };
  };
  parse(html, {
    open(tag, attrs) {
      if (tag === "img") {
        const { skipped, region } = state();
        if (skipped) return;
        const src = imageSource(attrs);
        const url = src ? joinUrl(baseUrl, src) : "";
        if (!url || /\.(svg|gif|ico)$/i.test(url.split("?")[0])) return;
        const own = `${url} ${attrs.alt || ""} ${attrs.class || ""}`.toLowerCase();
        if (SKIP_IMAGE_WORDS.some((w) => own.includes(w))) return;
        const sizes = [attrs.width, attrs.height].filter((v) => /^\d+$/.test(v || "")).map(Number);
        if (sizes.length && Math.min(...sizes) < 120) return;
        images.push([region, url]);
        return;
      }
      if (BLOCKS.has(tag)) chunks.push([state().region, "\n"]);
      if (VOID.has(tag)) return;
      const marker = `${attrs.class || ""} ${attrs.id || ""} ${attrs.role || ""}`.toLowerCase();
      const skip = SKIP_CONTENT_TAGS.has(tag) || ["navigation", "complementary", "banner"].includes((attrs.role || "").toLowerCase())
        || SKIP_MARKS.some((w) => marker.includes(w)) || attrs["aria-hidden"] === "true";
      const region = tag === "article" || (attrs.itemprop || "").toLowerCase() === "articlebody" ? "article" : tag === "main" ? "main" : "";
      stack.push({ tag, skip, region });
    },
    close(tag) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.splice(i);
          break;
        }
      }
      if (BLOCKS.has(tag)) chunks.push([state().region, "\n"]);
    },
    text(t) {
      const { skipped, region } = state();
      if (!skipped && t.trim()) chunks.push([region, t]);
    },
  });
  const textOf = (regions: Set<string>) => {
    const raw = chunks.filter(([r]) => regions.has(r)).map(([, t]) => t).join("");
    const seen = new Set<string>();
    let lines: string[] = [];
    for (const line of raw.split("\n")) {
      const clean = line.split(/\s+/).filter(Boolean).join(" ");
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        lines.push(clean);
      }
    }
    const end = lines.findIndex((line, index) => index >= 2 && END_OF_CONTENT.test(line));
    if (end > 0) lines = lines.slice(0, end);
    return lines.join("\n");
  };
  for (const regions of [new Set(["article"]), new Set(["article", "main"]), new Set(["article", "main", "body"])]) {
    const text = textOf(regions);
    if (text.length >= 200 || regions.size === 3) {
      return { text, images: [...new Set(images.filter(([r]) => regions.has(r)).map(([, u]) => u))] };
    }
  }
  return { text: "", images: [] };
}

/** Links an <a> parser finds, with their text. */
export function pageLinks(html: string): [string, string][] {
  const links: [string, string][] = [];
  let href: string | null = null;
  let text: string[] = [];
  parse(html, {
    open(tag, attrs) {
      if (tag === "a") {
        href = attrs.href || "";
        text = [];
      }
    },
    close(tag) {
      if (tag === "a" && href !== null) {
        links.push([href, text.join("").split(/\s+/).filter(Boolean).join(" ").slice(0, 120)]);
        href = null;
      }
    },
    text(t) {
      if (href !== null) text.push(t);
    },
  });
  return links;
}

const GOOD_LINK = ["about", "product", "feature", "service", "solution", "research", "article", "journal", "course", "program", "shop", "collection", "pricing", "work", "portfolio", "issue", "blog", "news"];
const BAD_LINK = ["login", "log in", "sign in", "signin", "register", "cart", "account", "privacy", "terms", "cookie", "contact", "careers", "facebook", "twitter", "instagram", "linkedin", "youtube"];

/** Internal links a visitor might click, best first, one per page. */
export function siteLinks(baseUrl: string, html: string) {
  const base = new URL(baseUrl);
  const host = base.hostname.replace(/^www\./, "");
  const clean = (u: URL) => `${u.origin}${u.pathname}`.replace(/\/$/, "");
  const found = new Map<string, { url: string; label: string; path: string; score: [number, number] }>();
  pageLinks(html).forEach(([href, label], order) => {
    const url = joinUrl(baseUrl, href);
    if (!url || label.length < 2 || label.length > 60) return;
    const parts = new URL(url);
    if (parts.hostname.replace(/^www\./, "") !== host) return;
    const key = clean(parts);
    if (key === clean(base) || found.has(key)) return;
    const words = `${label} ${parts.pathname}`.toLowerCase();
    if (BAD_LINK.some((w) => words.includes(w)) || /\.(pdf|jpe?g|png|zip|docx?)$/i.test(parts.pathname)) return;
    found.set(key, { url, label: cleanText(label).slice(0, 60), path: parts.pathname || "/", score: [GOOD_LINK.some((w) => words.includes(w)) ? 0 : 1, order] });
  });
  return [...found.values()].sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1]).slice(0, 12)
    .map(({ score, ...rest }) => rest);
}

export function articleInfo(meta: PageMeta) {
  const title = cleanText(meta.meta.citation_title || meta.meta["dc.title"] || "").slice(0, 300);
  if (!title) return null;
  const keywords = meta.keywords.length ? meta.keywords : (meta.meta.keywords || "").split(/[;,]/).map((k) => k.trim()).filter(Boolean);
  return {
    title,
    authors: meta.authors.slice(0, 12),
    journal: cleanText(meta.meta.citation_journal_title || meta.meta.citation_conference_title || "").slice(0, 200),
    doi: cleanText(meta.meta.citation_doi || "").slice(0, 100),
    date: cleanText(meta.meta.citation_publication_date || meta.meta.citation_date || "").slice(0, 20),
    abstract: cleanText(meta.meta.citation_abstract || meta.meta["dc.description"] || "").slice(0, 2500),
    keywords: [...new Set(keywords)].slice(0, 10),
  };
}

export function looksBlocked(title: string, text: string): boolean {
  const sample = `${title} ${text.slice(0, 600)}`.toLowerCase();
  return /just a moment|attention required|verify you are human|enable javascript|access denied|are you a robot|captcha|checking your browser/.test(sample)
    && text.length < 1500;
}

export function blockedError(url: string) {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // Keep the address as given.
  }
  return new ApiError(`${host} blocks automated readers, so the page couldn't be read.`,
    "Copy the page's text and paste it instead, or upload the article as a PDF.");
}

// --- Pages built with JavaScript ---
// Vercel has no headless browser, so a page whose HTML is only an empty shell (React, Vue and
// similar apps) is read through a reader service that runs the page's JavaScript and returns its
// text, links and images: Jina Reader (r.jina.ai, free; JINA_API_KEY raises its limits).
// READER_FALLBACK=off switches this off.

const READER = "https://r.jina.ai/";

function markdownToText(markdown: string, keepLinks: boolean) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\((https?:[^)\s]+)[^)]*\)/g, (_m, label, href) => (keepLinks && label.trim().length >= 15 ? `${label} [link: ${href}]` : label))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^={3,}$|^-{3,}$/gm, "")
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** A page as a browser shows it, from the reader service, or null if it can't be read that way. */
export async function renderedPage(url: string, keepLinks = false) {
  if (env("READER_FALLBACK").toLowerCase() === "off") return null;
  const clean = safeUrl(url);
  if (!clean) return null;
  await checkPublicHost(clean);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const headers: Record<string, string> = { Accept: "application/json", "X-With-Images-Summary": "true", "X-With-Links-Summary": "true", "X-Timeout": "20" };
    if (env("JINA_API_KEY")) headers.Authorization = `Bearer ${env("JINA_API_KEY")}`;
    const response = await fetch(`${READER}${clean}`, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json())?.data;
    if (!data || typeof data.content !== "string") return null;
    const images = Object.values<string>(data.images || {}).map((u) => safeUrl(u))
      .filter((u) => u && !/\.(svg|gif|ico)(\?|$)/i.test(u) && !SKIP_IMAGE_WORDS.some((w) => u.toLowerCase().includes(w)));
    const links = Object.entries<string>(data.links || {}).filter(([, href]) => safeUrl(href));
    const anchors = links.map(([label, href]) => `<a href="${href.replace(/"/g, "&quot;")}">${label.replace(/[<>&]/g, " ")}</a>`).join("\n");
    return {
      url: safeUrl(data.url) || clean, title: String(data.title || "").trim(), description: String(data.description || "").trim(),
      text: markdownToText(data.content, keepLinks), images: [...new Set(images)], linksHtml: `<nav>${anchors}</nav>`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Screenshots ---
// The same reader service also photographs the page in its browser: the first screen (1280 × 1280)
// and the whole page (1280 wide). Its picture links expire after a few hours, so the pictures are
// downloaded at once. A screenshot is a bonus: any failure just means no screenshot.
// SCREENSHOTS=off switches this off.

export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_SCREENSHOT_HEIGHT = 16_000;

/** Width and height of a PNG or JPEG, or null for anything else. */
export function imageSize(data: Buffer): { width: number; height: number; mime: string } | null {
  if (data.length > 24 && data.subarray(1, 4).toString() === "PNG") {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), mime: "image/png" };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let i = 2; i + 9 < data.length;) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1];
      const length = data.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5), mime: "image/jpeg" };
      }
      i += 2 + length;
    }
  }
  return null;
}

async function readerShot(url: string, format: "screenshot" | "pageshot", started: number, budgetMs: number): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, budgetMs - (Date.now() - started)));
  try {
    const headers: Record<string, string> = { Accept: "application/json", "X-Return-Format": format, "X-Timeout": String(Math.max(5, Math.floor(budgetMs / 1000) - 4)) };
    if (env("JINA_API_KEY")) headers.Authorization = `Bearer ${env("JINA_API_KEY")}`;
    const response = await fetch(`${READER}${url}`, { headers, signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json())?.data || {};
    const link = safeUrl(format === "pageshot" ? data.pageshotUrl : data.screenshotUrl);
    const left = budgetMs - (Date.now() - started);
    if (!link || left < 1500) return null;
    const { body } = await safeGet(link, "image/png,image/jpeg,image/*", MAX_SCREENSHOT_BYTES + 1, left);
    const size = imageSize(body);
    if (body.length > MAX_SCREENSHOT_BYTES || !size || size.width < 200 || size.height < 200 || size.height > MAX_SCREENSHOT_HEIGHT) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Screenshots of a public page: `page` is the whole page (or the first screen when the whole page
 * took too long), `first` the first screen. Both null when screenshots are off or failed.
 */
export async function pageScreenshot(url: string, budgetMs = 22_000): Promise<{ page: Buffer | null; first: Buffer | null }> {
  const none = { page: null, first: null };
  if (env("SCREENSHOTS").toLowerCase() === "off") return none;
  const clean = safeUrl(url);
  if (!clean) return none;
  try {
    await checkPublicHost(clean);
  } catch {
    return none;
  }
  const started = Date.now();
  // Two requests at once: the first screen is quick, the whole page can be slow on long pages.
  const [first, page] = await Promise.all([readerShot(clean, "screenshot", started, budgetMs), readerShot(clean, "pageshot", started, budgetMs)]);
  return { page: page || first, first: first || null };
}

/** Download a page and make sure it has readable content, using the reader for JavaScript sites. */
export async function readPage(url: string, minChars = 200) {
  let fetched: { url: string; html: string } | null = null;
  let failure: any = null;
  try {
    fetched = await fetchHtml(url);
  } catch (error: any) {
    if (!(error instanceof ApiError) || !(BLOCKED.includes(error.status as number) || (error.status as number) >= 500)) throw error;
    failure = error;
  }
  let finalUrl = fetched?.url || safeUrl(url);
  let html = fetched?.html || "";
  const meta = pageMeta(html);
  const content = mainContent(finalUrl, html);
  let text = content.text.length >= 40 ? content.text : pageText(finalUrl, html);
  let images = content.images;
  const blocked = Boolean(html) && looksBlocked(meta.title, text);
  if (failure || blocked || text.length < minChars) {
    const rendered = await renderedPage(finalUrl);
    if (rendered && rendered.text.length > text.length && !looksBlocked(rendered.title, rendered.text)) {
      text = rendered.text;
      images = [...new Set([...images, ...rendered.images])];
      html = `${html}\n${rendered.linksHtml}`;
      finalUrl = rendered.url || finalUrl;
      meta.title = meta.title || rendered.title;
      if (!meta.meta.description && rendered.description) meta.meta.description = rendered.description;
    } else if (blocked || failure) {
      throw failure && !blocked ? failure : blockedError(finalUrl);
    }
  }
  if (text.length < Math.min(minChars, 40)) {
    throw new ApiError("No readable text was found on that page.",
      "The page may need a sign-in. Copy its text and paste it instead.");
  }
  return { url: finalUrl, html, meta, text, images };
}

/** An image from a public address, as bytes. */
export async function fetchImage(url: string, maxBytes = 8 * 1024 * 1024) {
  const { contentType, body } = await safeGet(url, "image/*", maxBytes);
  if (!contentType.startsWith("image/") || contentType.includes("svg")) {
    throw new ConfigError("That address isn't a PNG, JPEG or WebP image.", "Download it and upload it instead.");
  }
  if (body.length >= maxBytes) throw new ConfigError("That image is too large.", "Download it, make it smaller and upload it instead.");
  return { data: body, mime: contentType.split(";")[0] };
}
