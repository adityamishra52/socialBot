// Renders a reel storyboard as a 1080x1920 3D animation, frame by frame, at any time t.
// Three.js draws the 3D scene on an offscreen canvas; titles and subtitles are drawn in 2D on top,
// on the visible canvas, which is what gets recorded.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;
export const VOICE_DELAY = 0.35;
const TAIL = 1.1;
const MIN_SECONDS = 15;
const ENTER = 0.5;
const EXIT = 0.35;
const FONT = "Inter, 'Segoe UI', Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', 'Source Serif Pro', serif";
const PAPER = "#F6F4EE";
const NAVY = "#1B2A4A";

const isAcademic = (board) => board.style === "academic";

function luminance(hex) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// Colours and type for the 2D titles. Academic reels are dark ink on paper; the rest are white on colour.
function themeFor(board) {
  if (!isAcademic(board)) {
    return {
      academic: false, headFont: FONT, bodyFont: FONT, ink: "#ffffff", soft: "rgba(255,255,255,0.86)",
      faint: "rgba(255,255,255,0.45)", track: "rgba(255,255,255,0.25)", fill: "rgba(255,255,255,0.95)",
      pill: "rgba(10,12,20,0.55)", pillText: "#fff", box: "rgba(8,10,18,0.62)", shadow: "rgba(0,0,0,0.35)",
      shade: ["rgba(0,0,0,0)", "rgba(0,0,0,0.42)", "rgba(0,0,0,0.72)"], fade: "0,0,0", headWeight: 800,
    };
  }
  const ink = luminance(board.palette[0]) < 0.35 ? board.palette[0] : NAVY;
  return {
    academic: true, headFont: SERIF, bodyFont: FONT, ink, soft: "rgba(27,42,74,0.82)", faint: "rgba(27,42,74,0.38)",
    track: "rgba(27,42,74,0.16)", fill: ink, pill: "rgba(255,255,255,0.92)", pillText: ink, box: "rgba(255,255,255,0.93)",
    shadow: "rgba(0,0,0,0)", shade: ["rgba(246,244,238,0)", "rgba(246,244,238,0.78)", "rgba(246,244,238,0.96)"],
    fade: "246,244,238", headWeight: 700,
  };
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeBack = (x) => {
  const c = 1.70158;
  const v = clamp(x) - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
};

// Scene timing follows the narration: each scene lasts as long as its share of the words.
export function buildTimeline(scenes, audioSeconds) {
  const words = scenes.map((s) => Math.max(1, s.narration.split(/\s+/).filter(Boolean).length));
  const totalWords = words.reduce((a, b) => a + b, 0);
  const speech = audioSeconds > 0 ? audioSeconds : totalWords / 2.6;
  const total = Math.max(MIN_SECONDS, VOICE_DELAY + speech + TAIL);
  let spoken = 0;
  const items = scenes.map((scene, index) => {
    const start = index === 0 ? 0 : VOICE_DELAY + (spoken / totalWords) * speech;
    spoken += words[index];
    const end = index === scenes.length - 1 ? total : VOICE_DELAY + (spoken / totalWords) * speech;
    return { scene, index, start, end, speechStart: Math.max(start, VOICE_DELAY), speechEnd: VOICE_DELAY + (spoken / totalWords) * speech };
  });
  return { items, total };
}

function color(hex) {
  return new THREE.Color(hex);
}

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function heroMaterial(style, base, accent) {
  switch (style) {
    case "neon":
      return new THREE.MeshStandardMaterial({ color: 0x07070c, emissive: base, emissiveIntensity: 0.9, metalness: 0.4, roughness: 0.25 });
    case "glass":
      return new THREE.MeshPhysicalMaterial({
        color: base, metalness: 0, roughness: 0.06, transmission: 0.92, thickness: 1.4, ior: 1.45,
        iridescence: 0.7, iridescenceIOR: 1.3, clearcoat: 1, clearcoatRoughness: 0.05, attenuationColor: accent,
        attenuationDistance: 2.5,
      });
    case "luxury":
      return new THREE.MeshPhysicalMaterial({ color: base.clone().lerp(new THREE.Color("#D4AF37"), 0.55), metalness: 1, roughness: 0.2, clearcoat: 0.6 });
    case "minimal":
      return new THREE.MeshStandardMaterial({ color: base, metalness: 0.05, roughness: 0.6 });
    case "bold":
      return new THREE.MeshStandardMaterial({ color: base, metalness: 0.25, roughness: 0.32, flatShading: true });
    case "playful":
      return new THREE.MeshToonMaterial({ color: base });
    case "academic":
      // Matte, paper-like and calm.
      return new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color("#ffffff"), 0.12), metalness: 0, roughness: 0.82 });
    default:
      return new THREE.MeshPhysicalMaterial({ color: base, metalness: 0.6, roughness: 0.2, clearcoat: 1 });
  }
}

function edgeLines(geometry, accent, opacity = 0.55) {
  const lines = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 25),
    new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  lines.scale.setScalar(1.002);
  return lines;
}

function wrapText(g, text, maxWidth, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function drawCover(g, image, x, y, w, h, radius = 18) {
  g.save();
  roundRect(g, x, y, w, h, radius);
  g.clip();
  if (image?.naturalWidth) {
    const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
    const iw = image.naturalWidth * scale;
    const ih = image.naturalHeight * scale;
    g.drawImage(image, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  } else {
    g.fillStyle = "#E5E7EB";
    g.fillRect(x, y, w, h);
  }
  g.restore();
}

function drawCursor(g, x, y, pressed) {
  g.save();
  g.translate(x, y);
  g.scale(pressed ? 0.9 : 1, pressed ? 0.9 : 1);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, 46);
  g.lineTo(12, 35);
  g.lineTo(21, 55);
  g.lineTo(30, 51);
  g.lineTo(21, 31);
  g.lineTo(37, 31);
  g.closePath();
  g.fillStyle = "#111827";
  g.strokeStyle = "#ffffff";
  g.lineWidth = 4;
  g.stroke();
  g.fill();
  g.restore();
}

// A website opening in a browser: the address is typed, a cursor clicks a link, the linked page
// loads and is read, scrolling, with the sentence being read highlighted. p is the scene's progress (0-1).
// The browser chrome: traffic lights, the address being typed, and a loading bar.
function drawWindowBar(g, W, address, p, accent, loading) {
  g.fillStyle = "#F1F3F5";
  g.fillRect(0, 0, W, 96);
  ["#FF5F57", "#FEBC2E", "#28C840"].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(40 + i * 30, 48, 10, 0, Math.PI * 2);
    g.fill();
  });
  g.fillStyle = "#ffffff";
  roundRect(g, 140, 24, W - 170, 48, 24);
  g.fill();
  const typed = p < 0.12 ? address.slice(0, Math.ceil((p / 0.12) * address.length)) : address;
  g.fillStyle = "#16A34A";
  g.font = `700 22px ${FONT}`;
  g.fillText("🔒", 162, 56);
  g.fillStyle = "#374151";
  g.font = `500 24px ${FONT}`;
  g.fillText(typed.slice(0, 48), 196, 57);
  if (loading > 0 && loading < 1) {
    g.fillStyle = accent;
    g.fillRect(0, 92, W * loading, 5);
  }
}

// One page, read from the top: the address is typed, the page loads, and it scrolls while a
// highlight follows the reading. Nothing else on the site is opened.
// The real page, as Chromium showed it on the server, scrolled from the top.
function drawScreenshot(g, W, H, p, info, scrollFrom = 0.28, scrollTo = 0.95) {
  const top = 96;
  const shot = info.shot;
  const scale = W / shot.naturalWidth;
  const pageH = shot.naturalHeight * scale;
  const visible = H - top;
  const maxScroll = Math.max(0, Math.min(pageH - visible, 2600));
  const scroll = easeInOut(clamp((p - scrollFrom) / (scrollTo - scrollFrom))) * maxScroll;
  const loaded = easeOut(clamp((p - 0.13) / 0.1));
  g.save();
  g.beginPath();
  g.rect(0, top, W, H - top);
  g.clip();
  g.fillStyle = "#ffffff";
  g.fillRect(0, top, W, H - top);
  g.globalAlpha = loaded;
  g.drawImage(shot, 0, top - scroll + (1 - loaded) * 30, W, pageH);
  g.restore();
  if (maxScroll > 0) {
    const trackH = H - top - 30;
    const thumbH = Math.max(80, trackH * (visible / (visible + maxScroll)));
    g.fillStyle = "rgba(0,0,0,0.25)";
    roundRect(g, W - 14, top + 12 + (trackH - thumbH) * (scroll / maxScroll), 7, thumbH, 4);
    g.fill();
  }
  return scroll;
}

function drawReading(g, W, H, p, info) {
  const { palette, academic } = info;
  const accent = academic ? NAVY : palette[0];
  if (info.shot?.naturalWidth && !info.article) {
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#ffffff";
    roundRect(g, 0, 0, W, H, 34);
    g.fill();
    g.save();
    roundRect(g, 0, 0, W, H, 34);
    g.clip();
    drawScreenshot(g, W, H, p, info);
    drawWindowBar(g, W, `${info.host}${info.path && info.path !== "/" ? info.path : ""}`, p, accent, clamp((p - 0.12) / 0.12));
    const settle = easeInOut(clamp((p - 0.18) / 0.2));
    drawCursor(g, W * 0.72 - W * 0.12 * settle + Math.sin(p * 14) * 8, H * 0.8 - H * 0.25 * settle + Math.cos(p * 11) * 10, false);
    g.restore();
    return;
  }
  const article = info.article;
  const top = 96;
  const pad = 44;
  const serif = academic || Boolean(article);
  g.clearRect(0, 0, W, H);
  g.fillStyle = academic ? "#FCFBF8" : "#ffffff";
  roundRect(g, 0, 0, W, H, 34);
  g.fill();
  g.save();
  roundRect(g, 0, 0, W, H, 34);
  g.clip();

  const loaded = easeOut(clamp((p - 0.13) / 0.1));
  const ops = [];
  let y = top + 70;
  const label = (article?.journal || info.siteName || info.host || "").toUpperCase().slice(0, 44);
  if (label) {
    ops.push({ kind: "label", text: label, y });
    y += 50;
  }
  g.font = `${serif ? 700 : 800} 46px ${serif ? SERIF : FONT}`;
  wrapText(g, article?.title || info.title || info.host, W - pad * 2, 4).forEach((line) => {
    ops.push({ kind: "title", text: line, y });
    y += 56;
  });
  if (article?.authors?.length) {
    y += 8;
    g.font = `italic 400 27px ${SERIF}`;
    wrapText(g, article.authors.join(", "), W - pad * 2, 2).forEach((line) => {
      ops.push({ kind: "authors", text: line, y });
      y += 36;
    });
  }
  const metaLine = [article?.date?.slice(0, 4), article?.doi ? `DOI ${article.doi}` : ""].filter(Boolean).join("  ·  ");
  if (metaLine) {
    ops.push({ kind: "meta", text: metaLine, y });
    y += 40;
  }
  ops.push({ kind: "rule", y });
  y += 34;
  const image = info.images[info.hero];
  if (image?.naturalWidth) {
    ops.push({ kind: "image", y, h: 400 });
    y += 440;
  }
  // For an article: its abstract, then the text from the introduction on (not the author block).
  const intro = (info.text || "").search(/\bintroduction\b/i);
  const bodyText = article?.abstract
    ? `${article.abstract} ${intro >= 0 ? info.text.slice(intro) : ""}`
    : `${info.description || ""} ${info.text || ""}`;
  if (article?.abstract) {
    ops.push({ kind: "heading", text: "Abstract", y: y + 10 });
    y += 60;
  }
  g.font = `400 29px ${serif ? SERIF : FONT}`;
  const body = wrapText(g, bodyText.replace(/^Abstract:\s*/i, "").trim(), W - pad * 2, 30);
  const bodyStart = ops.length;
  body.forEach((line) => {
    ops.push({ kind: "body", text: line, y: y + 30 });
    y += 44;
  });
  const visible = H - top - 60;
  const maxScroll = Math.max(0, y - top - visible);
  const scroll = easeInOut(clamp((p - 0.3) / 0.66)) * maxScroll;
  const reading = bodyStart + Math.floor(clamp((p - 0.26) / 0.72) * Math.max(1, body.length - 1));

  g.save();
  g.beginPath();
  g.rect(0, top, W, H - top);
  g.clip();
  g.globalAlpha = loaded;
  g.translate(0, -scroll + (1 - loaded) * 40);
  let readingY = H * 0.6;
  ops.forEach((op, i) => {
    switch (op.kind) {
      case "label":
        g.fillStyle = academic ? "#8A6D3B" : accent;
        g.font = `700 21px ${FONT}`;
        g.fillText(op.text, pad, op.y);
        break;
      case "title":
        g.fillStyle = academic ? NAVY : "#111827";
        g.font = `${serif ? 700 : 800} 46px ${serif ? SERIF : FONT}`;
        g.fillText(op.text, pad, op.y);
        break;
      case "authors":
        g.fillStyle = "#374151";
        g.font = `italic 400 27px ${SERIF}`;
        g.fillText(op.text, pad, op.y);
        break;
      case "meta":
        g.fillStyle = "#6B7280";
        g.font = `500 21px ${FONT}`;
        g.fillText(op.text, pad, op.y);
        break;
      case "rule":
        g.fillStyle = academic ? "rgba(27,42,74,0.25)" : "#E5E7EB";
        g.fillRect(pad, op.y, W - pad * 2, 2);
        g.fillStyle = academic ? NAVY : accent;
        g.fillRect(pad, op.y, 120, 2);
        break;
      case "image":
        drawCover(g, image, pad, op.y, W - pad * 2, op.h, 18);
        break;
      case "heading":
        g.fillStyle = academic ? NAVY : "#111827";
        g.font = `700 30px ${serif ? SERIF : FONT}`;
        g.fillText(op.text, pad, op.y);
        break;
      default: {
        const active = i === reading;
        if (active) {
          g.fillStyle = academic ? "rgba(27,42,74,0.10)" : `${palette[2]}33`;
          g.fillRect(pad - 12, op.y - 32, W - pad * 2 + 24, 44);
          readingY = op.y - scroll;
        }
        g.fillStyle = i <= reading ? "#111827" : "#9CA3AF";
        g.font = `400 29px ${serif ? SERIF : FONT}`;
        g.fillText(op.text, pad, op.y);
      }
    }
  });
  g.restore();

  // Scrollbar.
  if (maxScroll > 0) {
    const trackH = H - top - 30;
    const thumbH = Math.max(80, trackH * (visible / (visible + maxScroll)));
    g.fillStyle = "rgba(0,0,0,0.08)";
    roundRect(g, W - 16, top + 12, 8, trackH, 4);
    g.fill();
    g.fillStyle = "rgba(0,0,0,0.3)";
    roundRect(g, W - 16, top + 12 + (trackH - thumbH) * (scroll / maxScroll), 8, thumbH, 4);
    g.fill();
  }

  drawWindowBar(g, W, `${info.host}${info.path && info.path !== "/" ? info.path : ""}`, p, accent, clamp((p - 0.12) / 0.12));

  // The cursor follows the line being read.
  const settle = easeInOut(clamp((p - 0.18) / 0.14));
  const cx = W * 0.7 + (W * 0.82 - W * 0.7) * settle + Math.sin(p * 18) * 6;
  const cy = H * 0.8 + (clamp(readingY, top + 60, H - 60) + 8 - H * 0.8) * settle;
  drawCursor(g, cx, cy, false);
  g.restore();
}

function drawBrowser(g, W, H, p, info) {
  if (!info.page && info.single) {
    drawReading(g, W, H, p, info);
    return;
  }
  const { palette, academic } = info;
  const accent = academic ? NAVY : palette[0];
  const page = info.page;
  const links = info.links.length ? info.links.slice(0, 4) : ["Home", "About", "Work", "Contact"];
  if (page && !links.includes(page.label)) links[Math.min(links.length - 1, 1)] = page.label;
  const targetIndex = page ? links.indexOf(page.label) : Math.min(1, links.length - 1);

  g.clearRect(0, 0, W, H);
  g.fillStyle = "#ffffff";
  roundRect(g, 0, 0, W, H, 34);
  g.fill();
  g.save();
  roundRect(g, 0, 0, W, H, 34);
  g.clip();

  const top = 96;
  const slide = page ? easeInOut(clamp((p - 0.46) / 0.1)) : 0;
  // Page content stays below the browser bar, however far it scrolls.
  g.save();
  g.beginPath();
  g.rect(0, top, W, H - top);
  g.clip();
  // --- The home page ---
  g.save();
  g.translate(-slide * W, 0);
  g.fillStyle = "#ffffff";
  g.fillRect(0, top, W, H - top);
  if (info.shot?.naturalWidth) {
    // The real page; it scrolls a little before the cursor heads for the link.
    drawScreenshot(g, W, H, Math.min(p, 0.4), info, 0.12, 0.6);
    g.fillStyle = "rgba(255,255,255,0.94)";
    g.fillRect(0, top, W, 92);
  }
  g.fillStyle = academic ? NAVY : "#111827";
  g.font = `800 30px ${academic ? SERIF : FONT}`;
  if (!info.shot?.naturalWidth) g.fillText((info.brand || info.host).slice(0, 22), 40, top + 62);
  g.font = `600 22px ${FONT}`;
  let lx = W - 40;
  const linkBoxes = [];
  [...links].reverse().forEach((label, ri) => {
    const i = links.length - 1 - ri;
    const text = label.slice(0, 16);
    const w = g.measureText(text).width;
    lx -= w;
    linkBoxes[i] = { x: lx, y: top + 62, w };
    lx -= 28;
  });
  const clicked = p > 0.4;
  const hover = p > 0.32;
  links.forEach((label, i) => {
    const box = linkBoxes[i];
    if (box.x < 300) return;
    const active = i === targetIndex && hover;
    g.fillStyle = active ? accent : "#4B5563";
    g.fillText(label.slice(0, 16), box.x, box.y);
    if (active) g.fillRect(box.x, box.y + 10, box.w, 3);
  });
  if (!info.shot?.naturalWidth) {
    drawCover(g, info.images[info.hero], 40, top + 110, W - 80, 470, 24);
    g.fillStyle = academic ? NAVY : "#111827";
    g.font = `${academic ? 700 : 800} 50px ${academic ? SERIF : FONT}`;
    const titleLines = wrapText(g, info.title || info.host, W - 80, 3);
    titleLines.forEach((line, i) => g.fillText(line, 40, top + 650 + i * 60));
    g.fillStyle = "#4B5563";
    g.font = `400 27px ${FONT}`;
    wrapText(g, info.description || info.text, W - 80, 6).forEach((line, i) => g.fillText(line, 40, top + 670 + titleLines.length * 60 + i * 40));
  }
  g.restore();

  // --- The linked page, which slides in after the click ---
  if (page && slide > 0 && page.shotImage?.naturalWidth) {
    // The linked page as it really looks, scrolling while it is read.
    g.save();
    g.translate((1 - slide) * W, 0);
    drawScreenshot(g, W, H, p, { shot: page.shotImage }, 0.6, 0.98);
    g.restore();
  } else if (page && slide > 0) {
    g.save();
    g.translate((1 - slide) * W, 0);
    g.fillStyle = academic ? "#FCFBF8" : "#ffffff";
    g.fillRect(0, top, W, H - top);
    const scroll = easeInOut(clamp((p - 0.62) / 0.38)) * 220;
    g.translate(0, -scroll);
    g.fillStyle = "#6B7280";
    g.font = `500 22px ${FONT}`;
    g.fillText(`${info.host} › ${page.label}`.slice(0, 60), 40, top + 56);
    g.fillStyle = academic ? NAVY : "#111827";
    g.font = `${academic ? 700 : 800} 46px ${academic ? SERIF : FONT}`;
    const pageTitle = wrapText(g, page.title || page.label, W - 80, 3);
    pageTitle.forEach((line, i) => g.fillText(line, 40, top + 120 + i * 56));
    const imageY = top + 150 + pageTitle.length * 56;
    const pageImage = page.image >= 0 ? info.images[page.image] : null;
    let y = imageY;
    if (pageImage?.naturalWidth) {
      drawCover(g, pageImage, 40, imageY, W - 80, 380, 20);
      y += 430;
    }
    g.font = `400 29px ${academic ? SERIF : FONT}`;
    const body = wrapText(g, `${page.description} ${page.text}`.trim(), W - 80, 22);
    // Reading: a soft highlight moves down the lines as the page is read.
    const reading = Math.floor(clamp((p - 0.6) / 0.38) * Math.max(1, body.length - 1));
    body.forEach((line, i) => {
      const ly = y + 30 + i * 44;
      if (i === reading) {
        g.fillStyle = academic ? "rgba(27,42,74,0.10)" : `${palette[2]}33`;
        g.fillRect(30, ly - 32, W - 60, 44);
      }
      g.fillStyle = i <= reading ? "#111827" : "#6B7280";
      g.fillText(line, 40, ly);
    });
    g.restore();
  }

  g.restore();

  // Window bar and address bar.
  g.fillStyle = "#F1F3F5";
  g.fillRect(0, 0, W, 96);
  ["#FF5F57", "#FEBC2E", "#28C840"].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(40 + i * 30, 48, 10, 0, Math.PI * 2);
    g.fill();
  });
  g.fillStyle = "#ffffff";
  roundRect(g, 140, 24, W - 170, 48, 24);
  g.fill();
  const opened = page && p > 0.5;
  const address = `${info.host}${opened ? page.path : ""}`;
  const typed = p < 0.14 ? address.slice(0, Math.ceil((p / 0.14) * address.length)) : address;
  g.fillStyle = "#16A34A";
  g.font = `700 22px ${FONT}`;
  g.fillText("🔒", 162, 56);
  g.fillStyle = "#374151";
  g.font = `500 24px ${FONT}`;
  g.fillText(typed.slice(0, 48), 196, 57);
  // Loading bar after the click.
  if (p > 0.42 && p < 0.56) {
    g.fillStyle = accent;
    g.fillRect(0, 92, W * clamp((p - 0.42) / 0.12), 5);
  }


  // --- The cursor ---
  const box = linkBoxes[targetIndex] ?? { x: W * 0.6, y: top + 62, w: 60 };
  const startX = W * 0.62;
  const startY = H * 0.78;
  const move = easeInOut(clamp((p - 0.14) / 0.24));
  let cx = startX + (box.x + box.w / 2 - startX) * move;
  let cy = startY + (box.y - 8 - startY) * move;
  if (page && p > 0.56) {
    // After the click the cursor drifts down the page, following the reading.
    const drift = easeInOut(clamp((p - 0.56) / 0.4));
    cx = box.x + box.w / 2 + (W * 0.45 - box.x - box.w / 2) * drift;
    cy = box.y - 8 + (H * 0.62 - box.y) * drift;
  }
  const pressed = p > 0.39 && p < 0.44;
  if (clicked && p < 0.52) {
    const r = clamp((p - 0.4) / 0.1);
    g.strokeStyle = accent;
    g.globalAlpha = 1 - r;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(cx, cy, 20 + r * 60, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }
  drawCursor(g, cx, cy, pressed);
  g.restore();
}

// Builds the 3D object for one scene. Returns the group and a per-frame update function.
function buildHero(visual, style, palette, siteTexture, brand, dot, media = {}) {
  const [primary, secondary, accent] = palette.map(color);
  const group = new THREE.Group();
  const disposables = [];
  const track = (...items) => { disposables.push(...items); return items[0]; };
  const material = track(heroMaterial(style, primary, accent));
  const material2 = track(heroMaterial(style, secondary, accent));
  let update = () => {};

  const add = (geometry, mat = material, lines = style === "neon" || style === "bold") => {
    track(geometry);
    const mesh = new THREE.Mesh(geometry, mat);
    group.add(mesh);
    if (lines) {
      const edges = edgeLines(geometry, accent, style === "neon" ? 0.9 : 0.35);
      track(edges.geometry, edges.material);
      mesh.add(edges);
    }
    return mesh;
  };

  switch (visual) {
    case "cube": {
      const mesh = add(new THREE.BoxGeometry(1.35, 1.35, 1.35, 2, 2, 2), material, true);
      const inner = add(new THREE.BoxGeometry(0.6, 0.6, 0.6), material2, false);
      update = (t) => {
        mesh.rotation.set(t * 0.55, t * 0.8, 0.2);
        inner.rotation.set(-t * 1.1, -t * 0.7, 0);
      };
      break;
    }
    case "sphere": {
      const mesh = add(new THREE.IcosahedronGeometry(1.05, 12), material, false);
      const shell = new THREE.Mesh(
        track(new THREE.IcosahedronGeometry(1.32, 2)),
        track(new THREE.MeshBasicMaterial({ color: accent, wireframe: true, transparent: true, opacity: 0.35 })),
      );
      group.add(shell);
      update = (t) => {
        mesh.rotation.y = t * 0.4;
        shell.rotation.set(t * 0.2, -t * 0.3, 0);
        const s = 1 + Math.sin(t * 2.2) * 0.03;
        mesh.scale.setScalar(s);
      };
      break;
    }
    case "torus": {
      const mesh = add(new THREE.TorusGeometry(0.95, 0.36, 64, 180));
      update = (t) => mesh.rotation.set(t * 0.6 + 0.6, t * 0.9, 0);
      break;
    }
    case "knot": {
      const mesh = add(new THREE.TorusKnotGeometry(0.78, 0.26, 260, 36), material, false);
      update = (t) => mesh.rotation.set(t * 0.35, t * 0.6, 0);
      break;
    }
    case "rings": {
      const rings = [0, 1, 2].map((i) => {
        const ring = add(new THREE.TorusGeometry(1.25 - i * 0.28, 0.06, 24, 160), i === 1 ? material2 : material, false);
        return ring;
      });
      const core = add(new THREE.IcosahedronGeometry(0.32, 4), material2, false);
      update = (t) => {
        rings[0].rotation.set(t * 0.8, 0, t * 0.2);
        rings[1].rotation.set(0, t * 1.1, Math.PI / 4);
        rings[2].rotation.set(t * 1.4, t * 0.5, 0);
        core.rotation.y = t;
      };
      break;
    }
    case "crystal": {
      const mesh = add(new THREE.OctahedronGeometry(1.2, 0), material, true);
      const small = [0, 1, 2].map((i) => {
        const s = add(new THREE.OctahedronGeometry(0.22, 0), material2, false);
        s.userData.phase = (i / 3) * Math.PI * 2;
        return s;
      });
      update = (t) => {
        mesh.rotation.set(0.3, t * 0.7, Math.sin(t) * 0.15);
        small.forEach((s) => {
          const a = t * 1.2 + s.userData.phase;
          s.position.set(Math.cos(a) * 1.7, Math.sin(a * 1.3) * 0.5, Math.sin(a) * 1.7);
          s.rotation.set(t, t * 1.5, 0);
        });
      };
      break;
    }
    case "wave": {
      const geometry = track(new THREE.PlaneGeometry(4.2, 4.2, 70, 70));
      const points = new THREE.Points(
        geometry,
        track(new THREE.PointsMaterial({
          size: 0.055, map: dot, color: accent, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        })),
      );
      points.rotation.x = -Math.PI / 2.6;
      group.add(points);
      const base = geometry.attributes.position.array.slice();
      update = (t) => {
        const pos = geometry.attributes.position.array;
        for (let i = 0; i < pos.length; i += 3) {
          const x = base[i];
          const y = base[i + 1];
          pos[i + 2] = Math.sin(x * 1.6 + t * 2) * 0.28 + Math.cos(y * 1.9 + t * 1.4) * 0.22;
        }
        geometry.attributes.position.needsUpdate = true;
        points.rotation.z = t * 0.12;
      };
      break;
    }
    case "particles": {
      const count = 1400;
      const positions = new Float32Array(count * 3);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < count; i += 1) {
        const y = 1 - (i / (count - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = golden * i;
        positions.set([Math.cos(theta) * r * 1.3, y * 1.3, Math.sin(theta) * r * 1.3], i * 3);
      }
      const geometry = track(new THREE.BufferGeometry());
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const points = new THREE.Points(geometry, track(new THREE.PointsMaterial({
        size: 0.06, map: dot, color: primary.clone().lerp(accent, 0.4), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      })));
      group.add(points);
      const core = add(new THREE.IcosahedronGeometry(0.45, 3), material2, false);
      update = (t) => {
        points.rotation.set(t * 0.15, t * 0.35, 0);
        points.scale.setScalar(1 + Math.sin(t * 1.8) * 0.05);
        core.rotation.set(t * 0.5, t, 0);
      };
      break;
    }
    case "browser": {
      const W = 900;
      const H = 1400;
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d");
      const texture = track(new THREE.CanvasTexture(c));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      const h = 2.3;
      const w = h * (W / H);
      const frameMat = track(new THREE.MeshStandardMaterial({ color: media.academic ? "#D9D6CC" : "#1F2433", roughness: 0.5, metalness: 0.2 }));
      const screen = new THREE.Mesh(
        track(new THREE.BoxGeometry(w, h, 0.05)),
        [frameMat, frameMat, frameMat, frameMat, track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })), frameMat],
      );
      group.add(screen);
      const glow = new THREE.Mesh(
        track(new THREE.PlaneGeometry(w * 1.5, h * 1.3)),
        track(new THREE.MeshBasicMaterial({
          map: dot, color: media.academic ? "#1B2A4A" : accent, transparent: true, opacity: media.academic ? 0.12 : 0.5,
          depthWrite: false, blending: media.academic ? THREE.NormalBlending : THREE.AdditiveBlending,
        })),
      );
      glow.position.set(0, 0.38, -0.35);
      group.add(glow);
      update = (t, progress = 0) => {
        drawBrowser(g, W, H, clamp(progress), media.browserInfo);
        texture.needsUpdate = true;
        // Opens with a turn toward the viewer, then settles and floats while the page is read.
        const settle = easeOut(clamp(progress / 0.18));
        screen.rotation.set(-0.05 + Math.sin(t * 0.8) * 0.02, (1 - settle) * -0.55 + Math.sin(t * 0.6) * 0.07, 0);
        screen.position.y = 0.38 + Math.sin(t * 1.1) * 0.03;
        glow.rotation.copy(screen.rotation);
      };
      break;
    }
    case "gallery": {
      const textures = media.textures?.length ? media.textures : siteTexture ? [siteTexture] : [];
      const cards = [];
      const count = Math.max(textures.length, 1);
      const radius = count > 1 ? 1.9 : 0;
      const frameMat = track(new THREE.MeshStandardMaterial({ color: media.academic ? "#ffffff" : "#0E1117", roughness: 0.4, metalness: 0.1 }));
      (textures.length ? textures : [null]).forEach((texture, i) => {
        const image = texture?.image;
        const aspect = image?.width ? image.width / image.height : 1.4;
        const cw = aspect >= 1 ? 1.55 : 1.55 * aspect;
        const ch = aspect >= 1 ? 1.55 / aspect : 1.55;
        const face = texture
          ? track(new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }))
          : material;
        const card = new THREE.Mesh(track(new THREE.BoxGeometry(cw, ch, 0.04)), [frameMat, frameMat, frameMat, frameMat, face, frameMat]);
        card.userData.angle = (i / count) * Math.PI * 2;
        group.add(card);
        cards.push(card);
      });
      const focus = media.focus >= 0 && media.focus < count ? media.focus : 0;
      update = (t, progress = 0) => {
        // The ring turns so the scene's own image comes to the front halfway through.
        const spin = -cards[focus].userData.angle + (0.5 - clamp(progress)) * Math.PI * 0.9;
        cards.forEach((card) => {
          const a = card.userData.angle + spin;
          card.position.set(Math.sin(a) * radius, Math.sin(t * 1.2 + card.userData.angle) * 0.08, Math.cos(a) * radius - (radius ? 0.6 : 0));
          card.rotation.set(0, a, 0);
          const front = (Math.cos(a) + 1) / 2;
          card.scale.setScalar(0.75 + front * 0.35);
        });
      };
      break;
    }
    default: {
      // "card": the site's own image on a floating glass card, or the brand initial if there is none.
      let texture = media.textures?.[media.focus] ?? siteTexture;
      if (!texture) {
        const c = document.createElement("canvas");
        c.width = c.height = 512;
        const g = c.getContext("2d");
        const grad = g.createLinearGradient(0, 0, 512, 512);
        grad.addColorStop(0, palette[0]);
        grad.addColorStop(1, palette[1]);
        g.fillStyle = grad;
        g.fillRect(0, 0, 512, 512);
        g.fillStyle = "rgba(255,255,255,0.92)";
        g.font = `800 260px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText((brand || "•").trim().charAt(0).toUpperCase(), 256, 270);
        texture = track(new THREE.CanvasTexture(c));
        texture.colorSpace = THREE.SRGBColorSpace;
      }
      const aspect = texture.image ? texture.image.width / texture.image.height : 1;
      const w = aspect >= 1 ? 2.2 : 2.2 * aspect;
      const h = aspect >= 1 ? 2.2 / aspect : 2.2;
      const card = new THREE.Mesh(
        track(new THREE.BoxGeometry(w, h, 0.06)),
        [
          material, material, material, material,
          track(new THREE.MeshPhysicalMaterial({ map: texture, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 })),
          material,
        ],
      );
      group.add(card);
      const glow = new THREE.Mesh(
        track(new THREE.PlaneGeometry(w * 1.35, h * 1.35)),
        track(new THREE.MeshBasicMaterial({ map: dot, color: accent, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending })),
      );
      glow.position.z = -0.3;
      group.add(glow);
      update = (t) => {
        card.rotation.set(Math.sin(t * 0.9) * 0.12 - 0.08, Math.sin(t * 0.7) * 0.38, 0);
        card.position.y = Math.sin(t * 1.3) * 0.06;
        glow.rotation.copy(card.rotation);
      };
    }
  }
  return { group, update, disposables };
}

function cameraFor(kind, local, t) {
  const p = easeInOut(clamp(local));
  switch (kind) {
    case "dolly":
      return { pos: [Math.sin(t * 0.3) * 0.3, 1.25, 8.2 - p * 1.8], look: [0, 1.15, 0] };
    case "rise":
      return { pos: [0.4, 0.2 + p * 1.9, 7.2], look: [0, 1.15, 0] };
    case "sweep":
      return { pos: [-2.2 + p * 4.4, 1.3, 7], look: [0, 1.15, 0] };
    default: {
      const a = -0.7 + p * 1.4;
      return { pos: [Math.sin(a) * 7.1, 1.4, Math.cos(a) * 7.1], look: [0, 1.15, 0] };
    }
  }
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const FORMATS = ["cinematic", "kinetic", "split", "news", "spotlight"];
const SUBTITLE_TOP = HEIGHT - 340;

function wrapCount(ctx, text, th) {
  ctx.save();
  ctx.font = `${th.headWeight} 104px ${th.headFont}`;
  const n = wrap(ctx, text, WIDTH - 140).length;
  ctx.restore();
  return n;
}

// A small label such as "NEW RESEARCH", above the headline.
function drawKicker(ctx, text, x, y, th, accent, alpha, centered = false) {
  if (!text) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 34px ${FONT}`;
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 64;
  const left = centered ? (WIDTH - w) / 2 : x;
  ctx.fillStyle = th.academic ? th.ink : accent;
  roundRect(ctx, left, y - 30, w, 60, th.academic ? 6 : 30);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, left + 32, y + 2);
  ctx.restore();
}

// The reel's top hashtags, shown at the end.
function drawTags(ctx, tags, x, y, th, alpha, centered) {
  if (!tags?.length || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 36px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = th.soft;
  const text = tags.slice(0, 3).join("  ");
  ctx.fillText(text, centered ? (WIDTH - ctx.measureText(text).width) / 2 : x, y);
  ctx.restore();
}

function drawCta(ctx, o, x, y, centered, compact = false) {
  const { board, th, local, host } = o;
  const [primary, , accent] = board.palette;
  const ctaIn = easeBack((local - 0.4) / 0.6);
  ctx.save();
  ctx.globalAlpha = clamp(ctaIn);
  ctx.font = `800 50px ${FONT}`;
  const w = ctx.measureText(board.cta).width + 120;
  const left = centered ? (WIDTH - w) / 2 : x;
  const cg = ctx.createLinearGradient(left, y, left + w, y + 110);
  cg.addColorStop(0, primary);
  cg.addColorStop(1, accent);
  ctx.translate(left + w / 2, y + 55);
  ctx.scale(0.85 + 0.15 * ctaIn, 0.85 + 0.15 * ctaIn);
  ctx.fillStyle = th.academic ? th.ink : cg;
  roundRect(ctx, -w / 2, -55, w, 110, th.academic ? 14 : 55);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(board.cta, -w / 2 + 60, 2);
  ctx.restore();
  // Host and hashtags only where they clear the subtitles.
  if (compact || y + 190 > SUBTITLE_TOP) return;
  ctx.save();
  ctx.globalAlpha = clamp((local - 0.7) / 0.5);
  ctx.font = `600 40px ${FONT}`;
  ctx.fillStyle = th.soft;
  const hw = ctx.measureText(host).width;
  ctx.fillText(host, centered ? (WIDTH - hw) / 2 : x, y + 180);
  ctx.restore();
  if (y + 260 <= SUBTITLE_TOP) drawTags(ctx, board.hashtags, x, y + 250, th, clamp((local - 0.9) / 0.5), centered);
}

// Fits text in at most ``maxLines`` lines, stepping the font size down.
function fitLines(ctx, text, sizes, weight, font, maxWidth, maxLines) {
  for (const size of sizes) {
    ctx.font = `${weight} ${size}px ${font}`;
    const lines = wrap(ctx, text, maxWidth);
    const fits = lines.length <= maxLines && lines.every((line) => ctx.measureText(line).width <= maxWidth);
    if (fits || size === sizes[sizes.length - 1]) return { lines: lines.slice(0, maxLines), size };
  }
  return { lines: [text], size: sizes[0] };
}

// Headline, kicker, subline and call to action for the formats other than "cinematic".
function drawFormatText(fmt, ctx, o) {
  const { local, alpha, enter, exit, scene, board, th, isLast, index, count, t } = o;
  const [primary, secondary, accent] = board.palette;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  if (fmt === "kinetic") {
    // Huge words punch in one by one at the centre; the key word sits on a colour block.
    const { lines, size } = fitLines(ctx, scene.headline.toUpperCase(), th.academic ? [124, 108, 92, 80] : [156, 136, 116, 100, 88],
      th.headWeight === 800 ? 900 : 700, th.headFont, WIDTH - 160, 4);
    const lineH = size * 1.06;
    const blockH = lines.length * lineH;
    const top = (isLast ? 940 : 1080) - blockH / 2;
    // A soft wash behind the words, so they read over any 3D scene.
    const wash = ctx.createLinearGradient(0, top - 160, 0, top + blockH + 220);
    const tint = th.academic ? "246,244,238" : "5,7,15";
    wash.addColorStop(0, `rgba(${tint},0)`);
    wash.addColorStop(0.3, `rgba(${tint},${th.academic ? 0.7 : 0.5})`);
    wash.addColorStop(0.7, `rgba(${tint},${th.academic ? 0.7 : 0.5})`);
    wash.addColorStop(1, `rgba(${tint},0)`);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = wash;
    ctx.fillRect(0, top - 160, WIDTH, blockH + 380);
    const allWords = lines.join(" ").split(" ");
    const key = allWords.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (board.kicker) drawKicker(ctx, board.kicker, 0, top - 70, th, accent, alpha, true);
    let wi = 0;
    lines.forEach((line, li) => {
      const lineW = ctx.measureText(line).width;
      let x = (WIDTH - lineW) / 2;
      const y = top + (li + 1) * lineH - size * 0.18;
      line.split(" ").forEach((word) => {
        const r = clamp((local - 0.04 - wi * 0.11) / 0.22);
        const w = ctx.measureText(word).width;
        const pop = 1 + (1 - easeBack(r)) * 0.55;
        ctx.save();
        ctx.globalAlpha = alpha * clamp(r * 2);
        ctx.translate(x + w / 2, y - size * 0.35);
        ctx.scale(pop, pop);
        if (word === key && !th.academic) {
          ctx.fillStyle = accent;
          roundRect(ctx, -w / 2 - 16, -size * 0.62, w + 32, size * 1.02, 18);
          ctx.fill();
        }
        ctx.fillStyle = th.ink;
        ctx.shadowColor = th.shadow;
        ctx.shadowBlur = th.academic ? 0 : 30;
        ctx.fillText(word, -w / 2, size * 0.35);
        if (word === key && th.academic) ctx.fillRect(-w / 2, size * 0.45, w, 6);
        ctx.restore();
        x += w + ctx.measureText(" ").width;
        wi += 1;
      });
    });
    ctx.globalAlpha = alpha * clamp((local - 0.5) / 0.4);
    ctx.font = th.academic ? `italic 400 44px ${SERIF}` : `600 44px ${FONT}`;
    ctx.fillStyle = th.soft;
    const sub = wrap(ctx, scene.subline || "", WIDTH - 160).slice(0, 2);
    sub.forEach((line, i) => ctx.fillText(line, (WIDTH - ctx.measureText(line).width) / 2, top + blockH + 70 + i * 56));
    if (isLast && board.cta) drawCta(ctx, o, 0, top + blockH + 90 + sub.length * 56, true);
    // A white flash on each cut, like a beat drop.
    if (index > 0 && !th.academic) {
      ctx.globalAlpha = 0.35 * (1 - clamp(local / 0.18));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
  } else if (fmt === "split") {
    // A solid text panel slides in under the 3D scene, like a story deck.
    const slide = (1 - easeOut(clamp(local / 0.45))) * WIDTH * 0.7 - (1 - exit) * WIDTH * 0.7;
    const x0 = 48 + slide;
    const y0 = 1010;
    const h = 560;
    ctx.globalAlpha = clamp(Math.min(enter * 1.5, exit + 0.2));
    const panel = ctx.createLinearGradient(x0, y0, x0 + WIDTH, y0 + h);
    if (th.academic) {
      panel.addColorStop(0, "rgba(255,255,255,0.97)");
      panel.addColorStop(1, "rgba(250,248,243,0.97)");
    } else {
      panel.addColorStop(0, "rgba(10,12,22,0.88)");
      panel.addColorStop(1, "rgba(20,16,40,0.88)");
    }
    ctx.fillStyle = panel;
    roundRect(ctx, x0, y0, WIDTH - 96, h, th.academic ? 16 : 40);
    ctx.fill();
    const stripe = ctx.createLinearGradient(0, y0, 0, y0 + h);
    stripe.addColorStop(0, primary);
    stripe.addColorStop(1, accent);
    ctx.fillStyle = th.academic ? th.ink : stripe;
    roundRect(ctx, x0, y0 + 40, 12, h - 80, 6);
    ctx.fill();
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = th.faint;
    const counter = `${String(index + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`;
    ctx.fillText(counter, x0 + WIDTH - 96 - ctx.measureText(counter).width - 40, y0 + 70);
    if (board.kicker) {
      ctx.font = `800 30px ${FONT}`;
      ctx.fillStyle = th.academic ? th.ink : accent;
      ctx.fillText(board.kicker, x0 + 60, y0 + 70);
    }
    const { lines, size } = fitLines(ctx, scene.headline, [88, 76, 66], th.headWeight, th.headFont, WIDTH - 220, 3);
    ctx.fillStyle = th.academic ? th.ink : "#fff";
    lines.forEach((line, i) => {
      ctx.globalAlpha = alpha * clamp((local - 0.15 - i * 0.08) / 0.3);
      ctx.fillText(line, x0 + 60, y0 + 160 + i * size * 1.1);
    });
    ctx.globalAlpha = alpha * clamp((local - 0.4) / 0.4);
    ctx.font = th.academic ? `italic 400 40px ${SERIF}` : `500 40px ${FONT}`;
    ctx.fillStyle = th.soft;
    const subY = y0 + 170 + lines.length * size * 1.1;
    if (isLast && board.cta) {
      ctx.globalAlpha = 1;
      drawCta(ctx, o, x0 + 60, subY - 20, false, true);
    } else {
      wrap(ctx, scene.subline || "", WIDTH - 220).slice(0, 3).forEach((line, i) => ctx.fillText(line, x0 + 60, subY + i * 52));
    }
  } else if (fmt === "news") {
    // Kicker, headline on colour bars that slide in, and a ticker along the bottom.
    const { lines, size } = fitLines(ctx, scene.headline, [92, 80, 70], th.headWeight, th.headFont, WIDTH - 200, 3);
    const lineH = size * 1.32;
    const top = 1100 - (lines.length - 1) * lineH * 0.5;
    const kickerY = top - size * 0.92 - 52;
    drawKicker(ctx, board.kicker || "NEW", 60, kickerY, th, th.academic ? th.ink : accent, alpha);
    if (!th.academic) {
      // A pulsing "on air" dot after the kicker.
      ctx.save();
      ctx.font = `800 34px ${FONT}`;
      const kw = ctx.measureText(board.kicker || "NEW").width + 64;
      ctx.globalAlpha = alpha * (0.5 + 0.5 * Math.sin(t * 7));
      ctx.fillStyle = "#EF4444";
      ctx.beginPath();
      ctx.arc(60 + kw + 30, kickerY, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    lines.forEach((line, i) => {
      const r = easeOut(clamp((local - 0.06 - i * 0.1) / 0.35));
      ctx.font = `${th.headWeight} ${size}px ${th.headFont}`;
      const w = ctx.measureText(line).width + 60;
      const y = top + i * lineH;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = th.academic ? th.ink : i % 2 ? secondary : primary;
      ctx.fillRect(48 - (1 - r) * (w + 60), y - size * 0.92, w * r + 12, size * 1.2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(48, y - size * 0.92, w * r + 12, size * 1.2);
      ctx.clip();
      ctx.fillStyle = "#fff";
      ctx.fillText(line, 78, y);
      ctx.restore();
    });
    const subY = top + (lines.length - 1) * lineH + 110;
    ctx.globalAlpha = alpha * clamp((local - 0.45) / 0.4);
    ctx.font = th.academic ? `italic 400 42px ${SERIF}` : `600 42px ${FONT}`;
    ctx.fillStyle = th.soft;
    const sub = wrap(ctx, scene.subline || "", WIDTH - 140).slice(0, 2);
    sub.forEach((line, i) => ctx.fillText(line, 60, subY + i * 54));
    if (isLast && board.cta) drawCta(ctx, o, 60, subY + sub.length * 54 + 10, false);
    // Ticker.
    ctx.globalAlpha = 1;
    const tickerY = HEIGHT - 100;
    ctx.fillStyle = th.academic ? th.ink : "rgba(0,0,0,0.78)";
    ctx.fillRect(0, tickerY, WIDTH, 64);
    ctx.fillStyle = th.academic ? accent : primary;
    ctx.fillRect(0, tickerY, 14, 64);
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = "#fff";
    const tickerText = [o.host, ...(board.hashtags || []).slice(0, 6), board.tagline].filter(Boolean).join("   •   ") + "   •   ";
    const tw = Math.max(1, ctx.measureText(tickerText).width);
    const offset = (t * 140) % tw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(14, tickerY, WIDTH, 64);
    ctx.clip();
    for (let x = 30 - offset; x < WIDTH; x += tw) ctx.fillText(tickerText, x, tickerY + 43);
    ctx.restore();
  } else {
    // Spotlight: a big outlined scene number, the headline on top and the 3D scene below.
    const vignette = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.62, 200, WIDTH / 2, HEIGHT * 0.62, HEIGHT * 0.75);
    vignette.addColorStop(0, th.academic ? "rgba(246,244,238,0)" : "rgba(0,0,0,0)");
    vignette.addColorStop(1, th.academic ? "rgba(27,42,74,0.18)" : "rgba(0,0,0,0.65)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const num = String(index + 1).padStart(2, "0");
    const r = easeBack(clamp(local / 0.5));
    ctx.globalAlpha = alpha;
    ctx.font = `900 230px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = th.academic ? th.ink : accent;
    ctx.save();
    ctx.translate(70, 450);
    ctx.scale(r, r);
    ctx.strokeText(num, 0, 0);
    ctx.restore();
    ctx.font = `700 40px ${FONT}`;
    ctx.fillStyle = th.faint;
    ctx.fillText(`/ ${String(count).padStart(2, "0")}`, 70 + 290, 450);
    if (board.kicker) {
      ctx.font = `800 32px ${FONT}`;
      ctx.fillStyle = th.academic ? th.ink : accent;
      ctx.fillText(board.kicker, 74, 250);
    }
    const { lines, size } = fitLines(ctx, scene.headline, [96, 84, 72], th.headWeight, th.headFont, WIDTH - 140, 3);
    ctx.fillStyle = th.ink;
    ctx.shadowColor = th.shadow;
    ctx.shadowBlur = th.academic ? 0 : 24;
    lines.forEach((line, i) => {
      ctx.globalAlpha = alpha * clamp((local - 0.12 - i * 0.1) / 0.3);
      ctx.fillText(line, 70, 580 + i * size * 1.08 + (1 - clamp((local - 0.12 - i * 0.1) / 0.3)) * 30);
    });
    ctx.shadowBlur = 0;
    const subY = 600 + lines.length * size * 1.08;
    ctx.globalAlpha = alpha * clamp((local - 0.4) / 0.4);
    ctx.font = th.academic ? `italic 400 42px ${SERIF}` : `500 42px ${FONT}`;
    ctx.fillStyle = th.soft;
    const sub = wrap(ctx, scene.subline || "", WIDTH - 140).slice(0, 2);
    sub.forEach((line, i) => ctx.fillText(line, 70, subY + i * 54));
    if (isLast && board.cta) drawCta(ctx, o, 70, subY + sub.length * 54 + 20, false);
  }
  ctx.restore();
}

// Draws the titles, subtitles, brand and progress over the 3D frame.
function drawOverlay(ctx, t, timeline, board, host) {
  const [primary, secondary, accent] = board.palette;
  const th = themeFor(board);
  const { items, total } = timeline;
  const current = items.find((it) => t >= it.start && t < it.end) ?? items[items.length - 1];
  const { scene, start, end } = current;
  const local = t - start;
  const span = end - start;
  const enter = easeOut(local / ENTER);
  const exit = current.index === items.length - 1 ? 1 : 1 - easeOut((local - (span - EXIT)) / EXIT);
  const alpha = clamp(Math.min(enter, exit));

  // Soft shade behind the text so it reads on any colour.
  const shade = ctx.createLinearGradient(0, HEIGHT * 0.5, 0, HEIGHT);
  shade.addColorStop(0, th.shade[0]);
  shade.addColorStop(0.45, th.shade[1]);
  shade.addColorStop(1, th.shade[2]);
  ctx.fillStyle = shade;
  ctx.fillRect(0, HEIGHT * 0.5, WIDTH, HEIGHT * 0.5);

  // Story-style progress segments.
  const gap = 10;
  const segW = (WIDTH - 96 - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = 48 + i * (segW + gap);
    ctx.fillStyle = th.track;
    roundRect(ctx, x, 54, segW, 8, 4);
    ctx.fill();
    const fill = clamp((t - it.start) / (it.end - it.start));
    if (fill > 0) {
      ctx.fillStyle = th.fill;
      roundRect(ctx, x, 54, Math.max(8, segW * fill), 8, 4);
      ctx.fill();
    }
  });

  // Brand pill.
  ctx.save();
  ctx.globalAlpha = clamp(t / 0.6);
  ctx.font = `700 38px ${FONT}`;
  const brandText = board.brand || host;
  const pillW = ctx.measureText(brandText).width + 110;
  ctx.fillStyle = th.pill;
  roundRect(ctx, 48, 96, pillW, 76, th.academic ? 12 : 38);
  ctx.fill();
  if (th.academic) {
    ctx.strokeStyle = th.track;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const dotGrad = ctx.createLinearGradient(70, 112, 110, 156);
  dotGrad.addColorStop(0, primary);
  dotGrad.addColorStop(1, accent);
  ctx.fillStyle = dotGrad;
  ctx.beginPath();
  ctx.arc(90, 134, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = th.pillText;
  ctx.textBaseline = "middle";
  ctx.fillText(brandText, 124, 135);
  ctx.restore();

  const fmt = FORMATS.includes(board.format) ? board.format : "cinematic";
  const isLast = current.index === items.length - 1;
  if (fmt !== "cinematic") {
    drawFormatText(fmt, ctx, { t, local, span, alpha, enter, exit, scene, board, th, host, isLast, index: current.index, count: items.length });
  } else {
  // Headline, revealed word by word.
  ctx.save();
  ctx.textBaseline = "alphabetic";
  if (board.kicker) drawKicker(ctx, board.kicker, 70, (isLast ? 1130 : 1240) - (wrapCount(ctx, scene.headline, th) - 1) * 56 - 170, th, accent, alpha);
  ctx.font = `${th.headWeight} 104px ${th.headFont}`;
  const lines = wrap(ctx, scene.headline, WIDTH - 140);
  const lineH = 112;
  const baseY = (isLast ? 1130 : 1240) - (lines.length - 1) * lineH * 0.5 + (1 - enter) * 60;
  let wordIndex = 0;
  const totalHeadlineWords = scene.headline.split(/\s+/).length;
  lines.forEach((line, li) => {
    let x = 70;
    line.split(" ").forEach((word) => {
      const reveal = clamp((local - 0.08 - (wordIndex / totalHeadlineWords) * 0.45) / 0.3);
      ctx.globalAlpha = alpha * reveal;
      ctx.fillStyle = th.ink;
      ctx.shadowColor = th.shadow;
      ctx.shadowBlur = th.academic ? 0 : 24;
      ctx.fillText(word, x, baseY + li * lineH + (1 - reveal) * 26);
      x += ctx.measureText(`${word} `).width;
      wordIndex += 1;
    });
  });
  ctx.shadowBlur = 0;
  // Accent underline.
  const underY = baseY + (lines.length - 1) * lineH + 34;
  const grad = ctx.createLinearGradient(70, 0, 520, 0);
  grad.addColorStop(0, primary);
  grad.addColorStop(0.55, secondary);
  grad.addColorStop(1, accent);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = grad;
  if (th.academic) {
    // A thin rule, as in a printed journal.
    ctx.fillStyle = th.ink;
    ctx.fillRect(70, underY + 4, 520 * easeOut((local - 0.25) / 0.5), 3);
    ctx.fillStyle = accent;
    ctx.fillRect(70, underY + 4, 90 * easeOut((local - 0.25) / 0.5), 3);
  } else {
    roundRect(ctx, 70, underY, 380 * easeOut((local - 0.25) / 0.5), 12, 6);
    ctx.fill();
  }

  // Subline.
  ctx.font = th.academic ? `italic 400 46px ${SERIF}` : `500 46px ${FONT}`;
  ctx.fillStyle = th.soft;
  const subLines = wrap(ctx, scene.subline || "", WIDTH - 140).slice(0, 3);
  subLines.forEach((line, i) => ctx.fillText(line, 70, underY + 96 + i * 60));
  let after = underY + 96 + subLines.length * 60;

  // Call to action on the last scene.
  if (isLast && board.cta) {
    const ctaIn = easeBack((local - 0.4) / 0.6);
    ctx.globalAlpha = clamp(ctaIn);
    ctx.font = `800 50px ${FONT}`;
    const w = ctx.measureText(board.cta).width + 120;
    const y = after + 40;
    const cg = ctx.createLinearGradient(70, y, 70 + w, y + 110);
    cg.addColorStop(0, primary);
    cg.addColorStop(1, accent);
    ctx.save();
    ctx.translate(70 + w / 2, y + 55);
    ctx.scale(0.85 + 0.15 * ctaIn, 0.85 + 0.15 * ctaIn);
    ctx.fillStyle = th.academic ? th.ink : cg;
    roundRect(ctx, -w / 2, -55, w, 110, th.academic ? 14 : 55);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(board.cta, -w / 2 + 60, 2);
    ctx.restore();
    ctx.globalAlpha = clamp((local - 0.7) / 0.5);
    ctx.font = `600 40px ${FONT}`;
    ctx.fillStyle = th.soft;
    ctx.textBaseline = "alphabetic";
    if (y + 190 <= SUBTITLE_TOP) ctx.fillText(host, 70, y + 180);
    after = y + 200;
  }
  ctx.restore();
  }

  // Subtitles: the narration, with the words spoken so far highlighted.
  const words = scene.narration.split(/\s+/).filter(Boolean);
  const spoken = clamp((t - current.speechStart) / Math.max(0.1, current.speechEnd - current.speechStart));
  ctx.save();
  ctx.font = `700 44px ${FONT}`;
  const subtitleLines = wrap(ctx, scene.narration, WIDTH - 180).slice(0, 3);
  const boxH = subtitleLines.length * 58 + 44;
  const boxY = HEIGHT - (fmt === "news" ? 130 : 150) - boxH;
  ctx.globalAlpha = alpha * 0.9;
  ctx.fillStyle = th.box;
  roundRect(ctx, 60, boxY, WIDTH - 120, boxH, th.academic ? 14 : 28);
  ctx.fill();
  if (th.academic) {
    ctx.strokeStyle = th.track;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.globalAlpha = alpha;
  ctx.textBaseline = "alphabetic";
  let count = 0;
  subtitleLines.forEach((line, i) => {
    const lineWidth = ctx.measureText(line).width;
    let x = (WIDTH - lineWidth) / 2;
    line.split(" ").forEach((word) => {
      const said = count / words.length < spoken;
      ctx.fillStyle = said ? th.ink : th.faint;
      ctx.fillText(word, x, boxY + 64 + i * 58);
      x += ctx.measureText(`${word} `).width;
      count += 1;
    });
  });
  ctx.restore();

  // Fade from and to black at the very start and end.
  const fade = Math.max(1 - clamp(t / 0.35), clamp((t - (total - 0.4)) / 0.4));
  if (fade > 0) {
    ctx.fillStyle = `rgba(${th.fade},${fade})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

const BACKGROUND_SHADER = {
  vertex: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragment: `
    varying vec2 vUv;
    uniform float uTime;
    uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
    uniform float uPaper;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 aspect = vec2(0.5625, 1.0);
      vec3 col = mix(uA * 0.55, uA, uv.y);
      vec2 g1 = vec2(0.28 + 0.18 * sin(uTime * 0.35), 0.74 + 0.07 * cos(uTime * 0.28));
      vec2 g2 = vec2(0.78 + 0.12 * cos(uTime * 0.31), 0.36 + 0.1 * sin(uTime * 0.42));
      float d1 = distance(uv * aspect, g1 * aspect);
      float d2 = distance(uv * aspect, g2 * aspect);
      col += uB * 0.55 * smoothstep(0.55, 0.0, d1);
      col += uC * 0.42 * smoothstep(0.5, 0.0, d2);
      col += (hash(uv * 900.0 + uTime) - 0.5) * 0.025;
      if (uPaper > 0.5) {
        // Paper: flat light colour, the faintest colour wash, and a fine graph-paper grid.
        vec3 paper = uA;
        paper = mix(paper, uB, 0.05 * smoothstep(0.6, 0.0, d1));
        paper = mix(paper, uC, 0.04 * smoothstep(0.55, 0.0, d2));
        vec2 grid = abs(fract(uv * vec2(18.0, 32.0)) - 0.5);
        float line = 1.0 - smoothstep(0.0, 0.02, min(grid.x, grid.y));
        paper -= line * 0.035;
        paper *= 1.0 - 0.06 * distance(uv, vec2(0.5));
        col = paper + (hash(uv * 900.0) - 0.5) * 0.012;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Creates a renderer for a storyboard. ``output`` is the visible 1080x1920 canvas.
export async function createReel(output, board, { audioSeconds = 0, siteImage = null, site = null } = {}) {
  const academic = isAcademic(board);
  if (document.fonts?.load) {
    await Promise.all([document.fonts.load(`800 100px Inter`), document.fonts.load(`500 40px Inter`)]).catch(() => {});
  }
  const glCanvas = document.createElement("canvas");
  glCanvas.width = WIDTH;
  glCanvas.height = HEIGHT;
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTexture = pmrem.fromScene(room, 0.04).texture;
  scene.environment = envTexture;

  const camera = new THREE.PerspectiveCamera(40, WIDTH / HEIGHT, 0.1, 100);
  scene.add(camera);
  const [primary, secondary, accent] = board.palette.map(color);

  const bgMaterial = new THREE.ShaderMaterial({
    vertexShader: BACKGROUND_SHADER.vertex,
    fragmentShader: BACKGROUND_SHADER.fragment,
    uniforms: {
      uTime: { value: 0 },
      // Academic reels are on paper, even if the storyboard asked for a dark background.
      uA: { value: color(academic && luminance(board.background) < 0.6 ? PAPER : board.background) },
      uB: { value: primary.clone() }, uC: { value: secondary.clone() }, uPaper: { value: academic ? 1 : 0 },
    },
    depthWrite: false,
  });
  const bgDistance = 30;
  // Oversized, so view offsets (split, spotlight) and zoom punches never show its edges.
  const bgHeight = 2 * bgDistance * Math.tan(THREE.MathUtils.degToRad(20)) * 1.6;
  const bgGeometry = new THREE.PlaneGeometry(bgHeight * (WIDTH / HEIGHT), bgHeight);
  const background = new THREE.Mesh(bgGeometry, bgMaterial);
  background.position.z = -bgDistance;
  background.renderOrder = -1;
  camera.add(background);

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 6);
  scene.add(key);
  const rim1 = new THREE.PointLight(primary, 40, 20);
  rim1.position.set(-3.5, 2.5, 2);
  scene.add(rim1);
  const rim2 = new THREE.PointLight(accent, 30, 20);
  rim2.position.set(3.2, -0.5, 2.5);
  scene.add(rim2);

  const dot = dotTexture();
  // Floating dust in front of and behind the hero objects.
  const dustCount = 700;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions.set([(Math.random() - 0.5) * 9, (Math.random() - 0.5) * 12 + 1, (Math.random() - 0.5) * 9 - 1], i * 3);
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dustMaterial = new THREE.PointsMaterial({
    size: academic ? 0.03 : 0.045, map: dot,
    color: academic ? new THREE.Color(NAVY) : accent.clone().lerp(new THREE.Color("#ffffff"), 0.4), transparent: true,
    opacity: academic ? 0.18 : 0.75, depthWrite: false, blending: academic ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  scene.add(dust);

  // The site's own images, used on cards, in the gallery and inside the browser scene.
  const sources = site?.images?.length ? site.images : siteImage ? [siteImage] : [];
  const images = await Promise.all(sources.map(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode().catch(() => {});
    return image.naturalWidth ? image : null;
  }));
  const textures = images.map((image) => {
    if (!image) return null;
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  });
  const usable = textures.filter(Boolean);
  let shot = null;
  if (site?.screenshot) {
    shot = new Image();
    shot.src = site.screenshot;
    await shot.decode().catch(() => {});
    if (!shot.naturalWidth) shot = null;
  }
  const siteTexture = usable[0] ?? null;
  const pages = await Promise.all((site?.pages ?? []).map(async (page) => {
    if (!page.shot) return page;
    const image = new Image();
    image.src = page.shot;
    await image.decode().catch(() => {});
    return image.naturalWidth ? { ...page, shotImage: image } : page;
  }));
  const browserBase = {
    article: site?.article ?? null, single: !pages.length, shot, path: site?.path || "", siteName: site?.site_name || "",
    host: board.host || site?.host || "", brand: board.brand, title: site?.title || board.brand || "",
    description: site?.description || board.tagline || "", text: site?.text || "", links: site?.links ?? [],
    images, palette: board.palette, academic,
  };

  const host = board.host || "";
  const format = FORMATS.includes(board.format) ? board.format : "cinematic";
  // Split puts the 3D scene in the top half, spotlight in the bottom half.
  if (format === "split") camera.setViewOffset(WIDTH, HEIGHT, 0, HEIGHT * 0.13, WIDTH, HEIGHT);
  if (format === "spotlight") camera.setViewOffset(WIDTH, HEIGHT, 0, -HEIGHT * 0.2, WIDTH, HEIGHT);
  const formatScale = format === "split" ? 0.86 : format === "spotlight" ? 0.8 : 1;
  // Large soft bokeh near the camera, for depth.
  const bokehCount = academic ? 0 : 46;
  const bokehPositions = new Float32Array(bokehCount * 3);
  for (let i = 0; i < bokehCount; i += 1) {
    const a = (i / Math.max(1, bokehCount)) * Math.PI * 2 * 3.7;
    bokehPositions.set([Math.cos(a) * (3 + (i % 5) * 0.5), ((i * 37) % 23) / 23 * 8 - 2.5, Math.sin(a) * (3 + (i % 3))], i * 3);
  }
  const bokehGeometry = new THREE.BufferGeometry();
  bokehGeometry.setAttribute("position", new THREE.BufferAttribute(bokehPositions, 3));
  const bokehMaterial = new THREE.PointsMaterial({
    size: 0.42, map: dot, color: secondary.clone().lerp(new THREE.Color("#ffffff"), 0.3), transparent: true,
    opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const bokeh = new THREE.Points(bokehGeometry, bokehMaterial);
  scene.add(bokeh);
  const timeline = buildTimeline(board.scenes, audioSeconds);
  const heroes = board.scenes.map((s, i) => {
    const palette = i % 2 === 0 ? board.palette : [board.palette[1], board.palette[0], board.palette[2]];
    const focus = textures[s.image] ? usable.indexOf(textures[s.image]) : i % Math.max(1, usable.length);
    const page = pages[s.page] ?? (s.visual === "browser" && pages.length ? pages[0] : null) ?? null;
    const hero = buildHero(s.visual, board.style, palette, siteTexture, board.brand, dot, {
      academic, textures: usable, focus,
      browserInfo: { ...browserBase, page, hero: images.indexOf(textures[s.image] ? images[s.image] : images.find(Boolean) ?? null) },
    });
    hero.group.position.set(0, 1.15, 0);
    hero.group.visible = false;
    scene.add(hero.group);
    return hero;
  });

  const ctx = output.getContext("2d");
  output.width = WIDTH;
  output.height = HEIGHT;
  const look = new THREE.Vector3();

  function renderAt(t) {
    const time = clamp(t, 0, timeline.total);
    bgMaterial.uniforms.uTime.value = time;
    dust.rotation.y = time * 0.04;
    dust.position.y = -time * 0.05;
    bokeh.rotation.y = -time * 0.06;
    const current = timeline.items.find((it) => time >= it.start && time < it.end) ?? timeline.items[timeline.items.length - 1];
    timeline.items.forEach((it, i) => {
      const hero = heroes[i];
      const active = it === current;
      hero.group.visible = active;
      if (!active) return;
      const local = time - it.start;
      const span = it.end - it.start;
      const enter = easeBack(local / ENTER);
      const exit = i === heroes.length - 1 ? 1 : 1 - easeInOut(clamp((local - (span - EXIT)) / EXIT));
      const linear = clamp(local / ENTER);
      let scale = Math.max(0.001, Math.min(enter, exit)) * 1.05;
      hero.group.position.set(0, 1.15 + (1 - exit) * 0.6, 0);
      hero.group.rotation.set(0, (1 - linear) * -1.2 + (1 - exit) * 0.8, 0);
      // Each format cuts between scenes in its own way.
      switch (format) {
        case "kinetic": // Whip: in from the right, out to the left, with a tilt.
          scale = 1.05;
          hero.group.position.x = (1 - easeOut(linear)) * 5 - (1 - exit) * 5;
          hero.group.rotation.z = (1 - easeOut(linear)) * -0.35 + (1 - exit) * 0.35;
          break;
        case "split": // Slide, like turning a story card.
          scale = 1.05 * Math.max(0.001, Math.min(easeOut(linear), exit));
          hero.group.position.x = (1 - easeOut(linear)) * 3.2 - (1 - exit) * 3.2;
          break;
        case "news": // Push in: the scene arrives big and settles.
          scale = (1 + (1 - easeOut(linear)) * 0.7) * (1 + (1 - exit) * 0.8) * 1.05;
          hero.group.rotation.y = Math.sin(time * 0.4) * 0.15;
          break;
        case "spotlight": // Flip up from below.
          hero.group.rotation.x = (1 - easeOut(linear)) * -1.5 + (1 - exit) * 1.5;
          break;
        default:
          break;
      }
      hero.group.scale.setScalar(scale * formatScale);
      hero.update(time, local / span);
      const cam = cameraFor(it.scene.camera, local / span, time);
      camera.position.set(...cam.pos);
      look.set(...cam.look);
      camera.lookAt(look);
      // A zoom punch on the hook, so the first second grabs attention, and a smaller one on fast cuts.
      const punch = i === 0 ? 0.32 * (1 - easeOut(local / 1.1)) : format === "kinetic" ? 0.12 * (1 - easeOut(local / 0.4)) : 0;
      camera.zoom = 1 + punch;
      camera.updateProjectionMatrix();
      // Each scene leans the background toward its own colours.
      bgMaterial.uniforms.uB.value.copy(i % 2 === 0 ? primary : secondary);
      bgMaterial.uniforms.uC.value.copy(i % 2 === 0 ? secondary : accent);
    });
    renderer.render(scene, camera);
    ctx.drawImage(glCanvas, 0, 0, WIDTH, HEIGHT);
    drawOverlay(ctx, time, timeline, board, host);
  }

  function dispose() {
    heroes.forEach((h) => h.disposables.forEach((d) => d.dispose?.()));
    [bgGeometry, bgMaterial, dustGeometry, dustMaterial, bokehGeometry, bokehMaterial, dot, envTexture, ...usable].forEach((d) => d?.dispose?.());
    pmrem.dispose();
    room.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  return { renderAt, dispose, duration: timeline.total, timeline };
}

// Picks the best format this browser can record. Instagram and LinkedIn need MP4.
export function recordingType() {
  const types = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1.4d0028,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

// Plays the reel in real time, with its voiceover, and records it. Resolves to a Blob.
export async function recordReel(output, reel, audioBuffer, { onProgress, signal } = {}) {
  const type = recordingType();
  if (!type) throw new Error("This browser can't record video. Use Chrome or Edge.");
  const audio = new AudioContext();
  await audio.resume();
  const stream = output.captureStream(FPS);
  const destination = audio.createMediaStreamDestination();
  let source = null;
  if (audioBuffer) {
    source = audio.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(destination);
  }
  destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  reel.renderAt(0);
  recorder.start(250);
  const t0 = audio.currentTime + 0.1;
  source?.start(t0 + VOICE_DELAY);
  await new Promise((resolve, reject) => {
    const frame = () => {
      if (signal?.aborted) {
        reject(new DOMException("Recording cancelled.", "AbortError"));
        return;
      }
      const t = Math.max(0, audio.currentTime - t0);
      reel.renderAt(t);
      onProgress?.(Math.min(1, t / reel.duration));
      if (t >= reel.duration) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }).finally(() => {
    if (recorder.state !== "inactive") recorder.stop();
    try { source?.stop(); } catch { /* already stopped */ }
  });
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  await audio.close();
  return new Blob(chunks, { type: type.split(";")[0] });
}

// Plays the reel with sound on the page, without recording. Returns a stop function.
export function playReel(reel, audioBuffer, onEnd) {
  const audio = new AudioContext();
  let source = null;
  if (audioBuffer) {
    source = audio.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audio.destination);
  }
  let running = true;
  const t0 = audio.currentTime + 0.05;
  source?.start(t0 + VOICE_DELAY);
  const frame = () => {
    if (!running) return;
    const t = Math.max(0, audio.currentTime - t0);
    reel.renderAt(t);
    if (t >= reel.duration) {
      stop();
      onEnd?.();
    } else {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
  function stop() {
    if (!running) return;
    running = false;
    try { source?.stop(); } catch { /* already stopped */ }
    audio.close();
  }
  return stop;
}

export async function decodeWav(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const context = new OfflineAudioContext(1, 1, 24000);
  return context.decodeAudioData(bytes.buffer);
}
