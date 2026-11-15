import { renderBook, renderManuscript, STYLES } from "../../shared/render.ts";

// One list of blocks describes the whole document. The live preview, Print / PDF and the Word
// file are all made from it, so what you see on the right is what you download.

export const PAGE_SIZES = {
  a4: ["A4 (210 × 297 mm)", 210, 297], a5: ["A5 (148 × 210 mm)", 148, 210], b5: ["B5 (176 × 250 mm)", 176, 250],
  letter: ["US Letter (8.5 × 11 in)", 216, 279], "6x9": ["Trade 6 × 9 in", 152, 229], "5.5x8.5": ["Digest 5.5 × 8.5 in", 140, 216],
  "5x8": ["Pocket 5 × 8 in", 127, 203], royal: ["Royal (156 × 234 mm)", 156, 234], crown: ["Crown quarto (189 × 246 mm)", 189, 246],
};
export const FONTS = ["Times New Roman", "Georgia", "Garamond", "Palatino Linotype", "Cambria", "Book Antiqua", "Source Serif 4", "Arial"];
export { STYLES };

export function pageSize(layout) {
  const [, w, h] = PAGE_SIZES[layout.page_size] || PAGE_SIZES.a4;
  return [layout.page_width_mm || w, layout.page_height_mm || h];
}

export function roman(n) {
  if (n <= 0) return String(n);
  const map = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [value, letters] of map) while (n >= value) {
    out += letters;
    n -= value;
  }
  return out;
}

/** Split text into runs: plain, *italic* and [[placeholder]]. */
export function runs(text) {
  const out = [];
  const pattern = /\[\[([^[\]\n]{1,200})\]\]|(?<![\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g;
  let position = 0;
  for (const match of String(text || "").matchAll(pattern)) {
    if (match.index > position) out.push({ text: text.slice(position, match.index) });
    if (match[1] !== undefined) out.push({ text: `[${match[1]}]`, placeholder: true });
    else out.push({ text: match[2], italic: true });
    position = match.index + match[0].length;
  }
  if (position < String(text || "").length) out.push({ text: text.slice(position) });
  return out;
}

export function renderProject(project) {
  const draft = project.draft || {};
  const style = project.options?.style || (project.mode === "book" ? "apa" : "vancouver");
  if (project.mode === "book") return renderBook(draft, project.references || [], style, project.options);
  return renderManuscript(draft, project.references || [], style, project.figures || [], project.journal?.heading_case || "");
}

/** The document as blocks, in reading order. Each has a type and its content. */
export function buildBlocks(project) {
  const o = project.options || {};
  const layout = o.layout || {};
  const out = [];
  if (project.mode !== "book") {
    const r = renderProject(project);
    out.push({ type: "doc-title", text: r.title });
    if (o.authors) out.push({ type: "authors", text: o.authors });
    if (r.running_title) out.push({ type: "meta", text: `Running title: ${r.running_title}` });
    if (r.abstract?.length) {
      out.push({ type: "h1", text: "Abstract" });
      for (const a of r.abstract) out.push({ type: "p", text: a.heading ? `${a.heading}: ${a.text}` : a.text, lead: a.heading || "" });
    }
    if (r.keywords?.length) out.push({ type: "meta", text: `Keywords: ${r.keywords.join("; ")}` });
    for (const block of r.body) {
      if (block.type === "section") {
        out.push({ type: block.level === 2 ? "h2" : "h1", text: block.heading });
        for (const p of block.paragraphs) out.push({ type: "p", text: p });
      } else if (block.type === "table") out.push({ ...block, type: "table" });
      else out.push({ ...block, type: "figure" });
    }
    for (const d of r.declarations) {
      out.push({ type: "h2", text: d.heading });
      out.push({ type: "p", text: d.text });
    }
    if (r.references.length) {
      out.push({ type: "h1", text: "References" });
      r.references.forEach((ref, i) => out.push({ type: "ref", text: ref.text, number: ["vancouver", "ama", "ieee"].includes(r.style) ? i + 1 : null }));
    }
    return { blocks: out, rendered: r };
  }

  const r = renderProject(project);
  const front = (block) => out.push({ ...block, front: true });
  if (layout.title_page !== false) {
    front({ type: "title-page", title: r.title || o.book_name || "Untitled book", subtitle: r.subtitle || o.subtitle || "", authors: o.authors || "", publisher: o.publisher || "", breakAfter: true });
  }
  if (layout.copyright_page !== false) {
    const year = o.year || new Date().getFullYear();
    const lines = [`Copyright © ${year} ${o.authors || "[[author name]]"}. All rights reserved.`, o.edition ? `${o.edition} edition.` : "", o.isbn ? `ISBN: ${o.isbn}` : "", o.publisher ? `Published by ${o.publisher}.` : "",
      "No part of this book may be reproduced without written permission from the copyright holder, except for brief quotations in reviews and scholarly works."].filter(Boolean);
    front({ type: "copyright", lines, breakAfter: true });
  }
  if (o.dedication) front({ type: "dedication", text: o.dedication, breakAfter: true });
  if (layout.toc !== false) front({ type: "toc", breakAfter: true });
  if (r.preface) {
    front({ type: "chapter-title", label: "", text: "Preface", toc: true, breakBefore: true });
    for (const p of r.preface.split(/\n\s*\n/)) front({ type: "p", text: p });
  }
  let first = true;
  const chapterTitle = (block) => {
    out.push({ ...block, breakBefore: true, odd: layout.chapter_start === "odd-page", restart: first });
    first = false;
  };
  if (r.introduction) {
    chapterTitle({ type: "chapter-title", label: "", text: "Introduction", toc: true });
    for (const p of r.introduction.split(/\n\s*\n/)) out.push({ type: "p", text: p, chapter: "Introduction" });
  }
  const figures = project.figures || [];
  r.chapters.forEach((chapter, index) => {
    const name = `Chapter ${chapter.number || index + 1}`;
    chapterTitle({ type: "chapter-title", label: name, text: chapter.title, toc: true });
    if (chapter.objectives?.length) out.push({ type: "box", title: "Learning objectives", items: chapter.objectives, chapter: chapter.title });
    (chapter.sections || []).forEach((section, sIndex) => {
      out.push({ type: section.level === 2 ? "h2" : "h1", text: section.heading, chapter: chapter.title });
      section.paragraphs.forEach((p, pIndex) => out.push({ type: "p", text: p, chapter: chapter.title, drop: layout.drop_caps && sIndex === 0 && pIndex === 0 }));
      figures.forEach((f, fIndex) => {
        if (f.chapter === index && (f.after === section.heading || (!f.after && sIndex === chapter.sections.length - 1))) {
          out.push({ type: "figure", number: fIndex + 1, caption: f.caption, credit: f.credit, svg: f.svg, image: f.image, chapter: chapter.title });
        }
      });
    });
    if (chapter.case_study?.text) out.push({ type: "box", title: chapter.case_study.title || "Case study", text: chapter.case_study.text, chapter: chapter.title });
    if (chapter.key_points?.length) out.push({ type: "box", title: "Key points", items: chapter.key_points, chapter: chapter.title });
    if (chapter.summary) {
      out.push({ type: "h2", text: "Summary", chapter: chapter.title });
      out.push({ type: "p", text: chapter.summary, chapter: chapter.title });
    }
    if (chapter.questions?.length) out.push({ type: "box", title: "Review questions", items: chapter.questions, numbered: true, chapter: chapter.title });
    if (chapter.references?.length) {
      out.push({ type: "h2", text: "References", chapter: chapter.title });
      chapter.references.forEach((ref, i) => out.push({ type: "ref", text: ref.text, number: ["vancouver", "ama", "ieee"].includes(r.style) ? i + 1 : null, chapter: chapter.title }));
    }
  });
  if (r.conclusion) {
    chapterTitle({ type: "chapter-title", label: "", text: "Conclusion", toc: true });
    for (const p of r.conclusion.split(/\n\s*\n/)) out.push({ type: "p", text: p, chapter: "Conclusion" });
  }
  if (r.glossary?.length) {
    chapterTitle({ type: "chapter-title", label: "", text: "Glossary", toc: true });
    for (const g of r.glossary) out.push({ type: "glossary", term: g.term, text: g.definition, chapter: "Glossary" });
  }
  if (r.references.length) {
    chapterTitle({ type: "chapter-title", label: "", text: "References", toc: true });
    r.references.forEach((ref, i) => out.push({ type: "ref", text: ref.text, number: ["vancouver", "ama", "ieee"].includes(r.style) ? i + 1 : null, chapter: "References" }));
  }
  return { blocks: out, rendered: r };
}
