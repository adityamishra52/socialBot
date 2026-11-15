export const PLATFORMS = ["linkedin", "facebook", "instagram"] as const;
export type Platform = (typeof PLATFORMS)[number];
// Facebook must stay under 2000 characters, so its maximum is 1999.
export const LIMITS: Record<string, number> = { linkedin: 3000, facebook: 1999, instagram: 2200 };

/** Remove markdown from generated text, leaving hashtags and snake_case intact. */
export function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  let text = input.replace(/\r\n?/g, "\n");
  text = text.replace(/^\s*```[^\n]*$/gm, "");
  text = text.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "");
  text = text.replace(/^#{1,6}[ \t]+/gm, "");
  text = text.replace(/^>[ \t]?/gm, "");
  text = text.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
  text = text.replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ");
  text = text.replace(/\*\*\*([^\n]+?)\*\*\*/g, "$1");
  text = text.replace(/\*\*([^\n]+?)\*\*/g, "$1");
  text = text.replace(/__([^\n]+?)__/g, "$1");
  text = text.replace(/(?<![\w*])\*(\S(?:[^\n]*?\S)?)\*(?![\w*])/g, "$1");
  text = text.replace(/(?<![\w#])_(\S(?:[^\n]*?\S)?)_(?!\w)/g, "$1");
  text = text.replace(/~~([^\n]+?)~~/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.split("\n").map((line) => line.trimEnd()).join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function limitViolations(posts: Record<string, string>, platforms: string[]): string[] {
  const problems: string[] = [];
  for (const platform of platforms) {
    const text = posts[platform] || "";
    if (!text.trim()) problems.push(`${platform} post is empty`);
    else if (text.length > LIMITS[platform]) problems.push(`${platform} post is ${text.length} characters (limit ${LIMITS[platform]})`);
  }
  return problems;
}

const HASHTAG_LINE = /^(?:#\w+\s*)+$/u;

/** Add a link above the closing hashtags, within the platform's limit. Instagram can't link captions. */
export function withLink(text: string, url: string, platform: string): string {
  if (!url || text.includes(url)) return text;
  const shown = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const line = platform === "instagram" ? `🔗 Link in bio: ${shown}` : `🔗 Read more: ${url}`;
  const lines = text.trimEnd().split("\n");
  const tags: string[] = [];
  while (lines.length && HASHTAG_LINE.test(lines[lines.length - 1].trim())) tags.unshift(lines.pop() as string);
  let body = lines.join("\n").trimEnd();
  const tail = `\n\n${line}` + (tags.length ? `\n\n${tags.join("\n")}` : "");
  const room = LIMITS[platform] - tail.length;
  if (body.length > room) body = body.slice(0, Math.max(0, room - 1)).trimEnd() + "…";
  return body + tail;
}

export function cleanHashtags(value: unknown, max = 15): string[] {
  const tags: string[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== "string") continue;
    const tag = "#" + raw.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (/^#[\p{L}\p{N}][\p{L}\p{N}_]{1,49}$/u.test(tag) && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    if (tags.length >= max) break;
  }
  return tags;
}

export function clip(text: string, limit: number): string {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, limit);
}

export const squash = (value: unknown, limit = 1000) => (typeof value === "string" ? value.split(/\s+/).filter(Boolean).join(" ").slice(0, limit) : "");

export function str(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").replace(/\*\*/g, "").replace(/^#{1,6}\s+/gm, "").trim().slice(0, limit);
}

export const list = (value: unknown, limit = 1000): any[] => (Array.isArray(value) ? value.slice(0, limit) : []);

export function wordCount(text: string): number {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

const words = (text: string) => new Set((String(text).toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 2));
export function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / (left.size + right.size - shared);
}
