import { strToU8, zipSync } from "fflate";
import { buildBlocks, runs } from "./layout.js";

// EPUB 3 ebooks for Amazon KDP and Google Play Books, built in the browser from the same blocks as
// the preview, print and Word export. Reflowable text (readers choose the font size), a contents
// page and navigation, figures as images, references and glossary, and the cover image. Includes
// an EPUB 2 toc.ncx for older readers. The `mimetype` entry comes first and is stored uncompressed,
// as the EPUB rules require.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (text) => runs(text).map((r) => (r.italic ? `<em>${esc(r.text)}</em>` : esc(r.text))).join("");

/** The main language of the text, by script (Devanagari → Hindi, and so on); English otherwise. */
export function guessLanguage(text) {
  const sample = String(text || "").slice(0, 20000);
  const scripts = [["hi", /\p{Script=Devanagari}/gu], ["bn", /\p{Script=Bengali}/gu], ["ta", /\p{Script=Tamil}/gu], ["te", /\p{Script=Telugu}/gu],
    ["gu", /\p{Script=Gujarati}/gu], ["pa", /\p{Script=Gurmukhi}/gu], ["ar", /\p{Script=Arabic}/gu], ["zh", /\p{Script=Han}/gu]];
  const latin = (sample.match(/\p{Script=Latin}/gu) || []).length;
  for (const [code, pattern] of scripts) if ((sample.match(pattern) || []).length > latin) return code;
  return "en";
}

export const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 0; padding: 0 2%; }
h1, h2, h3 { font-family: serif; line-height: 1.25; page-break-after: avoid; break-after: avoid; }
h2 { font-size: 1.25em; margin: 1.4em 0 0.5em; }
h3 { font-size: 1.08em; font-style: italic; margin: 1.1em 0 0.4em; }
p { margin: 0; text-indent: 1.2em; text-align: justify; }
h1 + p, h2 + p, h3 + p, header + p, .box p, .noindent { text-indent: 0; }
.chapter-head { margin: 2.5em 0 1.6em; text-align: center; }
.chapter-label { text-transform: uppercase; letter-spacing: 0.15em; font-size: 0.8em; margin: 0 0 0.4em; text-indent: 0; text-align: center; }
.chapter-head h1 { font-size: 1.7em; margin: 0; }
.titlepage { text-align: center; margin-top: 25%; }
.titlepage h1 { font-size: 2em; margin: 0 0 0.5em; }
.titlepage p { text-indent: 0; text-align: center; }
.subtitle { font-style: italic; font-size: 1.2em; }
.author { margin-top: 2.5em; font-size: 1.15em; }
.publisher { margin-top: 4em; letter-spacing: 0.06em; }
.copyright { font-size: 0.85em; margin-top: 35%; }
.copyright p { text-indent: 0; margin-bottom: 0.7em; text-align: left; }
.dedication { text-align: center; font-style: italic; margin-top: 30%; }
.dedication p { text-indent: 0; text-align: center; }
.box { border: 1px solid #999; padding: 0.6em 0.9em; margin: 1em 0; }
.box-title { font-weight: bold; margin-bottom: 0.3em; }
.box ul, .box ol { margin: 0.2em 0 0; padding-left: 1.3em; }
figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
figcaption { font-size: 0.9em; text-align: left; margin-top: 0.4em; }
.credit { color: #555; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; margin: 0.4em 0; }
th, td { border-bottom: 1px solid #bbb; padding: 0.2em 0.4em; text-align: left; vertical-align: top; }
.caption { text-indent: 0; margin-top: 1em; }
.note { text-indent: 0; font-size: 0.9em; }
.ref { text-indent: -1.5em; padding-left: 1.5em; font-size: 0.92em; margin-bottom: 0.4em; text-align: left; }
.gloss { text-indent: 0; margin-bottom: 0.5em; }
nav ol { list-style: none; padding-left: 0; }
nav li { margin: 0.35em 0; }
nav ol ol { padding-left: 1.3em; font-size: 0.95em; }`;

function page(title, body, lang) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`;
}

const imageType = (bytes) => (bytes[0] === 0x89 && bytes[1] === 0x50 ? ["png", "image/png"] : ["jpg", "image/jpeg"]);

/**
 * Build the EPUB. `cover` is the cover as JPEG or PNG bytes (Uint8Array) or null.
 * `loadFigure(block)` returns a figure's image bytes (or null to leave the picture out).
 * Returns { data: Uint8Array, files: [...], chapters, images, warnings }.
 * @param {any} project
 * @param {{ cover?: Uint8Array | null, language?: string, loadFigure?: (block: any) => Promise<Uint8Array | null>, now?: Date, uuid?: string }} [settings]
 */
export async function buildEpub(project, { cover = null, language = "", loadFigure = async () => null, now = new Date(), uuid = "" } = {}) {
  const o = project.options || {};
  const { blocks, rendered } = buildBlocks({ ...project, options: { ...o, layout: { ...(o.layout || {}), title_page: true, copyright_page: true, toc: true } } });
  const title = rendered.title || o.book_name || "Untitled book";
  const lang = language || guessLanguage(blocks.map((b) => b.text || "").join(" "));
  const warnings = [];
  const parts = [];
  const images = [];
  let current = null;
  let tocAt = -1;
  let figureCount = 0;
  let sectionCount = 0;
  const start = (kind, heading = "", label = "") => {
    current = { id: `part-${String(parts.length + 1).padStart(3, "0")}`, kind, heading, label, html: [], sections: [] };
    parts.push(current);
  };

  for (const block of blocks) {
    switch (block.type) {
      case "title-page":
        start("titlepage", "Title page");
        current.html.push(`<section epub:type="titlepage" class="titlepage">\n<h1>${esc(block.title)}</h1>${block.subtitle ? `\n<p class="subtitle">${esc(block.subtitle)}</p>` : ""}${block.authors ? `\n<p class="author">${esc(block.authors)}</p>` : ""}${block.publisher ? `\n<p class="publisher">${esc(block.publisher)}</p>` : ""}\n</section>`);
        current = null;
        break;
      case "copyright":
        start("copyright", "Copyright");
        current.html.push(`<section epub:type="copyright-page" class="copyright">\n${block.lines.map((l) => `<p>${esc(l)}</p>`).join("\n")}\n</section>`);
        current = null;
        break;
      case "dedication":
        start("dedication", "Dedication");
        current.html.push(`<section epub:type="dedication" class="dedication">\n<p>${inline(block.text)}</p>\n</section>`);
        current = null;
        break;
      case "toc":
        tocAt = parts.length;
        current = null;
        break;
      case "chapter-title":
        start(block.label ? "chapter" : block.front ? "front" : "back", block.text, block.label);
        current.html.push(`<header class="chapter-head">${block.label ? `\n<p class="chapter-label">${esc(block.label)}</p>` : ""}\n<h1>${inline(block.text)}</h1>\n</header>`);
        break;
      default: {
        if (!current) start("front", "");
        const html = current.html;
        if (block.type === "h1") {
          sectionCount += 1;
          const id = `s${sectionCount}`;
          current.sections.push({ id, text: block.text });
          html.push(`<h2 id="${id}">${inline(block.text)}</h2>`);
        } else if (block.type === "h2") html.push(`<h3>${inline(block.text)}</h3>`);
        else if (block.type === "p") html.push(`<p>${inline(block.text)}</p>`);
        else if (block.type === "ref") html.push(`<p class="ref">${block.number ? `${block.number}. ` : ""}${inline(block.text)}</p>`);
        else if (block.type === "glossary") html.push(`<p class="gloss"><b>${esc(block.term)}.</b> ${inline(block.text)}</p>`);
        else if (block.type === "box") {
          const list = block.items?.length ? `\n<${block.numbered ? "ol" : "ul"}>${block.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${block.numbered ? "ol" : "ul"}>` : "";
          html.push(`<div class="box">\n<p class="box-title">${esc(block.title)}</p>${block.text ? `\n<p>${inline(block.text)}</p>` : ""}${list}\n</div>`);
        } else if (block.type === "table") {
          html.push(`<p class="caption"><b>Table ${block.number}.</b> ${inline(block.caption)}</p>\n<table>\n<thead><tr>${block.columns.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>\n<tbody>\n${block.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table>${block.note ? `\n<p class="note">${inline(block.note)}</p>` : ""}`);
        } else if (block.type === "figure") {
          let bytes = null;
          try {
            bytes = await loadFigure(block);
          } catch {
            bytes = null;
          }
          const caption = `<figcaption><b>Figure ${block.number}.</b> ${inline(block.caption)}${block.credit ? ` <span class="credit">${esc(block.credit)}</span>` : ""}</figcaption>`;
          if (bytes?.length) {
            figureCount += 1;
            const [ext, mime] = imageType(bytes);
            const href = `images/figure-${figureCount}.${ext}`;
            images.push({ id: `figure-${figureCount}`, href, mime, bytes });
            html.push(`<figure>\n<img src="${href}" alt="${esc(`Figure ${block.number}. ${block.caption || ""}`.slice(0, 300))}"/>\n${caption}\n</figure>`);
          } else {
            warnings.push(`Figure ${block.number}'s picture couldn't be added (its link may have expired: reopen the project and try again).`);
            html.push(`<figure>\n${caption}\n</figure>`);
          }
        }
      }
    }
  }

  const chapters = parts.filter((p) => p.kind === "chapter").length;
  if (!chapters) warnings.push("The book has no chapters yet.");
  const files = parts.map((p) => ({ ...p, href: `${p.id}.xhtml` }));
  const listed = files.filter((p) => p.heading && ["chapter", "front", "back"].includes(p.kind));
  const bodyStart = files.find((p) => p.kind === "chapter" || (p.kind === "back" && p.heading === "Introduction")) || listed[0] || files[0];
  const label = (p) => (p.label ? `${p.label}: ${p.heading}` : p.heading);

  const navList = listed.map((p) => `<li><a href="${p.href}">${esc(label(p))}</a>${p.kind === "chapter" && p.sections.length
    ? `\n<ol>${p.sections.map((s) => `<li><a href="${p.href}#${s.id}">${esc(s.text)}</a></li>`).join("")}</ol>` : ""}</li>`).join("\n");
  const nav = page("Contents", `<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
${navList}
</ol>
</nav>
<nav epub:type="landmarks" hidden="hidden">
<h2>Guide</h2>
<ol>
<li><a epub:type="toc" href="nav.xhtml#toc">Contents</a></li>${bodyStart ? `\n<li><a epub:type="bodymatter" href="${bodyStart.href}">Start of the book</a></li>` : ""}
</ol>
</nav>`, lang);

  const id = o.isbn && /^[\dXx-]{10,17}$/.test(o.isbn) ? `urn:isbn:${o.isbn.replace(/-/g, "")}` : `urn:uuid:${uuid || (globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000000")}`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${lang}">
<head>
<meta name="dtb:uid" content="${esc(id)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${listed.map((p, i) => `<navPoint id="nav-${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(label(p))}</text></navLabel><content src="${p.href}"/></navPoint>`).join("\n")}
</navMap>
</ncx>
`;

  // Reading order: title, copyright, dedication, the contents page, then the book.
  const spine = files.map((p) => `<itemref idref="${p.id}"/>`);
  spine.splice(tocAt >= 0 ? Math.min(tocAt, spine.length) : 0, 0, '<itemref idref="nav"/>');
  const coverType = cover?.length ? imageType(cover) : null;
  const modified = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${esc(id)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>${rendered.subtitle ? `\n<meta property="dcterms:alternative">${esc(rendered.subtitle)}</meta>` : ""}
${o.authors?.trim() ? `<dc:creator id="creator">${esc(o.authors.trim())}</dc:creator>` : ""}
<dc:language>${lang}</dc:language>${o.publisher ? `\n<dc:publisher>${esc(o.publisher)}</dc:publisher>` : ""}${o.year ? `\n<dc:date>${esc(String(o.year).slice(0, 4))}</dc:date>` : ""}${rendered.blurb ? `\n<dc:description>${esc(rendered.blurb.replace(/\*/g, ""))}</dc:description>` : ""}
<dc:rights>Copyright © ${esc(o.year || now.getFullYear())}${o.authors?.trim() ? ` ${esc(o.authors.trim())}` : ""}. All rights reserved.</dc:rights>
<meta property="dcterms:modified">${modified}</meta>${coverType ? '\n<meta name="cover" content="cover-image"/>' : ""}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>${coverType ? `\n<item id="cover-image" href="images/cover.${coverType[0]}" media-type="${coverType[1]}" properties="cover-image"/>` : ""}
${files.map((p) => `<item id="${p.id}" href="${p.href}" media-type="application/xhtml+xml"/>`).join("\n")}
${images.map((img) => `<item id="${img.id}" href="${img.href}" media-type="${img.mime}"/>`).join("\n")}
</manifest>
<spine toc="ncx">
${spine.join("\n")}
</spine>
</package>
`;

  const entries = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/toc.ncx": strToU8(ncx),
    "OEBPS/style.css": strToU8(EPUB_CSS),
  };
  for (const p of files) entries[`OEBPS/${p.href}`] = strToU8(page(p.heading || title, p.html.join("\n"), lang));
  if (coverType) entries[`OEBPS/images/cover.${coverType[0]}`] = [cover, { level: 0 }];
  for (const img of images) entries[`OEBPS/${img.href}`] = [img.bytes, { level: 0 }];
  const data = zipSync(entries, { level: 9 });
  return { data, files: Object.keys(entries), chapters, images: images.length, warnings, language: lang };
}
