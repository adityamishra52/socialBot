import { ApiError, ConfigError } from "./errors";
import { clip } from "./text";
import { articleInfo, fetchHtml, pageLinks, pageText, readPage, safeGet, safeUrl, joinUrl } from "./web";
import { checkChart, checkDiagram, chartSvg, diagramSvg, FigureSpecError } from "../shared/charts";

// Sources for the writer that the server reads: web pages, public GitHub repositories, the target
// journal's guidelines, books by ISBN, and openly licensed images for figures. Uploaded files
// (PDF, Word, ZIP, text) are read in the browser, so only their text is sent.

const MAX_SOURCE = 40_000;
const REPO = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:[/?#].*)?$/;

function person(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (name.includes(",")) {
    const [family, given] = name.split(",", 2);
    return { family: family.trim(), given: given.trim() };
  }
  return { family: parts[parts.length - 1] || name, given: parts.slice(0, -1).join(" ") };
}

export async function readRepo(url: string) {
  const match = REPO.exec(url.trim());
  if (!match) throw new ConfigError("Enter a GitHub repository address like https://github.com/owner/name.");
  const [, owner, rawName] = match;
  const name = rawName.replace(/\.git$/, "");
  const api = async (path: string, accept = "application/vnd.github+json") => {
    const { body } = await safeGet(`https://api.github.com/repos/${owner}/${name}${path}`, accept, 2_000_000);
    return body.toString("utf8");
  };
  let info: any;
  try {
    info = JSON.parse(await api(""));
  } catch (error: any) {
    if (error?.status === 404) throw new ConfigError("That repository wasn't found, or it is private.", "Only public repositories can be read. Upload a private one as a ZIP.");
    throw error;
  }
  const branch = info.default_branch || "main";
  const parts = [`Repository: ${info.full_name}`, `Description: ${info.description || ""}`, `Language: ${info.language || ""}. Topics: ${(info.topics || []).join(", ")}`,
    `Licence: ${info.license?.spdx_id || "not stated"}. Stars: ${info.stargazers_count || 0}. Last push: ${String(info.pushed_at || "").slice(0, 10)}.`];
  try {
    parts.push(`README:\n${clip(await api("/readme", "application/vnd.github.raw"), 15_000)}`);
  } catch {
    // No README.
  }
  try {
    const tree = JSON.parse(await api(`/git/trees/${encodeURIComponent(branch)}?recursive=1`));
    parts.push(`Files:\n${(tree.tree || []).filter((t: any) => t.type === "blob" && !/(^|\/)(node_modules|\.git|dist|build)\//.test(t.path)).map((t: any) => t.path).slice(0, 200).join("\n")}`);
  } catch {
    // The file list is optional.
  }
  const year = String(info.pushed_at || info.created_at || "").slice(0, 4);
  return {
    kind: "repo", label: `github.com/${owner}/${name}`, url: `https://github.com/${owner}/${name}`, text: clip(parts.join("\n\n"), MAX_SOURCE),
    reference: { kind: "software", title: `${info.name}: ${info.description || "source code"}`.slice(0, 300), authors: [{ family: owner, given: "" }], year, journal: "GitHub repository", url: `https://github.com/${owner}/${name}` },
  };
}

export async function readSourceUrl(url: string) {
  const clean = safeUrl(url);
  if (!clean) throw new ConfigError("Enter a web address starting with https://.");
  if (REPO.test(clean)) return readRepo(clean);
  if (/\.pdf($|\?)/i.test(new URL(clean).pathname)) {
    throw new ConfigError("PDF links are read in your browser instead.", "Download the PDF and add it under \"Upload proof material\".");
  }
  const page = await readPage(clean, 300);
  const article = articleInfo(page.meta);
  let text = page.text;
  if (article?.abstract && !text.includes(article.abstract.slice(0, 80))) text = `Abstract: ${article.abstract}\n${text}`;
  const host = new URL(page.url).hostname.replace(/^www\./, "");
  const reference = article
    ? { kind: "article", title: article.title, authors: article.authors.map(person), journal: article.journal, year: article.date.slice(0, 4),
      volume: (page.meta.meta.citation_volume || "").slice(0, 20), issue: (page.meta.meta.citation_issue || "").slice(0, 20),
      pages: [page.meta.meta.citation_firstpage, page.meta.meta.citation_lastpage].filter(Boolean).join("-"), doi: article.doi, url: page.url }
    : { kind: "web", title: (page.meta.meta["og:title"] || page.meta.title || page.url).slice(0, 300), authors: [], journal: page.meta.meta["og:site_name"] || host, year: "", url: page.url };
  return { kind: "web", label: `${host}${new URL(page.url).pathname.slice(0, 60)}`, url: page.url, text: clip(text, MAX_SOURCE), reference };
}

const GUIDE = /(author|submission|manuscript)[\s_-]*(guide|guidelines|instructions|information)|instructions[\s_-]*(for|to)[\s_-]*authors|guide[\s_-]*for[\s_-]*authors|for[\s_-]*authors|article[\s_-]*types/i;

export async function readJournal(url: string) {
  const clean = safeUrl(url);
  if (!clean) throw new ConfigError("Enter the journal's web address, starting with https://.");
  // readPage falls back to the reader service for journal sites built with JavaScript.
  const page = await readPage(clean, 300);
  const finalUrl = page.url;
  const html = page.html;
  const full = pageText(finalUrl, html);
  const texts = [`Journal page ${finalUrl}:\n${clip(full.length > page.text.length ? full : page.text, 8000)}`];
  const pages = [finalUrl];
  const warnings: string[] = [];
  const isGuide = GUIDE.test(new URL(finalUrl).pathname);
  const links = isGuide ? [] : [...new Set(pageLinks(html).filter(([href, label]) => GUIDE.test(`${label} ${href}`)).map(([href]) => joinUrl(finalUrl, href).split("#")[0]).filter(Boolean))].slice(0, 2);
  for (const link of links) {
    try {
      const guide = await readPage(link, 300);
      const guideText = pageText(guide.url, guide.html);
      texts.push(`Guidelines page ${guide.url}:\n${clip(guideText.length > guide.text.length ? guideText : guide.text, 12_000)}`);
      pages.push(guide.url);
    } catch (error: any) {
      warnings.push(`The guidelines page ${link} couldn't be read: ${error.message}`);
    }
  }
  if (pages.length === 1 && !isGuide) warnings.push("No author-guidelines page was found. For the best result, paste the address of the journal's \"Guide for authors\" page.");
  return { url: finalUrl, pages, text: clip(texts.join("\n\n"), 20_000), warnings };
}

export async function lookupBook(query: string) {
  const text = query.split(/\s+/).join(" ").slice(0, 200);
  const digits = text.replace(/[\s-]/g, "");
  const q = /^\d{9}[\dXx]$|^\d{13}$/.test(digits) ? `isbn:${digits}` : text;
  const { body } = await safeGet(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=1&fields=key,title,subtitle,author_name,first_publish_year,publisher,isbn,subject`, "application/json", 500_000);
  const doc = JSON.parse(body.toString("utf8")).docs?.[0];
  if (!doc) throw new ConfigError(`No book was found for "${text.slice(0, 80)}".`, "Check the ISBN, or type the exact title and author.");
  const reference = {
    kind: "book", title: doc.subtitle ? `${doc.title}: ${doc.subtitle}` : doc.title, authors: (doc.author_name || []).slice(0, 10).map(person),
    publisher: (doc.publisher || [""])[0], year: String(doc.first_publish_year || ""), isbn: (doc.isbn || []).find((i: string) => i.length === 13) || "", doi: "", journal: "",
    url: doc.key ? `https://openlibrary.org${doc.key}` : "", abstract: doc.subject ? `Subjects: ${doc.subject.slice(0, 12).join(", ")}` : "",
  };
  return { kind: "book", label: reference.title.slice(0, 120), url: reference.url, text: `Book: ${reference.title}\nBy: ${(doc.author_name || []).join(", ")}\nPublisher: ${reference.publisher} (${reference.year})\n${reference.abstract}`, reference };
}

// --- Figures ---

const FREE = ["cc0", "pdm", "by", "by-sa"];
const LICENCE: Record<string, string> = { cc0: "CC0", pdm: "Public domain", by: "CC BY", "by-sa": "CC BY-SA" };

export async function freeImage(query: string, used: Set<string>) {
  const q = query.split(/\s+/).join(" ").slice(0, 200);
  if (!q) return null;
  let results: any[] = [];
  try {
    const { body } = await safeGet(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=${FREE.join(",")}&page_size=10&mature=false&extension=jpg,jpeg,png`, "application/json", 1_000_000);
    results = JSON.parse(body.toString("utf8")).results || [];
  } catch {
    return null;
  }
  for (const item of results) {
    if (!FREE.includes(item.license) || !safeUrl(item.url) || used.has(item.url) || (item.width && item.width < 500)) continue;
    for (const address of [item.url, item.thumbnail].filter(Boolean)) {
      try {
        const { contentType, body } = await safeGet(address, "image/*", 6 * 1024 * 1024, 10_000);
        if (!/^image\/(jpeg|png)/.test(contentType)) continue;
        used.add(item.url);
        let licence = LICENCE[item.license] || item.license.toUpperCase();
        if (!["cc0", "pdm"].includes(item.license) && item.license_version) licence += ` ${item.license_version}`;
        const source = ({ wikimedia: "Wikimedia Commons", flickr: "Flickr" } as Record<string, string>)[item.source] || item.source || "";
        const credit = `${item.title ? `“${String(item.title).slice(0, 200)}”` : "Image"}${item.creator ? ` by ${String(item.creator).slice(0, 120)}` : ""}, ${licence}${source ? `, via ${source}` : ""}${item.foreign_landing_url ? ` (${item.foreign_landing_url})` : ""}.`;
        return { source: "free", data: body, mime: contentType.split(";")[0], credit, license: item.license, origin: item.foreign_landing_url || item.url, query: q, width: item.width, height: item.height };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** A chart or diagram drawn as SVG. Charts are drawn only from numbers stated in `corpus`. */
export function drawnFigure(plan: any, corpus: string) {
  try {
    if (plan.type === "chart") {
      const spec = checkChart(plan.chart, corpus);
      return { source: "chart", svg: chartSvg(spec), spec, credit: "Chart drawn for this work from figures reported in the text (no third-party copyright).", width: 760, height: 480 };
    }
    const spec = checkDiagram(plan.diagram);
    return { source: "diagram", svg: diagramSvg(spec), spec, credit: "Diagram drawn for this work (no third-party copyright).", width: 760, height: 480 };
  } catch (error) {
    if (error instanceof FigureSpecError && plan.type === "chart" && plan.diagram) {
      try {
        const spec = checkDiagram(plan.diagram);
        return { source: "diagram", svg: diagramSvg(spec), spec, credit: "Diagram drawn for this work (no third-party copyright).", width: 760, height: 480 };
      } catch {
        return null;
      }
    }
    if (error instanceof FigureSpecError) return null;
    throw error;
  }
}

export function corpusOf(project: any) {
  const draft = project.draft || {};
  const texts = [...(draft.sections || []), ...(draft.chapters || []).flatMap((c: any) => c.sections || [])].flatMap((s: any) => s.paragraphs || []);
  return [...texts, ...(draft.abstract || []).map((a: any) => a.text), ...(project.sources || []).map((s: any) => s.text)].join("\n");
}

export { ApiError };
