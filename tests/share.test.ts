import { afterEach, describe, expect, it, vi } from "vitest";
import { projectText, shareCopy, verifiedQuotes } from "../src/server/share";

const book = {
  mode: "book", status: "ready", options: { authors: "A. Kumar", publisher: "Example Press" },
  draft: {
    title: "The Silicon Correction", blurb: "How the AI boom met financial reality.",
    chapters: [{ title: "The Leveraged Capex Illusion", summary: "Why spending outran revenue [R2].", sections: [
      { heading: "Capital and sand", paragraphs: ["We witnessed a mass delusion where the sheer cost of infrastructure was mistaken for its value [R1, R3].", "Short one."] },
    ] }],
  },
};

const reply = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("share posts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("collects the prose without citations", () => {
    const text = projectText(book);
    expect(text).toContain("We witnessed a mass delusion where the sheer cost of infrastructure was mistaken for its value.");
    expect(text).not.toContain("[R1");
  });

  it("keeps only quotes that are really in the text", () => {
    const text = projectText(book);
    expect(verifiedQuotes([
      "“We witnessed a mass delusion where the sheer cost of infrastructure was mistaken for its value.”",
      "AI will replace every job by 2030, says the author.",
      "Short one.",
    ], text)).toEqual(["We witnessed a mass delusion where the sheer cost of infrastructure was mistaken for its value."]);
  });

  it("writes captions and drops made-up quotes", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    let prompt = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      prompt = JSON.parse(init.body).contents[0].parts[0].text;
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        captions: { linkedin: "A new book on the AI correction [R1].", facebook: "Out now.", instagram: "New book!\n\n#AI #Finance" },
        hashtags: ["AI", "#Finance", "bad tag"], kicker: "New book", tagline: "When the boom met the balance sheet",
        highlights: ["Why capex outran revenue"],
        quotes: ["We witnessed a mass delusion where the sheer cost of infrastructure was mistaken for its value [R1].", "This book changed my life."],
      }) }] } }], modelVersion: "gemini-3.1-flash-lite" });
    }));
    const copy = await shareCopy(book, "Mention the webinar");
    expect(prompt).toContain("The Silicon Correction");
    expect(prompt).toContain("Mention the webinar");
    expect(prompt).toContain("Never invent facts, prices");
    expect(copy.captions.linkedin).toBe("A new book on the AI correction.");
    expect(copy.hashtags).toEqual(["#AI", "#Finance", "#badtag"]);
    expect(copy.quotes).toEqual(["We witnessed a mass delusion where the sheer cost of infrastructure was mistaken for its value."]);
  });
});
