import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { pack, unpack, zipValue, unzipValue } from "../src/server/db";
import { formatReference, renderManuscript, renderBook, citedIds, toBibtex, toRis } from "../src/shared/render";
import { checkChart, chartSvg, checkDiagram, diagramSvg, FigureSpecError, suggestCharts, sourceDataCsv } from "../src/shared/charts";
import { mergeWorks, publicWork } from "../src/server/research";
import { normalizeContent, renderHtml, rich, recipientsFromText, recipientsFromRows } from "../src/server/emailer";
import { cleanText, withLink, limitViolations, cleanHashtags } from "../src/server/text";
import { nextRun, normalizeBot } from "../src/server/autopilot";
import { csvRows, readRows } from "../src/shared/sheets";
import { authorBlock, keepKnown } from "../src/server/writer";
import { applyTexts, countPlaceholders, fillPlaceholders, findPlaceholders, guessValues, looksLikePlaceholder, placeholderSpots } from "../src/shared/placeholders";
import { textModels } from "../src/server/gemini";
import { safeUrl, mainContent, pageText } from "../src/server/web";
import { toLittleText } from "../src/server/platforms";

const ref = (id: string, extra: any = {}) => ({ id, kind: "article", title: "Vitamin D and glycaemic control", authors: [{ family: "Smith", given: "Anna B" }, { family: "Rao", given: "K" }],
  journal: "Diabetes Care", year: "2021", volume: "44", issue: "3", pages: "100-110", doi: "10.1000/xyz", url: "https://doi.org/10.1000/xyz", ...extra });

describe("MongoDB packing", () => {
  it("stores bulky fields as a real ZIP archive and reads them back", () => {
    const doc = { user_id: "u1", status: "ready", draft: { sections: [{ heading: "Intro", paragraphs: ["x".repeat(5000)] }] } };
    const packed = pack(doc, ["user_id", "status"]);
    expect(packed.user_id).toBe("u1");
    expect(packed.draft).toBeUndefined();
    const files = unzipSync(new Uint8Array(packed.z.buffer));
    expect(Object.keys(files)).toEqual(["data.json"]);
    expect(JSON.parse(strFromU8(files["data.json"])).draft.sections[0].heading).toBe("Intro");
    expect(packed.z.buffer.length).toBeLessThan(1000);
    expect(unpack(packed)).toEqual(doc);
    expect(unzipValue(zipValue([1, 2, 3]))).toEqual([1, 2, 3]);
  });
});

describe("references and citations", () => {
  it("formats articles in each style", () => {
    expect(formatReference(ref("R1"), "vancouver")).toBe("Smith AB, Rao K. Vitamin D and glycaemic control. Diabetes Care. 2021;44(3):100-110. doi:10.1000/xyz");
    expect(formatReference(ref("R1"), "apa")).toContain("Smith, A. B., & Rao, K. (2021).");
    expect(formatReference(ref("R1"), "ieee")).toContain('"Vitamin D and glycaemic control," *Diabetes Care*, vol. 44');
    expect(formatReference(ref("R1"), "mla")).toContain("Smith, Anna B, and K Rao.");
    expect(formatReference({ id: "R2", kind: "book", title: "Endocrinology", authors: [{ family: "Lee", given: "J" }], publisher: "OUP", year: "2019", isbn: "9780000000000" }, "vancouver"))
      .toBe("Lee J. Endocrinology. OUP; 2019. ISBN: 9780000000000");
  });
  it("numbers citations in order of first use and drops unknown ids", () => {
    const draft = { title: "T", sections: [{ heading: "Introduction", paragraphs: ["First [R2]. Second [R1, R2]. Bad [R9]."] }] };
    const out = renderManuscript(draft, [ref("R1"), ref("R2", { title: "Other study" })], "vancouver");
    expect(out.body[0].paragraphs[0]).toBe("First [1]. Second [1,2]. Bad.");
    expect(out.references[0].text).toContain("Other study");
    expect(citedIds("R1–R3, R5")).toEqual(["R1", "R2", "R3", "R5"]);
    expect(keepKnown("A [R1, R7] b [R8].", new Set(["R1"]))).toBe("A [R1] b.");
  });
  it("renders a book with per-chapter references when asked", () => {
    const book = { title: "B", chapters: [{ number: 1, title: "One", sections: [{ heading: "S", paragraphs: ["Claim [R1]."] }] }, { number: 2, title: "Two", sections: [{ heading: "S", paragraphs: ["Claim [R2]."] }] }] };
    const out = renderBook(book, [ref("R1"), ref("R2", { title: "Second" })], "vancouver", { references_placement: "chapter" });
    expect(out.chapters[1].sections[0].paragraphs[0]).toBe("Claim [1].");
    expect(out.chapters[1].references).toHaveLength(1);
    expect(out.references).toHaveLength(0);
  });
  it("exports BibTeX and RIS", () => {
    expect(toBibtex([ref("R1")])).toContain("@article{Smith2021,");
    expect(toRis([ref("R1")])).toContain("TY  - JOUR");
  });
});

describe("figures", () => {
  it("refuses chart values that aren't stated in the text", () => {
    const spec = { type: "bar", categories: ["A", "B"], series: [{ name: "n", values: [12, 30] }] };
    expect(() => checkChart(spec, "We saw 12 cases.")).toThrow(FigureSpecError);
    expect(chartSvg(checkChart(spec, "We saw 12 and 30 cases."))).toContain("<svg");
    expect(diagramSvg(checkDiagram({ layout: "cycle", steps: ["Plan", "Do", "Check", "Act"] }))).toContain("Plan");
  });
  it("suggests charts from a spreadsheet, with points for small groups", () => {
    const rows = [["Group", "Score"], ["A", "1"], ["A", "2"], ["A", "3"], ["B", "5"], ["B", "6"], ["B", "7"]];
    const options = suggestCharts(rows);
    expect(options[0].spec.type).toBe("dot");
    expect(options[0].spec.series[0].values).toEqual([2, 6]);
    expect(sourceDataCsv(options[1].spec)).toContain('"A",2');
  });
});

describe("research", () => {
  it("merges duplicates by DOI and title, keeps the date range and hides sources", () => {
    const a = { kind: "article", title: "Deep learning for retinal imaging", authors: [], journal: "J", year: "2020", doi: "10.1/abc", url: "", abstract: "" };
    const b = { ...a, doi: "10.1/ABC", abstract: "Retinal imaging with deep learning.", authors: [{ family: "Lee", given: "J" }] };
    const c = { ...a, doi: "", title: "Deep Learning for Retinal Imaging." };
    const old = { ...a, doi: "10.1/old", title: "Retinal imaging in 1990", year: "1990" };
    const merged = mergeWorks([[a], [b, c], [old]], "deep learning retinal", 100, { from: "2015", to: "2024" });
    expect(merged).toHaveLength(1);
    expect(merged[0].abstract).toContain("Retinal");
    expect(Object.keys(publicWork(merged[0]))).not.toContain("source");
  });
});

describe("email", () => {
  it("escapes everything and only links http(s)", () => {
    expect(rich("**hi** <b>x</b> [click](javascript:alert(1)) [ok](https://a.org)")).toBe(
      '<strong>hi</strong> &lt;b&gt;x&lt;/b&gt; [click](javascript:alert(1)) <a href="https://a.org" style="color:#0E7490;text-decoration:underline">ok</a>');
    const content = normalizeContent({ kind: "banner", subject: "S", headline: "<script>", body: ["a"] });
    expect(renderHtml(content, () => "")).not.toContain("<script>");
  });
  it("reads recipients from text and sheets", () => {
    const pasted = recipientsFromText("Ana <ana@x.org>\nana@x.org\nbad@\nbob@y.com, Bob");
    expect(pasted.recipients).toEqual([{ email: "ana@x.org", name: "Ana" }, { email: "bob@y.com", name: "Bob" }]);
    expect(pasted.duplicates).toBe(1);
    expect(recipientsFromRows([["Name", "Email"], ["Cy", "cy@z.io"]]).recipients[0].email).toBe("cy@z.io");
    expect(csvRows('a,"b,c"\n1,2')).toEqual([["a", "b,c"], ["1", "2"]]);
    expect(() => readRows("x.xls", new Uint8Array())).toThrow();
  });
});

describe("posts", () => {
  it("cleans markdown and adds links within limits", () => {
    expect(cleanText("**Bold** and *it* #tag_x")).toBe("Bold and it #tag_x");
    const long = `${"word ".repeat(500)}\n#one #two`;
    const linked = withLink(long, "https://ex.org/a", "facebook");
    expect(linked.length).toBeLessThanOrEqual(1999);
    expect(linked.endsWith("#one #two")).toBe(true);
    expect(withLink("Hi", "https://ex.org", "instagram")).toContain("Link in bio: ex.org");
    expect(limitViolations({ facebook: "x".repeat(2000) }, ["facebook"])).toHaveLength(1);
    expect(cleanHashtags(["#AI", "ai", "#  bad tag", "#Research"])).toEqual(["#AI", "#badtag", "#Research"]);
    expect(toLittleText("C# and #AI (x)")).toBe("C\\# and {hashtag|\\#|AI} \\(x\\)");
  });
  it("only uses Gemini lite models", () => {
    process.env.GEMINI_MODEL = "gemini-3-pro";
    expect(textModels().every((m) => /lite/.test(m))).toBe(true);
    process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
    expect(textModels()[0]).toBe("gemini-3.1-flash-lite");
    delete process.env.GEMINI_MODEL;
  });
});

describe("bots", () => {
  it("schedules in the user's time zone", () => {
    const schedule = { days: [0], times: ["09:00"], timezone: "Asia/Kolkata" };
    const next = nextRun(schedule, new Date("2026-11-15T12:00:00Z"))!; // a Sunday
    expect(next.toISOString()).toBe("2026-11-16T03:30:00.000Z"); // Monday 09:00 IST
    expect(normalizeBot({ name: "B", urls: ["https://a.org"], platforms: ["facebook"], schedule: { days: [1], times: ["10:00"], timezone: "UTC" } }).content).toBe("post");
  });
});

describe("web reading", () => {
  it("keeps only safe URLs and the page's own text", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("https://a.org/x")).toBe("https://a.org/x");
    const html = "<html><body><nav>Menu</nav><article><h1>Title</h1><p>" + "Body text. ".repeat(30) + "</p><div class='related'>Other article</div></article></body></html>";
    const content = mainContent("https://a.org", html);
    expect(content.text).toContain("Body text");
    expect(content.text).not.toContain("Other article");
    expect(pageText("https://a.org", "<p>a</p><script>x</script><p>b</p>")).toBe("a\nb");
  });
});

describe("placeholders", () => {
  const book = {
    title: "After the Bust",
    preface: "This book draws on the expertise of [Author Name], with thanks to the teams at [Research Institution].",
    chapters: [{ title: "One", sections: [{ heading: "Start", paragraphs: ["As [[author name]] argues [R3], growth slowed [sic].", "Plain text.", "[[number of firms]]"] }],
      key_points: ["A point"] }],
    tables: [{ columns: ["A", "B"], rows: [["[[value]]", "x"]] }],
    author_notes: ["Check [[funding]]"],
  };

  it("recognises gaps but not citations or editorial brackets", () => {
    expect(looksLikePlaceholder("Author Name")).toBe(true);
    expect(looksLikePlaceholder("insert date")).toBe(true);
    expect(looksLikePlaceholder("Company X")).toBe(true);
    expect(looksLikePlaceholder("R3")).toBe(false);
    expect(looksLikePlaceholder("sic")).toBe(false);
    expect(looksLikePlaceholder("emphasis added")).toBe(false);
    expect(looksLikePlaceholder("2021")).toBe(false);
  });

  it("lists each gap once, merging [[x]] and [X], and skips notes to the author", () => {
    const found = findPlaceholders(book);
    expect(found.map((p) => p.key)).toEqual(["author name", "research institution", "number of firms", "value"]);
    expect(found[0].count).toBe(2);
    expect(countPlaceholders(book)).toBe(5);
  });

  it("fills values everywhere and guesses only from the author's details", () => {
    const values = guessValues(findPlaceholders(book), { authors: "A. Kumar", affiliation: "XYZ University" });
    expect(values).toEqual({ "author name": "A. Kumar" });
    expect(guessValues(findPlaceholders(book), { affiliation: "XYZ University" }, true)).toEqual({ "research institution": "XYZ University" });
    const filled = fillPlaceholders(book, values);
    expect(filled.preface).toContain("expertise of A. Kumar,");
    expect(filled.chapters[0].sections[0].paragraphs[0]).toBe("As A. Kumar argues [R3], growth slowed [sic].");
    expect(filled.author_notes).toEqual(["Check [[funding]]"]);
    expect(book.preface).toContain("[Author Name]");
  });

  it("puts rewritten passages back and drops emptied paragraphs but not table cells", () => {
    const spots = placeholderSpots(book);
    expect(spots.map((s) => s.path.join("."))).toEqual(["preface", "chapters.0.sections.0.paragraphs.0", "chapters.0.sections.0.paragraphs.2", "tables.0.rows.0.0"]);
    const done = applyTexts(book, [[spots[2].path, ""], [spots[3].path, ""], [spots[0].path, "This book draws on many experts."]]);
    expect(done.chapters[0].sections[0].paragraphs).toHaveLength(2);
    expect(done.tables[0].rows[0]).toEqual(["", "x"]);
    expect(done.preface).toBe("This book draws on many experts.");
    expect(book.chapters[0].sections[0].paragraphs).toHaveLength(3);
  });

  it("tells the writer the author's details and what to leave out", () => {
    const block = authorBlock({ authors: "A. Kumar", funding: "", facts: [{ question: "How many took part?", answer: "120" }, { question: "Which hospital?", answer: "" }] });
    expect(block).toContain("- Author(s): A. Kumar");
    expect(block).toContain("How many took part? 120");
    expect(block).toContain("didn't answer: Which hospital?");
    expect(block).not.toContain("Funding");
    expect(authorBlock({})).toContain("don't name the author");
  });
});
