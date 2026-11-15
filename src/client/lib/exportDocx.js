import { buildBlocks, pageSize, runs } from "./layout.js";
import { svgToPng } from "./images.js";

// The Word file is built in the browser with the "docx" library, from the same blocks as the preview.

const TWIP = 56.6929; // twentieths of a point per millimetre

export async function exportDocx(project) {
  const d = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageNumber, Footer, Header, Table, TableRow, TableCell, WidthType,
    ImageRun, PageBreak, SectionType, NumberFormat, LineNumberRestartFormat, TableOfContents, BorderStyle, ShadingType } = d;
  const layout = project.options?.layout || {};
  const isBook = project.mode === "book";
  const { blocks } = buildBlocks(project);
  const [width, height] = pageSize(layout);
  const font = layout.font || "Times New Roman";
  const size = Math.round((layout.font_size || 12) * 2);
  const line = Math.round(240 * (layout.line_spacing || 1.5));
  const align = layout.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT;

  const textRuns = (text, extra = {}) => runs(text).map((r) => new TextRun({
    text: r.text, italics: r.italic || extra.italics, bold: extra.bold, size: extra.size || size, font,
    ...(r.placeholder ? { highlight: "yellow" } : {}),
  }));
  const para = (text, options = {}) => new Paragraph({
    children: textRuns(text, options), alignment: options.alignment ?? align, spacing: { line, after: layout.paragraph_indent ? 0 : 160, before: options.before || 0 },
    indent: options.indent ? { firstLine: 400 } : undefined, heading: options.heading, keepNext: options.keepNext,
  });

  async function figure(block) {
    try {
      let data;
      let w;
      let h;
      if (block.svg) ({ data, width: w, height: h } = await svgToPng(block.svg));
      else if (block.image) {
        const response = await fetch(block.image);
        data = new Uint8Array(await response.arrayBuffer());
        const bitmap = await createImageBitmap(new Blob([data]));
        w = bitmap.width;
        h = bitmap.height;
      } else return [];
      const maxWidth = (width - layout.margin_inside - layout.margin_outside) * 3.78;
      const scale = Math.min(1, maxWidth / w);
      return [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data, type: block.svg || data[1] === 0x50 ? "png" : "jpg", transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } })] }),
        new Paragraph({ children: [new TextRun({ text: `Figure ${block.number}. `, bold: true, size: size - 2, font }), ...textRuns(block.caption || "", { size: size - 2 }),
          ...(block.credit ? [new TextRun({ text: ` ${block.credit}`, size: size - 4, font, italics: true })] : [])], spacing: { after: 240 } })];
    } catch {
      return [para(`[Figure ${block.number}: ${block.caption}]`)];
    }
  }

  const sections = [];
  let children = [];
  let front = [];
  let firstParagraph = true;
  let currentTitle = "";
  let currentOdd = false;
  for (const block of blocks) {
    const target = block.front ? front : children;
    if (block.type === "chapter-title" && !block.front && target.length) {
      // Each chapter starts a new page (or odd page) section in Word.
      sections.push({ children, odd: currentOdd, title: currentTitle });
      children = [];
    }
    if (block.type === "chapter-title" && !block.front) {
      currentTitle = block.text;
      currentOdd = Boolean(block.odd);
    }
    const out = block.front ? front : children;
    const indent = layout.paragraph_indent && !block.cont && !firstParagraph;
    switch (block.type) {
      case "doc-title": out.push(new Paragraph({ children: textRuns(block.text, { bold: true, size: size + 8 }), alignment: AlignmentType.CENTER, spacing: { after: 240 } })); break;
      case "authors": out.push(new Paragraph({ children: [new TextRun({ text: block.text, size, font })], alignment: AlignmentType.CENTER, spacing: { after: 240 } })); break;
      case "meta": out.push(para(block.text)); break;
      case "h1": out.push(para(block.text, { bold: true, heading: HeadingLevel.HEADING_1, size: size + 4, before: 240, keepNext: true, alignment: AlignmentType.LEFT })); firstParagraph = true; break;
      case "h2": out.push(para(block.text, { bold: true, heading: HeadingLevel.HEADING_2, size: size + 2, before: 200, keepNext: true, alignment: AlignmentType.LEFT })); firstParagraph = true; break;
      case "p": out.push(para(block.text, { indent })); firstParagraph = false; break;
      case "ref": out.push(new Paragraph({ children: [...(block.number ? [new TextRun({ text: `${block.number}. `, size, font })] : []), ...textRuns(block.text)], spacing: { line: 240, after: 120 }, indent: { left: 360, hanging: 360 } })); break;
      case "glossary": out.push(new Paragraph({ children: [new TextRun({ text: `${block.term}. `, bold: true, size, font }), ...textRuns(block.text)], spacing: { line, after: 120 } })); break;
      case "chapter-title":
        if (block.label) out.push(new Paragraph({ children: [new TextRun({ text: block.label.toUpperCase(), size: size - 2, font, characterSpacing: 40 })], alignment: AlignmentType.CENTER, spacing: { before: 1200 } }));
        out.push(new Paragraph({ children: textRuns(block.text, { bold: true, size: size + 14 }), heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { before: block.label ? 120 : 1200, after: 600 } }));
        firstParagraph = true;
        break;
      case "box": {
        const shade = { shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1F5F9" } };
        out.push(new Paragraph({ children: [new TextRun({ text: block.title, bold: true, size, font })], ...shade, spacing: { before: 200 }, keepNext: true }));
        if (block.text) out.push(new Paragraph({ children: textRuns(block.text), ...shade, spacing: { line } }));
        (block.items || []).forEach((item, i) => out.push(new Paragraph({ children: [new TextRun({ text: block.numbered ? `${i + 1}. ` : "• ", size, font }), ...textRuns(item)], ...shade, indent: { left: 360, hanging: 240 } })));
        out.push(new Paragraph({ children: [], spacing: { after: 160 } }));
        break;
      }
      case "table": {
        out.push(new Paragraph({ children: [new TextRun({ text: `Table ${block.number}. `, bold: true, size: size - 2, font }), ...textRuns(block.caption, { size: size - 2 })], keepNext: true, spacing: { before: 200 } }));
        const cell = (text, bold) => new TableCell({ children: [new Paragraph({ children: textRuns(text, { bold, size: size - 4 }) })], width: { size: Math.floor(100 / block.columns.length), type: WidthType.PERCENTAGE } });
        out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: block.columns.map((c) => cell(c, true)) }), ...block.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
          borders: { top: { style: BorderStyle.SINGLE, size: 6, color: "000000" }, bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "BBBBBB" }, insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } } }));
        if (block.note) out.push(para(block.note, { size: size - 4 }));
        break;
      }
      case "figure": out.push(...(await figure(block))); break;
      case "title-page":
        out.push(new Paragraph({ children: [new TextRun({ text: block.title, bold: true, size: size + 26, font })], alignment: AlignmentType.CENTER, spacing: { before: 2400, after: 360 } }));
        if (block.subtitle) out.push(new Paragraph({ children: [new TextRun({ text: block.subtitle, size: size + 6, font, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 1200 } }));
        if (block.authors) out.push(new Paragraph({ children: [new TextRun({ text: block.authors, size: size + 4, font })], alignment: AlignmentType.CENTER }));
        if (block.publisher) out.push(new Paragraph({ children: [new TextRun({ text: block.publisher, size, font })], alignment: AlignmentType.CENTER, spacing: { before: 2400 } }));
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case "copyright":
        out.push(new Paragraph({ children: [], spacing: { before: 6000 } }));
        block.lines.forEach((l) => out.push(new Paragraph({ children: [new TextRun({ text: l, size: size - 4, font })], spacing: { after: 120 } })));
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case "dedication":
        out.push(new Paragraph({ children: textRuns(block.text, { italics: true }), alignment: AlignmentType.CENTER, spacing: { before: 3000 } }));
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case "toc":
        out.push(new Paragraph({ children: [new TextRun({ text: "Contents", bold: true, size: size + 10, font })], spacing: { after: 360 } }));
        out.push(new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-1", stylesWithLevels: [] }));
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      default: break;
    }
    if (block.breakAfter && !["title-page", "copyright", "dedication", "toc"].includes(block.type)) out.push(new Paragraph({ children: [new PageBreak()] }));
  }
  if (children.length) sections.push({ children, odd: currentOdd, title: currentTitle });

  const position = layout.page_number_position || "bottom-center";
  const numberParagraph = (alignment) => new Paragraph({ alignment, children: [new TextRun({ children: [PageNumber.CURRENT], size: size - 2, font })] });
  const numberAlign = position.endsWith("center") ? AlignmentType.CENTER : AlignmentType.RIGHT;
  const page = {
    size: { width: Math.round(width * TWIP), height: Math.round(height * TWIP) },
    margin: { top: Math.round(layout.margin_top * TWIP), bottom: Math.round(layout.margin_bottom * TWIP), left: Math.round(layout.margin_inside * TWIP),
      right: Math.round(layout.margin_outside * TWIP), gutter: Math.round((layout.gutter || 0) * TWIP), mirror: Boolean(layout.mirror_margins), header: 400, footer: 400 },
  };
  const numbered = (format, start) => ({ ...page, pageNumbers: { start, formatType: format } });
  const pageBits = (title) => {
    const bits = {};
    if (position !== "none") {
      const where = position.startsWith("top") ? "headers" : "footers";
      const make = (alignment) => (where === "headers" ? new Header({ children: [numberParagraph(alignment)] }) : new Footer({ children: [numberParagraph(alignment)] }));
      bits[where] = layout.mirror_margins && position.endsWith("outside") ? { default: make(AlignmentType.RIGHT), even: make(AlignmentType.LEFT) } : { default: make(numberAlign) };
    }
    if (layout.running_headers && !position.startsWith("top")) {
      bits.headers = { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: title, size: size - 4, font, italics: true })] })] }),
        even: new Header({ children: [new Paragraph({ children: [new TextRun({ text: project.draft?.title || project.options?.book_name || "", size: size - 4, font, italics: true })] })] }) };
    }
    return bits;
  };
  const docSections = [];
  if (front.length) {
    docSections.push({ properties: { page: numbered(layout.front_matter_roman ? NumberFormat.LOWER_ROMAN : NumberFormat.DECIMAL, 1), titlePage: true }, ...pageBits(""), children: front });
  }
  sections.forEach((section, index) => {
    const chapterTitle = isBook ? section.title || "" : "";
    docSections.push({
      properties: {
        type: index === 0 && !front.length ? undefined : section.odd ? SectionType.ODD_PAGE : SectionType.NEXT_PAGE,
        page: index === 0 ? numbered(NumberFormat.DECIMAL, layout.page_number_start ?? 1) : page,
        ...(layout.line_numbers && !isBook ? { lineNumbers: { countBy: 1, restart: LineNumberRestartFormat.CONTINUOUS } } : {}),
      },
      ...pageBits(chapterTitle), children: section.children,
    });
  });
  const doc = new Document({
    features: { updateFields: true }, evenAndOddHeaderAndFooters: Boolean(layout.mirror_margins),
    creator: "Social Autopost", title: project.draft?.title || project.title || "Document",
    styles: { default: { document: { run: { font, size } } } },
    sections: docSections.length ? docSections : [{ children: [para("(empty)")] }],
  });
  return Packer.toBlob(doc);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
