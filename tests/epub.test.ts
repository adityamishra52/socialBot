import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildEpub, guessLanguage } from "../src/client/lib/exportEpub.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const project = {
  mode: "book", references: [{ id: "R1", kind: "article", title: "Capex & returns", authors: [{ family: "Smith", given: "A" }], journal: "J Fin", year: "2021" }],
  figures: [{ chapter: 0, after: "Capital and sand", caption: "Spending <vs> revenue", svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", credit: "Drawn from the text." }],
  options: { style: "apa", authors: "A. Kumar", publisher: "Example & Sons", year: "2026", isbn: "978-0-306-40615-7", dedication: "For my *teachers*", layout: {} },
  draft: {
    title: "The Silicon Correction", subtitle: "After the Bust", blurb: "How the AI boom met financial reality.", preface: "Why this book exists.\n\nHow to use it.",
    chapters: [
      { number: 1, title: "The Leveraged Capex Illusion", objectives: ["See the bubble"], key_points: ["Cost is not value"], summary: "A summary.", sections: [
        { heading: "Capital and sand", level: 1, paragraphs: ["We witnessed a mass delusion [R1].", "Second paragraph with *Homo sapiens* & more."] },
        { heading: "A detail", level: 2, paragraphs: ["Detail text."] },
      ] },
      { number: 2, title: "Governance After the Boom", sections: [{ heading: "Rules", level: 1, paragraphs: ["Text."] }] },
    ],
    conclusion: "The end.", glossary: [{ term: "Capex", definition: "Capital expenditure." }],
  },
};

/** A small well-formedness check: tags balance, empty tags self-close, only XML entities are used. */
function wellFormed(xml: string) {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, "").matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open}>`;
    } else stack.push(name);
  }
  if (stack.length) return `unclosed <${stack.join("> <")}>`;
  const bad = xml.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i);
  if (bad) return `bad entity near ${xml.slice(bad.index!, bad.index! + 20)}`;
  return "ok";
}

describe("EPUB export", () => {
  it("builds a valid EPUB 3 package", async () => {
    const built = await buildEpub(project, { cover: JPG, loadFigure: async () => PNG, now: new Date("2026-11-15T10:20:30.456Z"), uuid: "x" });
    const raw = built.data;
    // The mimetype entry is first, stored (method 0), with no extra field.
    expect(strFromU8(raw.slice(30, 38))).toBe("mimetype");
    expect(raw[8] | (raw[9] << 8)).toBe(0);
    expect(raw[28] | (raw[29] << 8)).toBe(0);
    expect(strFromU8(raw.slice(38, 58))).toBe("application/epub+zip");

    const files = unzipSync(raw);
    const text = (name: string) => strFromU8(files[name]);
    expect(Object.keys(files)[0]).toBe("mimetype");
    expect(text("META-INF/container.xml")).toContain('full-path="OEBPS/content.opf"');
    const opf = text("OEBPS/content.opf");
    expect(opf).toContain("<dc:identifier id=\"bookid\">urn:isbn:9780306406157</dc:identifier>");
    expect(opf).toContain("<dc:creator id=\"creator\">A. Kumar</dc:creator>");
    expect(opf).toContain("<dc:publisher>Example &amp; Sons</dc:publisher>");
    expect(opf).toContain('<meta property="dcterms:modified">2026-11-15T10:20:30Z</meta>');
    expect(opf).toContain('href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"');
    expect(opf).toContain('href="images/figure-1.png" media-type="image/png"');

    // Every content file is in the manifest, and the contents page comes after title, copyright and dedication.
    const xhtml = Object.keys(files).filter((f) => f.endsWith(".xhtml"));
    for (const f of xhtml) expect(opf).toContain(`href="${f.replace("OEBPS/", "")}"`);
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(spine.indexOf("nav")).toBe(3);
    expect(spine).toHaveLength(xhtml.length);

    for (const f of [...xhtml, "OEBPS/content.opf", "OEBPS/toc.ncx", "META-INF/container.xml"]) expect([f, wellFormed(text(f))]).toEqual([f, "ok"]);
    const nav = text("OEBPS/nav.xhtml");
    expect(nav).toContain("Chapter 1: The Leveraged Capex Illusion");
    expect(nav).toContain("Preface");
    expect(nav).toContain("Glossary");
    expect(nav).toContain("References");
    expect(nav).toContain('epub:type="bodymatter"');
    expect(text("OEBPS/toc.ncx")).toContain("Governance After the Boom");

    const all = xhtml.map(text).join("\n");
    expect(all).toContain("<em>Homo sapiens</em> &amp; more.");
    expect(all).toContain("(Smith, 2021)");
    expect(all).not.toContain("[R1]");
    expect(all).toContain('<img src="images/figure-1.png" alt="Figure 1. Spending &lt;vs&gt; revenue"/>');
    expect(all).toContain("For my <em>teachers</em>");
    expect(built.chapters).toBe(2);
    expect(built.images).toBe(1);
    expect(built.warnings).toEqual([]);
  });

  it("notes figures it couldn't add and works without a cover", async () => {
    const built = await buildEpub(project, { loadFigure: async () => null });
    const opf = strFromU8(unzipSync(built.data)["OEBPS/content.opf"]);
    expect(opf).not.toContain("cover-image");
    expect(built.warnings[0]).toContain("Figure 1");
  });

  it("guesses the language from the script", () => {
    expect(guessLanguage("The AI boom")).toBe("en");
    expect(guessLanguage("छठ पूजा की शुभकामनाएँ and a little English")).toBe("hi");
  });
});
