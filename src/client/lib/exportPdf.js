import { PDFDocument, PDFHexString, PDFName, rgb, setCharacterSpacing } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { buildBlocks, furniture, pageSize, roman, runs } from "./layout.js";

// A print-ready, text-based PDF of a book (for Google Play Books, Draft2Digital and printing),
// typeset here in the browser from the same blocks and layout settings as the preview: page size,
// mirrored margins and gutter, font, size and line spacing, justification, indents, chapters on
// right-hand pages, running headers, page numbers (roman for front matter), a contents page with
// page numbers and links, bookmarks, and figures. Fonts are embedded (subset) open-licence
// equivalents of the chosen font, so text stays selectable and searchable.
//
// pdf-lib does not shape scripts that join letters (Hindi, Bengali, Arabic...): for those books the
// browser's Print / PDF is used instead (`needsBrowserPdf`).

const PT = 72 / 25.4; // points per millimetre
const INK = rgb(0.067, 0.067, 0.067);
const GREY = rgb(0.27, 0.27, 0.27);
const MUTED = rgb(0.33, 0.33, 0.33);
const BOX_FILL = rgb(0.953, 0.961, 0.973);
const BOX_LINE = rgb(0.78, 0.808, 0.847);
const DOTS = rgb(0.53, 0.53, 0.53);

/** The open fonts embedded for each font the layout offers (metric-compatible where one exists). */
export const PDF_FONTS = {
  "Times New Roman": "tinos", Georgia: "gelasio", Garamond: "eb-garamond", "Palatino Linotype": "gelasio", "Book Antiqua": "gelasio",
  Cambria: "caladea", "Source Serif 4": "source-serif-4", Arial: "arimo",
};

export { needsBrowserPdf } from "./publishKit.js";

// --- Fonts and words ---

function fontKit(fonts) {
  const sets = Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, new Set(f.getCharacterSet())]));
  const cache = new Map();
  const missing = new Set();
  const IGNORE = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
  const clean = (text, style) => {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (sets[style].has(cp)) out += ch;
      else if (IGNORE.has(cp)) continue;
      else if (/\s/u.test(ch)) out += " ";
      else if (cp === 0x2010 || cp === 0x2011) out += "-";
      else {
        missing.add(ch);
        out += "?";
      }
    }
    return out;
  };
  const width = (text, style, size) => {
    const key = `${style}${size}\u0000${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      w = fonts[style].widthOfTextAtSize(text, size);
      cache.set(key, w);
    }
    return w;
  };
  return { fonts, clean, width, missing };
}

const italicOf = (base) => (base === "b" || base === "bi" ? "bi" : "i");

/** Words of a paragraph; each word is one or more styled pieces (italic can start mid-word). */
function wordsOf(text, kit, base, size) {
  const words = [];
  let space = false;
  for (const run of runs(text)) {
    const style = run.italic ? italicOf(base) : base;
    for (const part of String(run.text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        space = true;
        continue;
      }
      const seg = { text: kit.clean(part, style), style };
      seg.w = kit.width(seg.text, style, size);
      const last = words[words.length - 1];
      if (last && !space) {
        last.segs.push(seg);
        last.w += seg.w;
      } else words.push({ segs: [seg], w: seg.w, space: space && words.length > 0 });
      space = false;
    }
  }
  return words;
}

/** Split a word wider than `max` into pieces that fit. */
function splitWord(word, kit, size, max) {
  const pieces = [];
  let cur = { segs: [], w: 0, space: word.space };
  for (const seg of word.segs) {
    let text = "";
    for (const ch of seg.text) {
      const w = kit.width(text + ch, seg.style, size);
      if (cur.w + w > max && (cur.segs.length || text)) {
        if (text) cur.segs.push({ text, style: seg.style, w: kit.width(text, seg.style, size) });
        cur.w = cur.segs.reduce((n, s) => n + s.w, 0);
        pieces.push(cur);
        cur = { segs: [], w: 0, space: false };
        text = ch;
      } else text += ch;
    }
    if (text) {
      const s = { text, style: seg.style, w: kit.width(text, seg.style, size) };
      cur.segs.push(s);
      cur.w += s.w;
    }
  }
  if (cur.segs.length) pieces.push(cur);
  return pieces;
}

/** Greedy line breaking. Lines are { words, natural, spaces, indent, avail }. */
function breakLines(words, kit, size, width, firstIndent = 0, restIndent = 0) {
  const spaceW = kit.width(" ", "r", size);
  const lines = [];
  let cur = { words: [], natural: 0, spaces: 0, indent: firstIndent, avail: width - firstIndent };
  const push = () => {
    lines.push(cur);
    cur = { words: [], natural: 0, spaces: 0, indent: restIndent, avail: width - restIndent };
  };
  const queue = [...words];
  while (queue.length) {
    const word = queue.shift();
    const gap = cur.words.length && word.space ? spaceW : 0;
    if (cur.words.length && cur.natural + gap + word.w > cur.avail + 0.01) {
      push();
      queue.unshift(word);
      continue;
    }
    if (!cur.words.length && word.w > cur.avail + 0.01) {
      queue.unshift(...splitWord(word, kit, size, cur.avail));
      const first = queue.shift();
      cur.words.push({ ...first, space: false });
      cur.natural = first.w;
      if (queue.length) push();
      continue;
    }
    cur.words.push(cur.words.length ? word : { ...word, space: false });
    cur.natural += gap + word.w;
    if (gap) cur.spaces += 1;
  }
  if (cur.words.length) lines.push(cur);
  return lines;
}

// --- The document ---

/**
 * Build the PDF. `fonts` holds the TTF bytes { r, i, b, bi } of the body font.
 * `loadFigure(block)` returns PNG or JPEG bytes (or null).
 * @param {any} project
 * @param {{ fonts: { r: Uint8Array, i: Uint8Array, b: Uint8Array, bi: Uint8Array }, loadFigure?: (block: any) => Promise<Uint8Array | null>, language?: string, now?: Date }} settings
 */
export async function buildPdf(project, { fonts, loadFigure = async () => null, language = "en", now = new Date() }) {
  const o = project.options || {};
  const layout = o.layout || {};
  const { blocks, rendered } = buildBlocks(project);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = {};
  for (const key of ["r", "i", "b", "bi"]) embedded[key] = await doc.embedFont(fonts[key], { subset: true });
  const kit = fontKit(embedded);
  const warnings = [];

  // Geometry, in points.
  const [wMm, hMm] = pageSize(layout);
  const W = wMm * PT;
  const H = hMm * PT;
  const place = furniture(layout);
  const top = (Number(layout.margin_top) + place.top.push) * PT;
  const bottom = (Number(layout.margin_bottom) + place.bottom.push) * PT;
  const inside = (Number(layout.margin_inside) + (Number(layout.gutter) || 0)) * PT;
  const outside = Number(layout.margin_outside) * PT;
  const mirror = Boolean(layout.mirror_margins);
  const contentW = W - inside - outside;
  const contentH = H - top - bottom;
  const fs = Number(layout.font_size) || 11;
  const lh = Number(layout.line_spacing) || 1.4;
  const justify = Boolean(layout.justify);
  const indentFirst = layout.paragraph_indent ? fs * 1.4 : 0;
  const paraGap = layout.paragraph_indent ? 0 : fs * 0.7;
  const isRight = (index) => index % 2 === 0; // page 1 is a right-hand page
  const leftOf = (index) => (mirror && !isRight(index) ? outside : inside);

  // Figures first (they are fetched or converted).
  const figures = new Map();
  for (const block of blocks.filter((b) => b.type === "figure")) {
    let bytes = null;
    try {
      bytes = await loadFigure(block);
    } catch {
      bytes = null;
    }
    if (!bytes?.length) {
      warnings.push(`Figure ${block.number}'s picture couldn't be added (its link may have expired: reopen the project and try again).`);
      continue;
    }
    try {
      figures.set(block.number, bytes[0] === 0x89 ? await doc.embedPng(bytes) : await doc.embedJpg(bytes));
    } catch {
      warnings.push(`Figure ${block.number}'s picture couldn't be read.`);
    }
  }

  const meta = [];
  const st = { page: null, index: -1, y: 0, chapter: "" };
  const cur = () => meta[st.index];
  const newPage = (front) => {
    st.page = doc.addPage([W, H]);
    st.index += 1;
    st.y = 0;
    meta.push({ front: Boolean(front), blank: false, mainStart: false, chapter: "", chapterTitle: false, hide: false, content: false });
  };
  const used = () => {
    const m = cur();
    m.content = true;
    if (!m.chapter && st.chapter) m.chapter = st.chapter;
  };
  const baseline = (y, size, h) => H - top - y - (h - size) / 2 - size * 0.8;

  /** Draw one laid-out line with its top at st.y. */
  function drawLine(line, { size, h, align = "left", color = INK, x0 = 0, last = false, spacing = 0 }) {
    const spaceW = kit.width(" ", "r", size);
    let extra = 0;
    let x = leftOf(st.index) + x0 + line.indent;
    if (align === "justify" && !last && line.spaces > 0) {
      extra = (line.avail - line.natural) / line.spaces;
      if (extra > size * 2.2) extra = 0;
    } else if (align === "center") x += (line.avail - line.natural) / 2;
    else if (align === "right") x += line.avail - line.natural;
    const y = baseline(st.y, size, h);
    let text = "";
    let style = null;
    let startX = x;
    const flush = () => {
      if (!text) return;
      if (spacing) st.page.pushOperators(setCharacterSpacing(spacing));
      st.page.drawText(text, { x: startX, y, size, font: embedded[style], color });
      if (spacing) st.page.pushOperators(setCharacterSpacing(0));
      text = "";
    };
    for (const word of line.words) {
      for (const [k, seg] of word.segs.entries()) {
        const gap = k === 0 && word.space ? spaceW + extra : 0;
        // Same style and no stretched space: keep it in one string; otherwise start a new piece.
        if (style === seg.style && (gap === 0 || extra === 0) && !spacing) {
          text += k === 0 && word.space ? " " : "";
          text += seg.text;
        } else {
          flush();
          x += gap;
          style = seg.style;
          startX = x;
          text = seg.text;
          x += seg.w;
          continue;
        }
        x += gap + seg.w;
      }
    }
    flush();
    used();
  }

  /**
   * Place lines on the page, moving to new pages as needed, keeping at least two lines together at
   * the bottom and top of a page. `onChunk(yTop, height, first, last)` runs before each piece is drawn.
   */
  function placeLines(lines, opts, onChunk) {
    let i = 0;
    while (i < lines.length) {
      let room = 0;
      let height = 0;
      while (i + room < lines.length && st.y + height + lines[i + room].h <= contentH + 0.01) {
        height += lines[i + room].h;
        room += 1;
      }
      const left = lines.length - i;
      if (room === 0 || (room < Math.min(2, left) && cur().content)) {
        if (!cur().content && room === 0) room = 1; // a line taller than the page: draw it anyway
        else {
          newPage(cur().front);
          continue;
        }
      }
      let take = Math.min(room, left);
      if (take < left && left - take === 1 && take >= 3) take -= 1;
      const chunkHeight = lines.slice(i, i + take).reduce((n, l) => n + l.h, 0);
      onChunk?.(st.y, chunkHeight, i === 0, i + take === lines.length);
      for (let k = 0; k < take; k += 1) {
        const line = lines[i + k];
        drawLine(line, { ...opts, ...line.opts, size: line.size, h: line.h, last: line.lastOfPara });
        st.y += line.h;
      }
      i += take;
      if (i < lines.length) newPage(cur().front);
    }
  }

  /** Lines of a paragraph, with their size and line height. */
  function paraLines(text, { size = fs, base = "r", width = contentW, first = 0, rest = 0, leading = lh, opts = {}, bold = 0 }) {
    const words = wordsOf(text, kit, base, size);
    // The first `bold` words in bold (a glossary term, "Figure 3.").
    for (const word of words.slice(0, bold)) {
      for (const seg of word.segs) {
        seg.style = seg.style === "i" || seg.style === "bi" ? "bi" : "b";
        seg.text = kit.clean(seg.text, seg.style);
        seg.w = kit.width(seg.text, seg.style, size);
      }
      word.w = word.segs.reduce((n, s) => n + s.w, 0);
    }
    // Letter spacing widens each word by the spacing after every character.
    if (opts.spacing) {
      for (const word of words) {
        for (const seg of word.segs) seg.w += [...seg.text].length * opts.spacing;
        word.w = word.segs.reduce((n, s) => n + s.w, 0);
      }
    }
    const lines = breakLines(words, kit, size, width, first, rest);
    lines.forEach((l, i) => Object.assign(l, { size, h: size * leading, lastOfPara: i === lines.length - 1, opts }));
    return lines;
  }

  const space = (h) => {
    if (cur().content) st.y = Math.min(contentH, st.y + h);
  };
  const keepRoom = (h) => {
    if (cur().content && st.y + h > contentH + 0.01) newPage(cur().front);
  };

  // Contents entries, filled in once the chapters are placed.
  const tocBlocks = blocks.filter((b) => b.type === "chapter-title" && b.toc);
  const toc = tocBlocks.map((b) => ({ title: b.label ? `${b.label}: ${b.text}` : b.text, target: -1, lines: [] }));
  let tocNext = 0;
  let afterHeading = true;

  newPage(Boolean(blocks[0]?.front));
  let mainStarted = false;
  for (const [index, block] of blocks.entries()) {
    if (block.breakBefore && cur().content) newPage(block.front);
    if (block.breakBefore && block.odd && !isRight(st.index)) {
      cur().blank = true;
      newPage(block.front);
    }
    if (!block.front && !mainStarted) {
      if (cur().content) newPage(false);
      cur().mainStart = true;
      mainStarted = true;
    }
    cur().front = Boolean(block.front);
    st.chapter = block.chapter || "";

    switch (block.type) {
      case "title-page": {
        cur().hide = true;
        st.y = contentW * 0.32;
        const lines = [
          ...paraLines(block.title, { size: fs * 2.3, base: "b", leading: 1.15, opts: { align: "center" } }),
          ...(block.subtitle ? [{ gap: fs * 1.2 * 0.8 }, ...paraLines(block.subtitle, { size: fs * 1.2, base: "i", leading: 1.4, opts: { align: "center" } })] : []),
          ...(block.authors ? [{ gap: fs * 1.15 * 3 }, ...paraLines(block.authors, { size: fs * 1.15, leading: 1.4, opts: { align: "center" } })] : []),
          ...(block.publisher ? [{ gap: fs * 6 }, ...paraLines(block.publisher, { size: fs, leading: 1.4, opts: { align: "center" } })] : []),
        ];
        for (const line of lines) {
          if (line.gap) st.y += line.gap;
          else if (st.y + line.h <= contentH) {
            drawLine(line, { ...line.opts, size: line.size, h: line.h, last: true });
            st.y += line.h;
          }
        }
        used();
        break;
      }
      case "copyright": {
        cur().hide = true;
        const size = fs * 0.8;
        const lines = block.lines.flatMap((l) => {
          const ls = paraLines(l, { size, leading: lh });
          ls[ls.length - 1].after = size * 0.6;
          return ls;
        });
        const total = lines.reduce((n, l) => n + l.h + (l.after || 0), 0);
        st.y = Math.max(0, Math.min(contentW * 0.7, contentH - total));
        for (const line of lines) {
          drawLine(line, { size: line.size, h: line.h, last: true });
          st.y += line.h + (line.after || 0);
        }
        break;
      }
      case "dedication": {
        cur().hide = true;
        st.y = contentW * 0.35;
        for (const line of paraLines(block.text, { base: "i", opts: { align: "center" } })) {
          drawLine(line, { align: "center", size: line.size, h: line.h, last: true });
          st.y += line.h;
        }
        break;
      }
      case "toc": {
        const head = paraLines("Contents", { size: fs * 1.9, base: "b", leading: 1.2 });
        placeLines(head, { align: "left" });
        st.y += fs * 1.9;
        const numW = kit.width("0000", "r", fs) + fs;
        for (const entry of toc) {
          const lines = paraLines(entry.title, { width: contentW - numW, leading: lh });
          placeLines(lines, { align: "left" }, (yTop, height) => entry.lines.push({ index: st.index, yTop, height }));
          const last = lines[lines.length - 1];
          entry.end = { index: st.index, x: leftOf(st.index) + last.indent + last.natural, y: baseline(st.y - last.h, fs, last.h) };
          st.y += fs * 0.35;
        }
        break;
      }
      case "chapter-title": {
        cur().chapterTitle = true;
        if (block.toc && tocNext < toc.length) {
          toc[tocNext].target = st.index;
          tocNext += 1;
        }
        st.y += contentW * 0.18;
        if (block.label) {
          const size = fs * 0.85;
          placeLines(paraLines(block.label.toUpperCase(), { size, leading: 1.4, opts: { align: "center", color: MUTED, spacing: size * 0.18 } }), {});
        }
        const size = fs * 1.9;
        st.y += block.label ? size * 0.3 : 0;
        placeLines(paraLines(block.text, { size, base: "b", leading: 1.2, opts: { align: "center" } }), {});
        st.y += fs * 2.2;
        break;
      }
      case "h1":
      case "h2": {
        const size = block.type === "h1" ? fs * 1.18 : fs * 1.04;
        const lines = paraLines(block.text, { size, base: block.type === "h1" ? "b" : "bi", leading: 1.3 });
        space(size * (block.type === "h1" ? 1 : 0.8));
        keepRoom(lines.reduce((n, l) => n + l.h, 0) + fs * lh * 2);
        placeLines(lines, { align: "left" });
        st.y += size * (block.type === "h1" ? 0.4 : 0.3);
        break;
      }
      case "p": {
        const first = block.cont || afterHeading ? 0 : indentFirst;
        placeLines(paraLines(block.text, { first }), { align: justify ? "justify" : "left" });
        st.y += paraGap;
        break;
      }
      case "ref": {
        const size = fs * 0.9;
        const hang = size * 1.6;
        const text = block.number ? `${block.number}. ${block.text}` : block.text;
        placeLines(paraLines(text, { size, leading: 1.35, first: 0, rest: hang }), { align: "left" });
        st.y += size * 0.35;
        break;
      }
      case "glossary": {
        placeLines(paraLines(`${block.term}. ${block.text}`, { bold: String(block.term).split(/\s+/).filter(Boolean).length }), { align: "left" });
        st.y += fs * 0.4;
        break;
      }
      case "box": {
        const size = fs * 0.95;
        const padX = size * 0.9;
        const padY = size * 0.6;
        const inner = contentW - padX * 2;
        const lines = [...paraLines(block.title, { size, base: "b", width: inner, leading: lh })];
        lines[lines.length - 1].after = size * 0.3;
        if (block.text) lines.push(...paraLines(block.text, { size, width: inner, leading: lh }));
        (block.items || []).forEach((item, i) => {
          const marker = block.numbered ? `${i + 1}.` : "•";
          const hang = size * 1.3;
          const ls = paraLines(`${marker} ${item}`, { size, width: inner, leading: lh, first: 0, rest: hang });
          lines.push(...ls);
        });
        lines.forEach((l) => { l.h += l.after || 0; });
        space(size * 0.8);
        keepRoom(Math.min(lines.reduce((n, l) => n + l.h, 0), size * lh * 3) + padY * 2);
        st.y += padY;
        placeLines(lines, { align: "left", x0: padX }, (yTop, height, firstChunk, lastChunk) => {
          const y0 = firstChunk ? Math.max(0, yTop - padY) : yTop;
          const h = height + (yTop - y0) + (lastChunk ? padY : 0);
          st.page.drawRectangle({ x: leftOf(st.index), y: H - top - y0 - h, width: contentW, height: h, color: BOX_FILL, borderColor: BOX_LINE, borderWidth: 0.75 });
        });
        st.y += padY + size * 0.8;
        break;
      }
      case "figure": {
        const image = figures.get(block.number);
        const size = fs * 0.88;
        const caption = paraLines(`Figure ${block.number}. ${block.caption || ""}${block.credit ? ` ${block.credit}` : ""}`, { size, leading: 1.4, bold: 2 });
        const capH = caption.reduce((n, l) => n + l.h, 0);
        let w = 0;
        let h = 0;
        if (image) {
          w = Math.min(contentW, image.width * 0.75);
          h = (image.height / image.width) * w;
          const maxH = Math.max(contentH * 0.25, contentH - capH - fs * 2);
          if (h > Math.min(maxH, contentH * 0.62)) {
            h = Math.min(maxH, contentH * 0.62);
            w = (image.width / image.height) * h;
          }
        }
        space(fs * 0.8);
        keepRoom(h + fs * 0.4 + capH);
        if (image) {
          st.page.drawImage(image, { x: leftOf(st.index) + (contentW - w) / 2, y: H - top - st.y - h, width: w, height: h });
          used();
          st.y += h + fs * 0.4;
        }
        placeLines(caption, { align: "left" });
        st.y += fs * 0.8;
        break;
      }
      case "table": {
        placeLines(paraLines(`Table ${block.number}. ${block.caption || ""}`, { base: "b" }), { align: "left" });
        for (const row of [block.columns, ...(block.rows || [])]) placeLines(paraLines(row.join(" · "), { size: fs * 0.85 }), { align: "left" });
        st.y += fs * 0.8;
        break;
      }
      default:
        break;
    }
    // No first-line indent straight after a heading, a box or the front pages.
    afterHeading = ["h1", "h2", "chapter-title", "box", "title-page", "copyright", "dedication", "toc"].includes(block.type);
    if (block.breakAfter) newPage(Boolean(blocks[index + 1]?.front));
  }
  if (meta.length > 1 && !meta[meta.length - 1].content && !meta[meta.length - 1].blank) {
    doc.removePage(meta.length - 1);
    meta.pop();
  }

  // Page labels, running headers and page numbers (like the preview).
  const start = Number.isFinite(Number(layout.page_number_start)) ? Number(layout.page_number_start) : 1;
  const position = place.position;
  const title = rendered.title || o.book_name || "";
  let frontCount = 0;
  let main = start - 1;
  const pages = doc.getPages();
  meta.forEach((m, i) => {
    if (m.mainStart) main = start - 1;
    if (m.front) {
      frontCount += 1;
      m.label = layout.front_matter_roman ? roman(frontCount) : String(frontCount);
    } else {
      main += 1;
      m.label = String(main);
    }
    const page = pages[i];
    const right = isRight(i);
    const left = leftOf(i);
    const size = 9;
    const hidden = m.blank || m.hide;
    const header = layout.running_headers && !hidden && !m.chapterTitle ? (right ? m.chapter : title) : "";
    if (header) {
      const align = place.numberTop && position === "top-outside" ? "center" : right ? "right" : "left";
      const max = contentW * (place.numberTop && position === "top-center" ? 0.4 : place.numberTop ? 0.62 : 1);
      let text = kit.clean(header, "i");
      while (text.length > 3 && kit.width(text, "i", size) > max) text = `${text.slice(0, -2).trimEnd()}…`;
      const tw = kit.width(text, "i", size);
      const x = align === "center" ? left + (contentW - tw) / 2 : align === "right" ? left + contentW - tw : left;
      page.drawText(text, { x, y: H - place.top.offset * PT - size * 0.8, size, font: embedded.i, color: GREY });
    }
    if (position !== "none" && !hidden) {
      const label = m.label;
      const tw = kit.width(label, "r", size);
      const align = position.endsWith("center") ? "center" : right || !mirror ? "right" : "left";
      const x = align === "center" ? left + (contentW - tw) / 2 : align === "right" ? left + contentW - tw : left;
      const y = place.numberTop ? H - place.top.offset * PT - size * 0.8 : place.bottom.offset * PT + size * 0.2;
      page.drawText(label, { x, y, size, font: embedded.r, color: GREY });
    }
  });

  // Contents: page numbers with dotted leaders, and links to the chapters.
  for (const entry of toc) {
    if (entry.target < 0 || !entry.end) continue;
    const page = pages[entry.end.index];
    const label = meta[entry.target].label;
    const tw = kit.width(label, "r", fs);
    const right = leftOf(entry.end.index) + contentW;
    page.drawText(label, { x: right - tw, y: entry.end.y, size: fs, font: embedded.r, color: INK });
    const dotW = kit.width(". ", "r", fs);
    let x = entry.end.x + fs * 0.6;
    let dots = "";
    while (x + dotW * (dots.length / 2 + 1) < right - tw - fs * 0.6) dots += ". ";
    if (dots) page.drawText(dots.trimEnd(), { x, y: entry.end.y, size: fs, font: embedded.r, color: DOTS });
    for (const piece of entry.lines) {
      const annot = doc.context.obj({
        Type: "Annot", Subtype: "Link", Border: [0, 0, 0],
        Rect: [leftOf(piece.index), H - top - piece.yTop - piece.height, leftOf(piece.index) + contentW, H - top - piece.yTop],
        Dest: [pages[entry.target].ref, PDFName.of("XYZ"), null, null, null],
      });
      pages[piece.index].node.addAnnot(doc.context.register(annot));
    }
  }

  // Bookmarks for the chapters.
  const marks = toc.filter((e) => e.target >= 0);
  if (marks.length) {
    const outlines = doc.context.nextRef();
    const refs = marks.map(() => doc.context.nextRef());
    marks.forEach((entry, i) => {
      doc.context.assign(refs[i], doc.context.obj({
        Title: PDFHexString.fromText(entry.title), Parent: outlines, Dest: [pages[entry.target].ref, PDFName.of("XYZ"), null, null, null],
        ...(i > 0 ? { Prev: refs[i - 1] } : {}), ...(i < refs.length - 1 ? { Next: refs[i + 1] } : {}),
      }));
    });
    doc.context.assign(outlines, doc.context.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
    doc.catalog.set(PDFName.of("Outlines"), outlines);
    doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  }

  doc.setTitle(title, { showInWindowTitleBar: true });
  if (o.authors?.trim()) doc.setAuthor(o.authors.trim());
  if (rendered.subtitle) doc.setSubject(rendered.subtitle);
  doc.setLanguage(language || "en");
  doc.setCreator("Social Autopost");
  doc.setProducer("Social Autopost (pdf-lib)");
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  if (kit.missing.size) warnings.push(`These characters aren't in the font and show as "?": ${[...kit.missing].slice(0, 20).join(" ")}`);
  const data = await doc.save({ useObjectStreams: true });
  return { data, pages: pages.length, warnings };
}
