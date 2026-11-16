import { useEffect, useState } from "react";
import { api } from "../api.js";
import { fitOptions, uploadDataUrls } from "../lib/images.js";
import { screenshotPosts } from "../lib/shots.js";
import { Link } from "../router.jsx";
import {
  CostCard, ErrorNote, JobCard, LinkField, PLATFORMS, StatusBadge, announceTask, linkValue, useJobSteps,
} from "../shared.jsx";
import { Icon, PageHeader } from "../ui.jsx";

const MODES = {
  trending: ["Trending", "Bold hook, energetic and scroll-stopping."],
  academic: ["Academic", "Calm, precise and credible, for research and education."],
};
const PRESETS = [
  ["professional", "Professional"],
  ["cinematic", "Cinematic"],
  ["original", "Make it original (remove filters & edits)"],
  ["sharpen", "Sharper & brighter"],
  ["clean", "Clean up clutter & watermarks"],
  ["vibrant", "Vibrant colours"],
  ["popups", "Remove pop-ups & cookie banners"],
];
const MAX_SELECTED = 10;
const JOB_KEY = "sitepost_publishing";
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function siteForServer(site) {
  return {
    url: site.url, title: site.title, description: site.description, text: site.text, article: site.article ?? null,
    pages: site.pages ?? [], image_count: site.images?.length ?? 0,
  };
}

function ImageOption({ option, index, selected, order, onToggle, onEnhance, busy, aiImages }) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("");
  const [text, setText] = useState("");
  return (
    <div className={`sp-option${selected ? " on" : ""}`}>
      <button type="button" className="sp-thumb" onClick={onToggle} aria-pressed={selected}
        aria-label={`${selected ? "Unselect" : "Select"} image ${index + 1}`}>
        <img src={option.image} alt={option.label} />
        {selected && <span className="sp-order">{order}</span>}
        {option.enhancing && <span className="sp-working"><span className="job-orb" aria-hidden="true" /> Enhancing…</span>}
      </button>
      <div className="sp-meta">
        <span className="muted-text">{option.label}{option.enhanced ? " · enhanced" : ""}</span>
        {aiImages && (
          <button type="button" className="small" onClick={() => setOpen(!open)} disabled={busy}>
            <Icon name="wand" size={14} /> Enhance
          </button>
        )}
      </div>
      {open && (
        <div className="sp-enhance">
          <div className="chips">
            {PRESETS.map(([key, label]) => (
              <button key={key} type="button" className={`chip${preset === key ? " on" : ""}`} disabled={busy}
                onClick={() => setPreset(preset === key ? "" : key)}>{label}</button>
            ))}
          </div>
          <input value={text} maxLength={1000} disabled={busy} onChange={(e) => setText(e.target.value)}
            placeholder="Or type anything, e.g. remove the text banner, warmer light" />
          <div className="actions">
            <button type="button" className="small primary" disabled={busy || (!preset && !text.trim())}
              onClick={() => { onEnhance(preset, text); setOpen(false); }}>Apply</button>
            {option.original && <button type="button" className="small" disabled={busy} onClick={() => onEnhance(null)}>Undo</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SitePost({ me, refreshMe }) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState("trending");
  const [direction, setDirection] = useState("");
  const [followLinks, setFollowLinks] = useState(false);
  const [site, setSite] = useState(null);
  const [shotPlan, setShotPlan] = useState(null);
  const [options, setOptions] = useState([]);
  const [chosen, setChosen] = useState([]);
  const [round, setRound] = useState(0);
  const [captions, setCaptions] = useState({ linkedin: "", facebook: "", instagram: "" });
  const [hashtags, setHashtags] = useState([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [usageRuns, setUsageRuns] = useState([]);
  const [linkOn, setLinkOn] = useState(true);
  const [link, setLink] = useState("");
  const configured = PLATFORMS.filter((p) => me.platforms[p.key].configured).map((p) => p.key);
  const [platforms, setPlatforms] = useState(configured);
  const [results, setResults] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [copied, setCopied] = useState(false);
  const steps = useJobSteps(busy === "read", 3, 8);

  async function run(label, action) {
    setBusy(label);
    setError(null);
    announceTask("/site-post", "running");
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
      announceTask("/site-post", "done");
    }
  }

  const addUsage = (usage) => usage && setUsageRuns((old) => [...old, usage]);

  const read = () => run("read", async () => {
    const data = await api("/api/sitepost/read", {
      method: "POST", json: { url: url.trim(), mode, direction, follow_links: followLinks },
    });
    addUsage(data.usage);
    setSite(data.site);
    setShotPlan(data.shot_plan ?? null);
    // The AI's screenshot posts first (drawn here from the page's screenshot), then the page's own images.
    const shots = await screenshotPosts(data.site, data.shot_plan, { mode }).catch(() => []);
    data.images = [...shots, ...await fitOptions(data.images)];
    setOptions(data.images);
    setChosen(data.images.length ? [data.images[0].id] : []);
    setRound(0);
    setCaptions(data.captions);
    setHashtags(data.hashtags);
    setTitle(data.title);
    setLink(data.site.url);
    setResults({});
    setWarnings([]);
  });

  const moreImages = () => run("images", async () => {
    const next = round + 1;
    // Other parts of the page's screenshot, and the page's own images in another order, fitted to 4:5 here in the browser.
    const own = site.images || [];
    const shots = await screenshotPosts(site, shotPlan, { mode, round: next, count: 2 }).catch(() => []);
    if (!own.length && !shots.length) return;
    const start = own.length ? (next * 2) % own.length : 0;
    const ordered = [...own.slice(start), ...own.slice(0, start)].slice(0, 5 - Math.min(shots.length, 2));
    const fitted = await fitOptions(ordered.map((image, i) => ({ id: `r${next}-${i}`, label: `Site image ${((start + i) % own.length) + 1}`, image, fit: true })));
    const data = { images: [...shots, ...fitted] };
    setRound(next);
    // Keep the chosen images; replace the rest with the new options.
    setOptions((old) => [...old.filter((o) => chosen.includes(o.id)), ...data.images.filter((o) => !chosen.includes(o.id))]);
  });

  const aiImage = () => run("ai", async () => {
    const data = await api("/api/sitepost/ai-image", { method: "POST", json: { site: siteForServer(site) } });
    addUsage(data.usage);
    const option = { id: `ai-${Date.now()}`, label: "AI image", image: data.image };
    setOptions((old) => [option, ...old]);
    setChosen((old) => (old.length < MAX_SELECTED ? [...old, option.id] : old));
  });

  const newCaptions = () => run("captions", async () => {
    const data = await api("/api/sitepost/captions", { method: "POST", json: { site: siteForServer(site), mode, direction } });
    addUsage(data.usage);
    setCaptions(data.captions);
    setHashtags(data.hashtags);
  });

  function toggle(id) {
    setChosen((old) => (old.includes(id) ? old.filter((x) => x !== id) : old.length < MAX_SELECTED ? [...old, id] : old));
  }

  async function enhance(id, preset, instruction) {
    const option = options.find((o) => o.id === id);
    if (preset === null) {
      setOptions((old) => old.map((o) => (o.id === id ? { ...o, image: o.original, original: undefined, enhanced: false } : o)));
      return;
    }
    setOptions((old) => old.map((o) => (o.id === id ? { ...o, enhancing: true } : o)));
    setError(null);
    try {
      const data = await api("/api/image/enhance", {
        method: "POST", json: { image: option.image, preset, instruction, aspect: "4:5" },
      });
      addUsage(data.usage);
      setOptions((old) => old.map((o) => (o.id === id
        ? { ...o, image: data.image, original: o.original ?? o.image, enhanced: true, enhancing: false } : o)));
    } catch (failure) {
      setError(failure);
      setOptions((old) => old.map((o) => (o.id === id ? { ...o, enhancing: false } : o)));
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
    try { localStorage.removeItem(JOB_KEY); } catch { /* storage off */ }
  }

  const publish = () => run("publish", async () => {
    const targets = platforms.filter((p) => configured.includes(p) && !results[p]?.ok);
    // Images are stored first (in pieces), so the post request stays small.
    const images = await uploadDataUrls(chosen.map((id) => options.find((o) => o.id === id)?.image).filter(Boolean));
    const data = await api("/api/sitepost/publish", {
      method: "POST",
      json: {
        images, platforms: targets, captions, title: title || site?.title, link: linkValue(linkOn, link),
        usage_ids: usageRuns.filter(Boolean).map((u) => u.id),
      },
    });
    try { localStorage.setItem(JOB_KEY, data.id); } catch { /* storage off */ }
    await follow(data.id);
    refreshMe();
  });

  // After a reload, keep following a post that was still publishing.
  useEffect(() => {
    let id = null;
    try { id = localStorage.getItem(JOB_KEY); } catch { id = null; }
    if (id) follow(id).catch(() => { try { localStorage.removeItem(JOB_KEY); } catch { /* storage off */ } });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = !me.services.gemini ? "Site to Post needs the Gemini key on this server. Ask your administrator."
    : !me.services.image_uploads ? "Image uploads aren't set up on this server yet."
      : !/^https?:\/\/\S+\.\S+/.test(url.trim()) ? "Enter the page's address, starting with https://." : null;
  const toPost = platforms.filter((p) => configured.includes(p) && !results[p]?.ok);
  const publishing = busy === "publish";
  const anyEnhancing = options.some((o) => o.enhancing);
  const pending = Object.values(results).some((r) => r.pending);

  return (
    <section className="content" style={{ padding: 0 }}>
      <PageHeader
        eyebrow="Site to Post"
        title="Turn any page into an image post"
        lead="Paste a page. AI reads it, takes a screenshot, writes long captions for each platform and turns the best parts of the page into finished post images, next to the page's own pictures. Pick one or several, enhance them, and post them together."
      />
      {Object.keys(results).length > 0 && !site && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2>{pending ? "Your last post is still publishing" : "Your last post"}</h2>
          <div className="history-platform-row">
            {Object.entries(results).map(([key, r]) => (
              <span key={key} className="history-platform"><StatusBadge result={r} /> {PLATFORMS.find((p) => p.key === key)?.label}</span>
            ))}
          </div>
          <p className="field-note">It's also in History.</p>
        </div>
      )}
      <div style={{ display: "grid", gap: "1.1rem" }}>
        <div className="card">
          <h2><span className="step-num">1</span>The page</h2>
          <label htmlFor="sp-url">Page address</label>
          <input id="sp-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article/123"
            onKeyDown={(e) => e.key === "Enter" && !blocked && !busy && read()} />
          <label>Style</label>
          <div className="segmented" role="radiogroup" aria-label="Style">
            {Object.entries(MODES).map(([key, [label]]) => (
              <button key={key} role="radio" aria-checked={mode === key} className={mode === key ? "on" : ""}
                onClick={() => setMode(key)} disabled={Boolean(busy)}>{label}</button>
            ))}
          </div>
          <p className="field-note">{MODES[mode][1]}</p>
          <label className="check" style={{ marginTop: "0.6rem" }}>
            <input type="checkbox" checked={followLinks} disabled={Boolean(busy)} onChange={(e) => setFollowLinks(e.target.checked)} />
            Also read up to two linked pages on the same site
          </label>
          <label htmlFor="sp-direction">Direction (optional)</label>
          <textarea id="sp-direction" rows={2} maxLength={1000} value={direction} onChange={(e) => setDirection(e.target.value)}
            placeholder="e.g. Promote the free demo to school principals. Mention WhatsApp fee reminders." />
          <ErrorNote error={!site ? error : null} />
          {blocked && url && <p className="muted-text">{blocked}</p>}
          <div className="actions">
            <button className="accent" onClick={read} disabled={Boolean(busy) || Boolean(blocked)}>
              <Icon name="sparkles" /> {busy === "read" ? "Reading the page…" : site ? "Start over from this page" : "Create post"}
            </button>
          </div>
          {busy === "read" && (
            <JobCard title="Creating your post" steps={["Opening and photographing the page", "Writing the captions", "Designing the images"]}
              active={steps.active} startedAt={steps.startedAt} typical="Usually 20–45 seconds" />
          )}
        </div>

        {site && (
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}><span className="step-num">2</span>Choose images</h2>
              <span className="badge brand">{chosen.length} selected</span>
            </div>
            <p className="muted-text">
              Click to select. Pick several to post them together (a carousel on Instagram, an album on Facebook, a
              multi-image post on LinkedIn), in the order you pick them. Up to {MAX_SELECTED}.
            </p>
            <div className="sp-grid">
              {options.map((option, index) => (
                <ImageOption key={option.id} option={option} index={index} busy={publishing || option.enhancing}
                  selected={chosen.includes(option.id)} order={chosen.indexOf(option.id) + 1}
                  onToggle={() => toggle(option.id)} onEnhance={(preset, text) => enhance(option.id, preset, text)} aiImages={me.services.ai_images} />
              ))}
            </div>
            <div className="actions">
              <button onClick={moreImages} disabled={Boolean(busy)}>
                <Icon name="plus" /> {busy === "images" ? "Finding more…" : "Regenerate images"}
              </button>
              {me.services.ai_images && (
                <button onClick={aiImage} disabled={Boolean(busy)}>
                  <Icon name="sparkles" /> {busy === "ai" ? "Creating… (up to a minute)" : "Add an AI image"}
                </button>
              )}
              <label className="button">
                <Icon name="upload" /> Add your own image
                <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={Boolean(busy)} onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = async () => {
                    const [option] = await fitOptions([{ id: `own-${Date.now()}`, label: "Your image", image: reader.result, fit: true }]);
                    setOptions((old) => [option, ...old]);
                    setChosen((old) => (old.length < MAX_SELECTED ? [...old, option.id] : old));
                  };
                  reader.readAsDataURL(file);
                }} />
              </label>
            </div>
            <p className="field-note">
              Screenshot posts show the real page under an AI headline, in the brand colour. Regenerate shows other
              parts of the page (the images you selected stay). Enhance edits one image with AI: remove pop-ups,
              professional, cinematic, or anything you type.
            </p>
          </div>
        )}

        {site && (
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}><span className="step-num">3</span>Captions and posting</h2>
              <button className="small" onClick={newCaptions} disabled={Boolean(busy)}>
                <Icon name="wand" size={14} /> {busy === "captions" ? "Writing…" : "Regenerate captions"}
              </button>
            </div>
            {configured.length === 0 && (
              <p className="note note-warn">No accounts are connected. <Link to="/settings">Connect them in Settings</Link>.</p>
            )}
            <fieldset>
              <legend>Post to</legend>
              <div className="checks">
                {PLATFORMS.map((p) => (
                  <label key={p.key} className={configured.includes(p.key) ? "check" : "check disabled"}>
                    <input type="checkbox" disabled={!configured.includes(p.key) || results[p.key]?.ok} checked={platforms.includes(p.key)}
                      onChange={() => setPlatforms(platforms.includes(p.key) ? platforms.filter((k) => k !== p.key) : [...platforms, p.key])} />
                    <span className={`platform-dot ${p.key}`} />{p.label}
                  </label>
                ))}
              </div>
            </fieldset>
            {PLATFORMS.filter((p) => platforms.includes(p.key)).map((p) => (
              <div key={p.key}>
                <div className="draft-head" style={{ marginTop: "0.8rem" }}>
                  <label htmlFor={`sp-cap-${p.key}`}><span className={`platform-dot ${p.key}`} />{p.label} caption</label>
                  <span className={captions[p.key].length > p.limit ? "count over" : "count"}>{captions[p.key].length} / {p.limit}</span>
                </div>
                <textarea id={`sp-cap-${p.key}`} rows={8} value={captions[p.key]} disabled={results[p.key]?.ok}
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
            {hashtags.length > 0 && (
              <div style={{ marginTop: "0.9rem" }}>
                <div className="draft-head">
                  <label>Suggested hashtags</label>
                  <button type="button" className="small" onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(hashtags.join(" "));
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch { /* clipboard blocked */ }
                  }}>{copied ? "Copied" : "Copy all"}</button>
                </div>
                <div className="chips">{hashtags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</div>
              </div>
            )}
            <LinkField id="sp-link" on={linkOn} onToggle={setLinkOn} url={link} onUrl={setLink} disabled={publishing} />
            <ErrorNote error={site ? error : null} />
            {warnings.map((w) => <p className="warn-text" key={w}>{w}</p>)}
            <div className="actions">
              <button className="accent" onClick={publish}
                disabled={Boolean(busy) || anyEnhancing || chosen.length === 0 || toPost.length === 0
                  || toPost.some((k) => !captions[k].trim() || captions[k].length > PLATFORMS.find((p) => p.key === k).limit)}>
                <Icon name="send" /> {publishing ? "Posting… (Instagram can take a minute)"
                  : `Post ${chosen.length} image${chosen.length === 1 ? "" : "s"} to ${toPost.length} platform${toPost.length === 1 ? "" : "s"}`}
              </button>
            </div>
            <p className="field-note">
              {publishing ? "You can leave or reload this page: publishing carries on, and the post is already in History."
                : "Each platform is tried once. The post goes live as soon as you click."}
            </p>
          </div>
        )}
        <CostCard runs={usageRuns} title="AI cost for this post" />
      </div>
    </section>
  );
}
