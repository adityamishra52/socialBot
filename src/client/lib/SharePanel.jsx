import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { Link } from "../router.jsx";
import { CostCard, ErrorNote, LinkField, PLATFORMS, StatusBadge, linkValue } from "../shared.jsx";
import { Icon } from "../ui.jsx";
import { bannerBlob, drawBanner, loadBannerFonts, loadImage, shrinkDataUrl } from "./banner.js";
import { downloadBlob } from "./exportDocx.js";
import { uploadDataUrls } from "./images.js";

// "Share on social" for a finished book or manuscript. Social platforms take pictures and text,
// not book files, so this makes a carousel: a cover card (or your real cover), what readers will
// learn, and quotes copied word for word from the text, with a post written for each platform.
// The cards are drawn here in the browser (no AI image cost) and posted like Site to Post.

export const THEMES = {
  classic: { label: "Classic cream", palette: { background: "#f7f1e3", text: "#2b2118", accent: "#9a3412" }, ornament: "leaves", font: "serif" },
  midnight: { label: "Midnight", palette: { background: "#0f172a", text: "#f8fafc", accent: "#f59e0b" }, ornament: "stars", font: "serif" },
  ocean: { label: "Ocean", palette: { background: "#e0f2fe", text: "#0c4a6e", accent: "#0284c7" }, ornament: "waves", font: "sans" },
  forest: { label: "Forest", palette: { background: "#ecfdf5", text: "#064e3b", accent: "#059669" }, ornament: "leaves", font: "serif" },
  rose: { label: "Rose", palette: { background: "#fff1f2", text: "#881337", accent: "#e11d48" }, ornament: "lotus", font: "serif" },
};
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** The image cards for the carousel, from the draft and the AI's words. */
export function buildCards({ mode, draft, options, journalName }, words, theme, cover) {
  const isBook = mode === "book";
  const t = THEMES[theme] || THEMES.classic;
  const base = { aspect: "4:5", palette: t.palette, font: t.font, ornament: t.ornament, area: "center" };
  const title = draft?.title || options?.book_name || "Untitled";
  const authors = options?.authors || "";
  const footer = isBook ? [options?.publisher, options?.year].filter(Boolean).join(" · ") : journalName || "";
  const cards = [];
  if (cover) cards.push({ id: "own-cover", label: "Your cover", design: { ...base, artFit: "contain" }, art: cover });
  cards.push({ id: "cover", label: "Title card", design: {
    ...base, kicker: words.kicker || (isBook ? "New book" : "New research"), headline: title, headlineLines: 4,
    message: words.tagline || draft?.subtitle || "", byline: authors ? `by ${authors}` : "", footer,
  } });
  const chapters = isBook ? (draft?.chapters || []).slice(0, 7).map((c, i) => `${i + 1}. ${c.title}`) : [];
  const points = words.highlights.length ? words.highlights : chapters;
  if (points.length) {
    cards.push({ id: "inside", label: isBook ? "Inside the book" : "Key points", design: {
      ...base, kicker: isBook ? "Inside the book" : "Key points", headline: words.highlights.length ? "What you'll learn" : "Chapters",
      points, footer: title, ornament: "none",
    } });
  }
  words.quotes.forEach((quote, i) => cards.push({ id: `quote-${i}`, label: `Quote ${i + 1}`, design: {
    ...base, kicker: isBook ? "From the book" : "From the article", headline: `“${quote}”`, headlineLines: 7,
    byline: `— ${authors ? `${authors}, ` : ""}${title}`, ornament: "dots",
  } }));
  return cards;
}

function CardCanvas({ card, fontsReady }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) drawBanner(ref.current, card.design, { art: card.art });
  }, [card, fontsReady]);
  return <canvas ref={ref} role="img" aria-label={card.label} />;
}

export default function SharePanel({ project, draft, options, me }) {
  const isBook = project.mode === "book";
  const [words, setWords] = useState({ kicker: "", tagline: "", highlights: [], quotes: [] });
  const [theme, setTheme] = useState("classic");
  const [cover, setCover] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const [request, setRequest] = useState("");
  const [captions, setCaptions] = useState({ linkedin: "", facebook: "", instagram: "" });
  const configured = PLATFORMS.filter((p) => me?.platforms?.[p.key]?.configured).map((p) => p.key);
  const [platforms, setPlatforms] = useState(configured);
  const [linkOn, setLinkOn] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [usage, setUsage] = useState([]);
  const [results, setResults] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    loadBannerFonts().then(() => setFontsReady(true));
  }, []);

  const cards = useMemo(() => buildCards({ mode: project.mode, draft, options, journalName: project.journal?.name }, words, theme, cover),
    [project.mode, project.journal, draft, options, words, theme, cover]);
  const chosen = cards.filter((c) => !skipped.includes(c.id));

  async function write() {
    setBusy("write");
    setError(null);
    try {
      const data = await api(`/api/manuscript/${project.id}/share`, { method: "POST", json: { request } });
      if (data.usage) setUsage((old) => [...old, data.usage]);
      setWords({ kicker: data.kicker, tagline: data.tagline, highlights: data.highlights, quotes: data.quotes });
      const tags = data.hashtags.slice(0, 5).join(" ");
      setCaptions({
        linkedin: [data.captions.linkedin, tags].filter(Boolean).join("\n\n"),
        facebook: [data.captions.facebook, tags].filter(Boolean).join("\n\n"),
        instagram: data.captions.instagram,
      });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  function addCover(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setCover(await loadImage(await shrinkDataUrl(reader.result, 2000)));
      } catch (failure) {
        setError({ message: failure.message });
      }
    };
    reader.readAsDataURL(file);
  }

  const slug = (draft?.title || "post").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "post";
  async function download() {
    for (const [i, card] of chosen.entries()) {
      downloadBlob(await bannerBlob(card.design, { art: card.art }, "image/jpeg", 0.92), `${slug}-${i + 1}.jpg`);
      await wait(350);
    }
  }

  async function follow(id) {
    let data = await api(`/api/publish/job/${id}`);
    setResults(Object.fromEntries(data.results.map((r) => [r.platform, r])));
    while (!data.done) {
      await wait(4000);
      data = await api(`/api/publish/job/${id}`);
      setResults(Object.fromEntries(data.results.map((r) => [r.platform, r])));
    }
    setWarnings(data.warnings ?? []);
  }

  const toPost = platforms.filter((p) => configured.includes(p) && !results[p]?.ok);
  const badCaption = toPost.some((p) => !captions[p].trim() || captions[p].length > PLATFORMS.find((x) => x.key === p).limit);
  const badLink = linkOn && !/^https?:\/\/\S+\.\S+$/.test(link.trim());

  async function publish() {
    setBusy("publish");
    setError(null);
    try {
      const urls = [];
      for (const card of chosen.slice(0, 10)) {
        const blob = await bannerBlob(card.design, { art: card.art }, "image/jpeg", 0.92);
        urls.push(await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); }));
      }
      const images = await uploadDataUrls(urls);
      const data = await api("/api/sitepost/publish", { method: "POST", json: {
        images, platforms: toPost, captions, title: draft?.title || "Book", link: linkValue(linkOn, link), usage_ids: usage.map((u) => u.id),
      } });
      await follow(data.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="wr-panel sh-panel">
      <p className="field-note">
        LinkedIn, Facebook and Instagram take pictures and text, not book files. This makes a carousel announcing your {isBook ? "book" : "article"}:
        a title card (or your real cover), what readers will learn, and quotes copied word for word from the text, with a post for each platform.
      </p>
      <label htmlFor="sh-request">Anything the posts should say or stress? (optional)</label>
      <input id="sh-request" value={request} maxLength={600} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Aimed at CFOs and investors; mention the launch webinar" />
      <div className="actions tight">
        <button className="accent" onClick={write} disabled={Boolean(busy) || !me?.services?.gemini}>
          <Icon name="sparkles" /> {busy === "write" ? "Writing the posts…" : captions.linkedin || captions.instagram ? "Write again" : "Write the posts"}
        </button>
      </div>

      <h3 className="wr-h">Images ({chosen.length} of {cards.length} chosen)</h3>
      <div className="chips" role="radiogroup" aria-label="Colour theme">
        {Object.entries(THEMES).map(([key, t]) => (
          <button key={key} type="button" role="radio" aria-checked={theme === key} className={`chip${theme === key ? " on" : ""}`} onClick={() => setTheme(key)}>
            <span className="sh-dot" style={{ background: t.palette.background, borderColor: t.palette.accent }} /> {t.label}
          </button>
        ))}
      </div>
      <div className="sh-cards">
        {cards.map((card) => {
          const on = !skipped.includes(card.id);
          return (
            <label key={card.id} className={`sh-card${on ? " on" : ""}`}>
              <CardCanvas card={card} fontsReady={fontsReady} />
              <span><input type="checkbox" checked={on} onChange={() => setSkipped(on ? [...skipped, card.id] : skipped.filter((id) => id !== card.id))} /> {card.label}</span>
            </label>
          );
        })}
      </div>
      <div className="actions tight">
        <label className="button">
          <Icon name="upload" /> {cover ? "Change cover" : "Add your real cover (optional)"}
          <input type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) addCover(f); }} />
        </label>
        {cover && <button type="button" onClick={() => setCover(null)}>Remove cover</button>}
        <button type="button" onClick={download} disabled={!chosen.length}><Icon name="download" /> Download images</button>
      </div>
      <details className="sh-edit">
        <summary>Edit the words on the images</summary>
        <label>Top line<input value={words.kicker} maxLength={40} onChange={(e) => setWords({ ...words, kicker: e.target.value })} placeholder={isBook ? "New book" : "New research"} /></label>
        <label>Tagline<input value={words.tagline} maxLength={160} onChange={(e) => setWords({ ...words, tagline: e.target.value })} /></label>
        <label>What readers will learn (one per line)<textarea rows={4} value={words.highlights.join("\n")} onChange={(e) => setWords({ ...words, highlights: lines(e.target.value) })} /></label>
        <label>Quotes (one per line; keep them word for word)<textarea rows={4} value={words.quotes.join("\n")} onChange={(e) => setWords({ ...words, quotes: lines(e.target.value).slice(0, 3) })} /></label>
      </details>

      <h3 className="wr-h">Post</h3>
      {configured.length === 0 && <p className="note note-warn">No accounts are connected. <Link to="/settings">Connect them in Settings</Link>, or download the images.</p>}
      <div className="checks">
        {PLATFORMS.map((p) => (
          <label key={p.key} className={configured.includes(p.key) ? "check" : "check disabled"}>
            <input type="checkbox" disabled={!configured.includes(p.key) || results[p.key]?.ok} checked={platforms.includes(p.key)}
              onChange={() => setPlatforms(platforms.includes(p.key) ? platforms.filter((k) => k !== p.key) : [...platforms, p.key])} />
            <span className={`platform-dot ${p.key}`} />{p.label}
          </label>
        ))}
      </div>
      {PLATFORMS.filter((p) => platforms.includes(p.key)).map((p) => (
        <div key={p.key}>
          <div className="draft-head" style={{ marginTop: "0.6rem" }}>
            <label htmlFor={`sh-${p.key}`}><span className={`platform-dot ${p.key}`} />{p.label} post</label>
            <span className={captions[p.key].length > p.limit ? "count over" : "count"}>{captions[p.key].length} / {p.limit}</span>
          </div>
          <textarea id={`sh-${p.key}`} rows={7} value={captions[p.key]} disabled={results[p.key]?.ok} placeholder="Click Write the posts, or write your own."
            onChange={(e) => setCaptions({ ...captions, [p.key]: e.target.value })} />
          {results[p.key] && (
            <p className="post-actions">
              <StatusBadge result={results[p.key]} />
              {results[p.key].ok && results[p.key].url?.startsWith("https://") && <a href={results[p.key].url} target="_blank" rel="noreferrer">View post</a>}
              {results[p.key].error && <span className="hint">{results[p.key].error}{results[p.key].hint ? ` ${results[p.key].hint}` : ""}</span>}
            </p>
          )}
        </div>
      ))}
      <LinkField id="sh-link" on={linkOn} onToggle={setLinkOn} url={link} onUrl={setLink} disabled={busy === "publish"} />
      {warnings.map((w) => <p className="warn-text" key={w}>{w}</p>)}
      <ErrorNote error={error} />
      <div className="actions">
        <button className="accent" onClick={publish} disabled={Boolean(busy) || !chosen.length || !toPost.length || badCaption || badLink}>
          <Icon name="send" /> {busy === "publish" ? "Posting… (Instagram can take a minute)" : `Post ${Math.min(10, chosen.length)} image${chosen.length === 1 ? "" : "s"} to ${toPost.length} platform${toPost.length === 1 ? "" : "s"}`}
        </button>
      </div>
      <p className="field-note">Each platform is tried once and the post goes live as soon as you click. It also appears in History. Up to 10 images.</p>
      <CostCard runs={usage} title="AI cost for these posts" />
    </div>
  );
}
