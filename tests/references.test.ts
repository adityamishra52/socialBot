import { afterEach, describe, expect, it, vi } from "vitest";
import { citer, formatReference, renderBook, tidyReference, toRis } from "../src/shared/render";
import { glossaryTerms, outlineBook, termUsage, writeChapter } from "../src/server/writer";

// Records as the research services returned them for "The Silicon Correction".
const hasebe = {
  id: "R1", kind: "preprint", year: "2026", journal: "Zenodo (CERN European Organization for Nuclear Research)", doi: "10.5281/zenodo.23462530",
  authors: [{ family: "Hasebe(長谷部)", given: "Y." }],
  title: "The End of Uncompensated AI Free-Riding and the Bursting of the Leveraged Capex Bubble (1929–2026) (無償のAIフリーライドの終焉――[1929年との同型性]と[2026年の崩壊])",
};
const sidhu = {
  id: "R2", kind: "article", year: "2026", journal: "Journal of Administrative Development", volume: "3", issue: "2", pages: "111-132",
  authors: [{ family: "Arpit Sidhu", given: "" }, { family: "Shubham Kakran", given: "" }], title: "A Burst Bubble In Financial Stock Market Causes Financial Contagion",
};
const tewatiya = {
  id: "R3", kind: "article", year: "2026", journal: "Zenodo (CERN European Organization for Nuclear Research)",
  authors: [{ family: "tewatiya", given: "A." }], title: "THE GREAT ASIAN MARKET CORRECTION (2025–2026): ANALYZING CAPITAL FLIGHT, GEOPOLITICAL SHOCKS, AND PATHWAYS TO FINANCIAL STABILITY",
};
const whittle = { id: "R4", kind: "book", year: "2026", authors: [{ family: "Whittle", given: "J." }], title: "AI for Business", publisher: "CSIRO Publishing36 Gardiner Road, Clayton VIC 3168, Private Bag 10, Clayton South VIC 3169, Australia" };
const orf = { id: "R5", kind: "book", year: "2026", authors: [], title: "Democratising AI: Towards Open, Decentralised AI Ecosystems", publisher: "ORF" };
const zhang = { id: "R6", kind: "book", year: "2026", authors: [{ family: "Zhang", given: "X." }], title: "AI Finance: Financial Modeling", publisher: "World Scientific Publishing Co." };
const spellauge = { id: "R7", kind: "article", year: "2026", journal: "Applied Surface Science", volume: "752", pages: "168254-168254", authors: [{ family: "Spellauge", given: "M." }], title: "Enhancing the laser ablation efficiency of gold" };
const frontiers = { id: "R8", kind: "article", year: "2026", journal: "Advances in Social Science, Education and Humanities Research/Advances in social science, education and humanities research", authors: [{ family: "SWARTZ", given: "J." }, { family: "Huang", given: "J." }], title: "Frontiers" };
const silva = { id: "R9", kind: "article", year: "2026", journal: "Frontiers in oncology", volume: "1", issue: "05 - October", authors: [{ family: "World Health Organization", given: "" }], title: "The“Ai bubble” concept" };

describe("reference records are tidied for the book", () => {
  it("drops a name or title repeated in another script, which the PDF fonts show as ???", () => {
    const text = formatReference(hasebe, "apa");
    expect(text).toContain("Hasebe, Y. (2026). The End of Uncompensated AI Free-Riding and the Bursting of the Leveraged Capex Bubble (1929–2026).");
    expect(text).not.toMatch(/[長谷部無償]/u);
    const cite = citer([hasebe], "apa");
    cite.visit("Data were free [R1].");
    expect(cite.fix("Data were free [R1].")).toBe("Data were free (Hasebe, 2026).");
  });

  it("splits a full name given as the family name and fixes ALL-CAPS or lower-case names and titles", () => {
    expect(formatReference(sidhu, "apa")).toMatch(/^Sidhu, A\., & Kakran, S\. \(2026\)/);
    expect(formatReference(tewatiya, "apa")).toContain("Tewatiya, A. (2026). The Great Asian Market Correction (2025–2026): Analyzing Capital Flight, Geopolitical Shocks, and Pathways to Financial Stability.");
    expect(formatReference(frontiers, "apa")).toMatch(/^Swartz, J\., & Huang, J\./);
    const cite = citer([sidhu, tewatiya], "apa");
    cite.visit("x [R2, R3].");
    expect(cite.fix("x [R2, R3].")).toBe("x (Sidhu & Kakran, 2026; Tewatiya, 2026).");
  });

  it("keeps organisations, acronyms and mixed-case names as they are", () => {
    expect(tidyReference(silva).authors).toEqual([{ family: "World Health Organization", given: "" }]);
    expect(tidyReference({ id: "R", title: "GEN AI BUBBLE IN THE US AND EU", authors: [{ family: "Adler‐Nissen", given: "R." }, { family: "M N", given: "G. P." }] } as any))
      .toMatchObject({ title: "Gen AI Bubble in the US and EU", authors: [{ family: "Adler‐Nissen", given: "R." }, { family: "M N", given: "G. P." }] });
  });

  it("cleans publishers, journals, issues, pages and the no-author citation", () => {
    expect(formatReference(whittle, "apa")).toBe("Whittle, J. (2026). *AI for Business*. CSIRO Publishing.");
    expect(formatReference(zhang, "apa")).toBe("Zhang, X. (2026). *AI Finance: Financial Modeling*. World Scientific Publishing Co.");
    expect(formatReference(spellauge, "apa")).toContain("*Applied Surface Science*, *752*, 168254.");
    expect(formatReference(frontiers, "apa")).toContain("*Advances in Social Science, Education and Humanities Research*.");
    expect(formatReference(silva, "apa")).toContain("The “Ai bubble” concept. *Frontiers in Oncology*, *1*(5).");
    const cite = citer([orf], "apa");
    cite.visit("Open AI [R5].");
    expect(cite.fix("Open AI [R5].")).toBe("Open AI (Democratising AI, 2026).");
    expect(toRis([sidhu])).toContain("AU  - Sidhu, Arpit");
  });

  it("tidies the references in a rendered book", () => {
    const book = renderBook({ chapters: [{ title: "One", sections: [{ heading: "A", paragraphs: ["Text [R1, R3]."] }] }] }, [hasebe, tewatiya], "apa");
    expect(book.chapters[0].sections[0].paragraphs[0]).toBe("Text (Hasebe, 2026; Tewatiya, 2026).");
    expect(book.references.map((r) => r.text.slice(0, 12))).toEqual(["Hasebe, Y. (", "Tewatiya, A."]);
  });
});

const reply = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const answer = (data: any) => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], modelVersion: "gemini-3.1-flash-lite" });

describe("the book writer keeps to the subject", () => {
  afterEach(() => vi.unstubAllGlobals());
  const project = {
    mode: "book", sources: [],
    options: { topic: "The 2026 AI bubble burst", chapters: 3, words_per_chapter: 800, authors: "A. Author" },
    references: [
      { id: "R1", title: "Capital spending and the AI boom", authors: [{ family: "Kumar", given: "A" }], year: "2025", journal: "J Fin" },
      { id: "R2", title: "Robust burst bubble recognition in flotation froths via RGB-D imaging", authors: [{ family: "Zhao", given: "L" }], year: "2026", journal: "Minerals Engineering" },
    ],
  };

  it("doesn't force every reference in, and leaves off-topic ones out of the chapters", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
      if (prompts.length === 1) {
        return answer({ title: "T", subtitle: "S", off_topic: ["R2", "R99"], chapters: [1, 2, 3].map((n) => ({ title: `C${n}`, summary: "s", sections: ["A", "B", "C"], refs: ["R1", "R2"] })) });
      }
      return answer({ sections: [{ heading: "A", paragraphs: [`${"Words here. ".repeat(110)}Froth flotation shows it [R2]. Spending rose [R1].`] }] });
    }));
    const plan = await outlineBook(project);
    expect(prompts[0]).not.toContain("Every selected reference should be used");
    expect(prompts[0]).toContain('"off_topic"');
    expect(plan.off_topic).toEqual(["R2"]);
    expect(plan.chapters.map((c: any) => c.refs)).toEqual([["R1"], ["R1"], ["R1"]]);

    const chapter = await writeChapter({ ...project, plan }, 0);
    expect(prompts[1]).not.toContain("flotation froths");
    expect(prompts[1]).toContain("never claim the author ran an analysis".replace("never", "Never"));
    expect(chapter.sections[0].paragraphs[0]).toContain("Froth flotation shows it. Spending rose [R1].");
  });

  it("ignores an off-topic list that would leave no references at all", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    vi.stubGlobal("fetch", vi.fn(async () => answer({ title: "T", off_topic: ["R1", "R2"], chapters: [1, 2, 3].map((n) => ({ title: `C${n}`, summary: "s", sections: ["A"], refs: ["R1"] })) })));
    const plan = await outlineBook(project);
    expect(plan.off_topic).toEqual([]);
    expect(plan.chapters[0].refs).toEqual(["R1"]);
  });

  it("defines glossary terms from how the chapters use them", () => {
    const book = { chapters: [
      { key_terms: ["Leveraged Capex", "c_data"], sections: [{ paragraphs: ["Firms assumed c_data was zero [R1]. That was wrong."] }] },
      { key_terms: ["leveraged capex"], sections: [{ paragraphs: ["Leveraged capex is spending funded by debt."] }] },
    ] };
    const terms = glossaryTerms(book);
    expect(terms).toEqual(["Leveraged Capex", "c_data"]);
    expect(termUsage(book, terms)).toBe("- Leveraged Capex: Leveraged capex is spending funded by debt.\n- c_data: Firms assumed c_data was zero.");
  });
});
