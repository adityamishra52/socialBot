import { strToU8, zipSync } from "fflate";

// The publishing kit for Amazon KDP, Google Play Books and Draft2Digital: the upload steps (shown
// in the Ebook tab and written into the kit), the store listing as text, a paperback margin check,
// and the ZIP with every file.

export const STORE_STEPS = [
  {
    store: "Amazon Kindle (KDP)", url: "https://kdp.amazon.com", steps: [
      "Sign in at kdp.amazon.com and choose Create, then Kindle eBook.",
      "Details: language, title, subtitle, author, description, up to 7 keywords and categories (the listing has all of them).",
      "Answer KDP's question about AI-generated content honestly: it asks whether text, images or translations were made with AI tools.",
      "Content: upload the EPUB as the manuscript, and the cover JPG under \"Upload a cover you already have\". Check it in the previewer.",
      "An ISBN is optional for Kindle (Amazon gives an ASIN). Set the price and royalty, then publish. It is usually live within 72 hours.",
      "Paperback (optional): Create, then Paperback. Choose the PDF's page size as the trim size and \"No bleed\" for the interior, and upload the PDF as the manuscript. For the cover choose \"Upload a cover you already have (print-ready PDF only)\" and upload the paperback cover PDF; leave \"Yes, my cover has a barcode\" unticked so KDP adds it. Use the same paper and page count the cover was made for.",
      "If you enrol the ebook in KDP Select, Amazon requires it to be sold only on Amazon: then don't publish the ebook on Google Play or through Draft2Digital.",
    ],
  },
  {
    store: "Google Play Books", url: "https://play.google.com/books/publish", steps: [
      "Sign in to the Partner Center at play.google.com/books/publish and add a book.",
      "Book details: title, subtitle, contributors (author), description, language, subject categories, and your ISBN or Google's own ID.",
      "Content: upload the EPUB and the PDF (readers can then choose flowing text or the original pages), and the cover JPG.",
      "Set prices for the countries you sell in, then publish. Review can take a few days.",
    ],
  },
  {
    store: "Draft2Digital", url: "https://www.draft2digital.com", steps: [
      "Sign in at draft2digital.com and create a new book.",
      "Details: title, subtitle, contributors, description, search terms (the keywords) and categories. Draft2Digital can give you a free ISBN.",
      "Manuscript: upload the EPUB (used as it is) or the Word file (Draft2Digital lays it out with its own templates). Cover: the cover JPG (they recommend at least 1600 × 2400 px; this one is 1600 × 2560).",
      "If Draft2Digital asks about AI-generated content, answer honestly.",
      "Choose the stores (Apple Books, Kobo, Barnes & Noble and others). Untick Amazon if you publish there yourself through KDP, so the book isn't listed twice. Set prices and publish.",
    ],
  },
];

const COMPLEX = /[֐-ࣿऀ-෿฀-࿿က-႟ក-៿]/u;
/** True when the text uses a script whose letters join or reorder (Hindi, Arabic...), which the PDF maker can't set. */
export const needsBrowserPdf = (text) => COMPLEX.test(String(text || ""));

/** KDP's smallest inside margin for a paperback of this many pages, in mm (no bleed). */
export function kdpInsideMinimum(pages) {
  if (pages <= 150) return 9.6;
  if (pages <= 300) return 12.7;
  if (pages <= 500) return 15.9;
  if (pages <= 700) return 19.1;
  return 22.3;
}

/** Notes on using the PDF as a KDP paperback interior. */
export function paperbackNotes(layout, pages, [widthMm, heightMm]) {
  const notes = [];
  const inside = (Number(layout.margin_inside) || 0) + (Number(layout.gutter) || 0);
  const need = kdpInsideMinimum(pages);
  if (pages < 24) notes.push(`KDP paperbacks need at least 24 pages; this PDF has ${pages}.`);
  if (pages > 828) notes.push(`KDP paperbacks can have at most 828 pages; this PDF has ${pages}.`);
  if (inside < need) notes.push(`For a ${pages}-page KDP paperback the inside margin must be at least ${need} mm; it is ${inside} mm (Book layout → Inside margin).`);
  for (const [name, value] of [["top", layout.margin_top], ["bottom", layout.margin_bottom], ["outside", layout.margin_outside]]) {
    if ((Number(value) || 0) < 6.4) notes.push(`The ${name} margin must be at least 6.4 mm for KDP; it is ${value} mm.`);
  }
  if (!layout.mirror_margins) notes.push("Mirror margins (facing pages) are off: a printed book needs the wider margin on the inside of each page.");
  const inches = `${(widthMm / 25.4).toFixed(2)} × ${(heightMm / 25.4).toFixed(2)} in`;
  return { inches, notes };
}

/** The store listing as text, field by field, for pasting into the three stores' forms. */
export function listingText({ draft, options, listing, pages, words, language, size, date = new Date() }) {
  const o = options || {};
  const lines = [
    `STORE LISTING: ${draft?.title || o.book_name || "Untitled"}`,
    `Made with Social Autopost on ${date.toISOString().slice(0, 10)}. Check every field before you paste it.`,
    "",
    `Title: ${draft?.title || o.book_name || ""}`,
    `Subtitle: ${draft?.subtitle || o.subtitle || ""}`,
    `Author(s): ${o.authors || ""}`,
    o.publisher ? `Publisher: ${o.publisher}` : null,
    o.edition ? `Edition: ${o.edition}` : null,
    `ISBN: ${o.isbn || "none (Kindle gives an ASIN, Google Play its own ID, Draft2Digital a free ISBN if you want one)"}`,
    `Language: ${language || "en"}`,
    `Publication year: ${o.year || date.getFullYear()}`,
    pages ? `Length: ${pages} pages in the PDF${size ? ` (${size})` : ""}, about ${Number(words || 0).toLocaleString("en-US")} words` : `Length: about ${Number(words || 0).toLocaleString("en-US")} words`,
    "",
  ].filter((l) => l !== null);
  if (listing) {
    lines.push("DESCRIPTION (Amazon, Google Play, Draft2Digital; under 4,000 characters)", listing.description, "");
    if (listing.tagline) lines.push("TAGLINE", listing.tagline, "");
    lines.push("KEYWORDS (KDP has 7 boxes; Draft2Digital calls them search terms)", ...listing.keywords.map((k, i) => `${i + 1}. ${k}`), "");
    lines.push("CATEGORIES (suggestions in BISAC style: pick the closest in each store's own list)", ...listing.categories.map((c) => `- ${c}`), "");
    if (listing.audience) lines.push("AUDIENCE", listing.audience, "");
    if (listing.author_bio) lines.push("ABOUT THE AUTHOR", listing.author_bio, "");
  } else {
    lines.push("DESCRIPTION", draft?.blurb || "(Write the store listing in the Ebook tab, or paste your back-cover blurb here.)", "");
  }
  lines.push(
    "AI DISCLOSURE (for KDP's question, and any other store that asks)",
    "The text was drafted with an AI writing tool (Google Gemini) and reviewed and edited by the author. Charts and diagrams were drawn from the text; any photos are openly licensed and credited in their captions.",
    "",
  );
  return lines.join("\n");
}

/** The upload steps as text, for the kit. */
export function stepsText(files) {
  const out = ["HOW TO UPLOAD", "", "Files in this kit:", ...files.map((f) => `- ${f}`), ""];
  for (const s of STORE_STEPS) out.push(`${s.store.toUpperCase()} (${s.url})`, ...s.steps.map((step, i) => `${i + 1}. ${step}`), "");
  out.push("Read the whole book yourself before publishing: you are the author and responsible for it.", "");
  return out.join("\n");
}

/** A ZIP of the kit's files: { name: Uint8Array | string }. Already-compressed files are stored. */
export function kitZip(folder, files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? strToU8(content.replace(/\n/g, "\r\n")) : content;
    entries[`${folder}/${name}`] = [bytes, { level: /\.(epub|pdf|jpg|jpeg|png|docx)$/i.test(name) ? 0 : 6 }];
  }
  return zipSync(entries);
}
