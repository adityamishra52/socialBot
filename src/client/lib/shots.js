import { contrast, loadBannerFonts, loadImage, onColour, wrapLines } from "./banner.js";

// Site to Post: turns the page's screenshot into finished 4:5 post images (1080 × 1350). The AI
// plan from the server says which parts of the page to show (never a pop-up), with a kicker and a
// headline for each, and the brand colour. Without a plan, the most detailed parts of the page are
// used. Each image shows that part of the real page in a browser frame under the headline, drawn
// here in real fonts, so the words are always spelled right.

const W = 1080;
const H = 1350;
const SIDE = 72;
const FONT = '"Montserrat", "Noto Sans Devanagari", "Segoe UI", system-ui, sans-serif';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HEX = /^#[0-9a-f]{6}$/i;

function mix(a, b, t) {
  const p = parseInt(a.slice(1), 16);
  const q = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((p >> shift) & 255) * (1 - t) + ((q >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

/** Colours for the post: a deep brand-tinted background, or calm paper for academic posts. */
export function shotPalette(color, mode = "trending") {
  if (mode === "academic") {
    return { bg: "#F6F3EC", bg2: "#E9E3D5", ink: "#1F2A44", soft: "rgba(31,42,68,0.72)", accent: "#1F2A44", shadow: "rgba(31,42,68,0.28)" };
  }
  const base = HEX.test(color || "") ? color : "#2563EB";
  const n = parseInt(base.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (Math.max(...rgb) - Math.min(...rgb) < 28) {
    // Black, white or grey brands: a near-black design with a white label.
    return { bg: "#09090B", bg2: "#27272A", ink: "#FFFFFF", soft: "rgba(255,255,255,0.72)", accent: "#FFFFFF", shadow: "rgba(0,0,0,0.6)" };
  }
  const bg = mix(base, "#070B16", 0.74);
  const accent = contrast(base, bg) >= 3 ? base : mix(base, "#FFFFFF", 0.55);
  return { bg, bg2: mix(base, "#070B16", 0.48), ink: "#FFFFFF", soft: "rgba(255,255,255,0.78)", accent, shadow: "rgba(0,0,0,0.5)" };
}

/**
 * The part of the screenshot to show, in pixels, for a box given as fractions [top, left, bottom,
 * right], so it fills a frame of the given aspect (width / height). At least half the page width is
 * shown, and a box taller than the frame is shown from its top.
 */
export function cropFor(box, iw, ih, aspect) {
  const [t, l, b, r] = box;
  const bw = (r - l) * iw * 1.08;
  const bh = (b - t) * ih * 1.08;
  let w = clamp(Math.max(bw, bh * aspect, iw * 0.5), 1, iw);
  let h = w / aspect;
  if (h > ih) {
    h = ih;
    w = Math.min(iw, h * aspect);
  }
  const x = clamp(((l + r) / 2) * iw - w / 2, 0, iw - w);
  let y = clamp(((t + b) / 2) * ih - h / 2, 0, ih - h);
  if (bh > h) y = clamp(t * ih - h * 0.03, 0, ih - h);
  return { x, y, w, h };
}

/** How much of `region` (pixels) a box (fractions) covers, from 0 to 1. */
export function coverage(region, box, iw, ih) {
  const [t, l, b, r] = box;
  const w = Math.max(0, Math.min(region.x + region.w, r * iw) - Math.max(region.x, l * iw));
  const h = Math.max(0, Math.min(region.y + region.h, b * ih) - Math.max(region.y, t * ih));
  return (w * h) / Math.max(1, region.w * region.h);
}

/**
 * Move a part of the page clear of pop-ups (boxes as fractions), keeping as much of the chosen box
 * as possible. Returns the original region when nothing covers it, or null when no move works.
 */
export function avoidPopups(region, box, popups, iw, ih) {
  const covered = (r) => Math.max(0, ...popups.map((p) => coverage(r, p, iw, ih)));
  if (covered(region) < 0.02) return region;
  const shown = (r) => coverage(r, box, iw, ih) * ((r.w * r.h) / Math.max(1, (box[2] - box[0]) * ih * (box[3] - box[1]) * iw));
  const candidates = [];
  for (const [t, l, b, r] of popups) {
    candidates.push({ ...region, x: l * iw - region.w }, { ...region, x: r * iw }, { ...region, y: t * ih - region.h }, { ...region, y: b * ih });
  }
  let best = null;
  for (const raw of candidates) {
    const c = { ...raw, x: clamp(raw.x, 0, iw - raw.w), y: clamp(raw.y, 0, ih - raw.h) };
    const keep = Math.min(1, shown(c));
    if (covered(c) < 0.02 && keep >= 0.6 && (!best || keep > best.keep)) best = { region: c, keep };
  }
  return best ? best.region : null;
}

/**
 * How much is going on in a part of the image: `ink` is the share of pixels that differ from the
 * background, `spread` the spread of brightness. Parts the page hadn't drawn yet (pictures that load
 * late) come out nearly empty.
 */
function detail(image, region) {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, S, S);
  const { data } = g.getImageData(0, 0, S, S);
  const n = S * S;
  const lum = new Float32Array(n);
  const counts = new Array(32).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    lum[i] = v;
    sum += v;
    counts[Math.min(31, Math.floor(v / 8))] += 1;
  }
  const background = counts.indexOf(Math.max(...counts)) * 8 + 4;
  const mean = sum / n;
  let ink = 0;
  let squares = 0;
  for (const v of lum) {
    if (Math.abs(v - background) > 20) ink += 1;
    squares += (v - mean) ** 2;
  }
  return { ink: ink / n, spread: Math.sqrt(squares / n) };
}

/** Mostly empty: a little text on a plain background, or nothing at all. */
function empty(image, region) {
  const { ink, spread } = detail(image, region);
  return ink < 0.02 || (ink < 0.05 && spread < 20);
}

/** Full-width windows down the page, the top one first, then the most detailed ones. */
function pageWindows(image, aspect) {
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  const h = Math.min(ih, iw / aspect);
  const windows = [];
  for (let y = 0; y < ih - h * 0.4 || !windows.length; y += h * 0.5) {
    windows.push({ x: 0, y: Math.min(y, ih - h), w: iw, h });
    if (y + h >= ih) break;
  }
  const scored = windows.filter((region) => !empty(image, region)).map((region) => {
    const { ink, spread } = detail(image, region);
    return { region, score: spread + ink * 100 };
  });
  const [top, ...rest] = scored;
  rest.sort((a, b) => b.score - a.score);
  const picked = top ? [top.region] : [];
  for (const { region } of rest) {
    if (picked.every((p) => Math.abs(p.y - region.y) >= h * 0.8)) picked.push(region);
  }
  return picked;
}

function roundRect(g, x, y, w, h, r) {
  const rr = [r, r, r, r].map((v, i) => (Array.isArray(r) ? r[i] : v));
  g.beginPath();
  g.moveTo(x + rr[0], y);
  g.lineTo(x + w - rr[1], y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr[1]);
  g.lineTo(x + w, y + h - rr[2]);
  g.quadraticCurveTo(x + w, y + h, x + w - rr[2], y + h);
  g.lineTo(x + rr[3], y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr[3]);
  g.lineTo(x, y + rr[0]);
  g.quadraticCurveTo(x, y, x + rr[0], y);
  g.closePath();
}

function spaced(g, px) {
  if ("letterSpacing" in g) g.letterSpacing = `${px}px`;
}

/** The words at the top: where they end and the frame starts. Draws them when `draw` is true. */
function words(g, slide, pal, draw) {
  let y = 86;
  if (slide.kicker) {
    g.font = `600 26px ${FONT}`;
    spaced(g, 3);
    const width = g.measureText(slide.kicker).width + 44;
    if (draw) {
      g.fillStyle = pal.accent;
      roundRect(g, SIDE, y, width, 50, 25);
      g.fill();
      g.fillStyle = onColour(pal.accent);
      g.textBaseline = "middle";
      g.fillText(slide.kicker, SIDE + 22, y + 26);
    }
    spaced(g, 0);
    y += 50 + 30;
  }
  let size = 70;
  let lines = [];
  for (; size >= 44; size -= 6) {
    g.font = `800 ${size}px ${FONT}`;
    lines = wrapLines((t) => g.measureText(t).width, slide.headline, W - SIDE * 2);
    if (lines.length <= 3) break;
  }
  lines = lines.slice(0, 3);
  const lineHeight = Math.round(size * 1.12);
  if (draw) {
    g.fillStyle = pal.ink;
    g.textBaseline = "top";
    lines.forEach((line, i) => g.fillText(line, SIDE, y + i * lineHeight));
  }
  return y + lines.length * lineHeight + 40;
}

const FRAME = { x: 54, w: W - 108, bar: 58, bottom: H - 104 };

/** One finished post: background, kicker, headline, the page in a browser frame, the address. */
function drawPost(image, slide, pal, host, pick, address = host) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const top = words(g, slide, pal, false);
  const area = { x: FRAME.x, y: top + FRAME.bar, w: FRAME.w, h: FRAME.bottom - top - FRAME.bar };
  const region = pick(area.w / area.h);
  if (!region) return null;

  const back = g.createLinearGradient(0, 0, W * 0.4, H);
  back.addColorStop(0, pal.bg);
  back.addColorStop(1, pal.bg2);
  g.fillStyle = back;
  g.fillRect(0, 0, W, H);
  for (const [x, y, r, a] of [[0.95, 0.04, 0.55, 0.32], [0.02, 0.98, 0.6, 0.2]]) {
    const glow = g.createRadialGradient(W * x, H * y, 0, W * x, H * y, W * r);
    glow.addColorStop(0, `${pal.accent}${Math.round(a * 255).toString(16).padStart(2, "0")}`);
    glow.addColorStop(1, `${pal.accent}00`);
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
  }
  words(g, slide, pal, true);

  // The browser window, with a soft shadow.
  const frameH = FRAME.bottom - top;
  g.save();
  g.shadowColor = pal.shadow;
  g.shadowBlur = 60;
  g.shadowOffsetY = 22;
  g.fillStyle = "#ffffff";
  roundRect(g, FRAME.x, top, FRAME.w, frameH, 26);
  g.fill();
  g.restore();
  g.save();
  roundRect(g, FRAME.x, top, FRAME.w, frameH, 26);
  g.clip();
  g.fillStyle = "#EEF1F5";
  g.fillRect(FRAME.x, top, FRAME.w, FRAME.bar);
  ["#FF5F57", "#FEBC2E", "#28C840"].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(FRAME.x + 30 + i * 26, top + FRAME.bar / 2, 8, 0, Math.PI * 2);
    g.fill();
  });
  const pillX = FRAME.x + 120;
  g.fillStyle = "#ffffff";
  roundRect(g, pillX, top + 12, FRAME.w - 150, FRAME.bar - 24, 17);
  g.fill();
  g.fillStyle = "#4B5563";
  g.font = `500 22px ${FONT}`;
  g.textBaseline = "middle";
  let shown = address;
  while (shown.length > 4 && g.measureText(shown).width > FRAME.w - 190) shown = `${shown.slice(0, -2)}…`;
  g.fillText(shown, pillX + 20, top + FRAME.bar / 2 + 1);
  g.drawImage(image, region.x, region.y, region.w, region.h, area.x, area.y, area.w, area.h);
  g.strokeStyle = "rgba(0,0,0,0.08)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(FRAME.x, area.y);
  g.lineTo(FRAME.x + FRAME.w, area.y);
  g.stroke();
  g.restore();

  g.fillStyle = pal.soft;
  g.font = `600 26px ${FONT}`;
  g.textBaseline = "middle";
  g.textAlign = "center";
  g.fillText(host, W / 2, H - 52);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/** The top of the page, full width and full bleed, as a plain 4:5 picture. */
function plainTop(image) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  const iw = image.naturalWidth;
  const h = Math.min(image.naturalHeight, iw * (H / W));
  const w = h * (W / H);
  g.drawImage(image, (iw - w) / 2, 0, w, h, 0, 0, W, H);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/** "example.com/pricing" from a full address. */
function addressOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
}

/** A page title without the site name tacked on ("Pricing | Acme" → "Pricing"). */
export function bareTitle(title) {
  const parts = String(title || "").split(/\s+[|–—-]\s+/);
  return parts.length > 1 && parts[parts.length - 1].split(/\s+/).length <= 3 ? parts.slice(0, -1).join(" – ") : String(title || "");
}

/** A short label from link text: letters, numbers and spaces only, at most 3 words. */
export function labelOf(text) {
  return String(text || "").replace(/[^\p{L}\p{M}\p{N}\s&'-]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ").toUpperCase().slice(0, 24);
}

function sentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
}

/**
 * Finished post images from the page's screenshot. Round 0 uses the AI plan (then the most detailed
 * parts of the page), adds one post per photographed linked page and the plain top of the page;
 * later rounds ("Regenerate") show other parts of the page. Returns [] when there is no screenshot
 * or it can't be drawn.
 */
export async function screenshotPosts(site, plan, { mode = "trending", round = 0, count = 3 } = {}) {
  if (!site?.screenshot) return [];
  let image;
  try {
    [image] = await Promise.all([loadImage(site.screenshot), loadBannerFonts()]);
  } catch {
    return [];
  }
  const iw = image.naturalWidth;
  const ih = image.naturalHeight;
  if (!iw || !ih) return [];
  const pal = shotPalette(plan?.color || site.theme_color, mode);
  const host = site.host || "";
  const popups = plan?.popups || [];
  const clear = (region) => region && popups.every((box) => coverage(region, box, iw, ih) < 0.12) && !empty(image, region);
  const slides = plan?.slides || [];
  const short = (t) => String(t || "").split(/\s+/).slice(0, 10).join(" ");
  const general = [bareTitle(site.title), ...sentences(site.description)].map(short).filter(Boolean);
  const kicker = (slides[0]?.kicker || site.site_name || "").toUpperCase().slice(0, 24);
  const out = [];
  const used = [];
  const taken = new Set();
  const add = (slide, pick, label) => {
    try {
      const drawn = drawPost(image, slide, pal, host, pick);
      if (!drawn) return;
      out.push({ id: `shot-${round}-${out.length}`, label, image: drawn, fit: false });
      taken.add(slide.headline);
    } catch {
      // Skip a part that can't be drawn.
    }
  };
  // For a part of the page the AI didn't pick: the AI headline written for that part if there is
  // one, else the page's own title or description, each used once where possible.
  const headlineFor = (region, i) => {
    const own = slides.find((s) => {
      const middle = ((s.box[0] + s.box[2]) / 2) * ih;
      return middle >= region.y && middle <= region.y + region.h && !taken.has(s.headline);
    });
    const shift = general.length ? (round * count + i) % general.length : 0;
    const rotated = [...general.slice(shift), ...general.slice(0, shift)];
    return own?.headline || rotated.find((t) => !taken.has(t)) || rotated[0] || slides[i % Math.max(1, slides.length)]?.headline || host;
  };

  if (round === 0) {
    for (const slide of slides) {
      if (out.length >= count) break;
      add(slide, (aspect) => {
        const region = avoidPopups(cropFor(slide.box, iw, ih, aspect), slide.box, popups, iw, ih);
        if (!clear(region) || used.some((u) => Math.abs(u.y - region.y) < region.h * 0.35)) return null;
        used.push(region);
        return region;
      }, "AI screenshot post");
    }
  }
  // Without a (usable) plan, and in later rounds: the most detailed parts of the page.
  const aspect = FRAME.w / (FRAME.bottom - 340 - FRAME.bar);
  const windows = pageWindows(image, aspect).filter((w) => used.every((u) => Math.abs(u.y - w.y) >= w.h * 0.5));
  const start = (round * count) % Math.max(1, windows.length);
  const ordered = [...windows.slice(start), ...windows.slice(0, start)];
  for (const [i, region] of ordered.entries()) {
    if (out.length >= count) break;
    const slide = { headline: headlineFor(region, i), kicker };
    add(slide, (a) => {
      const crop = cropFor([region.y / ih, 0, (region.y + region.h) / ih, 1], iw, ih, a);
      return clear(crop) ? crop : null;
    }, "Screenshot post");
  }
  if (round === 0) {
    // Each linked page that was read and photographed: the top of it, under its own title.
    for (const [i, page] of (site.pages || []).entries()) {
      const headline = short(bareTitle(page.title) || page.label);
      if (!page.shot || !headline) continue;
      try {
        const shotOfPage = await loadImage(page.shot);
        const pw = shotOfPage.naturalWidth;
        const ph = shotOfPage.naturalHeight;
        const drawn = drawPost(shotOfPage, { headline, kicker: labelOf(page.label) }, pal, host, (aspect) => {
          const crop = cropFor([0, 0, 0.05, 1], pw, ph, aspect);
          return empty(shotOfPage, crop) ? null : crop;
        }, addressOf(page.url) || host);
        if (drawn) out.push({ id: `shot-${round}-page${i}`, label: "Linked page post", image: drawn, fit: false });
      } catch {
        // Skip a linked page whose screenshot can't be drawn.
      }
    }
    try {
      out.push({ id: `shot-${round}-plain`, label: "Page screenshot", image: plainTop(image), fit: false });
    } catch {
      // No plain version.
    }
  }
  return out;
}
