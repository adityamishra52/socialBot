import { useState } from "react";
import { api } from "../api.js";
import { Link } from "../router.jsx";
import { CostCard, ErrorNote, LinkField, PLATFORMS, StatusBadge, labelOf, linkValue } from "../shared.jsx";

export default function Compose({ me, refreshMe }) {
  const [topic, setTopic] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [selected, setSelected] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [draft, setDraft] = useState(null);
  const [results, setResults] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [usageRuns, setUsageRuns] = useState([]);
  const [linkOn, setLinkOn] = useState(false);
  const [link, setLink] = useState("");
  const [aiStyle, setAiStyle] = useState("photo");
  const [aiAspect, setAiAspect] = useState("1:1");
  const [aiDetails, setAiDetails] = useState("");
  const [aiImage, setAiImage] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);

  const configured = PLATFORMS.filter((p) => me.platforms[p.key].configured).map((p) => p.key);
  const chosen = (selected ?? configured).filter((key) => configured.includes(key));
  const hasImage = Boolean(imageUrl.trim() || imageFile);
  const toWrite = chosen.filter((key) => key !== "instagram" || hasImage);
  const nextTopic = me.next_topic?.topic;

  async function generateImage() {
    setAiBusy(true);
    setAiError(null);
    try {
      const data = await api("/api/image/generate", {
        method: "POST",
        json: { topic: topic.trim(), details: aiDetails, style: aiStyle, aspect: aiAspect },
      });
      if (data.usage) setUsageRuns((old) => [...old, data.usage]);
      const bytes = Uint8Array.from(atob(data.image), (c) => c.charCodeAt(0));
      const file = new File([bytes], `ai-image-${Date.now()}.jpg`, { type: data.mime });
      if (aiImage) URL.revokeObjectURL(aiImage);
      setAiImage(URL.createObjectURL(file));
      setImageUrl("");
      setImageFile(file);
    } catch (failure) {
      setAiError(failure);
    } finally {
      setAiBusy(false);
    }
  }

  function removeAiImage() {
    if (aiImage) URL.revokeObjectURL(aiImage);
    setAiImage(null);
    setImageFile(null);
  }

  function toggle(key) {
    setSelected(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]);
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

  const generate = () =>
    run("Writing posts…", async () => {
      const data = await api("/api/generate", {
        method: "POST",
        json: { topic, audience, tone, platforms: toWrite },
      });
      // Regenerating the same topic adds to that post's cost.
      setUsageRuns((old) => (draft?.topic === data.topic ? [...old, data.usage] : [data.usage]));
      setDraft(data);
      setResults(null);
      setPreview(null);
    });

  const overLimit = draft
    ? PLATFORMS.some((p) => draft.posts[p.key] !== undefined && (draft.posts[p.key].length > p.limit || !draft.posts[p.key].trim()))
    : false;

  const showRequests = () =>
    run("Loading requests…", async () => {
      const shownImage = imageFile ? "<temporary link to your image, created when you publish>" : imageUrl.trim();
      const data = await api("/api/preview", {
        method: "POST",
        json: { posts: draft.posts, image_url: shownImage },
      });
      setPreview(data.requests);
    });

  const publish = () =>
    run("Publishing…", async () => {
      let finalImage = imageUrl.trim();
      let imageKey;
      if (imageFile) {
        const form = new FormData();
        form.append("file", imageFile);
        const uploaded = await api("/api/image", { method: "POST", form });
        finalImage = uploaded.url;
        imageKey = uploaded.key;
      }
      const data = await api("/api/publish", {
        method: "POST",
        json: {
          topic: draft.topic,
          topic_index: draft.topic_index,
          posts: draft.posts,
          image_url: finalImage,
          image_key: imageKey,
          link: linkValue(linkOn, link),
          usage_ids: usageRuns.filter(Boolean).map((u) => u.id),
        },
      });
      setResults(data.results);
      setWarnings(data.warnings ?? []);
      setDraft(null);
      setPreview(null);
      setTopic("");
      setImageUrl("");
      setImageFile(null);
      refreshMe();
    });

  if (results) {
    return (
      <section className="card">
        <h1>Results</h1>
        <ul className="results">
          {results.map((r) => (
            <li key={r.platform}>
              <StatusBadge result={r} />
              <div>
                <strong>{labelOf(r.platform)}</strong>
                {r.ok && r.url?.startsWith("https://") && (
                  <p><a href={r.url} target="_blank" rel="noreferrer">View post</a></p>
                )}
                {r.ok && !r.url && <p>Published, but the platform didn't return a link.</p>}
                {r.error && <p>{r.error}</p>}
                {r.hint && <p className="hint">{r.hint}</p>}
              </div>
            </li>
          ))}
        </ul>
        {warnings.map((warning) => <p className="warn-text" key={warning}>{warning}</p>)}
        <CostCard runs={usageRuns} />
        <button className="primary" onClick={() => { setResults(null); setUsageRuns([]); }}>Write another post</button>
      </section>
    );
  }

  if (draft) {
    const count = Object.keys(draft.posts).length;
    return (
      <section>
        <div className="section-head">
          <div>
            <p className="eyebrow">Review before publishing</p>
            <h1>{draft.topic}</h1>
          </div>
          <button onClick={() => setDraft(null)} disabled={Boolean(busy)}>Back</button>
        </div>
        <div className="drafts">
          {PLATFORMS.filter((p) => draft.posts[p.key] !== undefined).map((p) => {
            const length = draft.posts[p.key].length;
            return (
              <div className="card" key={p.key}>
                <div className="draft-head">
                  <label htmlFor={`draft-${p.key}`}>{p.label}</label>
                  <span className={length > p.limit ? "count over" : "count"}>{length} / {p.limit}</span>
                </div>
                <textarea
                  id={`draft-${p.key}`}
                  rows={12}
                  value={draft.posts[p.key]}
                  onChange={(e) => setDraft({ ...draft, posts: { ...draft.posts, [p.key]: e.target.value } })}
                />
              </div>
            );
          })}
        </div>
        <div className="card" style={{ marginTop: "1rem" }}>
          <LinkField id="compose-link" on={linkOn} onToggle={setLinkOn} url={link} onUrl={setLink} disabled={Boolean(busy)} />
        </div>
        <div style={{ marginTop: "1rem" }}><CostCard runs={usageRuns} /></div>
        {draft.posts.linkedin !== undefined && hasImage && (
          <p className="muted-text">LinkedIn posts are text-only, so the image won't appear there.</p>
        )}
        <ErrorNote error={error} />
        <div className="actions">
          <button className="primary" onClick={publish} disabled={Boolean(busy) || overLimit}>
            {busy === "Publishing…" ? busy : `Publish to ${count} ${count === 1 ? "platform" : "platforms"}`}
          </button>
          <button onClick={generate} disabled={Boolean(busy)}>
            {busy === "Writing posts…" ? busy : "Regenerate"}
          </button>
          <button onClick={showRequests} disabled={Boolean(busy)}>Show exact requests</button>
        </div>
        {preview && (
          <div className="card requests">
            <h2>Requests that will be sent</h2>
            {preview.map((item, index) => (
              <div key={index}>
                <p className="eyebrow">{labelOf(item.platform)}</p>
                <pre>{item.request}</pre>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  if (configured.length === 0) {
    return (
      <section className="card compose">
        <h1>New post</h1>
        <p>Connect at least one account to start posting.</p>
        <Link to="/settings" className="button primary">Go to Settings</Link>
      </section>
    );
  }

  const blockedReason = !me.services.gemini
    ? "Post writing isn't set up on this server yet. Ask your administrator to add the Gemini key."
    : toWrite.length === 0
      ? "Choose at least one platform. Instagram also needs an image."
      : !topic.trim() && !nextTopic
        ? "Enter a topic, or add some on the Topics page."
        : null;

  return (
    <section className="card compose">
      <h1>New post</h1>
      <label htmlFor="topic">Topic</label>
      <textarea
        id="topic"
        rows={2}
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder={nextTopic ? `Leave blank to use the next topic: ${nextTopic}` : "What should the posts be about?"}
      />
      <div className="two-col">
        <div>
          <label htmlFor="audience">Audience</label>
          <input id="audience" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder={me.defaults.audience} />
        </div>
        <div>
          <label htmlFor="tone">Tone</label>
          <input id="tone" value={tone} onChange={(e) => setTone(e.target.value)} placeholder={me.defaults.tone} />
        </div>
      </div>

      <fieldset>
        <legend>Platforms</legend>
        <div className="checks">
          {PLATFORMS.map((p) => {
            const ready = me.platforms[p.key].configured;
            return (
              <label key={p.key} className={ready ? "check" : "check disabled"}>
                <input type="checkbox" checked={chosen.includes(p.key)} disabled={!ready} onChange={() => toggle(p.key)} />
                {p.label}
                {!ready && <span className="muted-text"> (not connected)</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="two-col">
        <div>
          <label htmlFor="image-url">Image URL</label>
          <input
            id="image-url"
            type="url"
            value={imageUrl}
            disabled={Boolean(imageFile)}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://example.com/photo.jpg"
          />
        </div>
        <div>
          <label htmlFor="image-file">Or upload an image</label>
          <input
            id="image-file"
            type="file"
            accept="image/*"
            disabled={Boolean(imageUrl.trim()) || !me.services.image_uploads || Boolean(aiImage)}
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </div>
      {me.services.ai_images && (<div className="ai-image card-inset">
        <label>Or create an image with AI</label>
        <div className="two-col">
          <select aria-label="Image style" value={aiStyle} onChange={(e) => setAiStyle(e.target.value)} disabled={aiBusy}>
            <option value="photo">Real photo look</option>
            <option value="illustration">Illustration</option>
            <option value="3d">3D render</option>
          </select>
          <select aria-label="Image shape" value={aiAspect} onChange={(e) => setAiAspect(e.target.value)} disabled={aiBusy}>
            <option value="1:1">Square (all platforms)</option>
            <option value="4:5">Portrait 4:5 (Instagram, Facebook)</option>
            <option value="16:9">Landscape 16:9 (LinkedIn, Facebook)</option>
          </select>
        </div>
        <input value={aiDetails} maxLength={1500} onChange={(e) => setAiDetails(e.target.value)} disabled={aiBusy}
          placeholder="Optional details, e.g. a young researcher in a modern lab, warm morning light" />
        <div className="actions">
          <button type="button" onClick={generateImage}
            disabled={aiBusy || !me.services.gemini || !me.services.image_uploads || Boolean(imageUrl.trim()) || !(topic.trim() || nextTopic)}>
            {aiBusy ? "Creating image… (up to a minute)" : aiImage ? "Make another" : "Generate image"}
          </button>
          {aiImage && <button type="button" onClick={removeAiImage} disabled={aiBusy}>Remove image</button>}
        </div>
        <p className="field-note">
          AI draws a new, realistic image for your topic. It is used for Facebook and Instagram and stored only when you publish.
        </p>
        <ErrorNote error={aiError} />
        {aiImage && <img className="ai-image-preview" src={aiImage} alt="AI-generated image for this post" />}
      </div>)}
      {!me.services.image_uploads && (
        <p className="muted-text">Image uploads aren't set up on this server yet. You can use an image URL.</p>
      )}
      {chosen.includes("instagram") && !hasImage && (
        <p className="muted-text">Instagram needs an image, so it will be skipped unless you add one.</p>
      )}
      <ErrorNote error={error} />
      {blockedReason && <p className="muted-text">{blockedReason}</p>}
      <button className="primary" onClick={generate} disabled={Boolean(busy) || Boolean(blockedReason)}>
        {busy || "Write posts"}
      </button>
    </section>
  );
}
