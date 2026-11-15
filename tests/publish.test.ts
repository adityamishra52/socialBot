import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bookListing } from "../src/server/listing";
import { kdpInsideMinimum, kitZip, listingText, paperbackNotes, stepsText, STORE_STEPS } from "../src/client/lib/publishKit.js";

const reply = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const book = {
  mode: "book", status: "ready",
  options: { authors: "A. Kumar", affiliation: "University of Delhi", book_type: "academic", audience: "finance students", topic: "The AI boom", year: "2026" },
  draft: { title: "The Silicon Correction", subtitle: "After the Bust", blurb: "How the AI boom met financial reality [R1].", chapters: [{ title: "The Leveraged Capex Illusion", summary: "Why spending outran revenue." }] },
};

describe("store listing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes a listing from the book and the author's own details", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    let prompt = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      prompt = JSON.parse(init.body).contents[0].parts[0].text;
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        description: "**A sharp look** at the AI boom [R1].\n\nFor investors.", tagline: "When the boom met the balance sheet.",
        keywords: ["ai bubble", "capex", "ai bubble", "x".repeat(60), "tech investing", "finance", "governance", "balance sheets", "extra"],
        categories: ["BUSINESS & ECONOMICS/Finance/General", "COMPUTERS / Artificial Intelligence / General"],
        audience: "Adult; investors", author_bio: "A. Kumar teaches at the University of Delhi.",
      }) }] } }], modelVersion: "gemini-3.1-flash-lite" });
    }));
    const listing = await bookListing(book);
    expect(prompt).toContain("Affiliation: University of Delhi");
    expect(prompt).toContain("Never invent reviews, awards");
    expect(listing.description).toBe("A sharp look at the AI boom.\n\nFor investors.");
    expect(listing.keywords).toEqual(["ai bubble", "capex", "tech investing", "finance", "governance", "balance sheets", "extra"]);
    expect(listing.categories[0]).toBe("BUSINESS & ECONOMICS / Finance / General");
    expect(listing.author_bio).toContain("University of Delhi");
  });
});

describe("publishing kit", () => {
  it("knows KDP's paperback margins", () => {
    expect(kdpInsideMinimum(120)).toBe(9.6);
    expect(kdpInsideMinimum(320)).toBe(15.9);
    const ok = paperbackNotes({ margin_inside: 22, margin_outside: 16, margin_top: 20, margin_bottom: 20, mirror_margins: true }, 180, [152.4, 228.6]);
    expect(ok.inches).toBe("6.00 × 9.00 in");
    expect(ok.notes).toEqual([]);
    const bad = paperbackNotes({ margin_inside: 10, margin_outside: 5, margin_top: 20, margin_bottom: 20, mirror_margins: false }, 12, [152.4, 228.6]);
    expect(bad.notes.join(" ")).toContain("at least 24 pages");
    expect(bad.notes.join(" ")).toContain("outside margin must be at least 6.4 mm");
    expect(bad.notes.join(" ")).toContain("Mirror margins");
  });

  it("writes the listing and the steps for all three stores", () => {
    const text = listingText({ draft: book.draft, options: book.options, listing: { description: "Desc.", tagline: "", keywords: ["a", "b"], categories: ["X / Y"], audience: "Adults", author_bio: "" }, pages: 180, words: 52000, language: "en", size: "6 × 9 in", date: new Date("2026-11-15") });
    expect(text).toContain("Title: The Silicon Correction");
    expect(text).toContain("Length: 180 pages in the PDF (6 × 9 in), about 52,000 words");
    expect(text).toContain("1. a\n2. b");
    expect(text).toContain("AI DISCLOSURE");
    expect(STORE_STEPS.map((s) => s.store)).toEqual(["Amazon Kindle (KDP)", "Google Play Books", "Draft2Digital"]);
    expect(stepsText(["book.epub"])).toContain("DRAFT2DIGITAL");
  });

  it("zips the kit, storing files that are already compressed", () => {
    const zip = kitZip("kit", { "book.epub": new Uint8Array([1, 2, 3]), "store-listing.txt": "a\nb" });
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(["kit/book.epub", "kit/store-listing.txt"]);
    expect(strFromU8(files["kit/store-listing.txt"])).toBe("a\r\nb");
  });
});

describe("KDP paperback cover", async () => {
  const { paperbackGeometry, coverDpi, paperbackSummary } = await import("../src/client/lib/paperbackCover.js");

  it("sizes the full cover like KDP's cover calculator", () => {
    const g = paperbackGeometry(152.4, 228.6, 200, "white");
    expect(g.spine).toBeCloseTo(0.4504, 4);
    expect(g.width).toBeCloseTo(12.7004, 4);
    expect(g.height).toBeCloseTo(9.25, 4);
    expect(g.front.x).toBeCloseTo(6.5754, 4);
    expect(g.spineText).toBe(true);
    // The barcode box: 2 x 1.2 in, 0.25 in from the spine and the bottom trim of the back cover.
    expect(g.barcode.x + g.barcode.w).toBeCloseTo(0.125 + 6 - 0.25, 4);
    expect(g.barcode.y + g.barcode.h).toBeCloseTo(0.125 + 9 - 0.25, 4);
    expect(paperbackGeometry(152.4, 228.6, 200, "cream").spine).toBeCloseTo(0.5, 4);
    expect(paperbackGeometry(152.4, 228.6, 60, "white").spineText).toBe(false);
    expect(coverDpi(g)).toBe(300);
    expect(coverDpi(paperbackGeometry(215.9, 279.4, 800, "premium"))).toBeLessThan(300);
    expect(paperbackSummary(g, 300).size).toBe("12.700 × 9.250 in");
  });
});
