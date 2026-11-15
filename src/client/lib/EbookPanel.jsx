import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { countPlaceholders } from "../../shared/placeholders.ts";
import { CostCard, ErrorNote } from "../shared.jsx";
import { Icon } from "../ui.jsx";
import { FONT_SETS, bannerBlob, drawBanner, loadBannerFonts, loadImage, shrinkDataUrl } from "./banner.js";
import { buildEpub, guessLanguage } from "./exportEpub.js";
import { downloadBlob, exportDocx } from "./exportDocx.js";
import { svgToPng } from "./images.js";
import { pageSize } from "./layout.js";
import { STORE_STEPS, kitZip, listingText, needsBrowserPdf, paperbackNotes, stepsText } from "./publishKit.js";
import { THEMES } from "./SharePanel.jsx";

// Publishing kit for Amazon KDP, Google Play Books and Draft2Digital: the EPUB, a print-ready PDF,
// the 1600 × 2560 front cover, a Word file, the store listing (written by AI from the book) and the
// upload steps, one by one or all in one ZIP. The stores need the author's own account, so the
// upload itself is done there.

const LANGUAGES = [["", "Detect from the text"], ["en", "English"], ["hi", "Hindi"], ["bn", "Bengali"], ["mr", "Marathi"], ["ta", "Tamil"], ["te", "Telugu"],
  ["gu", "Gujarati"], ["pa", "Punjabi"], ["ur", "Urdu"], ["es", "Spanish"], ["fr", "French"], ["de", "German"]];

function coverDesign(draft, options, theme, font, hasArt) {
  const t = THEMES[theme] || THEMES.classic;
  return {
    // Larger words than a post: the cover must read well as a small thumbnail in the store.
    aspect: "ebook", palette: t.palette, font, ornament: t.ornament, area: hasArt ? "top" : "center", fade: 0.85, scale: 1.45,
    headline: draft?.title || options?.book_name || "Untitled", headlineLines: 4, message: draft?.subtitle || options?.subtitle || "",
    byline: options?.authors || "", footer: options?.publisher || "",
  };
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

/** A finished cover image as JPEG bytes, at most 2560 px tall. */
async function finishedCoverBytes(image) {
  const scale = Math.min(1, 2560 / image.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return bytesOf(await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92)));
}

async function loadFigure(block) {
  if (block.svg) return (await svgToPng(block.svg, 1400)).data;
  if (!block.image) return null;
  const response = await fetch(block.image);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
}

function CopyButton({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="small" disabled={!text} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
    }}><Icon name="copy" size={14} /> {done ? "Copied" : label}</button>
  );
}

export default function EbookPanel({ project, draft, options }) {
  const [theme, setTheme] = useState("classic");
  const [font, setFont] = useState("serif");
  const [art, setArt] = useState(null);
  const [own, setOwn] = useState(null);
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [made, setMade] = useState({});
  const [listing, setListing] = useState(null);
  const [usage, setUsage] = useState([]);
  const [fontsReady, setFontsReady] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    loadBannerFonts().then(() => setFontsReady(true));
  }, []);

  const design = useMemo(() => coverDesign(draft, options, theme, font, Boolean(art)), [draft, options, theme, font, art]);
  useEffect(() => {
    if (canvasRef.current && !own) drawBanner(canvasRef.current, design, { art });
  }, [design, art, own, fontsReady]);

  const bookText = useMemo(() => [draft?.title, ...(draft?.chapters || []).flatMap((c) => [c.title, ...(c.sections || []).flatMap((s) => s.paragraphs)])].join(" "), [draft]);
  const words = useMemo(() => bookText.split(/\s+/).filter(Boolean).length, [bookText]);
  const detected = useMemo(() => guessLanguage(bookText), [bookText]);
  const lang = language || detected;
  const browserPdfOnly = useMemo(() => needsBrowserPdf(bookText), [bookText]);
  const placeholders = useMemo(() => countPlaceholders(draft || {}), [draft]);
  const checks = [
    placeholders > 0 && `${placeholders} placeholder${placeholders === 1 ? "" : "s"} such as [Author Name] ${placeholders === 1 ? "is" : "are"} still in the text. Fill ${placeholders === 1 ? "it" : "them"} in with Revise with AI → Fill in details first.`,
    !options?.authors?.trim() && "Add the author's name (Edit → Book details): the stores show it on the cover and the book's page.",
    !(draft?.chapters || []).length && "The book has no chapters yet.",
    (project.warnings || []).some((w) => /words \(you asked/.test(w)) && "Some chapters are shorter than you asked for. You can lengthen them with Revise with AI.",
  ].filter(Boolean);
  const slug = (draft?.title || "book").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "book";
  const book = { ...project, draft, options };

  const coverBytes = async () => (own ? finishedCoverBytes(own) : bytesOf(await bannerBlob(design, { art }, "image/jpeg", 0.92)));
  const makeEpub = async (cover) => buildEpub(book, { cover: cover ?? await coverBytes(), language, loadFigure });
  async function makePdf() {
    const [{ buildPdf, PDF_FONTS }, { loadPdfFonts }] = await Promise.all([import("./exportPdf.js"), import("./pdfFonts.js")]);
    const fonts = await loadPdfFonts(PDF_FONTS[options?.layout?.font] || "tinos");
    return buildPdf(book, { fonts, loadFigure, language: lang });
  }
  const pdfInfo = (built) => ({ pages: built.pages, warnings: built.warnings, size: built.data.length, ...paperbackNotes(options?.layout || {}, built.pages, pageSize(options?.layout || {})) });

  async function run(label, work) {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError({ message: failure.message || "Something went wrong." , hint: failure.hint });
    } finally {
      setBusy("");
    }
  }

  const downloadEpub = () => run("epub", async () => {
    const built = await makeEpub();
    downloadBlob(new Blob([built.data], { type: "application/epub+zip" }), `${slug}.epub`);
    setMade((m) => ({ ...m, epub: { chapters: built.chapters, images: built.images, size: built.data.length, language: built.language, warnings: built.warnings } }));
  });
  const downloadPdf = () => run("pdf", async () => {
    const built = await makePdf();
    downloadBlob(new Blob([built.data], { type: "application/pdf" }), `${slug}.pdf`);
    setMade((m) => ({ ...m, pdf: pdfInfo(built) }));
  });
  const downloadCover = () => run("cover", async () => {
    downloadBlob(new Blob([await coverBytes()], { type: "image/jpeg" }), `${slug}-cover.jpg`);
  });
  const downloadWord = () => run("docx", async () => {
    downloadBlob(await exportDocx(book), `${slug}.docx`);
  });
  const writeListing = () => run("listing", async () => {
    const data = await api(`/api/manuscript/${project.id}/listing`, { method: "POST" });
    if (data.usage) setUsage((old) => [...old, data.usage]);
    setListing({ description: data.description, tagline: data.tagline, keywords: data.keywords, categories: data.categories, audience: data.audience, author_bio: data.author_bio });
  });
  const downloadKit = () => run("kit", async () => {
    const cover = await coverBytes();
    const epub = await makeEpub(cover);
    const pdf = browserPdfOnly ? null : await makePdf();
    const docx = await bytesOf(await exportDocx(book));
    const files = { [`${slug}.epub`]: epub.data, ...(pdf ? { [`${slug}.pdf`]: pdf.data } : {}), [`${slug}-cover.jpg`]: cover, [`${slug}.docx`]: docx };
    const info = pdf ? pdfInfo(pdf) : null;
    files["store-listing.txt"] = listingText({ draft, options, listing, pages: pdf?.pages, words, language: lang, size: info?.inches });
    files["how-to-upload.txt"] = stepsText(Object.keys(files).concat("how-to-upload.txt"));
    downloadBlob(new Blob([kitZip(`${slug}-publishing-kit`, files)], { type: "application/zip" }), `${slug}-publishing-kit.zip`);
    setMade((m) => ({ ...m, epub: { chapters: epub.chapters, images: epub.images, size: epub.data.length, language: epub.language, warnings: epub.warnings }, ...(info ? { pdf: info } : {}), kit: true }));
  });

  function pick(file, then) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        then(await loadImage(await shrinkDataUrl(reader.result, 2800)));
      } catch (failure) {
        setError({ message: failure.message });
      }
    };
    reader.readAsDataURL(file);
  }

  const setField = (key, value) => setListing((old) => ({ ...old, [key]: value }));
  const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const BUSY = { epub: "Making the EPUB…", pdf: "Typesetting the PDF…", kit: "Making all the files… (up to a minute for a long book)", listing: "Writing the listing…" };

  return (
    <div className="wr-panel eb-panel">
      <p className="field-note">
        Everything Amazon KDP, Google Play Books and Draft2Digital ask for: the <strong>EPUB</strong> ebook, a print-ready <strong>PDF</strong>, the
        {" "}<strong>front cover</strong> (1600 × 2560), a <strong>Word</strong> file and the <strong>store listing</strong>. Upload them in your own accounts.
      </p>
      {checks.length > 0 && <div className="note note-warn"><strong>Before you publish</strong><ul>{checks.map((c) => <li key={c}>{c}</li>)}</ul></div>}

      <h3 className="wr-h">Front cover (1600 × 2560)</h3>
      <div className="eb-cover">
        {own ? <img src={own.src} alt="Your cover" className="eb-canvas" /> : <canvas ref={canvasRef} className="eb-canvas" role="img" aria-label={`Cover: ${design.headline}`} />}
        <div className="eb-cover-controls">
          {!own && (
            <>
              <label>Colours</label>
              <div className="chips" role="radiogroup" aria-label="Cover colours">
                {Object.entries(THEMES).map(([key, t]) => (
                  <button key={key} type="button" role="radio" aria-checked={theme === key} className={`chip${theme === key ? " on" : ""}`} onClick={() => setTheme(key)}>
                    <span className="sh-dot" style={{ background: t.palette.background, borderColor: t.palette.accent }} /> {t.label}
                  </button>
                ))}
              </div>
              <label>Title font
                <select value={font} onChange={(e) => setFont(e.target.value)}>{Object.entries(FONT_SETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
              </label>
              <div className="actions tight">
                <label className="button">
                  <Icon name="upload" /> {art ? "Change picture" : "Add a picture"}
                  <input type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) pick(f, setArt); }} />
                </label>
                {art && <button type="button" onClick={() => setArt(null)}>Remove picture</button>}
              </div>
              <p className="field-note">The title, subtitle and author come from Edit → Book details. For artwork, make a picture in Banner & Poster or use your own.</p>
            </>
          )}
          <div className="actions tight">
            <label className="button">
              <Icon name="upload" /> {own ? "Change finished cover" : "Use my finished cover"}
              <input type="file" hidden accept="image/jpeg,image/png" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) pick(f, setOwn); }} />
            </label>
            {own && <button type="button" onClick={() => setOwn(null)}>Design one here instead</button>}
          </div>
          {own && own.height < 2400 && <p className="warn-text">This cover is {own.width} × {own.height} px. The stores ask for at least 1600 × 2400 px (1600 × 2560 is best).</p>}
        </div>
      </div>

      <h3 className="wr-h">Files</h3>
      <label>Language of the book
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{code ? label : `${label} (${LANGUAGES.find(([c]) => c === detected)?.[1] || detected})`}</option>)}
        </select>
      </label>
      <div className="actions">
        <button className="accent" onClick={downloadKit} disabled={Boolean(busy)}><Icon name="download" /> {busy === "kit" ? BUSY.kit : "Download the publishing kit (ZIP)"}</button>
      </div>
      <p className="field-note">One ZIP with the EPUB, PDF, front cover, Word file, the store listing and the upload steps{listing ? "" : " (write the store listing below first to include it)"}.</p>
      <div className="actions tight">
        <button type="button" onClick={downloadEpub} disabled={Boolean(busy)}><Icon name="download" /> {busy === "epub" ? BUSY.epub : "EPUB"}</button>
        <button type="button" onClick={downloadPdf} disabled={Boolean(busy) || browserPdfOnly}><Icon name="download" /> {busy === "pdf" ? BUSY.pdf : "PDF"}</button>
        <button type="button" onClick={downloadCover} disabled={Boolean(busy)}><Icon name="download" /> Front cover (JPG)</button>
        <button type="button" onClick={downloadWord} disabled={Boolean(busy)}><Icon name="download" /> Word</button>
      </div>
      {browserPdfOnly && (
        <p className="note">This book's script joins letters (as Hindi does), which this PDF maker can't set correctly. Use <strong>Print / PDF</strong> at the top and choose <em>Save as PDF</em>: your browser sets it perfectly. The kit leaves the PDF out.</p>
      )}
      {made.epub && <p className="field-note">EPUB: {made.epub.chapters} chapter{made.epub.chapters === 1 ? "" : "s"}, {made.epub.images} figure{made.epub.images === 1 ? "" : "s"}, {mb(made.epub.size)}, language "{made.epub.language}". It passes the stores' EPUB checks.</p>}
      {made.pdf && (
        <div className="field-note">
          PDF: {made.pdf.pages} pages, {made.pdf.inches}, {mb(made.pdf.size)}, fonts embedded, with contents links and bookmarks.
          {made.pdf.notes.length > 0
            ? <ul className="warn-text">{made.pdf.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            : " It also meets KDP's paperback margins for this length."}
        </div>
      )}
      {[...(made.epub?.warnings || []), ...(made.pdf?.warnings || [])].length > 0 && (
        <ul className="warn-text">{[...new Set([...(made.epub?.warnings || []), ...(made.pdf?.warnings || [])])].map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      {busy && BUSY[busy] && <p className="muted-text"><span className="job-orb small" aria-hidden="true" /> {BUSY[busy]}</p>}
      <ErrorNote error={error} />

      <h3 className="wr-h">Store listing</h3>
      <p className="field-note">The description, 7 keywords, categories, audience and author bio, written from the book for the three stores' forms. It never invents reviews, awards or credentials.</p>
      <div className="actions tight">
        <button type="button" onClick={writeListing} disabled={Boolean(busy)}><Icon name="sparkles" /> {busy === "listing" ? BUSY.listing : listing ? "Write it again" : "Write the store listing"}</button>
      </div>
      {listing && (
        <div className="eb-listing">
          <div className="draft-head"><label htmlFor="eb-desc">Description</label><span className={listing.description.length > 4000 ? "count over" : "count"}>{listing.description.length} / 4000</span></div>
          <textarea id="eb-desc" rows={9} value={listing.description} onChange={(e) => setField("description", e.target.value)} />
          <div className="actions tight"><CopyButton text={listing.description} label="Copy description" /></div>
          <label htmlFor="eb-keys">Keywords (one per line; KDP takes 7)</label>
          <textarea id="eb-keys" rows={7} value={listing.keywords.join("\n")} onChange={(e) => setField("keywords", lines(e.target.value).slice(0, 7))} />
          <div className="actions tight"><CopyButton text={listing.keywords.join(", ")} label="Copy keywords" /></div>
          <label htmlFor="eb-cats">Categories (suggestions: pick the closest in each store's list)</label>
          <textarea id="eb-cats" rows={3} value={listing.categories.join("\n")} onChange={(e) => setField("categories", lines(e.target.value))} />
          <label htmlFor="eb-aud">Audience</label>
          <input id="eb-aud" value={listing.audience} onChange={(e) => setField("audience", e.target.value)} />
          <label htmlFor="eb-bio">About the author</label>
          <textarea id="eb-bio" rows={3} value={listing.author_bio} placeholder="Add a short bio in the author's details to have one written." onChange={(e) => setField("author_bio", e.target.value)} />
          <div className="actions tight">
            <CopyButton text={listing.author_bio} label="Copy bio" />
            <CopyButton text={listingText({ draft, options, listing, pages: made.pdf?.pages, words, language: lang, size: made.pdf?.inches })} label="Copy the whole listing" />
          </div>
        </div>
      )}

      <h3 className="wr-h">Upload steps</h3>
      {STORE_STEPS.map((s, i) => (
        <details key={s.store} className="eb-steps" open={i === 0}>
          <summary>{s.store}</summary>
          <ol>{s.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="field-note"><a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https:\/\/(www\.)?/, "")}</a></p>
        </details>
      ))}
      <p className="field-note">Read the whole book yourself before publishing: you are the author and responsible for it. Keep the credits of any openly licensed photos.</p>
      <CostCard runs={usage} title="AI cost for the listing" />
    </div>
  );
}
