import { afterEach, describe, expect, it, vi } from "vitest";
import { generate, textModels, LITE_MODELS } from "../src/server/gemini";

const reply = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Gemini fallbacks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves to the next free lite model when one is busy", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    const called: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      called.push(String(url).split("/models/")[1].split(":")[0]);
      if (called.length === 1) return reply(503, { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } });
      if (called.length === 2) return reply(429, { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } });
      return reply(200, { candidates: [{ content: { parts: [{ text: "{}" }] } }], modelVersion: "gemini-flash-lite-latest" });
    }));
    const data = await generate({ contents: [] });
    expect(data.candidates).toHaveLength(1);
    expect(called).toEqual(LITE_MODELS.slice(0, 3));
    expect(textModels().every((m) => /lite/.test(m))).toBe(true);
  });

  it("says plainly when every lite model is busy", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    vi.stubGlobal("fetch", vi.fn(async () => reply(503, { error: { code: 503, message: "high demand" } })));
    await expect(generate({ contents: [] })).rejects.toThrow("All the free Gemini lite models are busy");
  });
});
