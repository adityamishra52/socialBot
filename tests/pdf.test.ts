import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName } from "pdf-lib";
import { buildPdf, needsBrowserPdf } from "../src/client/lib/exportPdf.js";

const font = (file: string) => new Uint8Array(readFileSync(`node_modules/@expo-google-fonts/tinos/${file}/Tinos_${file}.ttf`));
const fonts = { r: font("400Regular"), i: font("400Regular_Italic"), b: font("700Bold"), bi: font("700Bold_Italic") };
const long = (n: number) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} explains how the cost of building infrastructure was mistaken for its value [R1].`).join(" ");

const project = {
  mode: "book", references: [{ id: "R1", kind: "article", title: "Capex & returns", authors: [{ family: "Smith", given: "A" }], journal: "J Fin", year: "2021" }],
  figures: [],
  options: {
    style: "apa", authors: "A. Kumar", publisher: "Example Press", year: "2026", dedication: "For my *teachers*",
    layout: { page_size: "6x9", margin_top: 20, margin_bottom: 20, margin_inside: 22, margin_outside: 16, gutter: 0, mirror_margins: true, page_number_start: 1,
      page_number_position: "bottom-outside", front_matter_roman: true, font: "Times New Roman", font_size: 11, line_spacing: 1.4, paragraph_indent: true,
      chapter_start: "odd-page", running_headers: true, title_page: true, copyright_page: true, toc: true, justify: true },
  },
  draft: {
    title: "The Silicon Correction", subtitle: "After the Bust", preface: "Why this book exists.",
    chapters: [
      { number: 1, title: "The Leveraged Capex Illusion", key_points: ["Cost is not value"], sections: [
        { heading: "Capital and sand", level: 1, paragraphs: [long(60), "A second paragraph with *Homo sapiens* in italics.", long(25)] },
      ] },
      { number: 2, title: "Governance After the Boom", sections: [{ heading: "Rules", level: 1, paragraphs: [long(8)] }] },
    ],
    glossary: [{ term: "Capex", definition: "Capital expenditure." }],
  },
};

async function textOf(data: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: false, disableFontFace: true } as any).promise;
  const pages: { text: string; x: number; y: number; size: number }[][] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((item: any) => ({ text: item.str, x: item.transform[4], y: item.transform[5], size: Math.hypot(item.transform[0], item.transform[1]) })).filter((i: any) => i.text.trim()));
  }
  return pages;
}

describe("book PDF", () => {
  it("typesets the book within the margins, with contents, numbers and bookmarks", async () => {
    const built = await buildPdf(project, { fonts, now: new Date("2026-11-15T10:00:00Z") });
    expect(built.warnings).toEqual([]);
    const doc = await PDFDocument.load(built.data);
    expect(doc.getTitle()).toBe("The Silicon Correction");
    expect(doc.getAuthor()).toBe("A. Kumar");
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(Math.round(w)).toBe(432); // exactly 6 in
    expect(Math.round(h)).toBe(648); // exactly 9 in
    expect(doc.catalog.get(PDFName.of("Outlines"))).toBeTruthy();

    const pages = await textOf(built.data);
    const all = pages.map((p) => p.map((i) => i.text).join(" ")).join("\n");
    expect(all).toContain("The Silicon Correction");
    expect(all).toContain("Contents");
    expect(all).toContain("Chapter 1: The Leveraged Capex Illusion");
    expect(all).toContain("Homo sapiens");
    expect(all).toContain("(Smith, 2021)");
    expect(all).not.toContain("[R1]");
    expect(all).toContain("Sentence 60 explains");

    // Body text stays between the margins; only the 9 pt header and page number sit in them.
    const mm = 72 / 25.4;
    for (const [n, items] of pages.entries()) {
      for (const item of items.filter((i) => i.size > 9.5)) {
        expect([n + 1, item.text, item.y >= 20 * mm - 4]).toEqual([n + 1, item.text, true]);
        expect([n + 1, item.text, item.y <= h - 20 * mm]).toEqual([n + 1, item.text, true]);
        expect([n + 1, item.text, item.x >= 15 * mm && item.x <= w - 15 * mm]).toEqual([n + 1, item.text, true]);
      }
    }
    // Chapter 1 starts on a right-hand (odd) page; the contents give its page number.
    const chapterPage = pages.findIndex((p) => p.some((i) => i.text.includes("The Leveraged Capex Illusion")) && !p.some((i) => i.text.includes("Contents")));
    expect(chapterPage % 2).toBe(0);
    const tocPage = pages.find((p) => p.some((i) => i.text === "Contents"))!;
    expect(tocPage.some((i) => i.text === "1")).toBe(true);
    // Front matter has roman numbers; the main text starts at 1.
    expect(pages.flat().some((i) => i.size < 9.5 && /^(i|ii|iii|iv|v|vi)$/.test(i.text))).toBe(true);
  });

  it("knows which scripts need the browser's PDF", () => {
    expect(needsBrowserPdf("The AI boom")).toBe(false);
    expect(needsBrowserPdf("छठ पूजा")).toBe(true);
  });
});
