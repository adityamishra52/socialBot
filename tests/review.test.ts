import { afterEach, describe, expect, it, vi } from "vitest";
import { review } from "../src/server/writer";
import { wrongAboutPlaceholders } from "../src/shared/placeholders";

const book = {
  mode: "book",
  references: [
    { id: "R1", kind: "article", title: "Capital spending and the AI boom", authors: [{ family: "Kumar", given: "A" }], journal: "Journal of Finance", year: "2025" },
    { id: "R2", kind: "article", title: "Bubbles and their bursts", authors: [{ family: "Lee", given: "B" }, { family: "Ito", given: "C" }], journal: "Economic Review", year: "2024" },
  ],
  draft: {
    title: "The Silicon Correction",
    chapters: [{ number: 1, title: "The Leveraged Capex Illusion", sections: [
      { heading: "Capital and sand", paragraphs: ["Spending outran revenue [R1].", "Earlier bubbles burst the same way [R2, R9]."] },
    ] }],
  },
};

const reply = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("quality review", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("knows advice that calls citations placeholders", () => {
    expect(wrongAboutPlaceholders("Replace placeholder citations with actual, real-world economic reports and peer-reviewed journals.", 0)).toBe(true);
    expect(wrongAboutPlaceholders("Are the [R#] citations intended to be replaced with actual academic bibliography?", 0)).toBe(true);
    expect(wrongAboutPlaceholders("The references look like placeholders.", 3)).toBe(true);
    expect(wrongAboutPlaceholders("Swap the [R3] citation for a real source.", 3)).toBe(true);
    expect(wrongAboutPlaceholders("Expand the historical comparison to include specific economic metrics.", 0)).toBe(false);
    expect(wrongAboutPlaceholders("Can you provide verifiable sources for the foresight isomorphism?", 0)).toBe(false);
    expect(wrongAboutPlaceholders("Fill in the [[number of participants]] placeholder.", 2)).toBe(false);
    expect(wrongAboutPlaceholders("Fill in the [[number of participants]] placeholder.", 0)).toBe(true);
  });

  it("shows real citations with their reference list and drops placeholder advice", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    let prompt = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      prompt = JSON.parse(init.body).contents[0].parts[0].text;
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        scores: { overall: 7, originality: 8, evidence: 6, structure: 7, clarity: 8, citations: 5 },
        decision: "minor edits",
        summary: "A sharp argument. The placeholder citations must be replaced. Chapter 2 is thin.",
        strengths: ["Clear thesis"],
        weaknesses: ["Relies on placeholder references", "Chapter 2 lacks data"],
        fixes: [
          { where: "Chapter 1", change: "Replace placeholder citations with actual reports.", instruction: "Replace the citations with real sources" },
          { where: "Chapter 1", change: "Expand the historical comparison.", instruction: "Expand the comparison with 1929 metrics" },
        ],
        questions: ["Are the [R#] citations intended to be replaced?", "Who is the target audience?"],
      }) }] } }], modelVersion: "gemini-3.1-flash-lite" });
    }));
    const result = await review(structuredClone(book));
    expect(prompt).toContain("Spending outran revenue (Kumar, 2025).");
    expect(prompt).toContain("(Lee & Ito, 2024)");
    expect(prompt).not.toMatch(/\[R\d/);
    expect(prompt).toContain("Capital spending and the AI boom");
    expect(prompt).toContain("never call them placeholders");
    expect(prompt).toContain("no placeholders or gaps left");
    expect(result.summary).toBe("A sharp argument. Chapter 2 is thin.");
    expect(result.weaknesses).toEqual(["Chapter 2 lacks data"]);
    expect(result.fixes.map((f: any) => f.change)).toEqual(["Expand the historical comparison."]);
    expect(result.questions).toEqual(["Who is the target audience?"]);
  });
});
