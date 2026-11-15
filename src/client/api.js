// The API is served by the same Vercel deployment, so requests go to this site's own /api.
export const API_BASE_URL = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const BASE = API_BASE_URL;
// Vercel accepts request bodies up to 4.5 MB, so files go up in pieces of this size.
const CHUNK_BYTES = 3 * 1024 * 1024;

const KEYS = { user: "social_autopost_session", admin: "social_autopost_admin_session" };

export function getToken(scope = "user") {
  try {
    return sessionStorage.getItem(KEYS[scope]);
  } catch {
    return null;
  }
}

export function setToken(token, scope = "user") {
  try {
    if (token) sessionStorage.setItem(KEYS[scope], token);
    else sessionStorage.removeItem(KEYS[scope]);
  } catch {
    // Without storage, the session simply ends when the page reloads.
  }
}

export class ApiFailure extends Error {
  constructor(message, hint, status) {
    super(message);
    this.hint = hint;
    this.status = status;
  }
}

const signedOutHandlers = { user: () => {}, admin: () => {} };
export function setSignedOutHandler(handler, scope = "user") {
  signedOutHandlers[scope] = handler;
}

const LOGIN_PATHS = ["/api/login", "/api/admin/login"];

/** Shrink an image in the browser (JPEG, at most `maxSide` px) so it stores and posts quickly. */
export async function compressImage(file, maxSide = 2048, quality = 0.9) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) throw new ApiFailure("Choose a JPEG, PNG or WebP image.");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new ApiFailure("That image couldn't be read.", "Try another file.");
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.type === "image/jpeg" && file.size < 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  return new File([blob], (file.name || "image").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}

export async function uploadImage(file) {
  const small = await compressImage(file);
  return uploadFile(small, { kind: "image", name: small.name });
}

export async function api(path, { method = "GET", json, form, scope = "user" } = {}) {
  // Uploads go to MongoDB in pieces (Vercel limits request bodies), so these two are redirected.
  if (form && path === "/api/image") return uploadImage(form.get("file"));
  if (form && path === "/api/reel/upload") {
    const video = form.get("file");
    const saved = await uploadFile(video, { kind: "video", name: video.name || "reel" });
    return { key: saved.key, content_type: saved.mime, bytes: saved.bytes };
  }
  const headers = {};
  const token = getToken(scope);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
    });
  } catch {
    throw new ApiFailure(
      "Couldn't reach the server.",
      "Check your internet connection and try again.",
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !LOGIN_PATHS.includes(path)) {
      setToken(null, scope);
      signedOutHandlers[scope]();
    }
    throw new ApiFailure(data.error || `The server returned an error (${response.status}).`, data.hint, response.status);
  }
  return data;
}

// Stores a file (image or video) in MongoDB, compressed, in pieces. Returns { key, url, bytes, mime }.
export async function uploadFile(blob, { kind = "image", name = "file" } = {}) {
  const mime = blob.type || "application/octet-stream";
  const started = await api("/api/files", { method: "POST", json: { kind, name, mime, size: blob.size } });
  const total = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
  for (let index = 0; index < total; index += 1) {
    const part = blob.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const headers = { "Content-Type": "application/octet-stream" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(`${BASE}/api/files/${started.id}/chunk/${index}`, { method: "PUT", headers, body: part });
    } catch {
      throw new ApiFailure("The upload was interrupted.", "Check your connection and try again.");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiFailure(data.error || "The upload failed.", data.hint, response.status);
    }
  }
  return api(`/api/files/${started.id}/finish`, { method: "POST", json: { chunks: total } });
}

// Downloads a file (such as a Word document) with the session, returning { blob, filename }.
export async function apiDownload(path, fallbackName = "download", scope = "user") {
  const headers = {};
  const token = getToken(scope);
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { headers });
  } catch {
    throw new ApiFailure("Couldn't reach the server.", "Check your connection and try again.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      setToken(null, scope);
      signedOutHandlers[scope]();
    }
    throw new ApiFailure(data.error || `The server returned an error (${response.status}).`, data.hint, response.status);
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
  return { blob: await response.blob(), filename: match ? match[1] : fallbackName };
}
