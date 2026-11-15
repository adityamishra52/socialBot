import { gunzipSync, gzipSync } from "node:zlib";
import { Binary, type ObjectId } from "mongodb";
import { sign, verify } from "./auth";
import { col, fileExpiry, now, toObjectId } from "./db";
import { ConfigError } from "./errors";

// Images and videos live in MongoDB (no S3): a "files" record plus gzip-compressed pieces of at
// most 3 MB in "file_chunks", because Vercel limits request bodies to 4.5 MB.

export const CHUNK_BYTES = 3 * 1024 * 1024;
export const MAX_FILE_BYTES: Record<string, number> = { image: 12 * 1024 * 1024, video: 60 * 1024 * 1024, audio: 10 * 1024 * 1024 };
const ALLOWED: Record<string, RegExp> = { image: /^image\/(jpeg|png|webp)$/, video: /^video\/(mp4|webm)$/, audio: /^audio\/(wav|x-wav|wave)$/ };

export async function startFile(userId: ObjectId, kind: string, mime: string, size: number, name = "file") {
  if (!ALLOWED[kind]) throw new ConfigError("That kind of file can't be stored.");
  const type = String(mime || "").split(";")[0].toLowerCase();
  if (!ALLOWED[kind].test(type)) {
    throw new ConfigError(kind === "image" ? "Upload a JPEG, PNG or WebP image." : kind === "video" ? "That file isn't an MP4 or WebM video." : "That file isn't a WAV recording.");
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES[kind]) {
    throw new ConfigError(`That file is too large (${Math.round(MAX_FILE_BYTES[kind] / 1024 / 1024)} MB maximum).`);
  }
  const files = await col("files");
  const result = await files.insertOne({ user_id: userId, kind, mime: type, size, name: String(name).slice(0, 120), status: "uploading", created_at: now(), expires_at: fileExpiry() });
  return String(result.insertedId);
}

async function ownedFile(userId: ObjectId, id: string) {
  const fileId = toObjectId(id);
  const file = fileId ? await (await col("files")).findOne({ _id: fileId, user_id: userId }) : null;
  if (!file) throw new ConfigError("That file wasn't found. Upload it again.");
  return file;
}

export async function putChunk(userId: ObjectId, id: string, index: number, data: Buffer) {
  const file = await ownedFile(userId, id);
  if (file.status !== "uploading") throw new ConfigError("That upload is already finished.");
  if (!Number.isInteger(index) || index < 0 || index > 40) throw new ConfigError("That part of the upload isn't valid.");
  if (data.length > CHUNK_BYTES + 1024) throw new ConfigError("That part of the upload is too large.");
  await (await col("file_chunks")).updateOne({ file_id: file._id, n: index },
    { $set: { data: new Binary(gzipSync(data, { level: 1 })), bytes: data.length, expires_at: file.expires_at || fileExpiry() } }, { upsert: true });
}

export async function finishFile(userId: ObjectId, id: string, chunks: number) {
  const file = await ownedFile(userId, id);
  const parts = await (await col("file_chunks")).find({ file_id: file._id }, { projection: { n: 1, bytes: 1 } }).sort({ n: 1 }).toArray();
  const size = parts.reduce((sum, p) => sum + (p.bytes || 0), 0);
  if (parts.length !== chunks || parts.some((p, i) => p.n !== i) || size !== file.size) {
    throw new ConfigError("Part of the file didn't arrive.", "Upload it again.");
  }
  const head = await readFile(userId, id, true);
  checkMagic(file.kind, file.mime, head);
  await (await col("files")).updateOne({ _id: file._id }, { $set: { status: "ready" } });
  return { key: id, mime: file.mime, bytes: size, kind: file.kind };
}

function checkMagic(kind: string, mime: string, head: Buffer) {
  const ok = kind === "image" ? (head[0] === 0xff && head[1] === 0xd8) || head.subarray(1, 4).toString() === "PNG" || head.subarray(8, 12).toString() === "WEBP"
    : kind === "video" ? head.subarray(4, 8).toString() === "ftyp" || head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : head.subarray(0, 4).toString() === "RIFF";
  if (!ok) throw new ConfigError(`That file isn't a real ${kind} (${mime}).`);
}

/** Store bytes the server made or fetched (an imported image, a voiceover). */
export async function storeBuffer(userId: ObjectId, kind: string, mime: string, data: Buffer, name = "file") {
  const id = await startFile(userId, kind, mime, data.length, name);
  const fileId = toObjectId(id)!;
  const chunks = await col("file_chunks");
  let index = 0;
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES, index += 1) {
    const part = data.subarray(offset, offset + CHUNK_BYTES);
    await chunks.insertOne({ file_id: fileId, n: index, data: new Binary(gzipSync(part, { level: 1 })), bytes: part.length, expires_at: fileExpiry() });
  }
  await (await col("files")).updateOne({ _id: fileId }, { $set: { status: "ready" } });
  return id;
}

export async function readFile(userId: ObjectId | null, id: string, headOnly = false): Promise<Buffer> {
  const fileId = toObjectId(id);
  const query: any = { _id: fileId };
  if (userId) query.user_id = userId;
  const file = fileId ? await (await col("files")).findOne(query) : null;
  if (!file) throw new ConfigError("That file wasn't found.");
  const cursor = (await col("file_chunks")).find({ file_id: file._id }).sort({ n: 1 });
  const parts: Buffer[] = [];
  for await (const chunk of cursor) {
    parts.push(gunzipSync(Buffer.from(chunk.data.buffer)));
    if (headOnly) break;
  }
  return Buffer.concat(parts);
}

export async function fileInfo(id: string) {
  const fileId = toObjectId(id);
  return fileId ? (await col("files")).findOne({ _id: fileId, status: "ready" }) : null;
}

export async function deleteFiles(ids: string[]) {
  const objectIds = ids.map(toObjectId).filter(Boolean) as ObjectId[];
  if (!objectIds.length) return;
  await (await col("file_chunks")).deleteMany({ file_id: { $in: objectIds } });
  await (await col("files")).deleteMany({ _id: { $in: objectIds } });
}

/** Keep files that a saved template or manuscript still uses for another full retention period. */
export async function touchFiles(ids: unknown[]) {
  const objectIds = ids.map(toObjectId).filter(Boolean) as ObjectId[];
  if (!objectIds.length) return;
  const expires_at = fileExpiry();
  await (await col("files")).updateMany({ _id: { $in: objectIds } }, { $set: { expires_at } });
  await (await col("file_chunks")).updateMany({ file_id: { $in: objectIds } }, { $set: { expires_at } });
}

export async function ownsFile(userId: ObjectId, id: unknown) {
  const fileId = toObjectId(id);
  return Boolean(fileId && await (await col("files")).findOne({ _id: fileId, user_id: userId, status: "ready" }, { projection: { _id: 1 } }));
}

/** A signed link Facebook and Instagram can download from while they publish (valid 3 hours). */
export function publicFileUrl(origin: string, id: string, hours = 3) {
  const token = sign("file", { f: id }, hours * 3600);
  return `${origin}/api/public/file/${token}`;
}

export function fileFromToken(token: string): string | null {
  const data = verify<{ f: string }>("file", token);
  return data?.f || null;
}

/** Stream a stored file chunk by chunk, so even large videos never sit in memory at once. */
export async function streamFile(id: string, range?: string | null): Promise<Response> {
  const file = await fileInfo(id);
  if (!file) return new Response("Not found", { status: 404 });
  const chunks = await col("file_chunks");
  const headers: Record<string, string> = { "Content-Type": file.mime, "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (match && file.size) {
    const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
    if (start > end || start >= file.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    const first = Math.floor(start / CHUNK_BYTES);
    const last = Math.floor(end / CHUNK_BYTES);
    const parts: Buffer[] = [];
    for await (const chunk of chunks.find({ file_id: file._id, n: { $gte: first, $lte: last } }).sort({ n: 1 })) {
      parts.push(gunzipSync(Buffer.from(chunk.data.buffer)));
    }
    const body = Buffer.concat(parts).subarray(start - first * CHUNK_BYTES, end - first * CHUNK_BYTES + 1);
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": String(body.length) } });
  }
  let n = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      const chunk = await chunks.findOne({ file_id: file._id, n });
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(gunzipSync(Buffer.from(chunk.data.buffer))));
      n += 1;
    },
  });
  return new Response(stream, { headers: { ...headers, "Content-Length": String(file.size) } });
}
