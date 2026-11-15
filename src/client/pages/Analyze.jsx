import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { Link } from "../router.jsx";
import { CostCard, ErrorNote, JobCard, LinkField, PLATFORMS, StatusBadge, announceTask, labelOf, linkValue, useJobSteps } from "../shared.jsx";
import { Icon, PageHeader, ScoreRing } from "../ui.jsx";

const GOALS = ["Engagement and reach", "Followers", "Website clicks", "Brand awareness", "Event sign-ups"];
// Upload links last an hour, so an older upload is sent again before posting.
const LINK_MINUTES = 50;

function scoreLabel(score) {
  if (score >= 80) return ["Strong", "good"];
  if (score >= 60) return ["Good start", "brand"];
  if (score >= 40) return ["Needs work", "warn"];
  return ["Weak", "bad"];
}

export default function Analyze({ me, refreshMe }) {
  const configured = PLATFORMS.filter((p) => me.platforms[p.key].configured).map((p) => p.key);
  const [draft, setDraft] = useState("");
  const [goal, setGoal] = useState(GOALS[0]);
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [selected, setSelected] = useState(configured.length ? configured : ["linkedin"]);
  const [imageUrl, setImageUrl] = useState("");
  const [linkOn, setLinkOn] = useState(false);
  const [link, setLink] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [uploaded, setUploaded] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [posts, setPosts] = useState({});
  const [results, setResults] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [usageRuns, setUsageRuns] = useState([]);
  const [analyzedLine, setAnalyzedLine] = useState("");

  const filePreview = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : null), [imageFile]);
  useEffect(() => () => filePreview && URL.revokeObjectURL(filePreview), [filePreview]);
  const hasImage = Boolean(imageFile || imageUrl.trim());

  function toggle(key) {
    setSelected(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  async function run(label, action) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  async function ensureUpload() {
    if (!imageFile) return null;
    if (uploaded && uploaded.file === imageFile && Date.now() - uploaded.at < LINK_MINUTES * 60_000) return uploaded;
    const form = new FormData();
    form.append("file", imageFile);
    const data = await api("/api/image", { method: "POST", form });
    const fresh = { ...data, file: imageFile, at: Date.now() };
    setUploaded(fresh);
    return fresh;
  }

  const jobSteps = [
    ...(imageFile && !uploaded ? ["Uploading your image"] : []),
    hasImage ? "Reading your draft and image" : "Reading your draft",
    "Scoring it for your goal",
    `Rewriting for ${selected.map(labelOf).join(", ")}`,
    "Finding hooks and hashtags",
  ];
  const job = useJobSteps(busy === "analyze", jobSteps.length, 7);

  const analyze = () =>
    run("analyze", async () => {
      announceTask("/analyze", "running");
      try {
        await runAnalysis();
      } finally {
        announceTask("/analyze", "done");
      }
    });

  async function runAnalysis() {
    const image = await ensureUpload();
    const data = await api("/api/analyze", {
      method: "POST",
      json: {
        draft, goal, audience, tone, platforms: selected,
        image_key: image?.key, image_url: image ? undefined : imageUrl.trim() || undefined,
      },
    });
    setAnalysis(data);
    setPosts(data.posts);
    setResults({});
    setWarnings([]);
    // Re-analysing the same post adds to its cost; a different first line starts a new post.
    const firstLine = draft.trim().split("\n")[0];
    setUsageRuns((old) => (firstLine === analyzedLine ? [...old, data.usage] : [data.usage]));
    setAnalyzedLine(firstLine);
  }

  async function publish(keys) {
    const image = await ensureUpload();
    const chosen = Object.fromEntries(keys.map((key) => [key, posts[key]]));
    const data = await api("/api/publish", {
      method: "POST",
      json: {
        topic: draft.trim().split("\n")[0].slice(0, 120),
        posts: chosen,
        image_url: image?.url || imageUrl.trim() || undefined,
        image_key: image?.key,
        link: linkValue(linkOn, link),
        usage_ids: usageRuns.filter(Boolean).map((u) => u.id),
      },
    });
    setResults((old) => ({ ...old, ...Object.fromEntries(data.results.map((r) => [r.platform, r])) }));
    setWarnings(data.warnings ?? []);
    refreshMe();
  }

  const postKeys = Object.keys(posts);
  const ready = (key) =>
    configured.includes(key) && !results[key]?.ok && posts[key]?.trim() &&
    posts[key].length <= PLATFORMS.find((p) => p.key === key).limit && (key !== "instagram" || hasImage);
  const readyKeys = postKeys.filter(ready);

  function useHook(hook) {
    setPosts(Object.fromEntries(Object.entries(posts).map(([key, text]) => {
      const lines = text.split("\n");
      lines[0] = hook;
      return [key, lines.join("\n")];
    })));
  }

  function addTag(tag) {
    setPosts(Object.fromEntries(Object.entries(posts).map(([key, text]) =>
      [key, text.includes(tag) ? text : `${text.trimEnd()} ${tag}`])));
  }

  const blocked = !me.services.gemini
    ? "Post analysis isn't set up on this server yet. Ask your administrator to add the Gemini key."
    : !draft.trim() ? "Write or paste a draft to analyse." : selected.length === 0 ? "Choose at least one platform." : null;

  const [label, tone_] = analysis ? scoreLabel(analysis.score) : [];

  return (
    <section className="content" style={{ padding: 0 }}>
      <PageHeader
        eyebrow="Analyze & Post"
        title="Score your post, then publish it"
        lead="Paste a draft and add an image if you have one. AI scores it, explains what to fix, rewrites it for each platform, and you post straight from here."
      />
      <div className="analyze-grid">
        <div className="card">
          <h2>Your draft</h2>
          <label htmlFor="an-draft">Post text</label>
          <textarea id="an-draft" rows={9} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste or write the post you want to improve…" maxLength={5000} />
          <p className="field-note">{draft.length} / 5,000 characters</p>

          <label htmlFor="an-goal">Goal</label>
          <select id="an-goal" value={goal} onChange={(e) => setGoal(e.target.value)}>
            {GOALS.map((g) => <option key={g}>{g}</option>)}
          </select>
          <div className="two-col">
            <div>
              <label htmlFor="an-audience">Audience</label>
              <input id="an-audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder={me.defaults.audience} />
            </div>
            <div>
              <label htmlFor="an-tone">Tone</label>
              <input id="an-tone" value={tone} onChange={(e) => setTone(e.target.value)} placeholder={me.defaults.tone} />
            </div>
          </div>

          <fieldset>
            <legend>Rewrite for</legend>
            <div className="checks">
              {PLATFORMS.map((p) => (
                <label key={p.key} className="check">
                  <input type="checkbox" checked={selected.includes(p.key)} onChange={() => toggle(p.key)} />
                  <span className={`platform-dot ${p.key}`} />{p.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label htmlFor="an-file">Image (optional, needed for Instagram)</label>
          <div className="dropzone">
            <Icon name="upload" size={22} />
            <span>{me.services.image_uploads ? "Upload a photo so AI can check text and image together" : "Image uploads aren't set up on this server. Use an image URL."}</span>
            <input id="an-file" type="file" accept="image/*" disabled={!me.services.image_uploads || Boolean(imageUrl.trim())}
              onChange={(e) => { setImageFile(e.target.files?.[0] ?? null); setUploaded(null); }} />
          </div>
          <label htmlFor="an-url">Or image URL</label>
          <input id="an-url" type="url" value={imageUrl} disabled={Boolean(imageFile)} onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://example.com/photo.jpg" />
          {(filePreview || imageUrl.trim().startsWith("https://")) && (
            <img className="image-preview" src={filePreview || imageUrl.trim()} alt="Selected" />
          )}

          <ErrorNote error={!analysis ? error : null} />
          {blocked && <p className="muted-text" style={{ marginTop: "0.9rem" }}>{blocked}</p>}
          <div className="actions">
            <button className="accent" onClick={analyze} disabled={Boolean(busy) || Boolean(blocked)}>
              <Icon name="sparkles" /> {busy === "analyze" ? "Analysing…" : analysis ? "Analyse again" : "Analyse post"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: "1.1rem" }}>
          {busy === "analyze" && (
            <JobCard title={analysis ? "Re-analysing your post" : "Analysing your post"} steps={jobSteps}
              active={job.active} startedAt={job.startedAt || Date.now()} />
          )}

          {!analysis && busy !== "analyze" && (
            <div className="card glow">
              <p className="eyebrow">How it works</p>
              <h2 style={{ marginTop: "0.4rem" }}>From draft to published in three steps</h2>
              <ol className="muted-text" style={{ paddingLeft: "1.1rem", marginBottom: 0 }}>
                <li>Paste your draft and choose the platforms.</li>
                <li>Get a score, strengths, fixes, new hooks and hashtags, plus a rewrite for each platform.</li>
                <li>Edit if you like, then post to one platform or all of them.</li>
              </ol>
              {configured.length === 0 && (
                <p className="note note-warn">No accounts are connected yet. You can analyse posts now and <Link to="/settings">connect accounts in Settings</Link> to publish.</p>
              )}
            </div>
          )}

          {analysis && (
            <div className={busy === "analyze" ? "is-stale" : undefined} style={{ display: "grid", gap: "1.1rem" }}>
              <div className="card score-card">
                <ScoreRing score={analysis.score} />
                <div style={{ flex: "1 1 240px" }}>
                  <span className={`badge ${tone_}`}>{label}</span>
                  <h2 style={{ marginTop: "0.5rem" }}>{analysis.verdict || "Here's how your draft scores."}</h2>
                  <p className="muted-text">Scored for {goal.toLowerCase()}. The rewrites below aim higher.</p>
                </div>
              </div>

              <CostCard runs={usageRuns} />

              <div className="insights">
                <div className="card flat">
                  <p className="eyebrow">What works</p>
                  <ul>{analysis.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
                </div>
                <div className="card flat">
                  <p className="eyebrow">What to improve</p>
                  <ul>{analysis.improvements.map((s) => <li key={s}>{s}</li>)}</ul>
                </div>
              </div>

              {(analysis.hooks.length > 0 || analysis.hashtags.length > 0) && (
                <div className="card flat">
                  {analysis.hooks.length > 0 && (
                    <>
                      <p className="eyebrow">Alternative hooks: click one to use it as the first line</p>
                      <div className="chips">
                        {analysis.hooks.map((h) => <button key={h} className="chip hook" onClick={() => useHook(h)}>{h}</button>)}
                      </div>
                    </>
                  )}
                  {analysis.hashtags.length > 0 && (
                    <>
                      <p className="eyebrow" style={{ marginTop: "0.9rem" }}>Hashtags: click to add</p>
                      <div className="chips">
                        {analysis.hashtags.map((t) => <button key={t} className="chip" onClick={() => addTag(t)}>{t}</button>)}
                      </div>
                    </>
                  )}
                </div>
              )}

              {postKeys.map((key) => {
                const platform = PLATFORMS.find((p) => p.key === key);
                const text = posts[key] ?? "";
                const result = results[key];
                const notReady = !configured.includes(key)
                  ? "Not connected."
                  : key === "instagram" && !hasImage ? "Instagram needs an image." : null;
                return (
                  <div className="card post-card" key={key}>
                    <div className="draft-head">
                      <label htmlFor={`an-post-${key}`}><span className={`platform-dot ${key}`} />{platform.label}</label>
                      <span className={text.length > platform.limit ? "count over" : "count"}>{text.length} / {platform.limit}</span>
                    </div>
                    <textarea id={`an-post-${key}`} rows={9} value={text} disabled={result?.ok}
                      onChange={(e) => setPosts({ ...posts, [key]: e.target.value })} />
                    <div className="post-actions">
                      {result?.ok ? (
                        <>
                          <StatusBadge result={result} />
                          {result.url?.startsWith("https://") && <a href={result.url} target="_blank" rel="noreferrer">View post</a>}
                        </>
                      ) : (
                        <button className="primary" disabled={Boolean(busy) || !ready(key)}
                          onClick={() => run(`post-${key}`, () => publish([key]))}>
                          <Icon name="send" /> {busy === `post-${key}` ? "Posting…" : `Post to ${platform.label}`}
                        </button>
                      )}
                      {result && !result.ok && <StatusBadge result={result} />}
                      {notReady && !result?.ok && (
                        <span className="muted-text">{notReady}{!configured.includes(key) && <> <Link to="/settings">Connect it</Link>.</>}</span>
                      )}
                    </div>
                    {result?.error && <p className="hint">{result.error}{result.hint ? ` ${result.hint}` : ""}</p>}
                    {key === "linkedin" && hasImage && <p className="field-note">LinkedIn posts are text-only, so the image won't appear there.</p>}
                  </div>
                );
              })}

              <LinkField id="analyze-link" on={linkOn} onToggle={setLinkOn} url={link} onUrl={setLink} disabled={Boolean(busy)} />
              <ErrorNote error={error} />
              {warnings.map((w) => <p className="warn-text" key={w}>{w}</p>)}
              <div className="actions" style={{ marginTop: 0 }}>
                <button className="accent" disabled={Boolean(busy) || readyKeys.length < 2}
                  onClick={() => run("post-all", () => publish(readyKeys))}>
                  <Icon name="send" /> {busy === "post-all" ? "Posting…" : `Post to all ${readyKeys.length} ready platforms`}
                </button>
                <span className="muted-text">Each post goes live as soon as you click.</span>
              </div>
              {Object.keys(results).length > 0 && (
                <p className="muted-text">Results are also saved on the <Link to="/history">History</Link> page.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
