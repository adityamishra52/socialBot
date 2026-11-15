import { useEffect, useMemo, useRef, useState } from "react";
import { countPlaceholders } from "../../shared/placeholders.ts";
import { ErrorNote } from "../shared.jsx";
import { Icon } from "../ui.jsx";
import { FONT_SETS, bannerBlob, drawBanner, loadBannerFonts, loadImage, shrinkDataUrl } from "./banner.js";
import { buildEpub, guessLanguage } from "./exportEpub.js";
import { downloadBlob } from "./exportDocx.js";
import { svgToPng } from "./images.js";
import { THEMES } from "./SharePanel.jsx";

// Ebook for Amazon KDP and Google Play Books: an EPUB 3 file and a 1600 × 2560 cover, both made
// here in the browser, with the steps to upload them. The stores need the author's own account,
// so the upload itself is done there.

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

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** A finished cover image as JPEG bytes, at most 2560 px tall. */
async function finishedCoverBytes(image) {
  const scale = Math.min(1, 2560 / image.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return blobBytes(await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92)));
}

export default function EbookPanel({ project, draft, options }) {
  const [theme, setTheme] = useState("classic");
  const [font, setFont] = useState("serif");
  const [art, setArt] = useState(null);
  const [own, setOwn] = useState(null);
  const [language, setLanguage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    loadBannerFonts().then(() => setFontsReady(true));
  }, []);

  const design = useMemo(() => coverDesign(draft, options, theme, font, Boolean(art)), [draft, options, theme, font, art]);
  useEffect(() => {
    if (canvasRef.current && !own) drawBanner(canvasRef.current, design, { art });
  }, [design, art, own, fontsReady]);

  const placeholders = useMemo(() => countPlaceholders(draft || {}), [draft]);
  const detected = useMemo(() => guessLanguage([draft?.title, ...(draft?.chapters || []).flatMap((c) => (c.sections || []).flatMap((s) => s.paragraphs))].join(" ")), [draft]);
  const checks = [
    placeholders > 0 && `${placeholders} placeholder${placeholders === 1 ? "" : "s"} such as [Author Name] ${placeholders === 1 ? "is" : "are"} still in the text. Fill ${placeholders === 1 ? "it" : "them"} in with Revise with AI → Fill in details first.`,
    !options?.authors?.trim() && "Add the author's name (Edit → Book details): the stores show it on the cover and the book's page.",
    !(draft?.chapters || []).length && "The book has no chapters yet.",
    (project.warnings || []).some((w) => /words \(you asked/.test(w)) && "Some chapters are shorter than you asked for. You can lengthen them with Revise with AI.",
  ].filter(Boolean);
  const slug = (draft?.title || "ebook").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "ebook";

  const coverBytes = async () => (own ? finishedCoverBytes(own) : blobBytes(await bannerBlob(design, { art }, "image/jpeg", 0.92)));

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

  async function downloadCover() {
    setError(null);
    try {
      downloadBlob(new Blob([await coverBytes()], { type: "image/jpeg" }), `${slug}-cover.jpg`);
    } catch (failure) {
      setError({ message: `The cover couldn't be made: ${failure.message}` });
    }
  }

  async function downloadEpub() {
    setBusy("epub");
    setError(null);
    try {
      const built = await buildEpub({ ...project, draft, options }, {
        cover: await coverBytes(), language,
        loadFigure: async (block) => {
          if (block.svg) return (await svgToPng(block.svg, 1400)).data;
          if (!block.image) return null;
          const response = await fetch(block.image);
          return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
        },
      });
      downloadBlob(new Blob([built.data], { type: "application/epub+zip" }), `${slug}.epub`);
      setResult({ ...built, size: built.data.length });
    } catch (failure) {
      setError({ message: `The ebook couldn't be made: ${failure.message}` });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="wr-panel eb-panel">
      <p className="field-note">
        Amazon KDP and Google Play Books take an <strong>EPUB</strong> ebook and a <strong>cover image</strong>. Make both here, then upload them in your
        own KDP and Google Play Books accounts. The text reflows on every reader, so page size and margins don't apply to the ebook.
      </p>
      {checks.length > 0 && <div className="note note-warn"><strong>Before you publish</strong><ul>{checks.map((c) => <li key={c}>{c}</li>)}</ul></div>}

      <h3 className="wr-h">Cover (1600 × 2560)</h3>
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
          {own && own.height < 1600 && <p className="warn-text">This cover is {own.width} × {own.height} px. The stores ask for at least 1600 px on the long side (2560 is best).</p>}
        </div>
      </div>

      <h3 className="wr-h">Ebook file</h3>
      <label>Language of the book
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{code ? label : `${label} (${LANGUAGES.find(([c]) => c === detected)?.[1] || detected})`}</option>)}
        </select>
      </label>
      <div className="actions">
        <button className="accent" onClick={downloadEpub} disabled={Boolean(busy)}><Icon name="download" /> {busy === "epub" ? "Making the ebook…" : "Download EPUB"}</button>
        <button type="button" onClick={downloadCover}><Icon name="download" /> Download cover (JPG)</button>
      </div>
      {result && (
        <p className="field-note">
          Made {slug}.epub: {result.chapters} chapter{result.chapters === 1 ? "" : "s"}, {result.images} figure{result.images === 1 ? "" : "s"}, {(result.size / 1024 / 1024).toFixed(1)} MB, language "{result.language}".
        </p>
      )}
      {result?.warnings?.length > 0 && <ul className="warn-text">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <ErrorNote error={error} />

      <h3 className="wr-h">Publishing</h3>
      <details className="eb-steps" open>
        <summary>Amazon Kindle (KDP)</summary>
        <ol>
          <li>Sign in at <a href="https://kdp.amazon.com" target="_blank" rel="noreferrer">kdp.amazon.com</a> and choose <em>Create → Kindle eBook</em>.</li>
          <li><strong>Details:</strong> language, title, subtitle, author, description (your back-cover blurb), up to 7 keywords and categories.</li>
          <li>Answer KDP's question about <strong>AI-generated content</strong> honestly: it asks whether text, images or translations were made with AI tools.</li>
          <li><strong>Content:</strong> upload the EPUB as the manuscript and the JPG as the cover (<em>Upload a cover you already have</em>), then check it in the previewer.</li>
          <li>An ISBN is optional for Kindle (Amazon gives an ASIN). Set the price and royalty, then publish. It usually goes live within 72 hours.</li>
        </ol>
      </details>
      <details className="eb-steps">
        <summary>Google Play Books</summary>
        <ol>
          <li>Sign in to the Partner Center at <a href="https://play.google.com/books/publish" target="_blank" rel="noreferrer">play.google.com/books/publish</a> and add a book.</li>
          <li><strong>Book details:</strong> title, contributors (author), description, language and subject. Use your ISBN, or Google gives the book its own ID.</li>
          <li><strong>Content:</strong> upload the EPUB and the cover JPG. A PDF from <em>Print / PDF</em> can be added as well.</li>
          <li>Set prices for the countries you sell in, then publish. Review can take a few days.</li>
        </ol>
      </details>
      <p className="field-note">
        Read the whole book yourself before publishing: you are the author and responsible for it. Free photos used as figures are openly licensed; keep their credits.
      </p>
      {draft?.blurb && (
        <div className="actions tight">
          <button type="button" className="small" onClick={async () => {
            try { await navigator.clipboard.writeText(draft.blurb); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
          }}><Icon name="copy" size={14} /> {copied ? "Copied" : "Copy the description (blurb)"}</button>
        </div>
      )}
    </div>
  );
}
