import { FONT_SETS, cover, drawBanner, plainBackground } from "./banner.js";

// The full paperback cover for Amazon KDP: back cover, spine and front cover as one image in one
// PDF, sized like KDP's Cover Calculator: width = bleed + trim width + spine + trim width + bleed,
// height = bleed + trim height + bleed, with the spine as thick as the page count on the chosen
// paper. Words stay inside the safe area, the back cover's barcode corner is left clear (KDP prints
// the barcode there), and the spine carries the title and author only from 79 pages, as KDP requires.

export const PAPERS = {
  white: { label: "White paper", inch: 0.002252 },
  cream: { label: "Cream paper", inch: 0.0025 },
  color: { label: "Standard colour", inch: 0.002252 },
  premium: { label: "Premium colour", inch: 0.002347 },
};
export const BLEED = 0.125; // inches, on the outside edges
const SAFE = 0.125; // keep words this far inside the trim line
const SPINE_TEXT_PAGES = 79;
const SPINE_MARGIN = 0.0625; // clear space on each side of the spine text
const BARCODE = { w: 2, h: 1.2, inset: 0.25 }; // KDP's barcode box, from the spine and bottom trim

/** Every size in inches, from the trim size in mm, the page count and the paper. */
export function paperbackGeometry(trimWidthMm, trimHeightMm, pages, paper = "white") {
  const tw = trimWidthMm / 25.4;
  const th = trimHeightMm / 25.4;
  const count = Math.max(0, Math.round(Number(pages) || 0));
  const spine = count * (PAPERS[paper] || PAPERS.white).inch;
  return {
    trimW: tw, trimH: th, pages: count, paper, spine,
    width: BLEED + tw + spine + tw + BLEED, height: BLEED + th + BLEED,
    back: { x: 0, w: BLEED + tw },
    spineX: BLEED + tw,
    front: { x: BLEED + tw + spine, w: tw + BLEED },
    barcode: { x: BLEED + tw - BARCODE.inset - BARCODE.w, y: BLEED + th - BARCODE.inset - BARCODE.h, w: BARCODE.w, h: BARCODE.h },
    spineText: count >= SPINE_TEXT_PAGES,
  };
}

/** The resolution to draw at: 300 DPI, lower only if the canvas would be too large for the browser. */
export function coverDpi(g, wanted = 300, maxPixels = 16_000_000) {
  const area = g.width * g.height;
  return Math.max(150, Math.min(wanted, Math.floor(Math.sqrt(maxPixels / area))));
}

/**
 * Draw the full cover on `canvas` at `dpi`.
 * front: { design, art } (a banner design for the front panel) or { image } (a finished cover).
 * back: a banner design for the back's words (tagline, description, author bio).
 */
export function drawPaperback(canvas, g, { dpi = 300, palette, front, back, title = "", author = "", font = "serif", guides = false }) {
  const s = dpi;
  const W = Math.round(g.width * s);
  const H = Math.round(g.height * s);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  plainBackground(ctx, W, H, palette);

  // Front panel (trim + bleed on the outer edges).
  const fx = Math.round(g.front.x * s);
  const fw = W - fx;
  if (front?.image) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, 0, fw, H);
    ctx.clip();
    ctx.translate(fx, 0);
    cover(ctx, front.image, fw, H);
    ctx.restore();
  } else if (front?.design) {
    const panel = document.createElement("canvas");
    drawBanner(panel, { ...front.design, width: fw, height: H }, { art: front.art });
    ctx.drawImage(panel, fx, 0);
  }

  // Back cover words: inside the safe area, above the barcode corner.
  if (back) {
    const left = Math.round((BLEED + SAFE) * s);
    const top = Math.round((BLEED + SAFE) * s);
    const width = Math.round((g.trimW - 2 * SAFE) * s);
    const height = Math.round((g.barcode.y - 0.2) * s) - top;
    if (width > 0 && height > 0) {
      const panel = document.createElement("canvas");
      drawBanner(panel, { ...back, width, height, bare: true, keepArea: true, area: "top", textAlign: "left" }, {});
      ctx.drawImage(panel, left, top);
    }
  }

  // Spine: title and author, reading from top to bottom, from 79 pages.
  if (g.spineText && (title || author)) {
    const set = FONT_SETS[font] || FONT_SETS.serif;
    const room = (g.spine - 2 * SPINE_MARGIN) * s;
    const length = (g.trimH - 2 * 0.5) * s;
    const text = [title, author].filter(Boolean).join("   ·   ");
    let size = Math.min(room * 0.7, 0.3 * s);
    const family = `"${set.body[1]}", serif`;
    ctx.save();
    ctx.translate((g.spineX + g.spine / 2) * s, H / 2);
    ctx.rotate(Math.PI / 2);
    for (let i = 0; i < 40; i += 1) {
      ctx.font = `700 ${Math.round(size)}px ${family}`;
      if (ctx.measureText(text).width <= length || size < 6) break;
      size *= 0.93;
    }
    ctx.fillStyle = palette.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // Guides for the preview only: trim, spine, safe area and the barcode box.
  if (guides) {
    ctx.save();
    ctx.lineWidth = Math.max(1, s / 60);
    ctx.setLineDash([s / 12, s / 18]);
    ctx.strokeStyle = "rgba(220, 38, 38, 0.9)";
    ctx.strokeRect(BLEED * s, BLEED * s, (g.width - 2 * BLEED) * s, g.trimH * s);
    for (const x of [g.spineX, g.spineX + g.spine]) {
      ctx.beginPath();
      ctx.moveTo(x * s, 0);
      ctx.lineTo(x * s, H);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(37, 99, 235, 0.8)";
    ctx.strokeRect((BLEED + SAFE) * s, (BLEED + SAFE) * s, (g.trimW - 2 * SAFE) * s, (g.trimH - 2 * SAFE) * s);
    ctx.strokeRect((g.front.x + SAFE) * s, (BLEED + SAFE) * s, (g.trimW - 2 * SAFE) * s, (g.trimH - 2 * SAFE) * s);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillRect(g.barcode.x * s, g.barcode.y * s, g.barcode.w * s, g.barcode.h * s);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.7)";
    ctx.strokeRect(g.barcode.x * s, g.barcode.y * s, g.barcode.w * s, g.barcode.h * s);
    ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
    ctx.font = `${Math.round(s * 0.14)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Barcode (KDP)", (g.barcode.x + g.barcode.w / 2) * s, (g.barcode.y + g.barcode.h / 2) * s);
    ctx.restore();
  }
  return canvas;
}

/** The drawn cover as a one-page PDF at the exact cover size. */
export async function paperbackPdf(canvas, g, title = "") {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const width = g.width * 72;
  const height = g.height * 72;
  const page = doc.addPage([width, height]);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  page.drawImage(image, { x: 0, y: 0, width, height });
  doc.setTitle(`${title || "Book"}: paperback cover`);
  doc.setCreator("Social Autopost");
  return doc.save();
}

/** Short, plain notes about the cover for the author. */
export function paperbackSummary(g, dpi) {
  const inch = (n) => n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return {
    size: `${g.width.toFixed(3)} × ${g.height.toFixed(3)} in`,
    text: `Full cover ${g.width.toFixed(3)} × ${g.height.toFixed(3)} in: back and front ${inch(g.trimW)} × ${inch(g.trimH)} in, spine ${g.spine.toFixed(3)} in for ${g.pages} pages on ${PAPERS[g.paper].label.toLowerCase()}, ${BLEED} in bleed, ${dpi} DPI.`,
  };
}
