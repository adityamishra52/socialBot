// Draws a banner or poster on a canvas: the artwork (cover-fitted), a soft fade behind the words,
// then the words in real web fonts, an ornament, a button, the footer and the logo. The design is
// plain data, so any word, colour or position can change without drawing a new picture.

export const SIZES = {
  "4:5": { w: 1080, h: 1350, label: "Post, Instagram and Facebook (4:5)" },
  "1:1": { w: 1080, h: 1080, label: "Square post (1:1)" },
  "9:16": { w: 1080, h: 1920, label: "Story, status or reel cover (9:16)" },
  "16:9": { w: 1920, h: 1080, label: "Landscape, YouTube or slides (16:9)" },
  "3:4": { w: 1800, h: 2400, label: "Print poster (3:4)" },
  "21:9": { w: 2520, h: 1080, label: "Wide web banner (21:9)" },
  // Ebook covers (Amazon KDP and Google Play Books recommend 1600 × 2560); not offered on the Banner page.
  ebook: { w: 1600, h: 2560, label: "Ebook cover (1600 × 2560)", hidden: true },
};

export const FONT_SETS = {
  script: { label: "Elegant script", kicker: ["700", "Dancing Script"], headline: ["400", "Great Vibes"], body: ["500", "Lora"], stroke: 0.018 },
  serif: { label: "Classic serif", kicker: ["italic 600", "Playfair Display"], headline: ["800", "Playfair Display"], body: ["400", "Lora"] },
  sans: { label: "Modern sans", kicker: ["600", "Montserrat"], headline: ["800", "Montserrat"], body: ["500", "Montserrat"] },
  display: { label: "Bold display", kicker: ["600", "Poppins"], headline: ["400", "Bebas Neue"], body: ["400", "Poppins"], upper: true },
};

export const ORNAMENTS = { sun: "Rising sun", lotus: "Lotus", diya: "Diya lamp", stars: "Stars", leaves: "Leaves", waves: "Waves", dots: "Dots", none: "Simple line" };
export const AREAS = { top: "Top", bottom: "Bottom", left: "Left", right: "Right", center: "Centre" };

const FONT_URL = "https://fonts.googleapis.com/css2?family=Great+Vibes&family=Dancing+Script:wght@600;700&family=Playfair+Display:ital,wght@0,600;0,800;1,600"
  + "&family=Lora:wght@400;500;600&family=Montserrat:wght@500;600;800&family=Bebas+Neue&family=Poppins:wght@400;600"
  + "&family=Noto+Sans+Devanagari:wght@400;600;800&family=Noto+Serif+Devanagari:wght@400;700&display=swap";
// Hindi, Marathi and other Devanagari text falls back to these when the chosen font has no glyphs.
const FALLBACK = '"Noto Serif Devanagari", "Noto Sans Devanagari", "Nirmala UI", "Segoe UI", sans-serif';

let fontsPromise = null;
/** Load the banner fonts once (Google Fonts), so the canvas draws with them. */
export function loadBannerFonts() {
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    if (typeof document === "undefined") return;
    if (!document.querySelector("link[data-banner-fonts]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = FONT_URL;
      link.dataset.bannerFonts = "1";
      document.head.appendChild(link);
      await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; setTimeout(resolve, 4000); });
    }
    const specs = Object.values(FONT_SETS).flatMap((set) => [set.kicker, set.headline, set.body]);
    specs.push(["400", "Noto Serif Devanagari"], ["700", "Noto Serif Devanagari"], ["400", "Noto Sans Devanagari"]);
    await Promise.race([
      Promise.all(specs.map(([weight, family]) => document.fonts.load(`${weight} 40px "${family}"`, "Aa अ").catch(() => null))),
      new Promise((resolve) => { setTimeout(resolve, 5000); }),
    ]);
  })();
  return fontsPromise;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture couldn't be loaded."));
    image.src = src;
  });
}

// --- Colour helpers ---

export function rgba(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Text colour for a filled button: white or near-black, whichever reads better. */
export const onColour = (hex) => (contrast(hex, "#ffffff") >= contrast(hex, "#1a1a1a") ? "#ffffff" : "#1a1a1a");

// --- Text ---

const font = ([weight, family], size) => `${weight} ${Math.round(size)}px "${family}", ${FALLBACK}`;

/** Break text into lines no wider than `max`; words longer than a line are split. */
export function wrapLines(measure, text, max) {
  const out = [];
  for (const paragraph of String(text || "").split(/\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (measure(trial) <= max || !line) {
        if (!line && measure(word) > max) {
          let piece = "";
          for (const ch of word) {
            if (measure(piece + ch) > max && piece) { out.push(piece); piece = ch; } else piece += ch;
          }
          line = piece;
        } else line = trial;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// --- Backgrounds ---

/** A whole picture (such as a book cover) centred on the background, with a soft shadow. */
function contain(ctx, image, W, H) {
  const scale = Math.min((W * 0.8) / image.width, (H * 0.84) / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = Math.min(W, H) * 0.04;
  ctx.shadowOffsetY = Math.min(W, H) * 0.015;
  ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
  ctx.restore();
}

function cover(ctx, image, W, H) {
  const scale = Math.max(W / image.width, H / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
}

function plainBackground(ctx, W, H, palette) {
  const g = ctx.createLinearGradient(0, 0, W * 0.3, H);
  g.addColorStop(0, palette.background);
  g.addColorStop(1, rgba(palette.accent, 0.22));
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const u = Math.min(W, H);
  for (const [x, y, r, a] of [[0.92, 0.08, 0.32, 0.16], [0.06, 0.94, 0.42, 0.12], [0.82, 0.86, 0.18, 0.1]]) {
    const radial = ctx.createRadialGradient(W * x, H * y, 0, W * x, H * y, u * r);
    radial.addColorStop(0, rgba(palette.accent, a));
    radial.addColorStop(1, rgba(palette.accent, 0));
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);
  }
}

function fade(ctx, W, H, area, colour, strength) {
  if (strength <= 0) return;
  let g;
  if (area === "top") g = ctx.createLinearGradient(0, 0, 0, H * 0.66);
  else if (area === "bottom") g = ctx.createLinearGradient(0, H, 0, H * 0.34);
  else if (area === "left") g = ctx.createLinearGradient(0, 0, W * 0.7, 0);
  else if (area === "right") g = ctx.createLinearGradient(W, 0, W * 0.3, 0);
  if (g) {
    g.addColorStop(0, rgba(colour, strength));
    g.addColorStop(0.55, rgba(colour, strength * 0.9));
    g.addColorStop(1, rgba(colour, 0));
  } else {
    g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.62);
    g.addColorStop(0, rgba(colour, strength * 0.8));
    g.addColorStop(1, rgba(colour, strength * 0.25));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// --- Ornaments (simple vector shapes in the accent colour) ---

function sun(ctx, cx, top, size, colour) {
  const r = size * 0.36;
  const cy = top + size * 0.95;
  ctx.save();
  const g = ctx.createLinearGradient(0, cy - r, 0, cy);
  g.addColorStop(0, rgba(colour, 0.75));
  g.addColorStop(1, colour);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineCap = "round";
  ctx.lineWidth = size * 0.045;
  for (let i = 0; i <= 8; i += 1) {
    const angle = Math.PI + (Math.PI * i) / 8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * r * 1.3, cy + Math.sin(angle) * r * 1.3);
    ctx.lineTo(cx + Math.cos(angle) * r * (i % 2 ? 1.62 : 1.85), cy + Math.sin(angle) * r * (i % 2 ? 1.62 : 1.85));
    ctx.stroke();
  }
  ctx.restore();
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const angle = (Math.PI * i) / 4 - Math.PI / 2;
    const radius = i % 2 ? r * 0.32 : r;
    ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  }
  ctx.closePath();
  ctx.fill();
}

function stars(ctx, cx, top, size, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  star(ctx, cx, top + size * 0.5, size * 0.34);
  star(ctx, cx - size * 0.62, top + size * 0.62, size * 0.17);
  star(ctx, cx + size * 0.6, top + size * 0.36, size * 0.2);
  ctx.restore();
}

function lotus(ctx, cx, cy, s, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  for (const [angle, scale] of [[0, 1], [-0.62, 0.86], [0.62, 0.86], [-1.15, 0.66], [1.15, 0.66]]) {
    ctx.save();
    ctx.translate(cx, cy + s * 0.3);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.42 * scale, s * 0.17 * scale, s * 0.42 * scale, 0, 0, Math.PI * 2);
    ctx.globalAlpha = angle === 0 ? 1 : 0.85;
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function diya(ctx, cx, cy, s, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.ellipse(cx, cy + s * 0.15, s * 0.55, s * 0.26, 0, 0, Math.PI);
  ctx.lineTo(cx - s * 0.55, cy + s * 0.15);
  ctx.fill();
  const flame = ctx.createLinearGradient(0, cy - s * 0.6, 0, cy + s * 0.1);
  flame.addColorStop(0, "#fde047");
  flame.addColorStop(1, "#f97316");
  ctx.fillStyle = flame;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.62);
  ctx.quadraticCurveTo(cx + s * 0.22, cy - s * 0.12, cx, cy + s * 0.08);
  ctx.quadraticCurveTo(cx - s * 0.22, cy - s * 0.12, cx, cy - s * 0.62);
  ctx.fill();
  ctx.restore();
}

function leaves(ctx, cx, cy, s, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(cx, cy + s * 0.2);
    ctx.rotate(side * 0.9);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(s * 0.32, -s * 0.38, 0, -s * 0.8);
    ctx.quadraticCurveTo(-s * 0.32, -s * 0.38, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy + s * 0.12, s * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function dots(ctx, cx, cy, s, colour) {
  ctx.save();
  ctx.fillStyle = colour;
  for (const [dx, r] of [[-0.36, 0.07], [0, 0.11], [0.36, 0.07]]) {
    ctx.beginPath();
    ctx.arc(cx + dx * s, cy, r * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function waves(ctx, cx, cy, s, colour) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i <= 40; i += 1) {
    const x = cx - s * 0.7 + (s * 1.4 * i) / 40;
    const y = cy + Math.sin((i / 40) * Math.PI * 4) * s * 0.12;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

const GLYPHS = { lotus, diya, leaves, dots, waves };

/** A divider: a centre glyph with fine lines on both sides that end in a small circle. */
function divider(ctx, cx, cy, width, s, ornament, colour, align, left) {
  ctx.save();
  if (align === "left" || ornament === "none") {
    ctx.fillStyle = colour;
    const w = Math.min(width * 0.3, s * 3.2);
    const x = align === "left" ? left : cx - w / 2;
    ctx.beginPath();
    ctx.roundRect(x, cy - s * 0.08, w, s * 0.16, s * 0.08);
    ctx.fill();
    ctx.restore();
    return;
  }
  const glyph = GLYPHS[ornament] || dots;
  const gap = s * 0.95;
  const line = Math.min(width * 0.3, s * 3.4);
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(1.5, s * 0.045);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + side * gap, cy);
    ctx.lineTo(cx + side * (gap + line), cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + side * (gap + line + s * 0.09), cy, s * 0.09, 0, Math.PI * 2);
    ctx.stroke();
  }
  glyph(ctx, cx, cy, s * 0.9, colour);
  ctx.restore();
}

// --- The banner ---

/** The design with defaults filled in. */
export function normalizeDesign(design) {
  const d = design || {};
  return {
    aspect: SIZES[d.aspect] ? d.aspect : "4:5", kicker: d.kicker || "", headline: d.headline || "", message: d.message || "",
    points: Array.isArray(d.points) ? d.points.filter((p) => String(p).trim()) : [], badge: d.badge || "", byline: d.byline || "", cta: d.cta || "", footer: d.footer || "",
    palette: { background: d.palette?.background || "#fbf3e6", text: d.palette?.text || "#5b1a1a", accent: d.palette?.accent || "#c2410c" },
    font: FONT_SETS[d.font] ? d.font : "serif", area: AREAS[d.area] ? d.area : "top", ornament: ORNAMENTS[d.ornament] ? d.ornament : "none",
    scale: Math.max(0.6, Math.min(1.5, Number(d.scale) || 1)), fade: Math.max(0, Math.min(1, d.fade ?? 0.7)), showLogo: d.showLogo !== false,
    artFit: d.artFit === "contain" ? "contain" : "cover", headlineLines: Math.max(1, Math.min(8, Math.round(Number(d.headlineLines) || 3))),
  };
}

function textBox(area, W, H, m) {
  if (area === "top") return { x: m, y: m, w: W - 2 * m, h: H * 0.5 - m };
  if (area === "bottom") return { x: m, y: H * 0.48, w: W - 2 * m, h: H * 0.52 - m };
  if (area === "left") return { x: m, y: m, w: W * 0.52 - m, h: H - 2 * m };
  if (area === "right") return { x: W * 0.48, y: m, w: W * 0.52 - m, h: H - 2 * m };
  return { x: m * 1.5, y: m, w: W - 3 * m, h: H - 2 * m };
}

/** Lay out the words in the box: sizes shrink until everything fits. */
function layout(ctx, d, box, unit) {
  const set = FONT_SETS[d.font];
  const measureWith = (spec, size) => { ctx.font = font(spec, size); return (t) => ctx.measureText(t).width; };
  const headlineText = set.upper ? d.headline.toUpperCase() : d.headline;
  const wide = box.w / box.h > 1.6;
  let scale = d.scale;
  let items = [];
  for (let round = 0; round < 6; round += 1) {
    const u = unit * scale;
    items = [];
    const centred = d.area !== "left" && d.area !== "right";
    if (centred && (d.ornament === "sun" || d.ornament === "stars")) items.push({ type: "top-ornament", h: u * 10, gap: u * 1.2 });
    if (d.kicker) {
      const size = u * (d.font === "script" ? 7.8 : 5.2);
      const lines = wrapLines(measureWith(set.kicker, size), d.kicker, box.w);
      items.push({ type: "kicker", lines, size, lh: size * 1.2, h: lines.length * size * 1.2, gap: u * 0.6 });
    }
    if (headlineText) {
      let size = u * (d.font === "script" ? 15.5 : d.font === "display" ? 14.5 : 12) * (wide ? 0.9 : 1);
      let lines = [];
      for (let i = 0; i < 30; i += 1) {
        const measure = measureWith(set.headline, size);
        lines = wrapLines(measure, headlineText, box.w);
        if ((lines.length <= d.headlineLines && lines.every((l) => measure(l) <= box.w)) || size < u * 4) break;
        size *= 0.93;
      }
      const lh = size * (d.font === "script" ? 1.12 : d.font === "display" ? 0.98 : 1.1);
      items.push({ type: "headline", lines, size, lh, h: lines.length * lh, gap: u * 1.8 });
    }
    items.push({ type: "divider", h: u * 4.2, size: u * 4.2, gap: u * 1.8 });
    if (d.badge) {
      const size = u * 4;
      const lines = wrapLines(measureWith(["700", set.body[1]], size), d.badge, box.w * 0.86);
      items.push({ type: "badge", lines, size, lh: size * 1.25, h: lines.length * size * 1.25 + size * 1.1, gap: u * 1.8 });
    }
    if (d.message) {
      const size = u * 4.3;
      const lines = wrapLines(measureWith(set.body, size), d.message, box.w * (centred ? 0.9 : 1));
      items.push({ type: "message", lines, size, lh: size * 1.42, h: lines.length * size * 1.42, gap: u * 1.6 });
    }
    if (d.points.length) {
      const size = u * 3.8;
      const measure = measureWith(set.body, size);
      const lines = d.points.flatMap((p) => wrapLines(measure, `•  ${p}`, box.w * 0.92));
      items.push({ type: "points", lines, size, lh: size * 1.45, h: lines.length * size * 1.45, gap: u * 1.6 });
    }
    if (d.byline) {
      const size = u * 3.5;
      const lines = wrapLines(measureWith(["italic 500", set.body[1]], size), d.byline, box.w);
      items.push({ type: "byline", lines, size, lh: size * 1.35, h: lines.length * size * 1.35, gap: u * 1.8 });
    }
    if (d.cta) {
      const size = u * 4;
      items.push({ type: "cta", size, h: size * 2.5, gap: u * 1.2 });
    }
    const total = items.reduce((n, item, i) => n + item.h + (i < items.length - 1 ? item.gap : 0), 0);
    if (total <= box.h || scale < 0.35) return { items, total };
    scale *= Math.max(0.7, Math.min(0.96, box.h / total));
  }
  return { items, total: items.reduce((n, item, i) => n + item.h + (i < items.length - 1 ? item.gap : 0), 0) };
}

/** Draw the banner `design` on `canvas` at full size. `assets` holds loaded images: { art, logo }. */
export function drawBanner(canvas, design, assets = {}) {
  const d = normalizeDesign(design);
  // Without a picture there is nothing to balance the words against, so they sit in the middle.
  if (!assets.art) d.area = "center";
  const { w: W, h: H } = SIZES[d.aspect];
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  const { background, text, accent } = d.palette;
  ctx.clearRect(0, 0, W, H);
  if (assets.art && d.artFit === "contain") {
    plainBackground(ctx, W, H, d.palette);
    contain(ctx, assets.art, W, H);
    return canvas;
  }
  if (assets.art) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    cover(ctx, assets.art, W, H);
    fade(ctx, W, H, d.area, background, d.fade);
  } else plainBackground(ctx, W, H, d.palette);

  const short = Math.min(W, H);
  const m = Math.round(short * 0.075);
  const unit = short / 100;
  const footerSize = unit * 3;
  const box = textBox(d.area, W, H, m);
  if (d.footer && d.area !== "top") box.h -= footerSize * 2.4;
  const align = d.area === "left" || d.area === "right" ? "left" : "center";
  const cx = align === "left" ? box.x : box.x + box.w / 2;
  const { items, total } = layout(ctx, d, box, unit);
  let y = d.area === "top" ? box.y : d.area === "bottom" ? box.y + box.h - total : box.y + (box.h - total) / 2;
  const set = FONT_SETS[d.font];

  // A soft glow in the background colour keeps the words readable on a busy picture.
  const glow = (blur) => {
    ctx.shadowColor = assets.art ? rgba(background, 0.85) : "transparent";
    ctx.shadowBlur = assets.art ? blur : 0;
  };
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  for (const item of items) {
    if (item.type === "top-ornament") {
      if (d.ornament === "sun") sun(ctx, cx, y, item.h, accent); else stars(ctx, cx, y, item.h, accent);
    } else if (item.type === "divider") {
      divider(ctx, align === "left" ? box.x + box.w * 0.15 : cx, y + item.h / 2, box.w, item.size, d.ornament === "sun" || d.ornament === "stars" ? "dots" : d.ornament, accent, align, box.x);
    } else if (item.type === "badge") {
      ctx.font = font(["700", set.body[1]], item.size);
      const width = Math.max(...item.lines.map((l) => ctx.measureText(l).width)) + item.size * 1.8;
      const x = align === "left" ? box.x : cx - width / 2;
      ctx.save();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(x, y, width, item.h, item.size * 0.5);
      ctx.fill();
      ctx.fillStyle = onColour(accent);
      item.lines.forEach((line, i) => ctx.fillText(line, align === "left" ? x + item.size * 0.9 : cx, y + item.size * 0.55 + item.lh * (i + 0.8)));
      ctx.restore();
    } else if (item.type === "cta") {
      ctx.font = font(["700", set.body[1]], item.size);
      const width = ctx.measureText(d.cta).width + item.size * 2.6;
      const x = align === "left" ? box.x : cx - width / 2;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = item.size * 0.6;
      ctx.shadowOffsetY = item.size * 0.15;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(x, y, width, item.h, item.h / 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = onColour(accent);
      ctx.textBaseline = "middle";
      ctx.fillText(d.cta, align === "left" ? x + item.size * 1.3 : cx, y + item.h / 2 + item.size * 0.04);
      ctx.textBaseline = "alphabetic";
    } else {
      const spec = item.type === "kicker" ? set.kicker : item.type === "headline" ? set.headline : item.type === "byline" ? ["italic 500", set.body[1]] : set.body;
      ctx.font = font(spec, item.size);
      ctx.fillStyle = item.type === "kicker" || item.type === "byline" ? (contrast(accent, background) >= 3 ? accent : text) : text;
      if (item.type === "headline" && set.upper) ctx.letterSpacing = `${Math.round(item.size * 0.02)}px`;
      ctx.save();
      glow(item.size * (item.type === "headline" ? 0.18 : 0.35));
      item.lines.forEach((line, i) => {
        const baseline = y + item.lh * (i + 1) - (item.lh - item.size) / 2 - item.size * 0.12;
        ctx.fillText(line, cx, baseline);
        if (item.type === "headline" && set.stroke) {
          ctx.lineWidth = item.size * set.stroke;
          ctx.strokeStyle = ctx.fillStyle;
          ctx.shadowColor = "transparent";
          ctx.strokeText(line, cx, baseline);
        }
      });
      ctx.restore();
      ctx.letterSpacing = "0px";
    }
    y += item.h + item.gap;
  }

  if (d.footer) {
    ctx.save();
    if (assets.art && d.area !== "bottom") {
      const band = ctx.createLinearGradient(0, H, 0, H - footerSize * 4.5);
      band.addColorStop(0, rgba(background, 0.85));
      band.addColorStop(1, rgba(background, 0));
      ctx.fillStyle = band;
      ctx.fillRect(0, H - footerSize * 4.5, W, footerSize * 4.5);
    }
    ctx.font = font(["600", set.body[1]], footerSize);
    ctx.fillStyle = text;
    ctx.textAlign = align;
    ctx.fillText(d.footer, align === "left" ? box.x : W / 2, H - m * 0.55, W - 2 * m);
    ctx.restore();
  }

  if (assets.logo && d.showLogo) {
    const maxW = W * 0.16;
    const maxH = H * 0.09;
    const s = Math.min(maxW / assets.logo.width, maxH / assets.logo.height);
    const w = assets.logo.width * s;
    const h = assets.logo.height * s;
    const x = d.area === "right" ? m * 0.6 : W - m * 0.6 - w;
    ctx.drawImage(assets.logo, x, m * 0.6, w, h);
  }
  return canvas;
}

/** The banner as a file: PNG, or JPEG for posting (smaller). */
export async function bannerBlob(design, assets, type = "image/png", quality = 0.92) {
  const canvas = drawBanner(document.createElement("canvas"), design, assets);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** A data URL resized so its longest side is at most `max` (for sending a picture to be edited). */
export async function shrinkDataUrl(dataUrl, max = 1600) {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}
