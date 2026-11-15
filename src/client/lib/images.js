import { uploadImage } from "../api.js";

// Image work done in the browser, so the server needs no image library.

const SIZE = [1080, 1350];

function load(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image couldn't be read."));
    image.src = src;
  });
}

/** Fit an image to 1080x1350 (4:5): crop when it is nearly 4:5, else place it on a blurred copy of itself. */
export async function fitImage(dataUrl) {
  const image = await load(dataUrl);
  const [W, H] = SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const ratio = image.width / Math.max(1, image.height);
  const cover = () => {
    const scale = Math.max(W / image.width, H / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
  };
  if (ratio >= 0.7 && ratio <= 0.9) {
    cover();
  } else {
    ctx.filter = "blur(40px)";
    cover();
    ctx.filter = "none";
    ctx.fillStyle = "rgba(10,12,20,0.35)";
    ctx.fillRect(0, 0, W, H);
    let scale = Math.min((W - 80) / image.width, (H - 160) / image.height);
    scale = Math.min(scale, 2);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 28;
    ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
  }
  return canvas.toDataURL("image/jpeg", 0.9);
}

export async function fitOptions(options) {
  return Promise.all((options || []).map(async (option) => {
    if (!option.fit) return option;
    try {
      return { ...option, image: await fitImage(option.image), fit: false };
    } catch {
      return option;
    }
  }));
}

export function dataUrlToFile(dataUrl, name = "image.jpg") {
  const [head, body] = dataUrl.split(",", 2);
  const mime = /data:([^;]+)/.exec(head)?.[1] || "image/jpeg";
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: mime });
}

/** Upload data-URL images and return their stored keys. */
export async function uploadDataUrls(images) {
  const keys = [];
  for (const [index, image] of images.entries()) {
    if (/^[0-9a-f]{24}$/.test(image)) keys.push(image);
    else keys.push((await uploadImage(dataUrlToFile(image, `image-${index + 1}.jpg`))).key);
  }
  return keys;
}

/** An SVG figure as a PNG (for Word files). */
export async function svgToPng(svg, width = 1520) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = await load(url);
    const scale = width / (image.width || 760);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((image.width || 760) * scale);
    canvas.height = Math.round((image.height || 480) * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { data: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
