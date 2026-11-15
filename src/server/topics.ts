import type { ObjectId } from "mongodb";
import { col, now } from "./db";

export const parseTopics = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export async function nextTopic(userId: ObjectId): Promise<[string, number] | null> {
  const doc = (await (await col("topics")).findOne({ user_id: userId })) || {};
  const topics = parseTopics(doc.text || "");
  if (!topics.length) return null;
  const index = Number(doc.next_index || 0) % topics.length;
  return [topics[index], index];
}

export async function advanceTopic(userId: ObjectId, index: number, topic: string) {
  const topicsCol = await col("topics");
  const doc = (await topicsCol.findOne({ user_id: userId })) || {};
  const topics = parseTopics(doc.text || "");
  if (index >= 0 && index < topics.length && topics[index] === topic) {
    await topicsCol.updateOne({ user_id: userId }, { $set: { next_index: (index + 1) % topics.length, updated_at: now() } });
  }
}
