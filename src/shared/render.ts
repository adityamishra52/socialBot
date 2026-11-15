// Citations and reference lists, shared by the server and the live preview in the browser.
// The draft cites references by id ([R3]); rendering turns ids into numbers or author-date
// citations in the chosen style and builds the list from the records' real metadata.

export const STYLES: Record<string, string> = {
  vancouver: "Vancouver (numbered)", ama: "AMA (numbered)", ieee: "IEEE (numbered)", apa: "APA 7 (author-date)",
  harvard: "Harvard (author-date)", chicago: "Chicago author-date", mla: "MLA 9",
};
export const NUMBERED = ["vancouver", "ama", "ieee"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const CITE = /\[\s*(R\d+(?:\s*[,;–-]\s*R?\d+)*)\s*\]/g;
export const PLACEHOLDER = /\[\[([^[\]\n]{1,200})\]\]/g;

export interface Person { family: string; given?: string }
export interface Reference {
  id: string; kind?: string; title: string; authors?: Person[]; journal?: string; publisher?: string; year?: string; month?: number;
  volume?: string; issue?: string; pages?: string; doi?: string; url?: string; isbn?: string; abstract?: string; open_access?: boolean;
}

export function citedIds(group: string): string[] {
  const ids: string[] = [];
  for (const piece of group.split(/\s*[,;]\s*/)) {
    const span = /^R?(\d+)\s*[–-]\s*R?(\d+)$/.exec(piece.trim());
    if (span) {
      const first = Number(span[1]);
      const last = Math.min(Number(span[2]), first + 30);
      for (let n = first; n <= last; n += 1) ids.push(`R${n}`);
    } else if (/^R\d+$/.test(piece.trim())) ids.push(piece.trim());
  }
  return [...new Set(ids)];
}

const initials = (given = "", dots: boolean) => given.split(/[\s-]+/).filter((p) => /^\p{L}/u.test(p)).map((p) => (dots ? `${p[0]}.` : p[0])).join(dots ? " " : "");

function authorList(ref: Reference, style: string): string {
  const people = ref.authors || [];
  if (!people.length) return "";
  if (style === "vancouver" || style === "ama") {
    const names = people.map((p) => `${p.family} ${initials(p.given, false)}`.trim());
    return names.length > 6 ? `${names.slice(0, 3).join(", ")}, et al` : names.join(", ");
  }
  if (style === "ieee") {
    const names = people.map((p) => `${initials(p.given, true)} ${p.family}`.trim());
    if (names.length > 6) return `${names[0]} et al.`;
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  if (style === "mla") {
    const first = `${people[0].family}${people[0].given ? `, ${people[0].given}` : ""}`;
    if (people.length === 1) return first;
    if (people.length === 2) return `${first}, and ${people[1].given ? `${people[1].given} ` : ""}${people[1].family}`;
    return `${first}, et al.`;
  }
  const names = people.map((p) => `${p.family}, ${initials(p.given, true)}`.trim().replace(/,$/, ""));
  if (style === "apa") {
    if (names.length > 20) return [...names.slice(0, 19), "...", names[names.length - 1]].join(", ");
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  }
  if (style === "chicago") {
    if (names.length > 10) return `${names.slice(0, 7).join(", ")}, et al.`;
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  }
  if (names.length > 3) return `${names[0]} et al.`;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function formatBook(ref: Reference, style: string, authors: string, title: string) {
  const year = ref.year || "", publisher = ref.publisher || "", doi = ref.doi || "", isbn = ref.isbn || "";
  if (style === "vancouver" || style === "ama") {
    const shown = style === "ama" ? `*${title}*` : title;
    return `${authors ? `${authors}. ` : ""}${shown}. ${publisher ? `${publisher}; ` : ""}${year}.` + (doi ? ` doi:${doi}` : isbn ? ` ISBN: ${isbn}` : "");
  }
  if (style === "ieee") return `${authors ? `${authors}, ` : ""}*${title}*. ${publisher ? `${publisher}, ` : ""}${year}.` + (doi ? ` doi: ${doi}.` : isbn ? ` ISBN: ${isbn}.` : "");
  if (style === "mla") return `${authors ? `${authors}. ` : ""}*${title}*. ${publisher ? `${publisher}, ` : ""}${year}.`;
  const yearPart = `(${year || "n.d."})`;
  if (style === "apa") return `${authors ? `${authors} ${yearPart}. *${title}*.` : `*${title}*. ${yearPart}.`}${publisher ? ` ${publisher}.` : ""}` + (doi ? ` https://doi.org/${doi}` : "");
  if (style === "chicago") return `${authors ? `${authors}. ${year || "n.d."}. *${title}*.` : `*${title}*. ${year || "n.d."}.`}${publisher ? ` ${publisher}.` : ""}` + (doi ? ` https://doi.org/${doi}.` : "");
  return `${authors ? `${authors} ${yearPart} *${title}*.` : `*${title}* ${yearPart}.`}${publisher ? ` ${publisher}.` : ""}` + (doi ? ` doi:${doi}.` : "");
}

/** One reference in a style. *Asterisks* mark italics. */
export function formatReference(ref: Reference, style: string): string {
  const authors = authorList(ref, style);
  const title = ref.title.replace(/\.$/, "");
  const journal = ref.journal || "";
  const { year = "", volume = "", issue = "", pages = "", doi = "" } = ref;
  const dash = pages.replace(/-/g, "–");
  if (ref.kind === "book") return formatBook(ref, style, authors, title);
  const month = ref.kind === "magazine" && ref.month ? MONTHS[ref.month - 1] : "";
  const isArticle = ["article", "magazine", "preprint"].includes(ref.kind || "article") && journal;
  const url = ref.url || "";
  if (style === "vancouver" || style === "ama") {
    if (!isArticle) return `${authors ? `${authors}. ` : ""}${title} [Internet]. ${journal ? `${journal}. ` : ""}${year ? `${year}. ` : ""}Available from: ${url}`;
    let text = `${authors ? `${authors}. ` : ""}${title}. ${style === "ama" ? `*${journal}*` : journal}. ${year}`;
    text += month ? ` ${month.slice(0, 3)}` : "";
    text += volume ? `;${volume}` : "";
    text += issue ? `(${issue})` : "";
    text += pages ? `:${pages}` : "";
    return `${text}.${doi ? ` doi:${doi}` : ""}`;
  }
  if (style === "ieee") {
    if (!isArticle) return `${authors ? `${authors}, ` : ""}"${title}," ${journal ? `${journal}, ` : ""}${year ? `${year}. ` : ""}[Online]. Available: ${url}`;
    let text = `${authors ? `${authors}, ` : ""}"${title}," *${journal}*`;
    text += volume ? `, vol. ${volume}` : "";
    text += issue ? `, no. ${issue}` : "";
    text += pages ? (pages.includes("-") ? `, pp. ${dash}` : `, p. ${pages}`) : "";
    text += month ? `, ${month.slice(0, 3)}.` : "";
    text += year ? (month ? ` ${year}` : `, ${year}`) : "";
    return text + (doi ? `, doi: ${doi}.` : ".");
  }
  if (style === "mla") {
    if (!isArticle) return `${authors ? `${authors}. ` : ""}"${title}." ${journal ? `*${journal}*, ` : ""}${year ? `${year}, ` : ""}${url}.`;
    let text = `${authors ? `${authors}. ` : ""}"${title}." *${journal}*`;
    text += volume ? `, vol. ${volume}` : "";
    text += issue ? `, no. ${issue}` : "";
    text += year ? `, ${year}` : "";
    text += pages ? `, pp. ${dash}` : "";
    return `${text}.${doi ? ` https://doi.org/${doi}.` : ""}`;
  }
  if (style === "chicago") {
    const lead = authors ? `${authors}. ${year || "n.d."}.` : `${title}. ${year || "n.d."}.`;
    if (!isArticle) return `${lead}${authors ? ` "${title}."` : ""}${journal ? ` ${journal}.` : ""} ${url}.`;
    let text = `${lead}${authors ? ` "${title}."` : ""} *${journal}*`;
    text += volume ? ` ${volume}` : "";
    text += issue ? ` (${issue})` : "";
    text += pages ? `: ${dash}` : "";
    return `${text}.${doi ? ` https://doi.org/${doi}.` : ""}`;
  }
  const yearPart = `(${year || "n.d."}${month && style === "apa" ? `, ${month}` : ""})`;
  if (style === "apa") {
    const lead = authors ? `${authors} ${yearPart}. ` : `${title}. ${yearPart}. `;
    if (!isArticle) return `${lead}${authors ? `*${title}*. ` : ""}${journal ? `${journal}. ` : ""}${url}`;
    let text = `${lead}${authors ? `${title}. ` : ""}*${journal}*`;
    text += volume ? `, *${volume}*` : "";
    text += issue ? `(${issue})` : "";
    text += pages ? `, ${dash}` : "";
    return `${text}.${doi ? ` https://doi.org/${doi}` : ""}`;
  }
  const lead = authors ? `${authors} ${yearPart} ` : `${title} ${yearPart} `;
  if (!isArticle) return `${lead}${authors ? `*${title}*. ` : ""}Available at: ${url}`;
  let text = `${lead}${authors ? `'${title}', ` : ""}*${journal}*`;
  text += volume ? `, ${volume}` : "";
  text += issue ? `(${issue})` : "";
  text += pages ? `, pp. ${dash}` : "";
  return `${text}.${doi ? ` doi:${doi}.` : ""}`;
}

function inText(ref: Reference, style: string) {
  const people = ref.authors || [];
  const year = ref.year || "n.d.";
  if (!people.length) return `${ref.title.split(/\s+[-|–—]\s+/)[0].split(/\s+/).slice(0, 4).join(" ")}${style === "mla" ? "" : `, ${year}`}`;
  const names = people.length === 1 ? people[0].family
    : people.length === 2 ? `${people[0].family} ${style === "apa" ? "&" : "and"} ${people[1].family}` : `${people[0].family} et al.`;
  return style === "mla" ? names : `${names}${style === "chicago" ? " " : ", "}${year}`;
}

function compress(numbers: number[]) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  sorted.forEach((n, i) => {
    if (start === null) start = n;
    if (i + 1 === sorted.length || sorted[i + 1] !== n + 1) {
      parts.push(n === start ? `${start}` : n === start + 1 ? `${start},${n}` : `${start}–${n}`);
      start = null;
    }
  });
  return parts.join(",");
}

export function headingCase(text: string, kind: string) {
  if (kind === "upper") return text.toUpperCase();
  if (kind === "title") {
    const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with", "via", "vs"]);
    return text.split(" ").map((w, i) => ((i && small.has(w.toLowerCase())) || /^\p{Lu}/u.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  }
  return text;
}

export interface Section { heading: string; level?: number; paragraphs: string[] }

function place(sections: Section[], label: string, number: number, after: string) {
  const mention = new RegExp(`\\b${label}s?\\.?\\s+(?:\\d+\\s*(?:,|and|&|[–-])\\s*)*${number}\\b`, "i");
  let index = sections.findIndex((s) => s.paragraphs.some((p) => mention.test(p)));
  if (index >= 0) return index;
  const wanted = after.toLowerCase().split(/\s+/).join(" ");
  index = sections.findIndex((s) => wanted && s.heading.toLowerCase().split(/\s+/).join(" ") === wanted);
  if (index >= 0) return index;
  index = sections.findIndex((s, i) => i && /^(conclusions?|concluding|summary)\b/i.test(s.heading));
  return index > 0 ? index - 1 : sections.length - 1;
}

/** Citation numbering and formatting for a list of texts read in order. */
export function citer(refs: Reference[], style: string) {
  const byId = new Map(refs.map((r) => [r.id, r]));
  const order: string[] = [];
  const visit = (text: string) => {
    for (const match of String(text || "").matchAll(new RegExp(CITE.source, "g"))) {
      for (const id of citedIds(match[1])) if (byId.has(id) && !order.includes(id)) order.push(id);
    }
  };
  const fix = (text: string) => {
    const numbers = new Map(order.map((id, i) => [id, i + 1]));
    return String(text || "").replace(new RegExp(CITE.source, "g"), (_m, group) => {
      const ids = citedIds(group).filter((id) => numbers.has(id));
      if (!ids.length) return "";
      if (NUMBERED.includes(style)) return `[${compress(ids.map((id) => numbers.get(id)!))}]`;
      return `(${ids.map((id) => inText(byId.get(id)!, style)).join("; ")})`;
    }).replace(/\s+([.,;:])/g, "$1");
  };
  const list = () => {
    const cited = order.map((id) => byId.get(id)!);
    if (!NUMBERED.includes(style)) cited.sort((a, b) => ((a.authors?.[0]?.family || a.title).toLowerCase() + (a.year || "")).localeCompare((b.authors?.[0]?.family || b.title).toLowerCase() + (b.year || "")));
    return cited.map((r) => ({ text: formatReference(r, style), url: r.url || "", doi: r.doi || "", kind: r.kind || "article", open_access: Boolean(r.open_access), id: r.id }));
  };
  return { visit, fix, list, order };
}

/** A journal manuscript laid out in reading order: sections with their tables and figures, back matter, references last. */
export function renderManuscript(draft: any, refs: Reference[], style: string, figures: any[] = [], caseKind = "") {
  style = style in STYLES ? style : "vancouver";
  const sections: Section[] = draft?.sections || [];
  const tables: any[] = draft?.tables || [];
  const tableAt = tables.map((t, n) => place(sections, "table", n + 1, t.after || ""));
  const figureAt = figures.map((f, n) => place(sections, "fig(?:ure)?", n + 1, f.after || ""));
  const cite = citer(refs, style);
  sections.forEach((section, index) => {
    section.paragraphs.forEach(cite.visit);
    tables.forEach((t, n) => {
      if (tableAt[n] === index) [t.caption, ...t.rows.flat(), t.note].forEach(cite.visit);
    });
  });
  (draft?.declarations || []).forEach((d: any) => cite.visit(d.text));
  const body: any[] = [];
  sections.forEach((section, index) => {
    body.push({ type: "section", level: section.level || 1, heading: (section.level || 1) === 1 ? headingCase(section.heading, caseKind) : section.heading, paragraphs: section.paragraphs.map(cite.fix), index });
    tables.forEach((t, n) => {
      if (tableAt[n] === index) body.push({ type: "table", number: n + 1, caption: cite.fix(t.caption), columns: t.columns, rows: t.rows.map((r: string[]) => r.map(cite.fix)), note: cite.fix(t.note || "") });
    });
    figures.forEach((f, n) => {
      if (figureAt[n] === index) body.push({ type: "figure", number: n + 1, caption: f.caption || "", credit: f.credit || "", source: f.source || "", svg: f.svg || null, image: f.image || null, key: f.key || null, width: f.width, height: f.height });
    });
  });
  return {
    title: draft?.title || "", running_title: draft?.running_title || "", abstract: draft?.abstract || [], keywords: draft?.keywords || [],
    body, declarations: (draft?.declarations || []).map((d: any) => ({ ...d, text: cite.fix(d.text) })), author_notes: draft?.author_notes || [],
    references: cite.list(), style, word_count: wordsIn(draft),
  };
}

export function wordsIn(draft: any) {
  const sections = draft?.sections || [];
  const chapters = draft?.chapters || [];
  const count = (list: Section[]) => list.reduce((n, s) => n + s.paragraphs.reduce((m, p) => m + p.split(/\s+/).filter(Boolean).length, 0), 0);
  return count(sections) + chapters.reduce((n: number, c: any) => n + count(c.sections || []), 0);
}

/** A book laid out for the preview, DOCX and print: front matter, chapters, back matter and references. */
export function renderBook(book: any, refs: Reference[], style: string, options: any = {}) {
  style = style in STYLES ? style : "apa";
  const perChapter = options.references_placement === "chapter";
  const chapters: any[] = book?.chapters || [];
  const global = citer(refs, style);
  const rendered = chapters.map((chapter) => {
    const cite = perChapter ? citer(refs, style) : global;
    for (const s of chapter.sections || []) s.paragraphs.forEach(cite.visit);
    [chapter.case_study?.text, ...(chapter.key_points || []), chapter.summary].forEach((t) => t && cite.visit(t));
    return {
      ...chapter,
      sections: (chapter.sections || []).map((s: Section) => ({ ...s, paragraphs: s.paragraphs.map(cite.fix) })),
      summary: chapter.summary ? cite.fix(chapter.summary) : "",
      key_points: (chapter.key_points || []).map(cite.fix),
      case_study: chapter.case_study ? { ...chapter.case_study, text: cite.fix(chapter.case_study.text || "") } : null,
      references: perChapter ? cite.list() : [],
    };
  });
  return {
    title: book?.title || options.book_name || "", subtitle: book?.subtitle || options.subtitle || "", preface: book?.preface || "",
    introduction: book?.introduction || "", conclusion: book?.conclusion || "", glossary: book?.glossary || [], blurb: book?.blurb || "",
    chapters: rendered, references: perChapter ? [] : global.list(), style, word_count: wordsIn(book),
  };
}

export function plainText(text: string) {
  return String(text || "").replace(new RegExp(PLACEHOLDER.source, "g"), "[$1]").replace(/(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g, "$1");
}

// --- Exports: BibTeX and RIS ---

const bibKey = (ref: Reference, used: Set<string>) => {
  let key = `${(ref.authors?.[0]?.family || "ref").replace(/[^A-Za-z]/g, "")}${ref.year || ""}`;
  while (used.has(key)) key += "a";
  used.add(key);
  return key;
};

export function toBibtex(refs: Reference[]) {
  const used = new Set<string>();
  return refs.map((ref) => {
    const type = ref.kind === "book" ? "book" : ref.journal ? "article" : "misc";
    const fields: [string, string | undefined][] = [
      ["title", ref.title], ["author", (ref.authors || []).map((a) => `${a.family}, ${a.given || ""}`.trim().replace(/,$/, "")).join(" and ")],
      [type === "book" ? "publisher" : "journal", type === "book" ? ref.publisher : ref.journal], ["year", ref.year], ["volume", ref.volume],
      ["number", ref.issue], ["pages", ref.pages?.replace("-", "--")], ["doi", ref.doi], ["isbn", ref.isbn], ["url", ref.url],
    ];
    return `@${type}{${bibKey(ref, used)},\n${fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${String(v).replace(/[{}]/g, "")}}`).join(",\n")}\n}`;
  }).join("\n\n");
}

export function toRis(refs: Reference[]) {
  return refs.map((ref) => {
    const lines = [`TY  - ${ref.kind === "book" ? "BOOK" : ref.journal ? "JOUR" : "GEN"}`, `TI  - ${ref.title}`];
    for (const a of ref.authors || []) lines.push(`AU  - ${a.family}${a.given ? `, ${a.given}` : ""}`);
    if (ref.journal) lines.push(`JO  - ${ref.journal}`);
    if (ref.publisher) lines.push(`PB  - ${ref.publisher}`);
    if (ref.year) lines.push(`PY  - ${ref.year}`);
    if (ref.volume) lines.push(`VL  - ${ref.volume}`);
    if (ref.issue) lines.push(`IS  - ${ref.issue}`);
    if (ref.pages) {
      const [sp, ep] = ref.pages.split("-");
      lines.push(`SP  - ${sp}`);
      if (ep) lines.push(`EP  - ${ep}`);
    }
    if (ref.doi) lines.push(`DO  - ${ref.doi}`);
    if (ref.isbn) lines.push(`SN  - ${ref.isbn}`);
    if (ref.url) lines.push(`UR  - ${ref.url}`);
    lines.push("ER  - ");
    return lines.join("\n");
  }).join("\n\n");
}
