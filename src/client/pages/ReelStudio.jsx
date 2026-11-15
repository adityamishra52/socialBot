import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Link } from "../router.jsx";
import { CostCard, ErrorNote, JobCard, LinkField, PLATFORMS, StatusBadge, announceTask, linkValue } from "../shared.jsx";
import { Icon, PageHeader } from "../ui.jsx";

const VOICES = {
  Kore: "Firm", Puck: "Upbeat", Charon: "Informative", Zephyr: "Bright", Fenrir: "Excitable", Aoede: "Breezy",
  Orus: "Firm", Leda: "Youthful", Achird: "Friendly", Sulafat: "Warm", Sadaltager: "Knowledgeable",
  Gacrux: "Mature", Algieba: "Smooth", Laomedeia: "Upbeat",
};
const STYLES = ["glass", "neon", "minimal", "bold", "luxury", "playful", "academic"];
const VISUALS = ["browser", "gallery", "card", "cube", "sphere", "torus", "knot", "rings", "crystal", "wave", "particles"];
const FORMATS = {
  auto: ["Auto", "A different format from your last reel, every time."],
  cinematic: ["Cinematic", "Big 3D centrepiece, headline in the lower third, smooth zoom cuts."],
  kinetic: ["Kinetic", "Huge words punch in at the centre, fast whip cuts and flashes."],
  split: ["Split", "3D on top, a solid text panel below that slides in like a story deck."],
  news: ["News", "Kicker label, headline on colour bars and a scrolling hashtag ticker."],
  spotlight: ["Spotlight", "Numbered points under a spotlight, headline on top, 3D below."],
};
const LAST_FORMAT_KEY = "reel_last_format";
const PUBLISHING_KEY = "reel_publishing";
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const VISUAL_LABELS = {
  browser: "the page opens and is read", gallery: "site images gallery", card: "site image card",
};
const MODES = {
  trending: ["Trending", "Scroll-stopping and eye-catching: bold hook, punchy lines, vivid 3D and an energetic voice."],
  academic: ["Academic", "Clean and credible: paper background, serif titles, navy ink, calm motion and a measured voice."],
};
const CAMERAS = ["orbit", "dolly", "rise", "sweep"];
const IDEAS = [
  "Darker and more cinematic",
  "Brighter, playful colours",
  "Faster and punchier, shorter lines",
  "Use glass spheres and crystals",
  "Luxury gold look",
  "Warmer, friendlier voice",
  "Show the website image more",
  "Make the hook more surprising",
  "Switch to the kinetic format",
  "Switch to the news format",
  "Make it clean and academic",
];
const CREATE_STEPS = ["Visiting the site", "Writing the storyboard and script", "Recording the AI voiceover", "Building the 3D scenes"];
const REVISE_STEPS = ["Applying your changes", "Recording the AI voiceover", "Building the 3D scenes"];

const narrationOf = (board) => board.scenes.map((s) => s.narration).join(" ");

export default function ReelStudio({ me, refreshMe, active }) {
  const [url, setUrl] = useState("");
  const [direction, setDirection] = useState("");
  const [mode, setMode] = useState("trending");
  const [format, setFormat] = useState("auto");
  const [followLinks, setFollowLinks] = useState(false);
  const [tagsCopied, setTagsCopied] = useState(false);
  const [linkOn, setLinkOn] = useState(true);
  const [background, setBackground] = useState(null);
  const [link, setLink] = useState("");
  const [site, setSite] = useState(null);
  const [board, setBoard] = useState(null);
  const [voiced, setVoiced] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [usageRuns, setUsageRuns] = useState([]);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(null);
  const [video, setVideo] = useState(null);
  const [captions, setCaptions] = useState({ linkedin: "", facebook: "", instagram: "" });
  const configured = PLATFORMS.filter((p) => me.platforms[p.key].configured).map((p) => p.key);
  const [selected, setSelected] = useState(configured);
  const [results, setResults] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [posting, setPosting] = useState(false);

  const canvasRef = useRef(null);
  const reelRef = useRef(null);
  const stopRef = useRef(null);
  const abortRef = useRef(null);
  const uploadedRef = useRef(null);

  const busy = Boolean(job) || Boolean(recording) || posting;
  const dirty = board && voiced && (narrationOf(board) !== voiced.text || board.voice !== voiced.voice);

  async function voice(nextBoard) {
    const text = narrationOf(nextBoard);
    const data = await api("/api/reel/voice", { method: "POST", json: { text, voice: nextBoard.voice } });
    setUsageRuns((old) => [...old, data.usage]);
    const { decodeWav } = await import("../reel/renderer.js");
    const buffer = await decodeWav(data.audio);
    setVoiced({ text, voice: nextBoard.voice, seconds: data.seconds, buffer });
  }

  async function runJob(kind, steps, work) {
    setJob({ kind, steps, active: 0, startedAt: Date.now() });
    setError(null);
    announceTask("/reel", "running");
    try {
      await work((active) => setJob((old) => (old ? { ...old, active } : old)));
    } catch (failure) {
      setError(failure);
    } finally {
      setJob(null);
      announceTask("/reel", "done");
    }
  }

  const create = () =>
    runJob("create", CREATE_STEPS, async (step) => {
      let lastFormat = null;
      try { lastFormat = localStorage.getItem(LAST_FORMAT_KEY); } catch { /* storage off */ }
      const data = await api("/api/reel/storyboard", {
        method: "POST",
        json: { url: url.trim(), instructions: direction, mode, format, last_format: lastFormat, follow_links: followLinks },
      });
      try { localStorage.setItem(LAST_FORMAT_KEY, data.storyboard.format); } catch { /* storage off */ }
      setUsageRuns((old) => [...old, data.usage]);
      setSite(data.site);
      setLink(data.site.url);
      setCaptions(data.storyboard.captions);
      setVideo(null);
      setResults({});
      step(1);
      setBoard(data.storyboard);
      step(2);
      await voice(data.storyboard);
      step(3);
    });

  const revise = (text) =>
    runJob("revise", REVISE_STEPS, async (step) => {
      const data = await api("/api/reel/revise", {
        method: "POST",
        json: {
          storyboard: board, instruction: text,
          site: {
            url: site.url, title: site.title, description: site.description, text: site.text, article: site.article ?? null,
            image_count: site.images?.length ?? (site.image ? 1 : 0), pages: site.pages ?? [],
          },
        },
      });
      setUsageRuns((old) => [...old, data.usage]);
      setBoard(data.storyboard);
      setCaptions(data.storyboard.captions);
      setVideo(null);
      setResults({});
      setInstruction("");
      step(1);
      if (narrationOf(data.storyboard) !== voiced?.text || data.storyboard.voice !== voiced?.voice) await voice(data.storyboard);
      step(2);
    });

  const revoice = () =>
    runJob("revise", REVISE_STEPS.slice(1), async (step) => {
      await voice(board);
      setVideo(null);
      step(1);
    });

  // Rebuild the 3D preview whenever the storyboard or the voiceover changes.
  useEffect(() => {
    if (!board || !voiced || !site || recording) return undefined;
    let cancelled = false;
    setReady(false);
    (async () => {
      const { createReel } = await import("../reel/renderer.js");
      if (cancelled) return;
      stopRef.current?.();
      reelRef.current?.dispose();
      try {
        const reel = await createReel(canvasRef.current, { ...board, host: site.host }, { audioSeconds: voiced.seconds, siteImage: site.image, site });
        if (cancelled) {
          reel.dispose();
          return;
        }
        reelRef.current = reel;
        reel.renderAt(1.4);
        setReady(true);
      } catch (failure) {
        setError({ message: "The 3D preview couldn't start.", hint: `${failure.message} This needs a browser with WebGL, such as Chrome or Edge.` });
      }
    })();
    return () => { cancelled = true; };
  }, [board, voiced, site]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    stopRef.current?.();
    reelRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (!active && playing) {
      stopRef.current?.();
      setPlaying(false);
    }
  }, [active, playing]);

  async function play() {
    if (playing) {
      stopRef.current?.();
      setPlaying(false);
      return;
    }
    const { playReel } = await import("../reel/renderer.js");
    setPlaying(true);
    stopRef.current = playReel(reelRef.current, voiced.buffer, () => setPlaying(false));
  }

  async function record() {
    stopRef.current?.();
    setPlaying(false);
    setError(null);
    const { recordReel, recordingType } = await import("../reel/renderer.js");
    const controller = new AbortController();
    abortRef.current = controller;
    setRecording({ progress: 0 });
    announceTask("/reel", "running");
    try {
      const blob = await recordReel(canvasRef.current, reelRef.current, voiced.buffer, {
        signal: controller.signal,
        onProgress: (progress) => setRecording({ progress }),
      });
      if (video?.url) URL.revokeObjectURL(video.url);
      uploadedRef.current = null;
      const type = recordingType() ?? blob.type;
      setVideo({ blob, url: URL.createObjectURL(blob), mp4: blob.type === "video/mp4", type, size: blob.size });
      setResults({});
    } catch (failure) {
      if (failure.name !== "AbortError") setError({ message: "Recording failed.", hint: failure.message });
    } finally {
      setRecording(null);
      announceTask("/reel", "done");
      reelRef.current?.renderAt(1.4);
    }
  }

  function download() {
    const link = document.createElement("a");
    link.href = video.url;
    const name = (board.title || site.host || "reel").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reel";
    link.download = `${name}.${video.mp4 ? "mp4" : "webm"}`;
    link.click();
  }

  async function post() {
    setPosting(true);
    setError(null);
    setWarnings([]);
    try {
      if (!uploadedRef.current) {
        const form = new FormData();
        form.append("file", new File([video.blob], `reel.${video.mp4 ? "mp4" : "webm"}`, { type: video.blob.type }));
        uploadedRef.current = (await api("/api/reel/upload", { method: "POST", form })).key;
      }
      const targets = selected.filter((key) => configured.includes(key) && !results[key]?.ok);
      let data = await api("/api/reel/publish", {
        method: "POST",
        json: {
          video_key: uploadedRef.current, platforms: targets, captions, title: board.title, link: linkValue(linkOn, link),
          usage_ids: usageRuns.filter(Boolean).map((u) => u.id),
        },
      });
      // The server keeps publishing even if this page is closed; remember the job so a reload can follow it.
      try { localStorage.setItem(PUBLISHING_KEY, JSON.stringify({ id: data.id, title: board.title })); } catch { /* storage off */ }
      setResults((old) => ({ ...old, ...Object.fromEntries(data.results.map((r) => [r.platform, r])) }));
      while (!data.done) {
        await wait(4000);
        data = await api(`/api/reel/publish/${data.id}`);
        setResults((old) => ({ ...old, ...Object.fromEntries(data.results.map((r) => [r.platform, r])) }));
      }
      try { localStorage.removeItem(PUBLISHING_KEY); } catch { /* storage off */ }
      setWarnings(data.warnings ?? []);
      refreshMe();
    } catch (failure) {
      setError(failure);
    } finally {
      setPosting(false);
    }
  }

  // After a reload, keep following a reel that was still publishing.
  useEffect(() => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PUBLISHING_KEY) || "null"); } catch { saved = null; }
    if (!saved?.id) return undefined;
    let stopped = false;
    (async () => {
      try {
        let data = await api(`/api/reel/publish/${saved.id}`);
        setBackground({ ...data, title: saved.title });
        while (!data.done && !stopped) {
          await wait(4000);
          data = await api(`/api/reel/publish/${saved.id}`);
          if (!stopped) setBackground({ ...data, title: saved.title });
        }
        if (data.done) localStorage.removeItem(PUBLISHING_KEY);
      } catch {
        try { localStorage.removeItem(PUBLISHING_KEY); } catch { /* storage off */ }
      }
    })();
    return () => { stopped = true; };
  }, []);

  function setScene(index, fields) {
    setBoard((old) => ({ ...old, scenes: old.scenes.map((s, i) => (i === index ? { ...s, ...fields } : s)) }));
    setVideo(null);
  }

  const words = board ? narrationOf(board).split(/\s+/).filter(Boolean).length : 0;
  const blocked = !me.services.gemini
    ? "Reels need the Gemini key on this server. Ask your administrator to add it."
    : !/^https?:\/\/\S+\.\S+/.test(url.trim()) ? "Enter the website's address, starting with https://." : null;
  const toPost = selected.filter((key) => configured.includes(key) && !results[key]?.ok);

  return (
    <section className="content" style={{ padding: 0 }}>
      <PageHeader
        eyebrow="Site to Reel"
        title="Turn any website into a 3D reel"
        lead="Enter a site. AI visits it, writes a 15–20 second script, voices it, and animates it in 3D. Redesign it with a sentence, then download it or post it."
      />
      <div className="studio">
        <div style={{ display: "grid", gap: "1.1rem", minWidth: 0 }}>
          {background && (
            <div className="card">
              <div className="row">
                <h2 style={{ margin: 0 }}>{background.done ? "Your last reel" : "Your last reel is still publishing"}</h2>
                <button className="small" onClick={() => setBackground(null)} aria-label="Close"><Icon name="x" size={15} /></button>
              </div>
              <p className="muted-text">{background.title}</p>
              <div className="history-platform-row">
                {background.results.map((r) => (
                  <span key={r.platform} className="history-platform">
                    <StatusBadge result={r} /> {PLATFORMS.find((p) => p.key === r.platform)?.label ?? r.platform}
                    {r.ok && r.url?.startsWith("https://") && <> · <a href={r.url} target="_blank" rel="noreferrer">View</a></>}
                  </span>
                ))}
              </div>
              {background.warnings?.map((w) => <p className="warn-text" key={w}>{w}</p>)}
              <p className="field-note">
                {background.done ? "It's also in History." : "Instagram can take a few minutes to process a video. You can leave this page; it carries on, and History shows it too."}
              </p>
            </div>
          )}
          <div className="card">
            <h2><span className="step-num">1</span>Your website</h2>
            <label htmlFor="reel-url">Website address</label>
            <input id="reel-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article/123"
              onKeyDown={(e) => e.key === "Enter" && !blocked && !busy && create()} />
            <label>Reel type</label>
            <div className="segmented" role="radiogroup" aria-label="Reel type">
              {Object.entries(MODES).map(([key, [label]]) => (
                <button key={key} role="radio" aria-checked={mode === key} className={mode === key ? "on" : ""}
                  onClick={() => setMode(key)} disabled={busy}>{label}</button>
              ))}
            </div>
            <p className="field-note">{MODES[mode][1]}</p>
            <label htmlFor="reel-format">Video format</label>
            <select id="reel-format" value={format} disabled={busy} onChange={(e) => setFormat(e.target.value)}>
              {Object.entries(FORMATS).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <p className="field-note">{FORMATS[format][1]}</p>
            <label className="check" style={{ marginTop: "0.6rem" }}>
              <input type="checkbox" checked={followLinks} disabled={busy} onChange={(e) => setFollowLinks(e.target.checked)} />
              Also open up to two linked pages on the same site
            </label>
            <label htmlFor="reel-direction">Direction (optional)</label>
            <textarea id="reel-direction" rows={3} maxLength={1000} value={direction} onChange={(e) => setDirection(e.target.value)}
              placeholder="e.g. Promote the new spring collection. Energetic, for young professionals. End with 'Shop now'." />
            <ErrorNote error={!board ? error : null} />
            {blocked && url && <p className="muted-text" style={{ marginTop: "0.8rem" }}>{blocked}</p>}
            <div className="actions">
              <button className="accent" onClick={create} disabled={busy || Boolean(blocked)}>
                <Icon name="sparkles" /> {job?.kind === "create" ? "Creating…" : board ? "Start over from this site" : "Create reel"}
              </button>
            </div>
            <p className="field-note">
              AI reads only the page you paste: its own text and images, not its menus, sidebars, "related" lists or
              references, so the reel never promotes another author's work. For a journal article it uses the title,
              authors, journal and abstract. Only public pages work. Sites built with JavaScript (React, Vue…) are read as a browser shows them.
            </p>
          </div>

          {board && (
            <div className="card">
              <h2><span className="step-num">2</span>Redesign with a command</h2>
              <label htmlFor="reel-command">What should change?</label>
              <div className="input-row">
                <input id="reel-command" value={instruction} maxLength={1000} onChange={(e) => setInstruction(e.target.value)}
                  placeholder="e.g. Make it darker with neon shapes and a calmer voice"
                  onKeyDown={(e) => e.key === "Enter" && instruction.trim() && !busy && revise(instruction)} />
                <button className="primary" onClick={() => revise(instruction)} disabled={busy || !instruction.trim()}>
                  <Icon name="wand" /> Apply
                </button>
              </div>
              <div className="chips">
                {IDEAS.map((idea) => (
                  <button key={idea} className="chip" disabled={busy} onClick={() => revise(idea)}>{idea}</button>
                ))}
              </div>

              <div className="two-col" style={{ marginTop: "0.6rem" }}>
                <div>
                  <label htmlFor="reel-board-format">Format</label>
                  <select id="reel-board-format" value={board.format ?? "cinematic"} disabled={busy}
                    onChange={(e) => { setBoard({ ...board, format: e.target.value }); setVideo(null); }}>
                    {Object.entries(FORMATS).filter(([key]) => key !== "auto").map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="reel-kicker">Label</label>
                  <input id="reel-kicker" value={board.kicker ?? ""} maxLength={24} disabled={busy} placeholder="NEW RESEARCH"
                    onChange={(e) => { setBoard({ ...board, kicker: e.target.value.toUpperCase() }); setVideo(null); }} />
                </div>
              </div>
              <div className="two-col">
                <div>
                  <label htmlFor="reel-style">Look</label>
                  <select id="reel-style" value={board.style} disabled={busy}
                    onChange={(e) => { setBoard({ ...board, style: e.target.value }); setVideo(null); }}>
                    {STYLES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="reel-voice">Voice</label>
                  <select id="reel-voice" value={board.voice} disabled={busy} onChange={(e) => setBoard({ ...board, voice: e.target.value })}>
                    {Object.entries(VOICES).map(([name, tone]) => <option key={name} value={name}>{name} ({tone})</option>)}
                  </select>
                </div>
              </div>
              <label>Colours</label>
              <div className="accent-swatches">
                {board.palette.map((value, i) => (
                  <input key={i} type="color" className="swatch" value={value} aria-label={`Colour ${i + 1}`} disabled={busy}
                    onChange={(e) => { setBoard({ ...board, palette: board.palette.map((c, j) => (j === i ? e.target.value : c)) }); setVideo(null); }} />
                ))}
                <input type="color" className="swatch" value={board.background} aria-label="Background colour" disabled={busy}
                  onChange={(e) => { setBoard({ ...board, background: e.target.value }); setVideo(null); }} />
              </div>

              <details style={{ marginTop: "1rem" }}>
                <summary>Edit scenes and script ({board.scenes.length} scenes, {words} words)</summary>
                <ul className="article-list">
                  {board.scenes.map((scene, i) => (
                    <li className="article-item" key={i} style={{ gridTemplateColumns: "1fr" }}>
                      <div className="fields">
                        <strong style={{ fontSize: "0.8rem" }}>Scene {i + 1}</strong>
                        <input aria-label={`Scene ${i + 1} headline`} value={scene.headline} maxLength={60} disabled={busy}
                          onChange={(e) => setScene(i, { headline: e.target.value })} placeholder="Headline" />
                        <input aria-label={`Scene ${i + 1} subline`} value={scene.subline} maxLength={120} disabled={busy}
                          onChange={(e) => setScene(i, { subline: e.target.value })} placeholder="Subline" />
                        <textarea aria-label={`Scene ${i + 1} narration`} rows={2} value={scene.narration} maxLength={200} disabled={busy}
                          onChange={(e) => setScene(i, { narration: e.target.value })} placeholder="Spoken words" />
                        <div className="split" style={{ gridTemplateColumns: "1fr 1fr" }}>
                          <select aria-label={`Scene ${i + 1} 3D object`} value={scene.visual} disabled={busy} onChange={(e) => setScene(i, { visual: e.target.value })}>
                            {VISUALS.map((v) => <option key={v} value={v}>{VISUAL_LABELS[v] ?? v}</option>)}
                          </select>
                          <select aria-label={`Scene ${i + 1} camera`} value={scene.camera} disabled={busy} onChange={(e) => setScene(i, { camera: e.target.value })}>
                            {CAMERAS.map((c) => <option key={c} value={c}>camera: {c}</option>)}
                          </select>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <label htmlFor="reel-cta">Call to action</label>
                <input id="reel-cta" value={board.cta} maxLength={60} disabled={busy} onChange={(e) => setBoard({ ...board, cta: e.target.value })} />
              </details>
              {dirty && (
                <div className="note note-warn" style={{ marginTop: "0.9rem" }}>
                  The script or voice changed, so the voiceover is out of date.
                  <div className="actions" style={{ marginTop: "0.5rem" }}>
                    <button className="small primary" onClick={revoice} disabled={busy}><Icon name="mic" size={15} /> Re-record voiceover</button>
                  </div>
                </div>
              )}
              <ErrorNote error={board ? error : null} />
            </div>
          )}

          {board && (
            <div className="card">
              <h2><span className="step-num">3</span>Post it</h2>
              {configured.length === 0 && (
                <p className="note note-warn">No accounts are connected. <Link to="/settings">Connect them in Settings</Link>, or download the video.</p>
              )}
              <fieldset>
                <legend>Post to</legend>
                <div className="checks">
                  {PLATFORMS.map((p) => (
                    <label key={p.key} className={configured.includes(p.key) ? "check" : "check disabled"}>
                      <input type="checkbox" disabled={!configured.includes(p.key) || results[p.key]?.ok} checked={selected.includes(p.key)}
                        onChange={() => setSelected(selected.includes(p.key) ? selected.filter((k) => k !== p.key) : [...selected, p.key])} />
                      <span className={`platform-dot ${p.key}`} />{p.label}{p.key === "instagram" ? " Reel" : " video"}
                    </label>
                  ))}
                </div>
              </fieldset>
              {PLATFORMS.filter((p) => selected.includes(p.key)).map((p) => (
                <div key={p.key}>
                  <div className="draft-head" style={{ marginTop: "0.8rem" }}>
                    <label htmlFor={`reel-cap-${p.key}`}><span className={`platform-dot ${p.key}`} />{p.label} caption</label>
                    <span className={captions[p.key].length > p.limit ? "count over" : "count"}>{captions[p.key].length} / {p.limit}</span>
                  </div>
                  <textarea id={`reel-cap-${p.key}`} rows={4} value={captions[p.key]} disabled={results[p.key]?.ok}
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
              <LinkField id="reel-link" on={linkOn} onToggle={setLinkOn} url={link} onUrl={setLink} disabled={posting} />
              {board.hashtags?.length > 0 && (
                <div style={{ marginTop: "0.9rem" }}>
                  <div className="draft-head">
                    <label>Suggested hashtags</label>
                    <button type="button" className="small" onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(board.hashtags.join(" "));
                        setTagsCopied(true);
                        setTimeout(() => setTagsCopied(false), 1500);
                      } catch { /* clipboard blocked */ }
                    }}>{tagsCopied ? "Copied" : "Copy all"}</button>
                  </div>
                  <div className="chips">
                    {board.hashtags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
                  </div>
                  <p className="field-note">The captions already include the best of these for each platform.</p>
                </div>
              )}
              {warnings.map((w) => <p className="warn-text" key={w}>{w}</p>)}
              <div className="actions">
                <button className="accent" onClick={post}
                  disabled={busy || !video?.mp4 || toPost.length === 0 || toPost.some((k) => !captions[k].trim() || captions[k].length > PLATFORMS.find((p) => p.key === k).limit)}>
                  <Icon name="send" /> {posting ? "Posting… (Instagram can take a few minutes)" : `Post reel to ${toPost.length} platform${toPost.length === 1 ? "" : "s"}`}
                </button>
              </div>
              <p className="field-note">
                {!video ? "Record the video first (step 4 in the preview)." : !video.mp4
                  ? "This browser recorded WebM, which Instagram and LinkedIn don't accept. Record in Chrome or Edge to post, or download it."
                  : posting ? "You can leave or reload this page: publishing carries on, and the reel is already in History."
                    : "The reel goes live as soon as you click. Each platform is tried once."}
              </p>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gap: "1.1rem", minWidth: 0, position: "sticky", top: "1rem" }}>
          {job && (
            <JobCard title={job.kind === "create" ? "Creating your reel" : "Updating your reel"} steps={job.steps}
              active={job.active} startedAt={job.startedAt} typical="Usually 20–60 seconds" />
          )}
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}><span className="step-num">4</span>Preview and record</h2>
              {voiced && <span className="badge brand">{reelRef.current ? `${Math.round(reelRef.current.duration)}s` : ""} · {voiced.voice}</span>}
            </div>
            <div className="reel-stage">
              <canvas ref={canvasRef} className="reel-canvas" width={1080} height={1920} aria-label="Reel preview" />
              {!ready && (
                <div className="reel-empty">
                  {job ? <span className="job-orb" aria-hidden="true" /> : <Icon name="film" size={34} />}
                  <p>{job ? "Building your reel…" : "Your 3D reel will appear here."}</p>
                </div>
              )}
              {recording && (
                <div className="reel-rec"><span /> REC {Math.round(recording.progress * 100)}%</div>
              )}
            </div>
            {recording && (
              <>
                <div className="progress"><div style={{ width: `${recording.progress * 100}%` }} /></div>
                <p className="field-note">Recording in real time. Keep this tab open and visible until it finishes.</p>
              </>
            )}
            <div className="actions">
              <button onClick={play} disabled={!ready || Boolean(recording) || Boolean(job)}>
                <Icon name={playing ? "stop" : "play"} /> {playing ? "Stop" : "Play with sound"}
              </button>
              {recording ? (
                <button className="danger" onClick={() => abortRef.current?.abort()}>Cancel recording</button>
              ) : (
                <button className="primary" onClick={record} disabled={!ready || Boolean(job) || posting || dirty}>
                  <Icon name="film" /> {video ? "Record again" : "Record video"}
                </button>
              )}
            </div>
            {video && !recording && (
              <div style={{ marginTop: "1rem" }}>
                <video className="reel-video" src={video.url} controls playsInline />
                <div className="actions">
                  <button onClick={download}><Icon name="download" /> Download {video.mp4 ? "MP4" : "WebM"}</button>
                  <span className="muted-text">{(video.size / 1024 / 1024).toFixed(1)} MB · 1080×1920 · 30 fps</span>
                </div>
              </div>
            )}
          </div>
          <CostCard runs={usageRuns} title="AI cost for this reel" />
        </div>
      </div>
    </section>
  );
}
