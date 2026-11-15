import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "./env";
import { ApiError, ConfigError, GenerationError, PromptBlockedError } from "./errors";
import { httpCall, jsonOf } from "./http";

// Only Gemini *lite* models are used, to keep the bill low. GEMINI_MODEL may pick another lite
// model; a name without "lite" is ignored. When a model is retired (404), the next one is tried.

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const LITE_MODELS = ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];
export const LITE_TTS_MODELS = ["gemini-3.8-flash-lite-tts"];

let workingModel: string | null = null;

export function textModels(): string[] {
  const configured = env("GEMINI_MODEL").replace(/^models\//, "");
  const list = configured && /lite/i.test(configured) ? [configured, ...LITE_MODELS] : [...LITE_MODELS];
  if (workingModel) list.unshift(workingModel);
  return [...new Set(list)];
}

export function ttsModels(): string[] {
  const configured = env("GEMINI_TTS_MODEL").replace(/^models\//, "");
  return [...new Set([...(configured && /lite/i.test(configured) ? [configured] : []), ...LITE_TTS_MODELS])];
}

export const LITE_IMAGE_MODEL = "gemini-3.1-flash-lite-image";

/** AI images use the lite image model. GEMINI_IMAGE_MODEL may name another lite one; "off" switches images off. */
export function imageModel(): string {
  const configured = env("GEMINI_IMAGE_MODEL").replace(/^models\//, "");
  if (configured.toLowerCase() === "off") return "";
  return configured && /lite/i.test(configured) ? configured : LITE_IMAGE_MODEL;
}

export function currentModel(): string {
  return textModels()[0];
}

// --- Pricing (US$ per 1M tokens, Gemini Developer API paid tier, checked 2026-11-06) ---

type Rate = { input: number; output: number; cached?: number };
export const PRICES_CHECKED = "2026-11-06";
export const PRICES_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
const PRICES: Record<string, Rate> = {
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cached: 0.01 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-flash-lite-latest": { input: 0.1, output: 0.4, cached: 0.01 },
  "gemini-3.8-flash-lite-tts": { input: 0.5, output: 6.0 },
  "gemini-3.1-flash-image": { input: 0.3, output: 30.0 },
};

export const freeTier = () => env("GEMINI_BILLING_TIER").toLowerCase() === "free";

function overrides(): Record<string, Rate> {
  try {
    const raw = env("GEMINI_PRICES");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function rateFor(model: string): [string, Rate] | null {
  const name = model.replace(/^models\//, "").toLowerCase();
  const table = { ...PRICES, ...overrides() };
  const matches = Object.keys(table).filter((key) => name === key || name.startsWith(`${key}-`));
  if (!matches.length) return null;
  const key = matches.sort((a, b) => b.length - a.length)[0];
  return [key, table[key]];
}

export function priceUsage(data: any, requested: string, kind = "text") {
  const meta = data?.usageMetadata || {};
  const count = (key: string) => Math.max(0, Number(meta[key]) || 0);
  const prompt = count("promptTokenCount") + count("toolUsePromptTokenCount");
  const cached = Math.min(count("cachedContentTokenCount"), prompt);
  const output = count("candidatesTokenCount");
  const thinking = count("thoughtsTokenCount");
  const model = String(data?.modelVersion || requested).replace(/^models\//, "");
  const found = rateFor(model);
  let cost: number | null = null;
  if (found) {
    const [, rate] = found;
    cost = freeTier() ? 0 : ((prompt - cached) * rate.input + cached * (rate.cached ?? rate.input) + (output + thinking) * rate.output) / 1_000_000;
    cost = Math.round(cost * 1e8) / 1e8;
  }
  return { model, kind, input_tokens: prompt, cached_tokens: cached, output_tokens: output, thinking_tokens: thinking, cost_usd: cost };
}

// Every billed call (retries too) made inside trackUsage() is collected here.
const usageStore = new AsyncLocalStorage<any[]>();

export async function trackUsage<T>(work: () => Promise<T>): Promise<{ result?: T; events: any[]; error?: unknown }> {
  const events: any[] = [];
  try {
    const result = await usageStore.run(events, work);
    return { result, events };
  } catch (error) {
    return { events, error };
  }
}

function record(data: any, model: string, kind = "text") {
  usageStore.getStore()?.push(priceUsage(data, model, kind));
}

export function requireKey(): string {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new ConfigError("The Gemini key isn't set on this server.", "Set GEMINI_API_KEY on Vercel. Create a key at https://aistudio.google.com/apikey");
  return key;
}

const retired = (error: any) => error instanceof ApiError && (error.status === 404 || /not found|not supported/i.test(error.message));

/** POST generateContent to the first lite model that exists. */
export async function generate(body: any, { models = textModels(), timeoutMs = 55_000, kind = "text" } = {}): Promise<any> {
  const key = requireKey();
  let last: unknown = null;
  for (const model of models) {
    try {
      const response = await httpCall("POST", `${GEMINI_BASE}/models/${model}:generateContent`, "gemini", {
        headers: { "x-goog-api-key": key }, json: body, timeoutMs,
      });
      const data = await jsonOf(response, "gemini");
      record(data, model, kind);
      if (kind === "text") workingModel = model;
      return data;
    } catch (error) {
      if (retired(error)) {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw new ApiError("No Gemini lite model is available to this key.", "Set GEMINI_MODEL on Vercel to a current flash-lite model.", (last as any)?.status);
}

function textOf(data: any): string {
  const candidates = data?.candidates || [];
  if (!candidates.length) {
    const reason = data?.promptFeedback?.blockReason || "no reason given";
    throw new PromptBlockedError(`Gemini returned no text (${reason}).`, "Try rewording your request.");
  }
  const parts = candidates[0]?.content?.parts || [];
  const text = parts.filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
  if (!text.trim()) throw new GenerationError(`Gemini returned an empty response (${candidates[0]?.finishReason || "unknown"}).`, "Try again.");
  return text;
}

export function parseObject(raw: string): any {
  const candidate = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  let data: any;
  try {
    data = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    try {
      data = start >= 0 && end > start ? JSON.parse(candidate.slice(start, end + 1)) : null;
    } catch {
      data = null;
    }
    if (data === null) throw new GenerationError("Gemini returned text that is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new GenerationError("Gemini returned JSON that is not an object.");
  return data;
}

/**
 * Ask for a JSON object and return check(object). check throws GenerationError to ask again,
 * up to `regenerations` more times. API errors are raised at once.
 */
export async function requestJson<T>(prompt: string, check: (data: any) => T, options: {
  extraParts?: any[]; regenerations?: number; timeoutMs?: number; maxOutputTokens?: number; temperature?: number;
} = {}): Promise<T> {
  const { extraParts = [], regenerations = 2, timeoutMs = 55_000, maxOutputTokens, temperature } = options;
  let attempt = prompt;
  let problem = "";
  for (let i = 0; i <= regenerations; i += 1) {
    try {
      const data = await generate({
        contents: [{ role: "user", parts: [{ text: attempt }, ...extraParts] }],
        generationConfig: {
          responseMimeType: "application/json",
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        },
      }, { timeoutMs });
      return check(parseObject(textOf(data)));
    } catch (error) {
      if (error instanceof PromptBlockedError || !(error instanceof GenerationError)) throw error;
      problem = error.message;
      attempt = `${prompt}\n\nYour previous attempt was rejected: ${problem}. Follow the format exactly.`;
    }
  }
  throw new GenerationError(`Gemini did not return a usable answer after ${regenerations + 1} attempts: ${problem}`,
    "Try again, or shorten or reword your request.");
}

/** Speech with the lite TTS model, returned as WAV bytes. */
export async function speak(text: string, voice: string): Promise<Buffer> {
  const data = await generate({
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  }, { models: ttsModels(), kind: "tts", timeoutMs: 55_000 });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      const audio = Buffer.from(inline.data, "base64");
      if (audio.subarray(0, 4).toString() === "RIFF") return audio;
      const rate = Number(/rate=(\d+)/.exec(String(inline.mimeType || inline.mime_type || ""))?.[1] || 24000);
      return wavFromPcm(audio, rate);
    }
  }
  throw new GenerationError("Gemini returned no audio.", "Try again, or pick another voice.");
}

export function wavFromPcm(pcm: Buffer, rate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function wavSeconds(wav: Buffer): number {
  let position = 12;
  let rate = 24000;
  let block = 2;
  let size = wav.length - 44;
  while (position + 8 <= wav.length) {
    const chunk = wav.subarray(position, position + 4).toString();
    const length = wav.readUInt32LE(position + 4);
    if (chunk === "fmt " && length >= 16) {
      rate = wav.readUInt32LE(position + 12);
      block = wav.readUInt16LE(position + 20);
    } else if (chunk === "data") {
      size = Math.min(length, wav.length - position - 8);
      break;
    }
    position += 8 + length;
  }
  return rate && block ? size / (rate * block) : 0;
}

/** An image from the optional image model, as raw bytes and its type. */
export async function makeImage(parts: any[], aspect: string): Promise<{ data: Buffer; mime: string }> {
  const model = imageModel();
  if (!model) {
    throw new ConfigError("AI images are switched off on this server.",
      "Upload your own image, or ask your administrator to remove GEMINI_IMAGE_MODEL=off.");
  }
  const data = await generate({
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } },
  }, { models: [model], kind: "image", timeoutMs: 58_000 });
  for (const part of data?.candidates?.[0]?.content?.parts || []) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) return { data: Buffer.from(inline.data, "base64"), mime: inline.mimeType || inline.mime_type || "image/png" };
  }
  throw new GenerationError("Gemini made no image.", "Try again or reword the description.");
}
