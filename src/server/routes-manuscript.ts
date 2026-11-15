import type { ObjectId } from "mongodb";
import { json, textField, type Route } from "./app";
import { col, now, pack, toObjectId, unpack } from "./db";
import { config, envNumber } from "./env";
import { AppError, ConfigError, redact } from "./errors";
import { ownsFile, publicFileUrl, storeBuffer } from "./files";
import { publicWork, searchAll, type Work } from "./research";
import { corpusOf, drawnFigure, freeImage, lookupBook, readJournal, readRepo, readSourceUrl } from "./sources";
import { aiRun, usageForIds, usageJson } from "./usage";
import {
  ARTICLE_TYPES, BOOK_TYPES, VOICES, finishBook, finishManuscript, outlineBook, planManuscript, researchQueries, review, revise, suggestFigures,
  writeChapter, writeManuscriptPart,
} from "./writer";
import { STYLES, wordsIn } from "../shared/render";
import { checkChart, chartSvg } from "../shared/charts";

// Manuscript Writer and Book Writer. The browser drives the writing one step at a time
// (POST /step), so no request runs longer than a lite-model call or two.

const PLAIN = ["user_id", "mode", "status", "title", "created_at", "updated_at", "word_count", "figure_keys", "type_label", "voice", "locked_until"];
const SECTIONS_PER_CALL = 2;
const MAX_SOURCES_CHARS = 80_000;

const PAGE_SIZES: Record<string, [number, number]> = {
  a4: [210, 297], a5: [148, 210], b5: [176, 250], letter: [216, 279], "6x9": [152, 229], "5.5x8.5": [140, 216], "5x8": [127, 203], royal: [156, 234], crown: [189, 246],
};
const FONTS = ["Times New Roman", "Georgia", "Garamond", "Palatino Linotype", "Cambria", "Book Antiqua", "Source Serif 4", "Arial"];

const clampNumber = (value: unknown, low: number, high: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};
const pick = (value: unknown, allowed: string[] | Record<string, unknown>, fallback: string) => {
  const keys = Array.isArray(allowed) ? allowed : Object.keys(allowed);
  return typeof value === "string" && keys.includes(value) ? value : fallback;
};
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Page layout: book name, page size, margins, page numbers... Used by the preview, DOCX and print. */
export function layoutOptions(raw: any, mode: string) {
  const r = raw && typeof raw === "object" ? raw : {};
  const book = mode === "book";
  return {
    page_size: pick(r.page_size, PAGE_SIZES, book ? "6x9" : "a4"),
    page_width_mm: clampNumber(r.page_width_mm, 90, 300, 0), page_height_mm: clampNumber(r.page_height_mm, 120, 420, 0),
    margin_top: clampNumber(r.margin_top, 5, 60, book ? 20 : 25), margin_bottom: clampNumber(r.margin_bottom, 5, 60, book ? 20 : 25),
    margin_inside: clampNumber(r.margin_inside, 5, 60, book ? 22 : 25), margin_outside: clampNumber(r.margin_outside, 5, 60, book ? 16 : 25),
    gutter: clampNumber(r.gutter, 0, 30, 0), mirror_margins: flag(r.mirror_margins, book),
    page_number_start: Math.round(clampNumber(r.page_number_start, 0, 9999, 1)),
    page_number_position: pick(r.page_number_position, ["bottom-center", "bottom-outside", "top-outside", "top-center", "none"], "bottom-center"),
    front_matter_roman: flag(r.front_matter_roman, book),
    font: pick(r.font, FONTS, book ? "Georgia" : "Times New Roman"), font_size: clampNumber(r.font_size, 8, 16, book ? 11 : 12),
    line_spacing: clampNumber(r.line_spacing, 1, 2.5, book ? 1.4 : 2), paragraph_indent: flag(r.paragraph_indent, book),
    chapter_start: pick(r.chapter_start, ["new-page", "odd-page", "continuous"], book ? "odd-page" : "continuous"),
    running_headers: flag(r.running_headers, book), drop_caps: flag(r.drop_caps, false), line_numbers: flag(r.line_numbers, !book),
    title_page: flag(r.title_page, book), copyright_page: flag(r.copyright_page, book), toc: flag(r.toc, book), justify: flag(r.justify, book),
  };
}

function projectOptions(raw: any, mode: string) {
  const r = raw && typeof raw === "object" ? raw : {};
  const topic = String(r.topic || "").split(/\s+/).join(" ").trim().slice(0, 1500);
  if (!topic) throw new ConfigError(mode === "book" ? "Enter the book's topic." : "Enter the manuscript's topic.");
  const common = {
    topic, brief: String(r.brief || "").trim().slice(0, 4000), voice: pick(r.voice, VOICES, "researcher"), authors: String(r.authors || "").slice(0, 2000),
    style: pick(r.style, STYLES, mode === "book" ? "apa" : "vancouver"), from: String(r.from || "").slice(0, 10), to: String(r.to || "").slice(0, 10),
    layout: layoutOptions(r.layout, mode),
  };
  if (mode === "book") {
    return {
      ...common, book_name: String(r.book_name || "").trim().slice(0, 200), subtitle: String(r.subtitle || "").trim().slice(0, 300),
      publisher: String(r.publisher || "").slice(0, 200), edition: String(r.edition || "").slice(0, 60), isbn: String(r.isbn || "").replace(/[^\dXx-]/g, "").slice(0, 20),
      year: String(r.year || new Date().getFullYear()).slice(0, 4), book_type: pick(r.book_type, BOOK_TYPES, "academic"), audience: String(r.audience || "").slice(0, 200),
      chapters: Math.round(clampNumber(r.chapters, 3, 20, 8)), words_per_chapter: Math.round(clampNumber(r.words_per_chapter, 800, 5000, 2500)),
      preface: flag(r.preface, true), introduction: flag(r.introduction, false), conclusion: flag(r.conclusion, true), glossary: flag(r.glossary, true),
      learning_objectives: flag(r.learning_objectives, r.book_type === "textbook"), key_points: flag(r.key_points, true), chapter_summary: flag(r.chapter_summary, true),
      review_questions: flag(r.review_questions, r.book_type === "textbook"), case_studies: flag(r.case_studies, false), key_terms: flag(r.key_terms, true),
      references_placement: pick(r.references_placement, ["book", "chapter"], "book"), dedication: String(r.dedication || "").slice(0, 600),
    };
  }
  return {
    ...common, type: pick(r.type, ARTICLE_TYPES, "original"), length: pick(r.length, ["short", "standard", "long"], "standard"),
    journal_url: typeof r.journal_url === "string" && /^https?:\/\//.test(r.journal_url.trim()) ? r.journal_url.trim().slice(0, 1000) : "",
    figures: pick(r.figures, ["auto", "charts", "free", "none"], "auto"), figure_count: Math.round(clampNumber(r.figure_count, 1, 4, 2)),
  };
}

function cleanSources(raw: unknown) {
  let total = 0;
  const sources: any[] = [];
  for (const s of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    if (!s || typeof s !== "object" || typeof s.text !== "string" || !s.text.trim()) continue;
    const text = s.text.slice(0, Math.max(0, Math.min(40_000, MAX_SOURCES_CHARS - total)));
    if (!text) break;
    total += text.length;
    sources.push({ kind: String(s.kind || "text").slice(0, 20), label: String(s.label || "Material").slice(0, 160), text, url: typeof s.url === "string" ? s.url.slice(0, 1000) : "" });
  }
  return sources;
}

async function owned(userId: ObjectId, id: string) {
  const objectId = toObjectId(id);
  const doc = objectId ? await (await col("manuscripts")).findOne({ _id: objectId, user_id: userId }) : null;
  if (!doc) throw new ConfigError(`That project wasn't found. Projects are kept ${envNumber("MANUSCRIPT_DAYS", 30, 1)} days after their last change.`);
  return unpack(doc);
}

async function save(project: any) {
  project.updated_at = now();
  project.word_count = project.draft ? wordsIn(project.draft) : 0;
  project.figure_keys = (project.figures || []).map((f: any) => f.key).filter(Boolean);
  project.title = project.draft?.title || project.plan?.title || project.title;
  await (await col("manuscripts")).replaceOne({ _id: project._id, user_id: project.user_id }, pack(project, PLAIN));
}

function totalSteps(project: any) {
  const parts = project.mode === "book" ? (project.plan?.chapters?.length || project.options.chapters)
    : Math.ceil((project.plan?.outline?.length || 6) / SECTIONS_PER_CALL);
  const figures = project.mode !== "book" && project.options.figures !== "none" ? 1 : 0;
  return (project.options.journal_url ? 1 : 0) + 1 + parts + 1 + figures;
}

function stepLabel(project: any) {
  const stage = project.stage;
  if (stage === "journal") return "Reading the journal's author guidelines";
  if (stage === "plan") return project.mode === "book" ? "Planning the chapters" : "Planning the manuscript";
  if (stage === "write") {
    if (project.mode === "book") return `Writing chapter ${(project.cursor || 0) + 1} of ${project.plan.chapters.length}: ${project.plan.chapters[project.cursor || 0]?.title || ""}`;
    const outline = project.plan.outline;
    return `Writing ${outline.slice(project.cursor || 0, (project.cursor || 0) + SECTIONS_PER_CALL).map((s: any) => s.heading).join(" and ")}`;
  }
  if (stage === "finish") return project.mode === "book" ? "Writing the preface, conclusion and glossary" : "Writing the abstract, tables and declarations";
  if (stage === "figures") return "Drawing the figures";
  return "";
}

export function projectJson(project: any, origin: string, usage: any[] = []) {
  const figures = (project.figures || []).map((f: any, i: number) => ({ ...f, number: i + 1, image: f.key ? publicFileUrl(origin, f.key, 6) : null }));
  return {
    id: String(project._id), mode: project.mode, status: project.status, stage: project.stage, title: project.title || "", options: project.options,
    progress: { done: project.steps_done || 0, total: project.status === "ready" ? project.steps_done || 0 : totalSteps(project), label: project.status === "writing" ? stepLabel(project) : "" },
    error: project.error || null, hint: project.hint || null, warnings: project.warnings || [],
    sources: (project.sources || []).map((s: any) => ({ kind: s.kind, label: s.label, url: s.url || "", chars: (s.text || "").length })),
    references: project.references || [], plan: project.plan || null, journal: project.plan?.journal || null, draft: project.draft || null, figures,
    style: project.options.style, review: project.review || null, can_undo: Boolean(project.previous),
    revisions: (project.revisions || []).map((r: any) => ({ note: r.note, at: r.at ? new Date(r.at).toISOString() : null })),
    usage: usage.map(usageJson), word_count: project.word_count || 0, updated_at: new Date(project.updated_at).toISOString(),
  };
}

async function respond(project: any, origin: string) {
  const ids = (project.usage_ids || []).map(toObjectId).filter(Boolean) as ObjectId[];
  return projectJson(project, origin, await usageForIds(project.user_id, ids));
}

/** Add each figure's sentence to the end of its section, with the figure's real number. */
function addMentions(draft: any, placed: [number, any][]) {
  const sections = (draft.sections || []).map((s: any) => ({ ...s, paragraphs: [...s.paragraphs] }));
  for (const [number, plan] of placed) {
    let sentence = String(plan.mention || "").replace(/\bFig(?:ure)?\.?\s*(?:\d+|N|X)\b/g, `Figure ${number}`);
    if (!sentence) continue;
    if (!sentence.includes(`Figure ${number}`)) sentence = `${sentence.replace(/\.$/, "")} (Figure ${number}).`;
    const wanted = String(plan.after || "").toLowerCase().split(/\s+/).join(" ");
    let target = sections.find((s: any) => s.heading.toLowerCase().split(/\s+/).join(" ") === wanted && s.paragraphs.length);
    if (!target) target = [...sections].reverse().find((s: any) => s.paragraphs.length && !/^(conclusions?|summary)\b/i.test(s.heading));
    if (target) {
      target.paragraphs[target.paragraphs.length - 1] = `${target.paragraphs[target.paragraphs.length - 1].trimEnd()} ${sentence.trim()}`;
      plan.after = target.heading;
    }
  }
  return { ...draft, sections };
}

function renumberFigures(draft: any, removed: number) {
  const fix = (text: string) => text.replace(new RegExp(`\\s*\\((?:see )?Fig(?:ure)?\\.?\\s+${removed}\\)`, "g"), "")
    .replace(/\b(Fig(?:ure)?s?\.?)\s+(\d+)\b/g, (whole, label, n) => (Number(n) > removed ? `${label} ${Number(n) - 1}` : whole));
  const sections = (list: any[]) => list.map((s) => ({ ...s, paragraphs: s.paragraphs.map(fix) }));
  return draft.chapters ? { ...draft, chapters: draft.chapters.map((c: any) => ({ ...c, sections: sections(c.sections || []) })) } : { ...draft, sections: sections(draft.sections || []) };
}

async function makeFigure(userId: ObjectId, plan: any, corpus: string, used: Set<string>) {
  if (plan.type === "chart" || plan.type === "diagram") {
    const drawn = drawnFigure(plan, corpus);
    return drawn ? { ...drawn, caption: plan.caption, after: plan.after || "" } : null;
  }
  const image = plan.search ? await freeImage(plan.search, used) : null;
  if (!image) return null;
  const key = await storeBuffer(userId, "image", image.mime, image.data, "figure");
  return { source: "free", key, caption: plan.caption, after: plan.after || "", credit: image.credit, license: image.license, origin: image.origin, width: image.width, height: image.height };
}

/** One step of writing. Returns after one stage. */
async function runStep(project: any, origin: string) {
  const stage = project.stage;
  if (stage === "journal") {
    try {
      const journal = await readJournal(project.options.journal_url);
      project.journal_text = journal.text;
      project.warnings = [...(project.warnings || []), ...journal.warnings];
    } catch (error: any) {
      project.warnings = [...(project.warnings || []), `The journal's site couldn't be read, so general conventions were used: ${error.message}`];
    }
    project.stage = "plan";
    return;
  }
  if (stage === "plan") {
    project.plan = project.mode === "book" ? await outlineBook(project) : await planManuscript(project, project.journal_text || "");
    if (project.mode !== "book" && project.plan.journal?.reference_style && !project.options.style_chosen) project.options.style = project.plan.journal.reference_style;
    project.draft = project.mode === "book"
      ? { title: project.plan.title, subtitle: project.plan.subtitle, chapters: [] }
      : { title: project.plan.title, sections: [] };
    project.cursor = 0;
    project.stage = "write";
    return;
  }
  if (stage === "write") {
    if (project.mode === "book") {
      const chapter = await writeChapter(project, project.cursor);
      project.draft.chapters[project.cursor] = chapter;
      project.cursor += 1;
      if (project.cursor >= project.plan.chapters.length) project.stage = "finish";
    } else {
      const indices = Array.from({ length: SECTIONS_PER_CALL }, (_, i) => project.cursor + i).filter((i) => i < project.plan.outline.length);
      const sections = await writeManuscriptPart(project, indices);
      project.draft.sections.push(...sections);
      project.cursor += indices.length;
      if (project.cursor >= project.plan.outline.length) project.stage = "finish";
    }
    return;
  }
  if (stage === "finish") {
    if (project.mode === "book") {
      Object.assign(project.draft, await finishBook(project));
      project.stage = "done";
    } else {
      const finished = await finishManuscript(project);
      const { figure_plans, ...rest } = finished;
      Object.assign(project.draft, rest);
      project.figure_plans = figure_plans;
      project.stage = project.options.figures === "none" || !figure_plans.length ? "done" : "figures";
    }
    return;
  }
  if (stage === "figures") {
    const corpus = corpusOf(project);
    const used = new Set<string>((project.figures || []).map((f: any) => f.origin).filter(Boolean));
    const placed: [number, any][] = [];
    project.figures = project.figures || [];
    for (const plan of project.figure_plans || []) {
      if (project.options.figures === "charts" && plan.type === "image") continue;
      if (project.options.figures === "free" && plan.type !== "image") continue;
      try {
        const figure = await makeFigure(project.user_id, plan, corpus, used);
        if (figure) {
          project.figures.push(figure);
          placed.push([project.figures.length, plan]);
        }
      } catch (error) {
        console.warn("A planned figure failed:", redact(error));
      }
    }
    project.draft = addMentions(project.draft, placed);
    placed.forEach(([n, plan]) => (project.figures[n - 1].after = plan.after));
    const missing = (project.figure_plans || []).length - placed.length;
    if (missing > 0) project.warnings = [...(project.warnings || []), `${missing} planned figure(s) couldn't be made (no free image, or a chart whose numbers aren't stated in the text). Add figures below.`];
    project.stage = "done";
  }
}

const isoRange = (value: string) => (/^\d{4}(-\d{2}-\d{2})?$/.test(value || "") ? value : "");

export const routes: Route[] = [
  ["POST", "/api/research", "user", async ({ body, user }) => {
    const data = await body();
    const topic = String(data.topic || "").split(/\s+/).join(" ").trim().slice(0, 1500);
    if (!topic) throw new ConfigError("Enter the topic to research.");
    const range = { from: isoRange(String(data.from || "")), to: isoRange(String(data.to || "")) };
    if (range.from && range.to && range.from > range.to) throw new ConfigError("The start date must be before the end date.");
    const mode = data.mode === "book" ? "book" : "manuscript";
    let queries = [topic.slice(0, 200)];
    let usage = null;
    if (config.geminiKey()) {
      try {
        const [more, run] = await aiRun(user._id, "manuscript", `Research queries: ${topic.slice(0, 80)}`, () => researchQueries(topic, mode));
        queries = [...new Set([topic.slice(0, 200), ...more])];
        usage = run;
      } catch (error) {
        console.warn("Research queries failed, using the topic:", redact(error));
      }
    }
    const works = await searchAll(queries, topic, range, { books: mode === "book" || data.books === true, limit: 100 });
    if (!works.length) throw new ConfigError("Nothing was found for that topic and those dates.", "Try broader words or a wider date range.");
    const doc = { user_id: user._id, created_at: now(), topic, range, works };
    const result = await (await col("research")).insertOne(pack(doc, ["user_id", "created_at"]));
    return { research_id: String(result.insertedId), results: works.map(publicWork), usage };
  }],
  ["POST", "/api/sources/read", "user", async ({ body }) => {
    const data = await body();
    if (data.book) return lookupBook(String(data.book));
    const url = textField(data, "url") || "";
    return /github\.com\//i.test(url) ? readRepo(url) : readSourceUrl(url);
  }],
  ["GET", "/api/manuscripts", "user", async ({ user }) => {
    const docs = await (await col("manuscripts")).find({ user_id: user._id }, { projection: { z: 0 } }).sort({ updated_at: -1 }).limit(60).toArray();
    return { manuscripts: docs.map((d) => ({ id: String(d._id), mode: d.mode, title: d.title || "", status: d.status, type_label: d.type_label, word_count: d.word_count || 0, updated_at: new Date(d.updated_at).toISOString() })),
      keep_days: envNumber("MANUSCRIPT_DAYS", 30, 1) };
  }],
  ["POST", "/api/manuscripts", "user", async ({ body, user, origin }) => {
    const data = await body();
    const mode = data.mode === "book" ? "book" : "manuscript";
    const options: any = projectOptions(data.options, mode);
    options.style_chosen = Boolean(data.options?.style_chosen);
    const sources = cleanSources(data.sources);
    let works: Work[] = [];
    const researchId = toObjectId(data.research_id);
    if (researchId) {
      const research = await (await col("research")).findOne({ _id: researchId, user_id: user._id });
      const wanted = new Set(Array.isArray(data.selected) ? data.selected.filter((id: unknown) => typeof id === "string") : []);
      if (research) works = unpack(research).works.filter((w: Work) => wanted.has(w.id!));
    }
    const extra = (Array.isArray(data.extra_references) ? data.extra_references : []).slice(0, 20).filter((r: any) => r && typeof r.title === "string");
    const references = [...works, ...extra].slice(0, 120).map((ref: any, i: number) => ({ ...ref, id: `R${i + 1}` }));
    if (!references.length && !sources.length && !options.brief) throw new ConfigError("Select some research titles or add proof material first.");
    const project: any = {
      user_id: user._id, mode, status: "writing", stage: options.journal_url && mode !== "book" ? "journal" : "plan", steps_done: 0, title: options.book_name || options.topic.slice(0, 120),
      type_label: mode === "book" ? "Book" : ARTICLE_TYPES[options.type].label, voice: options.voice, options, sources, references, warnings: [], usage_ids: [],
      revisions: [], created_at: now(), updated_at: now(), locked_until: new Date(0), figures: [],
    };
    const result = await (await col("manuscripts")).insertOne(pack(project, PLAIN));
    project._id = result.insertedId;
    return json(await respond(project, origin), 201);
  }],
  ["GET", "/api/manuscript/:id", "user", async ({ params, user, origin }) => respond(await owned(user._id, params.id), origin)],
  ["POST", "/api/manuscript/:id/step", "user", async ({ params, user, origin }) => {
    const projects = await col("manuscripts");
    const id = toObjectId(params.id);
    const claimed = id ? await projects.findOneAndUpdate({ _id: id, user_id: user._id, status: { $in: ["writing", "failed"] }, locked_until: { $lt: new Date() } },
      { $set: { locked_until: new Date(Date.now() + 58_000), status: "writing" } }, { returnDocument: "after" }) : null;
    if (!claimed) return respond(await owned(user._id, params.id), origin);
    const project = unpack(claimed);
    project.error = null;
    project.hint = null;
    try {
      const [, usage] = await aiRun(user._id, "manuscript", `${project.mode === "book" ? "Book" : "Manuscript"}: ${stepLabel(project) || project.stage}`.slice(0, 200), () => runStep(project, origin));
      if (usage) project.usage_ids = [...(project.usage_ids || []), usage.id];
      project.steps_done = (project.steps_done || 0) + 1;
      if (project.stage === "done") {
        project.status = "ready";
        project.revisions = [{ note: "First draft", at: now() }];
      }
    } catch (error: any) {
      project.status = "failed";
      project.error = error instanceof AppError ? error.message : "Something went wrong while writing.";
      project.hint = error instanceof AppError ? error.hint : "Try again: writing continues from where it stopped.";
      if (!(error instanceof AppError)) console.error("Writing step crashed:", redact(error?.stack || error));
    }
    project.locked_until = new Date(0);
    await save(project);
    return respond(project, origin);
  }],
  ["PUT", "/api/manuscript/:id", "user", async ({ params, body, user, origin }) => {
    const project = await owned(user._id, params.id);
    if (project.status === "writing") throw new ConfigError("Wait until writing finishes.");
    const data = await body();
    if (data.draft && typeof data.draft === "object") {
      const size = JSON.stringify(data.draft).length;
      if (size > 3_000_000) throw new ConfigError("The text is too long to save.");
      project.draft = data.draft;
    }
    if (data.layout) project.options.layout = layoutOptions(data.layout, project.mode);
    if (typeof data.style === "string" && data.style in STYLES) project.options.style = data.style;
    for (const key of ["book_name", "subtitle", "authors", "publisher", "edition", "isbn", "year", "dedication"]) {
      if (typeof data[key] === "string") project.options[key] = data[key].slice(0, key === "authors" || key === "dedication" ? 2000 : 300);
    }
    if (Array.isArray(data.figures)) {
      // Captions and placement edited by the author; images and drawings stay as they were.
      project.figures = (project.figures || []).map((f: any, i: number) => ({ ...f, caption: String(data.figures[i]?.caption ?? f.caption).slice(0, 600),
        after: String(data.figures[i]?.after ?? f.after ?? "").slice(0, 200), chapter: Number.isInteger(data.figures[i]?.chapter) ? data.figures[i].chapter : f.chapter }));
    }
    await save(project);
    return respond(project, origin);
  }],
  ["POST", "/api/manuscript/:id/revise", "user", async ({ params, body, user, origin }) => {
    const project = await owned(user._id, params.id);
    if (project.status !== "ready" || !project.draft) throw new ConfigError("Wait until the first draft is written.");
    const data = await body();
    const chapter = project.mode === "book" ? Math.round(clampNumber(data.chapter, 0, (project.draft.chapters || []).length - 1, 0)) : null;
    const [result, usage] = await aiRun(user._id, "manuscript", `Revision: ${String(data.instruction || "").slice(0, 80)}`, () => revise(project, String(data.instruction || ""), chapter));
    project.previous = { draft: project.draft };
    project.draft = project.mode === "book"
      ? { ...project.draft, chapters: project.draft.chapters.map((c: any, i: number) => (i === chapter ? { ...c, sections: result.sections } : c)) }
      : { ...project.draft, sections: result.sections };
    project.revisions = [...(project.revisions || []).slice(-19), { note: result.note || String(data.instruction).slice(0, 300), at: now() }];
    if (usage) project.usage_ids = [...(project.usage_ids || []), usage.id];
    await save(project);
    return respond(project, origin);
  }],
  ["POST", "/api/manuscript/:id/undo", "user", async ({ params, user, origin }) => {
    const project = await owned(user._id, params.id);
    if (!project.previous) throw new ConfigError("There is no earlier version to go back to.");
    project.draft = project.previous.draft;
    project.previous = null;
    project.revisions = (project.revisions || []).slice(0, -1);
    await save(project);
    return respond(project, origin);
  }],
  ["POST", "/api/manuscript/:id/review", "user", async ({ params, user, origin }) => {
    const project = await owned(user._id, params.id);
    if (!project.draft) throw new ConfigError("Write the draft first.");
    const [result, usage] = await aiRun(user._id, "manuscript", `Quality review: ${project.title.slice(0, 80)}`, () => review(project));
    project.review = { ...result, at: now() };
    if (usage) project.usage_ids = [...(project.usage_ids || []), usage.id];
    await save(project);
    return respond(project, origin);
  }],
  ["POST", "/api/manuscript/:id/figures", "user", async ({ params, body, user, origin }) => {
    const project = await owned(user._id, params.id);
    if (!project.draft) throw new ConfigError("Write the draft first.");
    if ((project.figures || []).length >= 30) throw new ConfigError("This project already has the most figures allowed.");
    const data = await body();
    const caption = String(data.caption || "").split(/\s+/).join(" ").slice(0, 600);
    const after = String(data.after || "").slice(0, 200);
    const chapter = Number.isInteger(data.chapter) ? data.chapter : null;
    let figure: any = null;
    let usage: any = null;
    if (data.source === "data") {
      const spec = checkChart(data.spec, null);
      figure = { source: "data", svg: chartSvg(spec), spec, credit: String(data.credit || "Drawn from the authors' data.").slice(0, 300), width: 760, height: 480 };
    } else if (data.source === "upload") {
      if (!(await ownsFile(user._id, data.key))) throw new ConfigError("Upload the image first.");
      const credit = String(data.credit || "").trim().slice(0, 300);
      if (!credit) throw new ConfigError('Say where the image comes from and its licence, for example "Photo by the authors".');
      figure = { source: "upload", key: data.key, credit, license: "own" };
    } else if (data.source === "free") {
      const description = String(data.description || "").trim().slice(0, 300);
      if (!description) throw new ConfigError("Describe what the image should show.");
      figure = await makeFigure(user._id, { type: "image", search: description, caption: caption || description, after }, "", new Set((project.figures || []).map((f: any) => f.origin)));
      if (!figure) throw new ConfigError("No openly licensed image was found for that.", "Try other words: what the picture shows.");
    } else {
      const description = String(data.description || "").trim().slice(0, 300);
      if (!description) throw new ConfigError("Describe what the chart or diagram should show.");
      const [plans, run] = await aiRun(user._id, "manuscript", `Figure: ${description.slice(0, 80)}`, () => suggestFigures(
        project.mode === "book" ? { ...project, draft: { title: project.draft.title, sections: project.draft.chapters?.[chapter ?? 0]?.sections || [] } } : project, 1, `${description} (as a ${data.source === "chart" ? "chart" : "diagram"})`));
      usage = run;
      const plan = { ...plans[0], type: data.source === "chart" ? "chart" : "diagram" };
      figure = drawnFigure(plan, corpusOf(project)) || (plan.diagram ? drawnFigure({ ...plan, type: "diagram" }, "") : null);
      if (!figure) throw new ConfigError("That figure couldn't be drawn.", "Charts need numbers stated in the text. Try a diagram, or add a chart from your own data.");
      if (!caption) figure.caption = plan.caption;
      if (project.mode !== "book" && plan.mention) project.draft = addMentions(project.draft, [[(project.figures || []).length + 1, { ...plan, after: after || plan.after }]]);
      figure.after = after || plan.after;
    }
    figure.caption = caption || figure.caption || "";
    figure.after = figure.after || after;
    if (chapter !== null) figure.chapter = chapter;
    project.figures = [...(project.figures || []), figure];
    if (usage) project.usage_ids = [...(project.usage_ids || []), usage.id];
    await save(project);
    return json(await respond(project, origin), 201);
  }],
  ["DELETE", "/api/manuscript/:id/figures/:n", "user", async ({ params, user, origin }) => {
    const project = await owned(user._id, params.id);
    const index = Number(params.n) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= (project.figures || []).length) throw new ConfigError("That figure wasn't found.");
    project.figures.splice(index, 1);
    project.draft = renumberFigures(project.draft, index + 1);
    await save(project);
    return respond(project, origin);
  }],
  ["DELETE", "/api/manuscript/:id", "user", async ({ params, user }) => {
    const project = await owned(user._id, params.id);
    const { deleteFiles } = await import("./files");
    await deleteFiles(project.figure_keys || []);
    await (await col("manuscripts")).deleteOne({ _id: project._id, user_id: user._id });
    return { deleted: true };
  }],
];
