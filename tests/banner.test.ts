import { afterEach, describe, expect, it, vi } from "vitest";
import { artPrompt, bannerBrief, planBanner } from "../src/server/banner";
import { contrast, normalizeDesign, onColour, wrapLines } from "../src/client/lib/banner.js";

const reply = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("banner brief", () => {
  it("needs a topic and keeps only known, trimmed details", () => {
    expect(() => bannerBrief({ topic: "  " })).toThrow("Enter what the banner is about");
    const brief = bannerBrief({ topic: " Happy  Chhath Puja ", kind: "festival", aspect: "7:3", variations: 9, details: { message: "  Blessings  ", evil: "x", brand: "" } });
    expect(brief.topic).toBe("Happy Chhath Puja");
    expect(brief.aspect).toBe("4:5");
    expect(brief.variations).toBe(3);
    expect(brief.style).toBe("illustration");
    expect(brief.details).toEqual({ message: "Blessings" });
    expect(bannerBrief({ topic: "Sale", kind: "marketing" }).style).toBe("photo");
    expect(bannerBrief({ topic: "Sale", kind: "nope", style: "watercolour" }).kind).toBe("festival");
  });
});

describe("banner plan", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for words and concepts without invented facts, and cleans the answer", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    let prompt = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      prompt = JSON.parse(init.body).contents[0].parts[0].text;
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        kicker: "Happy", headline: "Chhath Puja", message: "May the setting sun bless you.", points: [], cta: "",
        caption: "Wishing everyone a blessed Chhath Puja.", hashtags: ["ChhathPuja", "#Festival", "#Festival", "bad tag!"],
        concepts: [
          { scene: "A woman offering arghya at sunset on a river ghat", text_area: "top", palette: { background: "#FDF3E7", text: "#7a1f1f", accent: "#d97706" }, headline_font: "script", ornament: "sun" },
          { scene: "Baskets of fruit and diyas on the water", text_area: "sideways", palette: { background: "red" }, headline_font: "comic", ornament: "dragon" },
        ],
      }) }] } }], modelVersion: "gemini-3.1-flash-lite" });
    }));
    const plan = await planBanner(bannerBrief({ topic: "Happy Chhath Puja", kind: "festival", language: "Hindi", variations: 2, details: { brand: "Team eManuscript" } }));
    expect(prompt).toContain("Team eManuscript");
    expect(prompt).toContain("Language of every word on the banner and in the caption: Hindi");
    expect(prompt).toContain("Never invent dates");
    expect(plan.headline).toBe("Chhath Puja");
    expect(plan.hashtags).toEqual(["#ChhathPuja", "#Festival", "#badtag"]);
    expect(plan.concepts).toHaveLength(2);
    expect(plan.concepts[0]).toMatchObject({ text_area: "top", headline_font: "script", ornament: "sun", palette: { background: "#fdf3e7" } });
    expect(plan.concepts[1]).toMatchObject({ text_area: "top", headline_font: "serif", ornament: "none", palette: { background: "#fbf3e6" } });
  });

  it("tells the image model to leave room for the words and draw no text", () => {
    const text = artPrompt({ kind: "research", style: "minimal", scene: "Molecules and light", area: "left" });
    expect(text).toContain("the left half of the image");
    expect(text).toContain("absolutely no text");
    expect(() => artPrompt({ kind: "festival", style: "photo", scene: "", area: "top" })).toThrow("Describe what the picture should show");
  });
});

describe("banner drawing helpers", () => {
  it("wraps words to the width and splits words that are too long", () => {
    const measure = (t: string) => t.length * 10;
    expect(wrapLines(measure, "May the divine blessings fill your life", 120)).toEqual(["May the", "divine", "blessings", "fill your", "life"]);
    expect(wrapLines(measure, "Supercalifragilistic", 60)).toEqual(["Superc", "alifra", "gilist", "ic"]);
    expect(wrapLines(measure, "One\nTwo", 500)).toEqual(["One", "Two"]);
  });

  it("picks readable button text and fills design defaults", () => {
    expect(onColour("#7a1f1f")).toBe("#ffffff");
    expect(onColour("#fde68a")).toBe("#1a1a1a");
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    const d = normalizeDesign({ aspect: "2:1", font: "comic", area: "middle", points: ["a", " ", ""], scale: 9 });
    expect(d).toMatchObject({ aspect: "4:5", font: "serif", area: "top", points: ["a"], scale: 1.5, fade: 0.7 });
  });
});
