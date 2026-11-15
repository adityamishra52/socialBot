import type { ObjectId } from "mongodb";
import { col, now, pack, toObjectId, unpack } from "./db";
import { freeTier, trackUsage } from "./gemini";
import { redact } from "./errors";

// Every Gemini run is saved with what it cost, from Gemini's own token counts.

const PLAIN = ["user_id", "feature", "label", "ok", "calls", "models", "input_tokens", "output_tokens", "thinking_tokens", "cost_usd", "unpriced_calls", "created_at", "published"];

export async function saveUsage(userId: ObjectId, feature: string, label: string, events: any[], ok: boolean) {
  const known = events.filter((e) => e.cost_usd !== null && e.cost_usd !== undefined).map((e) => e.cost_usd as number);
  const document = {
    user_id: userId, feature, label: label.slice(0, 200), ok, calls: events.length,
    models: [...new Set(events.map((e) => e.model).filter(Boolean))].sort(),
    input_tokens: events.reduce((n, e) => n + (e.input_tokens || 0), 0),
    output_tokens: events.reduce((n, e) => n + (e.output_tokens || 0), 0),
    thinking_tokens: events.reduce((n, e) => n + (e.thinking_tokens || 0), 0),
    cost_usd: Math.round(known.reduce((a, b) => a + b, 0) * 1e8) / 1e8,
    unpriced_calls: events.length - known.length, published: [], created_at: now(), events: events.slice(0, 20),
  };
  const result = await (await col("ai_usage")).insertOne(pack(document, PLAIN));
  return { ...document, _id: result.insertedId };
}

export function usageJson(document: any) {
  return {
    id: String(document._id), feature: document.feature, label: document.label || "", ok: document.ok !== false,
    calls: document.calls || 0, models: document.models || [], input_tokens: document.input_tokens || 0,
    output_tokens: document.output_tokens || 0, thinking_tokens: document.thinking_tokens || 0,
    cost_usd: document.cost_usd ?? 0, unpriced_calls: document.unpriced_calls || 0, free_tier: freeTier(),
    published: (document.published || []).map((p: any) => ({ ...p, at: p.at instanceof Date ? p.at.toISOString() : p.at })),
    created_at: new Date(document.created_at).toISOString(),
  };
}

/** Run Gemini work and record what it cost, including attempts that failed after being billed. */
export async function aiRun<T>(userId: ObjectId, feature: string, label: string, work: () => Promise<T>): Promise<[T, any]> {
  const { result, events, error } = await trackUsage(work);
  let document: any = null;
  if (events.length) {
    try {
      document = await saveUsage(userId, feature, label, events, !error);
    } catch (problem) {
      console.error("Could not save AI usage:", redact(problem));
    }
  }
  if (error) throw error;
  return [result as T, document ? usageJson(document) : null];
}

export function usageIdsFrom(data: any): ObjectId[] {
  const raw = Array.isArray(data?.usage_ids) ? data.usage_ids.slice(0, 30) : [];
  const ids = raw.map(toObjectId).filter(Boolean) as ObjectId[];
  return [...new Map(ids.map((id) => [String(id), id])).values()];
}

export async function usageForIds(userId: ObjectId, ids: ObjectId[]) {
  if (!ids.length) return [];
  return (await (await col("ai_usage")).find({ _id: { $in: ids }, user_id: userId }, { projection: { z: 0 } }).toArray());
}

/** Store the AI cost on a post and mark the AI runs as published. */
export async function linkUsage(userId: ObjectId, ids: ObjectId[], posted: string[], topic: string) {
  const runs = await usageForIds(userId, ids);
  if (!runs.length) return {};
  if (posted.length) {
    await (await col("ai_usage")).updateMany({ _id: { $in: runs.map((r) => r._id) }, user_id: userId },
      { $push: { published: { $each: [{ at: now(), topic: topic.slice(0, 200), platforms: posted }], $slice: -20 } } } as any);
  }
  return { ai_cost_usd: Math.round(runs.reduce((n, r) => n + (r.cost_usd || 0), 0) * 1e8) / 1e8, ai_usage_ids: runs.map((r) => String(r._id)) };
}

export { unpack };
