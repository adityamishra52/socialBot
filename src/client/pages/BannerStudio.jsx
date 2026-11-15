import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { AREAS, FONT_SETS, ORNAMENTS, SIZES, bannerBlob, drawBanner, loadBannerFonts, loadImage, shrinkDataUrl } from "../lib/banner.js";
import { downloadBlob } from "../lib/exportDocx.js";
import { uploadDataUrls } from "../lib/images.js";
import { Link } from "../router.jsx";
import { CostCard, ErrorNote, JobCard, PLATFORMS, StatusBadge, announceTask, useJobSteps } from "../shared.jsx";
import { Icon, PageHeader } from "../ui.jsx";

// Banner & Poster Studio. Type the topic, choose the kind of banner, the size, the art style and
// the colours, add any details, and the AI writes the words and paints two or three pictures.
// The words are set on top in real fonts here in the browser, so they are always spelled right
// and every word, colour and position can be changed without paying for a new picture.

const KINDS = [
  ["festival", "Festival & greeting", "Diwali, Chhath Puja, Eid, Christmas, New Year, birthdays", "sun"],
  ["creative", "Creative poster", "One bold idea, striking art and a punchy line", "sparkles"],
  ["research", "Research / academic", "Conference posters, findings, calls for papers", "doc"],
  ["marketing", "Marketing & promotion", "Offers, launches, products and services", "bolt"],
  ["event", "Event & announcement", "Webinars, workshops, openings, results", "clock"],
];
const KIND_STYLE = { festival: "illustration", creative: "3d", research: "minimal", marketing: "photo", event: "flat" };
const ART_STYLES = [
  ["illustration", "Soft illustration"], ["watercolour", "Watercolour"], ["photo", "Photo"], ["3d", "3D render"],
  ["flat", "Flat vector"], ["minimal", "Minimal abstract"], ["papercut", "Paper-cut"],
];
const MOODS = [
  ["auto", "Auto"], ["warm", "Warm & festive"], ["cool", "Cool blues"], ["pastel", "Pastel"], ["dark", "Dark & bold"],
  ["earthy", "Earthy"], ["mono", "One colour"], ["brand", "My brand colour"],
];
const LANGUAGES = ["English", "Hindi", "English and Hindi", "Bengali", "Marathi", "Gujarati", "Punjabi", "Tamil", "Telugu", "Spanish", "French"];
// The detail fields for each kind: [key, label, example, multi-line].
const FIELDS = {
  festival: [
    ["message", "Your wishes (optional)", "e.g. May Chhathi Maiya bless you and your family with health and happiness", true],
    ["brand", "From: name or brand (optional)", "e.g. Team eManuscript"],
    ["contact", "Website or contact (optional)", "e.g. www.example.com"],
  ],
  creative: [
    ["message", "Message or tagline (optional)", "What should people feel or remember?", true],
    ["brand", "Brand (optional)", ""],
    ["cta", "Call to action (optional)", "e.g. Discover more"],
    ["contact", "Website or contact (optional)", ""],
  ],
  research: [
    ["message", "One-line summary (optional)", "e.g. A 12-month cohort study of 1,200 adults in Delhi", true],
    ["points", "Key findings or points, one per line", "e.g. Vitamin D lowered HbA1c by 0.4%\nNo serious side effects", true],
    ["authors", "Authors", "e.g. A. Kumar, B. Singh"],
    ["institution", "Institution", "e.g. University of Delhi"],
    ["contact", "Link or DOI (optional)", "e.g. https://doi.org/10.1000/xyz"],
  ],
  marketing: [
    ["offer", "Offer or price (optional)", "e.g. 20% off until 30 November"],
    ["points", "Selling points, one per line (optional)", "e.g. Live classes every weekend\nCertificate on completion", true],
    ["cta", "Call to action", "e.g. Enrol today"],
    ["brand", "Brand", ""],
    ["contact", "Website or phone", "e.g. www.example.com · +91 98xxxxxx"],
  ],
  event: [
    ["date", "Date and time", "e.g. Saturday 6 December 2026, 11 am IST"],
    ["venue", "Venue or online", "e.g. Online on Zoom"],
    ["points", "Speakers or highlights, one per line (optional)", "", true],
    ["cta", "Call to action", "e.g. Register free"],
    ["brand", "Organiser", ""],
    ["contact", "Registration link or contact", ""],
  ],
};
const PLAN_STEPS = ["Reading your brief", "Writing the words", "Imagining the pictures"];
const JOB_KEY = "banner_publishing";
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Instagram feed posts must be between 4:5 and 1.91:1.
const INSTAGRAM_OK = ["4:5", "1:1", "16:9"];

const blankBrief = () => ({
  topic: "", kind: "festival", aspect: "4:5", style: "illustration", mood: "auto", brand_color: "#c2410c", language: "English",
  picture: "", variations: 2, details: {},
});

/** One banner on a canvas, redrawn whenever its design, pictures or fonts change. */
function BannerCanvas({ design, logo, fontsReady, className, label }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && design) drawBanner(ref.current, design, { art: design.artImage, logo });
  }, [design, logo, fontsReady]);
  return <canvas ref={ref} className={className} role="img" aria-label={label} />;
}

function designFrom(plan, concept, brief, index) {
  const d = brief.details || {};
  const byline = brief.kind === "research" ? [d.authors, d.institution].filter(Boolean).join(" · ")
    : brief.kind === "event" ? [d.date, d.venue].filter(Boolean).join(" · ") : "";
  return {
    id: `v${Date.now()}-${index}`, concept, aspect: brief.aspect,
    kicker: plan.kicker, headline: plan.headline, message: plan.message, points: plan.points, badge: brief.kind === "marketing" ? d.offer || "" : "",
    byline, cta: d.cta || plan.cta || "", footer: [brief.kind === "research" ? "" : d.brand, d.contact].filter(Boolean).join("  ·  "),
    palette: brief.mood === "brand" && brief.brand_color ? { ...concept.palette, accent: brief.brand_color } : concept.palette,
    font: concept.headline_font, area: concept.text_area, ornament: concept.ornament, scale: 1, fade: 0.7, showLogo: true,
    art: null, artImage: null, artStatus: "waiting", artError: "",
  };
}

export default function BannerStudio({ me, refreshMe }) {
  const [brief, setBrief] = useState(blankBrief);
  const [planBrief, setPlanBrief] = useState(null);
  const [designs, setDesigns] = useState([]);
  const [current, setCurrent] = useState(0);
  const [logo, setLogo] = useState(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [usageRuns, setUsageRuns] = useState([]);
  const [artInstruction, setArtInstruction] = useState("");
  const [photoQuery, setPhotoQuery] = useState("");
  const [noAiPictures, setNoAiPictures] = useState("");
  const photoChain = useRef(Promise.resolve());
  const usedPhotos = useRef(new Set());
  const [caption, setCaption] = useState("");
  const configured = PLATFORMS.filter((p) => me.platforms[p.key].configured).map((p) => p.key);
  const [platforms, setPlatforms] = useState(configured);
  const [results, setResults] = useState({});
  const [warnings, setWarnings] = useState([]);
  const steps = useJobSteps(busy === "plan", PLAN_STEPS.length, 4);
  const design = designs[current] || null;
  const aiImages = me.services.ai_images;

  useEffect(() => {
    loadBannerFonts().then(() => setFontsReady(true));
  }, []);

  const set = (patch) => setBrief((old) => ({ ...old, ...patch }));
  const setDetail = (key, value) => setBrief((old) => ({ ...old, details: { ...old.details, [key]: value } }));
  const addUsage = (usage) => usage && setUsageRuns((old) => [...old, usage]);
  const updateDesign = (id, patch) => setDesigns((old) => old.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const edit = (patch) => design && updateDesign(design.id, patch);

  async function paint(target, usedBrief, instruction = "") {
    updateDesign(target.id, { artStatus: "drawing", artError: "" });
    announceTask("/banner", "running");
    try {
      const json = target.art && instruction
        ? { image: await shrinkDataUrl(target.art), instruction, aspect: target.aspect }
        : { kind: usedBrief.kind, style: usedBrief.style, scene: target.concept.scene, area: target.area, palette: target.palette, mood: usedBrief.mood,
          brand_color: usedBrief.mood === "brand" ? usedBrief.brand_color : "", topic: usedBrief.topic, aspect: target.aspect, instruction };
      const data = await api("/api/banner/art", { method: "POST", json });
      addUsage(data.usage);
      const image = await loadImage(data.image);
      updateDesign(target.id, { art: data.image, artImage: image, artStatus: "ready", credit: "", photoOrigin: "", previousArt: target.art ? { art: target.art, artImage: target.artImage } : null });
    } catch (failure) {
      const message = failure.message || "The picture couldn't be made.";
      // This key's plan has no AI pictures: say so once and use a free photo instead.
      const notInPlan = /free Gemini tier|switched off/i.test(message);
      if (notInPlan) setNoAiPictures(`${message} ${failure.hint || ""}`.trim());
      if (notInPlan && !target.art) await freePhoto(target, usedBrief.photo_search || usedBrief.topic, true);
      else updateDesign(target.id, { artStatus: target.art ? "ready" : "failed", artError: message });
    } finally {
      announceTask("/banner", "done");
    }
  }

  // Photo searches run one after another, so each design gets a different photo.
  function freePhoto(target, query, quiet = false) {
    updateDesign(target.id, { artStatus: "drawing", artError: "" });
    const run = photoChain.current.then(async () => {
      try {
        const data = await api("/api/banner/photo", { method: "POST", json: { query, used: [...usedPhotos.current] } });
        usedPhotos.current.add(data.origin);
        const image = await loadImage(data.image);
        updateDesign(target.id, { art: data.image, artImage: image, artStatus: "ready", credit: data.credit, photoOrigin: data.origin, fade: 0.9,
          previousArt: target.art ? { art: target.art, artImage: target.artImage } : null });
      } catch (failure) {
        updateDesign(target.id, { artStatus: quiet ? "none" : "failed", artError: failure.message || "No photo was found." });
      }
    });
    photoChain.current = run;
    return run;
  }

  async function create() {
    setBusy("plan");
    setError(null);
    setResults({});
    setWarnings([]);
    announceTask("/banner", "running");
    try {
      const details = Object.fromEntries(FIELDS[brief.kind].map(([key]) => [key, (brief.details[key] || "").trim()]).filter(([, v]) => v));
      const data = await api("/api/banner/plan", { method: "POST", json: { ...brief, details } });
      addUsage(data.usage);
      const made = data.plan.concepts.map((concept, i) => designFrom(data.plan, concept, data.brief, i));
      setPlanBrief({ ...data.brief, photo_search: data.plan.photo_search });
      setPhotoQuery(data.plan.photo_search || data.brief.topic);
      setDesigns(made);
      setCurrent(0);
      setCaption([data.plan.caption, data.plan.hashtags.join(" ")].filter(Boolean).join("\n\n"));
      const used = { ...data.brief, photo_search: data.plan.photo_search };
      if (aiImages && !noAiPictures) made.forEach((d) => paint(d, used));
      else made.forEach((d) => freePhoto(d, data.plan.photo_search || data.brief.topic, true));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
      announceTask("/banner", "done");
    }
  }

  function ownPicture(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const art = await shrinkDataUrl(reader.result, 2600);
        const image = await loadImage(art);
        edit({ art, artImage: image, artStatus: "ready", artError: "", credit: "", photoOrigin: "", previousArt: design.art ? { art: design.art, artImage: design.artImage } : null });
      } catch (failure) {
        setError({ message: failure.message });
      }
    };
    reader.readAsDataURL(file);
  }

  function addLogo(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setLogo(await loadImage(reader.result));
      } catch (failure) {
        setError({ message: failure.message });
      }
    };
    reader.readAsDataURL(file);
  }

  async function download(type) {
    const blob = await bannerBlob(design, { art: design.artImage, logo }, type === "png" ? "image/png" : "image/jpeg", 0.93);
    const name = (design.headline || "banner").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 50) || "banner";
    downloadBlob(blob, `${name}.${type}`);
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
    try { localStorage.removeItem(JOB_KEY); } catch { /* storage off */ }
  }

  const toPost = platforms.filter((p) => configured.includes(p) && !results[p]?.ok && (p !== "instagram" || INSTAGRAM_OK.includes(design?.aspect)));
  const captionLimit = Math.min(...PLATFORMS.filter((p) => toPost.includes(p.key)).map((p) => p.limit), 3000);

  async function publish() {
    setBusy("publish");
    setError(null);
    announceTask("/banner", "running");
    try {
      const blob = await bannerBlob(design, { art: design.artImage, logo }, "image/jpeg", 0.92);
      const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
      const images = await uploadDataUrls([dataUrl]);
      const withCredit = design.credit && !caption.includes(design.credit) ? `${caption}\n\nPhoto: ${design.credit}` : caption;
      const data = await api("/api/sitepost/publish", { method: "POST", json: {
        images, platforms: toPost, captions: Object.fromEntries(toPost.map((p) => [p, withCredit])), title: design.headline || planBrief?.topic || "Banner",
        usage_ids: usageRuns.filter(Boolean).map((u) => u.id),
      } });
      try { localStorage.setItem(JOB_KEY, data.id); } catch { /* storage off */ }
      await follow(data.id);
      refreshMe();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
      announceTask("/banner", "done");
    }
  }

  // After a reload, keep following a banner that was still publishing.
  useEffect(() => {
    let id = null;
    try { id = localStorage.getItem(JOB_KEY); } catch { id = null; }
    if (id) follow(id).catch(() => { try { localStorage.removeItem(JOB_KEY); } catch { /* storage off */ } });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = !me.services.gemini ? "Banners need the Gemini key on this server. Ask your administrator." : !brief.topic.trim() ? "Enter what the banner is about." : null;
  const publishing = busy === "publish";
  const wide = design && ["16:9", "21:9"].includes(design.aspect);

  return (
    <section>
      <PageHeader eyebrow="Banner & Poster Studio" title="Create a banner or poster"
        lead="Type the topic and choose the kind of banner. AI writes the words and paints the pictures; the words are set in real fonts, so you can change any of them, the colours or the layout, then download it or post it." />
      {!me.services.gemini && <p className="note note-warn">Banners need the Gemini key on this server. Ask your administrator to set GEMINI_API_KEY.</p>}
      {!aiImages && me.services.gemini && <p className="note">AI pictures are switched off on this server: banners use free, openly licensed photos, a designed background or your own picture.</p>}
      {noAiPictures && <p className="note note-warn">{noAiPictures} Free photos are used meanwhile.</p>}
      <div className="bn-stack">
        <div className="card">
          <h2><span className="step-num">1</span>What is it for?</h2>
          <div className="bn-kinds" role="radiogroup" aria-label="Kind of banner">
            {KINDS.map(([key, label, note, icon]) => (
              <button key={key} type="button" role="radio" aria-checked={brief.kind === key} className={`bn-kind${brief.kind === key ? " on" : ""}`}
                onClick={() => set({ kind: key, style: KIND_STYLE[key] })} disabled={Boolean(busy)}>
                <Icon name={icon} size={22} />
                <strong>{label}</strong>
                <small>{note}</small>
              </button>
            ))}
          </div>
          <label htmlFor="bn-topic">Topic</label>
          <input id="bn-topic" value={brief.topic} maxLength={500} onChange={(e) => set({ topic: e.target.value })}
            placeholder={{ festival: "e.g. Happy Chhath Puja", creative: "e.g. Ideas grow when shared", research: "e.g. Vitamin D and blood sugar control in type 2 diabetes",
              marketing: "e.g. Launch of our online AI writing course", event: "e.g. Free webinar: publishing in high-impact journals" }[brief.kind]}
            onKeyDown={(e) => e.key === "Enter" && !blocked && !busy && create()} />
          <div className="two-col">
            {FIELDS[brief.kind].map(([key, label, example, multi]) => (
              <label key={`${brief.kind}-${key}`} className={multi ? "span2" : undefined}>{label}
                {multi
                  ? <textarea rows={key === "points" ? 3 : 2} maxLength={key === "points" ? 1200 : 500} value={brief.details[key] || ""} placeholder={example} onChange={(e) => setDetail(key, e.target.value)} />
                  : <input value={brief.details[key] || ""} maxLength={500} placeholder={example} onChange={(e) => setDetail(key, e.target.value)} />}
              </label>
            ))}
          </div>

          <h3 className="bn-h">Look and size</h3>
          <label>Size</label>
          <div className="chips" role="radiogroup" aria-label="Size">
            {Object.entries(SIZES).map(([key, size]) => (
              <button key={key} type="button" role="radio" aria-checked={brief.aspect === key} className={`chip${brief.aspect === key ? " on" : ""}`} onClick={() => set({ aspect: key })}>{size.label}</button>
            ))}
          </div>
          <label>Art style</label>
          <div className="chips" role="radiogroup" aria-label="Art style">
            {ART_STYLES.map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={brief.style === key} className={`chip${brief.style === key ? " on" : ""}`} onClick={() => set({ style: key })}>{label}</button>
            ))}
          </div>
          <label>Colours</label>
          <div className="chips" role="radiogroup" aria-label="Colours">
            {MOODS.map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={brief.mood === key} className={`chip${brief.mood === key ? " on" : ""}`} onClick={() => set({ mood: key })}>{label}</button>
            ))}
            {brief.mood === "brand" && <input type="color" className="bn-swatch" aria-label="Brand colour" value={brief.brand_color} onChange={(e) => set({ brand_color: e.target.value })} />}
          </div>
          <div className="two-col">
            <label>Language of the words
              <select value={brief.language} onChange={(e) => set({ language: e.target.value })}>{LANGUAGES.map((l) => <option key={l}>{l}</option>)}</select>
            </label>
            <label>Versions to create
              <select value={brief.variations} onChange={(e) => set({ variations: Number(e.target.value) })}>
                <option value={1}>1 design</option><option value={2}>2 designs</option><option value={3}>3 designs</option>
              </select>
            </label>
            <label className="span2">What should the picture show? (optional)
              <input value={brief.picture} maxLength={800} onChange={(e) => set({ picture: e.target.value })}
                placeholder="e.g. a young woman in a yellow saree offering arghya to the setting sun on a river ghat" />
            </label>
          </div>
          <div className="bn-logo-row">
            <label className="button">
              <Icon name="upload" /> {logo ? "Change logo" : "Add your logo (optional)"}
              <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) addLogo(f); }} />
            </label>
            {logo && <><img src={logo.src} alt="Your logo" className="bn-logo" /><button type="button" className="small" onClick={() => setLogo(null)}>Remove logo</button></>}
          </div>
          <ErrorNote error={!design ? error : null} />
          <div className="actions">
            <button className="accent" onClick={create} disabled={Boolean(busy) || Boolean(blocked)}>
              <Icon name="sparkles" /> {busy === "plan" ? "Creating…" : designs.length ? "Create new designs" : "Create banner"}
            </button>
            {blocked && brief.topic && <span className="muted-text">{blocked}</span>}
          </div>
          <p className="field-note">The AI uses only the facts you give: it never invents dates, prices, names or statistics.{aiImages ? ` Each design's picture costs one AI image (${brief.variations} in all).` : ""}</p>
          {busy === "plan" && <JobCard title="Creating your banner" steps={PLAN_STEPS} active={steps.active} startedAt={steps.startedAt} typical="Words in 5–15 seconds, pictures in 15–40 more" />}
        </div>

        {design && (
          <div className="card">
            <div className="bn-head">
              <h2 style={{ margin: 0 }}><span className="step-num">2</span>Choose and edit</h2>
              <span className="spacer" />
              <button type="button" onClick={() => download("png")} disabled={design.artStatus === "drawing"}><Icon name="download" /> PNG</button>
              <button type="button" onClick={() => download("jpg")} disabled={design.artStatus === "drawing"}><Icon name="download" /> JPG</button>
            </div>
            {designs.length > 1 && (
              <div className="bn-thumbs" role="radiogroup" aria-label="Designs">
                {designs.map((d, i) => (
                  <button key={d.id} type="button" role="radio" aria-checked={i === current} className={`bn-thumb${i === current ? " on" : ""}`} onClick={() => setCurrent(i)}>
                    <BannerCanvas design={d} logo={logo} fontsReady={fontsReady} label={`Design ${i + 1}`} />
                    <span>Design {i + 1}{d.artStatus === "drawing" ? " · painting…" : d.artStatus === "failed" ? " · no picture" : ""}</span>
                  </button>
                ))}
              </div>
            )}
            <div className={`bn-editor${wide ? " wide" : ""}`}>
              <div className="bn-preview">
                <BannerCanvas design={design} logo={logo} fontsReady={fontsReady} className="bn-canvas" label={`Banner: ${design.kicker} ${design.headline}`} />
                {design.artStatus === "drawing" && <div className="bn-painting"><span className="job-orb" aria-hidden="true" /> Painting the picture… (up to a minute)</div>}
              </div>
              <div className="bn-controls">
                {design.artError && design.artStatus !== "drawing" && <p className="warn-text">The picture couldn't be made: {design.artError} Try a free photo, upload your own picture, or keep the designed background.</p>}
                <h3 className="bn-h">Words</h3>
                <label>Small line above<input value={design.kicker} maxLength={80} onChange={(e) => edit({ kicker: e.target.value })} /></label>
                <label>Headline<textarea rows={2} maxLength={200} value={design.headline} onChange={(e) => edit({ headline: e.target.value })} /></label>
                {(design.badge || planBrief?.kind === "marketing") && <label>Offer badge<input value={design.badge} maxLength={120} onChange={(e) => edit({ badge: e.target.value })} /></label>}
                <label>Message<textarea rows={3} maxLength={500} value={design.message} onChange={(e) => edit({ message: e.target.value })} /></label>
                <label>Points (one per line)<textarea rows={3} maxLength={800} value={design.points.join("\n")} onChange={(e) => edit({ points: e.target.value.split("\n") })} /></label>
                <label>{planBrief?.kind === "research" ? "Authors and institution" : planBrief?.kind === "event" ? "Date and venue" : "Extra line"}<input value={design.byline} maxLength={300} onChange={(e) => edit({ byline: e.target.value })} /></label>
                <div className="two-col">
                  <label>Button<input value={design.cta} maxLength={40} onChange={(e) => edit({ cta: e.target.value })} placeholder="None" /></label>
                  <label>Footer<input value={design.footer} maxLength={200} onChange={(e) => edit({ footer: e.target.value })} placeholder="Brand · website" /></label>
                </div>

                <h3 className="bn-h">Design</h3>
                {design.artImage ? (
                  <>
                    <label>Words placed</label>
                    <div className="segmented" role="radiogroup" aria-label="Where the words go">
                      {Object.entries(AREAS).map(([key, label]) => (
                        <button key={key} type="button" role="radio" aria-checked={design.area === key} className={design.area === key ? "on" : ""} onClick={() => edit({ area: key })}>{label}</button>
                      ))}
                    </div>
                  </>
                ) : <p className="field-note">Without a picture the words sit in the middle. Add a photo or your own picture to place them.</p>}
                <div className="two-col">
                  <label>Fonts<select value={design.font} onChange={(e) => edit({ font: e.target.value })}>{Object.entries(FONT_SETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
                  <label>Ornament<select value={design.ornament} onChange={(e) => edit({ ornament: e.target.value })}>{Object.entries(ORNAMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                </div>
                <div className="bn-colours">
                  {[["background", "Background"], ["text", "Text"], ["accent", "Accent"]].map(([key, label]) => (
                    <label key={key} className="bn-colour"><input type="color" value={design.palette[key]} onChange={(e) => edit({ palette: { ...design.palette, [key]: e.target.value } })} /> {label}</label>
                  ))}
                </div>
                <label className="bn-range">Text size <input type="range" min={0.6} max={1.5} step={0.05} value={design.scale} onChange={(e) => edit({ scale: Number(e.target.value) })} /></label>
                {design.artImage && <label className="bn-range">Fade behind the words <input type="range" min={0} max={1} step={0.05} value={design.fade} onChange={(e) => edit({ fade: Number(e.target.value) })} /></label>}
                {logo && <label className="check"><input type="checkbox" checked={design.showLogo} onChange={(e) => edit({ showLogo: e.target.checked })} /> Show the logo</label>}

                <h3 className="bn-h">Picture</h3>
                {aiImages && !noAiPictures && design.artImage && !design.credit && (
                  <>
                    <label htmlFor="bn-art-edit">Change the picture with AI</label>
                    <div className="wr-inline">
                      <input id="bn-art-edit" value={artInstruction} maxLength={1000} onChange={(e) => setArtInstruction(e.target.value)}
                        placeholder="e.g. make it sunrise, add marigold flowers on the water" />
                      <button type="button" disabled={!artInstruction.trim() || design.artStatus === "drawing"} onClick={() => { paint(design, planBrief, artInstruction.trim()); setArtInstruction(""); }}>Apply</button>
                    </div>
                  </>
                )}
                <label htmlFor="bn-photo">Free photo (openly licensed)</label>
                <div className="wr-inline">
                  <input id="bn-photo" value={photoQuery} maxLength={200} onChange={(e) => setPhotoQuery(e.target.value)} placeholder="e.g. river sunset offering" />
                  <button type="button" disabled={!photoQuery.trim() || design.artStatus === "drawing"} onClick={() => freePhoto(design, photoQuery.trim())}>{design.credit ? "Another photo" : "Find"}</button>
                </div>
                <div className="actions tight">
                  {aiImages && !noAiPictures && <button type="button" disabled={design.artStatus === "drawing"} onClick={() => paint(design, planBrief)}><Icon name="sparkles" /> New AI picture</button>}
                  <label className="button">
                    <Icon name="upload" /> Use my own picture
                    <input type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) ownPicture(f); }} />
                  </label>
                  {design.previousArt && <button type="button" onClick={() => edit({ art: design.previousArt.art, artImage: design.previousArt.artImage, previousArt: null, artStatus: "ready" })}>Undo picture</button>}
                  {design.artImage && <button type="button" onClick={() => edit({ art: null, artImage: null, artStatus: "none", previousArt: { art: design.art, artImage: design.artImage } })}>Plain background</button>}
                </div>
                {design.credit && <p className="field-note">Photo: {design.credit} The credit is added to the caption when you post; keep it when you share the download.</p>}
                <p className="field-note">Editing the words, fonts, colours or photo is free. A new or changed AI picture is one more AI image.</p>
              </div>
            </div>
          </div>
        )}

        {design && (
          <div className="card">
            <h2><span className="step-num">3</span>Post it (optional)</h2>
            {configured.length === 0 && <p className="note note-warn">No accounts are connected. <Link to="/settings">Connect them in Settings</Link>, or download the banner above.</p>}
            <fieldset>
              <legend>Post to</legend>
              <div className="checks">
                {PLATFORMS.map((p) => {
                  const fits = p.key !== "instagram" || INSTAGRAM_OK.includes(design.aspect);
                  return (
                    <label key={p.key} className={configured.includes(p.key) && fits ? "check" : "check disabled"}>
                      <input type="checkbox" disabled={!configured.includes(p.key) || !fits || results[p.key]?.ok} checked={platforms.includes(p.key) && fits}
                        onChange={() => setPlatforms(platforms.includes(p.key) ? platforms.filter((k) => k !== p.key) : [...platforms, p.key])} />
                      <span className={`platform-dot ${p.key}`} />{p.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {!INSTAGRAM_OK.includes(design.aspect) && configured.includes("instagram") && <p className="field-note">Instagram feed posts must be 4:5, square or landscape: choose one of those sizes to post there.</p>}
            <div className="draft-head" style={{ marginTop: "0.8rem" }}>
              <label htmlFor="bn-caption">Caption</label>
              <span className={caption.length > captionLimit ? "count over" : "count"}>{caption.length} / {captionLimit}</span>
            </div>
            <textarea id="bn-caption" rows={6} value={caption} onChange={(e) => setCaption(e.target.value)} />
            {Object.entries(results).map(([key, r]) => (
              <p key={key} className="post-actions">
                <StatusBadge result={r} /> {PLATFORMS.find((p) => p.key === key)?.label}
                {r.ok && r.url?.startsWith("https://") && <a href={r.url} target="_blank" rel="noreferrer">View post</a>}
                {r.error && <span className="hint">{r.error}{r.hint ? ` ${r.hint}` : ""}</span>}
              </p>
            ))}
            {warnings.map((w) => <p className="warn-text" key={w}>{w}</p>)}
            <ErrorNote error={design ? error : null} />
            <div className="actions">
              <button className="accent" onClick={publish}
                disabled={Boolean(busy) || design.artStatus === "drawing" || !toPost.length || !caption.trim() || caption.length > captionLimit}>
                <Icon name="send" /> {publishing ? "Posting… (Instagram can take a minute)" : `Post to ${toPost.length} platform${toPost.length === 1 ? "" : "s"}`}
              </button>
            </div>
            <p className="field-note">{publishing ? "You can leave or reload this page: publishing carries on, and the post is already in History." : "Each platform is tried once. The post goes live as soon as you click."}</p>
          </div>
        )}
        <CostCard runs={usageRuns} title="AI cost for this banner" />
      </div>
    </section>
  );
}
