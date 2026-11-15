import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Link } from "../router.jsx";
import { EMAIL_OPEN_KEY, ErrorNote, SuccessNote } from "../shared.jsx";
import { Icon, PageHeader } from "../ui.jsx";

const ACCENTS = {
  cyan: ["#06B6D4", "#8B5CF6"],
  violet: ["#8B5CF6", "#F97316"],
  coral: ["#F97316", "#8B5CF6"],
  ink: ["#0E1117", "#155E75"],
};
const MAX_FIGURES = 6;
const POLL_MS = 3000;
const ACTIVE_STATUSES = ["queued", "sending"];
const STATUS_BADGE = {
  queued: ["Queued", "brand"], sending: ["Sending", "brand"], paused: ["Paused", "warn"],
  cancelled: ["Cancelled", "muted"], done: ["Finished", "good"],
};

function blankContent(kind) {
  return {
    kind, subject: "", preheader: "", journal: "", issue: "", heading: kind === "toc" ? "In this issue" : "",
    eyebrow: "", headline: "", subheadline: "", greeting: "Dear {{name}},", intro: "", body: [], highlights: [],
    sections: kind === "toc" ? [{ title: "In this issue", articles: [] }] : [],
    cta_text: "", cta_url: "", closing: "", accent: "cyan", layout: "one", figures: [],
  };
}

// A textarea with Bold, Italic and Link buttons. Formatting is stored as **bold**, *italic* and
// [text](https://link), which the server turns into safe HTML; raw HTML is never sent.
function RichField({ id, label, value, onChange, rows = 3, maxLength }) {
  const ref = useRef(null);
  function wrap(before, after, placeholder) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const chosen = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + chosen + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + chosen.length);
    });
  }
  function link() {
    const url = window.prompt("Link address (https://…)", "https://");
    if (!url) return;
    if (!/^https?:\/\/\S+$/.test(url.trim())) {
      window.alert("The link must start with https:// or http://.");
      return;
    }
    wrap("[", `](${url.trim()})`, "link text");
  }
  return (
    <>
      <div className="row" style={{ marginBottom: 0, alignItems: "end" }}>
        <label htmlFor={id}>{label}</label>
        <span className="format-bar" role="toolbar" aria-label={`Format ${label}`}>
          <button type="button" className="small" title="Bold" aria-label="Bold" onClick={() => wrap("**", "**", "bold text")}><strong>B</strong></button>
          <button type="button" className="small" title="Italic" aria-label="Italic" onClick={() => wrap("*", "*", "italic text")}><em>I</em></button>
          <button type="button" className="small" title="Add a link" aria-label="Add a link" onClick={link}><Icon name="link" size={14} /> Link</button>
        </span>
      </div>
      <textarea id={id} ref={ref} rows={rows} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

const blankArticle = () => ({ title: "", authors: "", doi: "", url: "", pages: "" });

function useBusy() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  async function run(label, action) {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError(failure);
      return undefined;
    } finally {
      setBusy("");
    }
  }
  return { busy, error, setError, run };
}

export default function EmailStudio({ me, active }) {
  const [tab, setTab] = useState("design");
  const [content, setContent] = useState(null);
  const [templateId, setTemplateId] = useState(null);
  const [templateName, setTemplateName] = useState("");
  const [openRequest, setOpenRequest] = useState(null);

  // History can ask to open a saved template or the Send tab.
  useEffect(() => {
    if (!active) return;
    const raw = sessionStorage.getItem(EMAIL_OPEN_KEY);
    if (!raw) return;
    sessionStorage.removeItem(EMAIL_OPEN_KEY);
    try {
      const request = JSON.parse(raw);
      setTab(request.tab === "send" ? "send" : "design");
      if (request.template) setOpenRequest(request.template);
    } catch { /* ignore a bad value */ }
  }, [active]);

  return (
    <section className="content" style={{ padding: 0 }}>
      <PageHeader
        eyebrow="Email Studio"
        title="Email templates and bulk sending"
        lead="Create journal table-of-contents and banner emails with AI, add figures, preview them live, and send them to a list."
        action={
          <div className="segmented" role="tablist" aria-label="Email Studio sections">
            <button role="tab" aria-selected={tab === "design"} className={tab === "design" ? "on" : ""} onClick={() => setTab("design")}>
              <span className="step-num">1</span>Design
            </button>
            <button role="tab" aria-selected={tab === "send"} className={tab === "send" ? "on" : ""} onClick={() => setTab("send")}>
              <span className="step-num">2</span>Send
            </button>
          </div>
        }
      />
      <div hidden={tab !== "design"}>
        <DesignTab me={me} content={content} setContent={setContent} templateId={templateId} setTemplateId={setTemplateId}
          templateName={templateName} setTemplateName={setTemplateName} onNext={() => setTab("send")}
          openRequest={openRequest} clearOpenRequest={() => setOpenRequest(null)} />
      </div>
      <div hidden={tab !== "send"}>
        <SendTab active={active && tab === "send"} content={content} templateName={templateName} goDesign={() => setTab("design")} />
      </div>
    </section>
  );
}

// --- Design tab ---

function DesignTab({ me, content, setContent, templateId, setTemplateId, templateName, setTemplateName, onNext, openRequest, clearOpenRequest }) {
  const [kind, setKind] = useState("toc");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("text");
  const [sourceText, setSourceText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [parsed, setParsed] = useState(null);
  const [issue, setIssue] = useState(null);
  const [previews, setPreviews] = useState({});
  const [notice, setNotice] = useState("");
  const { busy, error, run } = useBusy();

  const gemini = me.services.gemini;
  const uploads = me.services.image_uploads;

  function update(fields) {
    setContent((old) => ({ ...old, ...fields }));
  }

  const blocked = !gemini
    ? "AI writing isn't set up on this server. Start from a blank template instead."
    : kind === "banner" && !description.trim() ? "Describe what the banner is for."
    : kind === "toc" && source === "text" && !sourceText.trim() && !description.trim() ? "Paste the table of contents or describe the issue."
    : kind === "toc" && source === "issue" && !sourceUrl.trim().startsWith("http") ? "Enter the journal issue's web address."
    : kind === "toc" && source === "file" && !parsed?.length ? "Upload a CSV or Excel file of articles."
    : null;

  async function parseFile(file) {
    setParsed(null);
    if (!file) return;
    await run("parse", async () => {
      const form = new FormData();
      form.append("file", file);
      const data = await api("/api/email/articles/parse", { method: "POST", form });
      setParsed(data.articles);
    });
  }

  const generate = () =>
    run("generate", async () => {
      const data = await api("/api/email/generate", {
        method: "POST",
        json: {
          kind, description, source,
          text: source === "text" ? sourceText : undefined,
          url: source === "issue" ? sourceUrl.trim() : undefined,
          articles: source === "file" ? parsed : undefined,
        },
      });
      const found = data.content.figures ?? [];
      if (data.issue?.cover) {
        const coverKey = found[0]?.key;
        if (coverKey) setPreviews((old) => ({ ...old, [coverKey]: data.issue.cover }));
      }
      setIssue(data.issue ?? null);
      setContent((old) => {
        // From an issue page, the cover found there comes first; figures you uploaded are kept after it.
        const kept = (old?.figures ?? []).filter((f) => !f.fromIssue);
        const figures = found.length ? [...found.map((f) => ({ ...f, fromIssue: true })), ...kept] : kept;
        return {
          ...blankContent(kind), ...data.content,
          accent: old?.accent ?? data.content.accent ?? "cyan",
          layout: old?.layout ?? "one",
          figures: (data.issue ? figures : old?.figures?.length ? old.figures : found).slice(0, MAX_FIGURES),
        };
      });
      setTemplateId(null);
      setTemplateName("");
      setNotice("");
    });

  function startBlank() {
    setContent(blankContent(kind));
    setTemplateId(null);
    setTemplateName("");
    setNotice("");
  }

  async function addFigures(files) {
    const room = MAX_FIGURES - (content.figures?.length ?? 0);
    const chosen = Array.from(files ?? []).slice(0, Math.max(0, room));
    for (const file of chosen) {
      // Upload one at a time so a failure says which file it was.
      const ok = await run("figure", async () => {
        const form = new FormData();
        form.append("file", file);
        const data = await api("/api/image", { method: "POST", form });
        setPreviews((old) => ({ ...old, [data.key]: URL.createObjectURL(file) }));
        setContent((old) => ({ ...old, figures: [...(old.figures ?? []), { key: data.key, caption: "", alt: file.name.replace(/\.[^.]+$/, "") }] }));
        return true;
      });
      if (!ok) break;
    }
  }

  const addPageImage = (image) =>
    run("figure", async () => {
      if ((content.figures?.length ?? 0) >= MAX_FIGURES) throw new Error(`Up to ${MAX_FIGURES} figures.`);
      let figure;
      try {
        const data = await api("/api/email/images/import", { method: "POST", json: { url: image.url } });
        setPreviews((old) => ({ ...old, [data.key]: image.url }));
        figure = { key: data.key, caption: "", alt: image.alt || "" };
      } catch {
        // Couldn't copy it: link to it on the journal's site instead.
        figure = { url: image.url, caption: "", alt: image.alt || "" };
      }
      setContent((old) => ({ ...old, figures: [...(old.figures ?? []), figure] }));
    });

  function setFigure(index, fields) {
    update({ figures: content.figures.map((f, i) => (i === index ? { ...f, ...fields } : f)) });
  }

  function moveFigure(index, step) {
    const figures = [...content.figures];
    const target = index + step;
    if (target < 0 || target >= figures.length) return;
    [figures[index], figures[target]] = [figures[target], figures[index]];
    update({ figures });
  }

  function setSection(index, fields) {
    update({ sections: content.sections.map((s, i) => (i === index ? { ...s, ...fields } : s)) });
  }

  function setArticle(sectionIndex, articleIndex, fields) {
    const section = content.sections[sectionIndex];
    setSection(sectionIndex, { articles: section.articles.map((a, i) => (i === articleIndex ? { ...a, ...fields } : a)) });
  }

  function removeArticle(sectionIndex, articleIndex) {
    const section = content.sections[sectionIndex];
    setSection(sectionIndex, { articles: section.articles.filter((_, i) => i !== articleIndex) });
  }

  return (
    <div className="studio">
      <div style={{ display: "grid", gap: "1.1rem", minWidth: 0 }}>
        <div className="card">
          <h2>Start an email</h2>
          <label>Email type</label>
          <div className="segmented">
            <button className={kind === "toc" ? "on" : ""} onClick={() => setKind("toc")}>Table of contents</button>
            <button className={kind === "banner" ? "on" : ""} onClick={() => setKind("banner")}>Banner</button>
          </div>
          <p className="field-note">
            {kind === "toc" ? "Lists the articles in a journal issue, grouped by section." : "An announcement or promotion: call for papers, event, special issue."}
          </p>

          <label htmlFor="es-desc">{kind === "toc" ? "Instructions (optional)" : "What is the banner for?"}</label>
          <textarea id="es-desc" rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={kind === "toc"
              ? "e.g. Volume 12, Issue 3 of the Journal of Applied Science. Warm, professional tone."
              : "e.g. Call for papers for a special issue on climate resilience, deadline 31 March, link https://…"} />

          {kind === "toc" && (
            <>
              <label>Table of contents source</label>
              <div className="segmented">
                <button className={source === "text" ? "on" : ""} onClick={() => setSource("text")}>Paste</button>
                <button className={source === "file" ? "on" : ""} onClick={() => setSource("file")}>CSV / Excel</button>
                <button className={source === "issue" ? "on" : ""} onClick={() => setSource("issue")}>Issue URL</button>
              </div>
              {source === "text" && (
                <>
                  <label htmlFor="es-src-text" className="sr-only">Pasted table of contents</label>
                  <textarea id="es-src-text" rows={7} value={sourceText} maxLength={60000} onChange={(e) => setSourceText(e.target.value)}
                    placeholder="Paste the issue's table of contents: titles, authors, DOIs, pages…" style={{ marginTop: "0.6rem" }} />
                </>
              )}
              {source === "file" && (
                <>
                  <div className="dropzone" style={{ marginTop: "0.6rem" }}>
                    <Icon name="upload" size={22} />
                    <span>Columns: Title, Authors, Section, DOI, URL, Pages. Only Title is required.</span>
                    <input type="file" aria-label="Articles file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={(e) => parseFile(e.target.files?.[0])} />
                  </div>
                  {busy === "parse" && <p className="field-note">Reading the file…</p>}
                  {parsed && <p className="field-note">{parsed.length} article{parsed.length === 1 ? "" : "s"} found.</p>}
                </>
              )}
              {source === "issue" && (
                <>
                  <label htmlFor="es-src-url" className="sr-only">Journal issue URL</label>
                  <input id="es-src-url" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://journal.example.com/issue/view/12" style={{ marginTop: "0.6rem" }} />
                  <p className="field-note">
                    The issue page is read once. Every article on it is listed with its link and DOI, and the issue's
                    cover image is added at the top if one is found. Check them before sending.
                  </p>
                </>
              )}
            </>
          )}

          <ErrorNote error={error} />
          {blocked && gemini && <p className="muted-text" style={{ marginTop: "0.9rem" }}>{blocked}</p>}
          {!gemini && <p className="note note-warn">{blocked}</p>}
          <div className="actions">
            <button className="accent" onClick={generate} disabled={Boolean(busy) || Boolean(blocked)}>
              <Icon name="sparkles" /> {busy === "generate" ? "Writing…" : content ? "Generate again" : "Generate with AI"}
            </button>
            <button onClick={startBlank} disabled={Boolean(busy)}>Start blank</button>
          </div>
          {content && busy !== "generate" && <p className="field-note">Generating again replaces the text below. Figures are kept.</p>}
          {issue && content && (
            <div className="note" style={{ marginTop: "0.9rem" }}>
              <strong>From the issue page</strong>
              <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                {issue.suggestions.map((tip) => <li key={tip}>{tip}</li>)}
              </ul>
              {issue.images.length > 0 && (
                <div className="page-images">
                  {issue.images.map((image) => {
                    const added = (content.figures ?? []).some((f) => f.url === image.url || previews[f.key] === image.url);
                    return (
                      <figure key={image.url}>
                        <img src={image.url} alt={image.alt || "Image from the issue page"} loading="lazy" referrerPolicy="no-referrer" />
                        <button className="small" disabled={added || Boolean(busy) || (content.figures?.length ?? 0) >= MAX_FIGURES}
                          onClick={() => addPageImage(image)}>
                          {added ? "Added" : image.url === issue.cover ? "Add cover" : "Add as figure"}
                        </button>
                      </figure>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <TemplatesCard content={content} setContent={setContent} templateId={templateId} setTemplateId={setTemplateId}
          templateName={templateName} setTemplateName={setTemplateName} onLoaded={(c) => setKind(c.kind)}
          openRequest={openRequest} clearOpenRequest={clearOpenRequest} />

        {content && (
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}>Edit the email</h2>
              <span className="badge brand">{content.kind === "toc" ? "Table of contents" : "Banner"}</span>
            </div>

            <label htmlFor="es-subject">Subject</label>
            <input id="es-subject" value={content.subject} maxLength={200} onChange={(e) => update({ subject: e.target.value })} />
            <label htmlFor="es-pre">Preheader (shown after the subject in the inbox)</label>
            <input id="es-pre" value={content.preheader} maxLength={250} onChange={(e) => update({ preheader: e.target.value })} />

            {content.kind === "toc" ? (
              <div className="two-col">
                <div>
                  <label htmlFor="es-journal">Journal</label>
                  <input id="es-journal" value={content.journal} maxLength={200} onChange={(e) => update({ journal: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="es-issue">Issue</label>
                  <input id="es-issue" value={content.issue} maxLength={200} onChange={(e) => update({ issue: e.target.value })}
                    placeholder="Volume 12, Issue 3, March 2026" />
                </div>
              </div>
            ) : (
              <>
                <div className="two-col">
                  <div>
                    <label htmlFor="es-eyebrow">Label above the headline</label>
                    <input id="es-eyebrow" value={content.eyebrow} maxLength={80} onChange={(e) => update({ eyebrow: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="es-headline">Headline</label>
                    <input id="es-headline" value={content.headline} maxLength={200} onChange={(e) => update({ headline: e.target.value })} />
                  </div>
                </div>
                <label htmlFor="es-sub">Subheadline</label>
                <input id="es-sub" value={content.subheadline} maxLength={400} onChange={(e) => update({ subheadline: e.target.value })} />
              </>
            )}

            <div className="two-col">
              <div>
                <label htmlFor="es-greet">Greeting</label>
                <input id="es-greet" value={content.greeting} maxLength={120} onChange={(e) => update({ greeting: e.target.value })} />
                <p className="field-note">{"{{name}}"} becomes each recipient's name.</p>
              </div>
              {content.kind === "toc" && (
                <div>
                  <label htmlFor="es-heading">Heading</label>
                  <input id="es-heading" value={content.heading} maxLength={250} onChange={(e) => update({ heading: e.target.value })} />
                </div>
              )}
            </div>

            <label>Layout</label>
            <div className="segmented" role="radiogroup" aria-label="Layout">
              <button role="radio" aria-checked={(content.layout ?? "one") === "one"} className={(content.layout ?? "one") === "one" ? "on" : ""}
                onClick={() => update({ layout: "one" })}>One column</button>
              <button role="radio" aria-checked={content.layout === "two"} className={content.layout === "two" ? "on" : ""}
                onClick={() => update({ layout: "two" })}>Two columns</button>
            </div>
            <p className="field-note">
              {content.layout === "two"
                ? "The cover sits beside the introduction, and articles and figures go two per row. On phones they stack into one column."
                : "Everything in a single column, best for long titles."}
            </p>

            <RichField id="es-intro" label="Introduction" rows={3} maxLength={3000} value={content.intro} onChange={(v) => update({ intro: v })} />
            <RichField id="es-body" label="Body (leave a blank line between paragraphs)" rows={4}
              value={(content.body ?? []).join("\n\n")} onChange={(v) => update({ body: v.split("\n\n") })} />
            <RichField id="es-hl" label="Highlights (one per line)" rows={3}
              value={(content.highlights ?? []).join("\n")} onChange={(v) => update({ highlights: v.split("\n") })} />
            <p className="field-note">Select text and press <strong>B</strong>, <em>I</em> or Link to format it. Links must start with https://.</p>

            <div className="two-col">
              <div>
                <label htmlFor="es-cta">Button text</label>
                <input id="es-cta" value={content.cta_text} maxLength={60} onChange={(e) => update({ cta_text: e.target.value })} />
              </div>
              <div>
                <label htmlFor="es-cta-url">Button link</label>
                <input id="es-cta-url" type="url" value={content.cta_url} onChange={(e) => update({ cta_url: e.target.value })} placeholder="https://" />
              </div>
            </div>
            {content.cta_url && !/^https?:\/\/\S+$/.test(content.cta_url.trim()) && (
              <p className="warn-text">The button link must start with https:// or it won't be shown.</p>
            )}

            <RichField id="es-close" label="Closing" rows={2} maxLength={1500} value={content.closing} onChange={(v) => update({ closing: v })} />

            <label>Accent colour</label>
            <div className="accent-swatches">
              {Object.entries(ACCENTS).map(([name, [start, end]]) => (
                <button key={name} className={content.accent === name ? "swatch on" : "swatch"} title={name} aria-label={`${name} accent`}
                  aria-pressed={content.accent === name} style={{ background: `linear-gradient(135deg, ${start}, ${end})` }}
                  onClick={() => update({ accent: name })} />
              ))}
            </div>

            <h3 style={{ marginTop: "1.3rem" }}>Figures</h3>
            <p className="field-note">
              Up to {MAX_FIGURES} images, embedded in the email and resized to 1200px wide. The first one is shown at the top:
              use it for the issue cover. Upload your own cover or other images here at any time.
            </p>
            {(content.figures ?? []).length > 0 && (
              <ul className="figure-list">
                {content.figures.map((figure, index) => (
                  <li className="figure-item" key={figure.key || figure.url || index}>
                    {previews[figure.key] || figure.url
                      ? <img src={previews[figure.key] || figure.url} alt={figure.alt || "Figure"} />
                      : <span className="muted-text" style={{ fontSize: "0.75rem" }}>Saved image</span>}
                    <div style={{ display: "grid", gap: "0.3rem" }}>
                      <input aria-label={`Caption for figure ${index + 1}`} value={figure.caption} maxLength={400} placeholder="Caption"
                        onChange={(e) => setFigure(index, { caption: e.target.value })} />
                      <input aria-label={`Alt text for figure ${index + 1}`} value={figure.alt} maxLength={200} placeholder="Alt text (describe the image)"
                        onChange={(e) => setFigure(index, { alt: e.target.value })} />
                    </div>
                    <div style={{ display: "grid", gap: "0.3rem" }}>
                      <button className="small" onClick={() => moveFigure(index, -1)} disabled={index === 0} aria-label="Move up">↑</button>
                      <button className="small danger" aria-label={`Remove figure ${index + 1}`}
                        onClick={() => update({ figures: content.figures.filter((_, i) => i !== index) })}><Icon name="trash" size={15} /></button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {uploads ? (
              (content.figures ?? []).length < MAX_FIGURES && (
                <div className="dropzone" style={{ marginTop: "0.6rem" }}>
                  <Icon name="upload" size={22} />
                  <span>{busy === "figure" ? "Uploading…" : "Add figures (PNG or JPEG)"}</span>
                  <input type="file" accept="image/*" multiple aria-label="Figure images" disabled={busy === "figure"}
                    onChange={(e) => { addFigures(e.target.files); e.target.value = ""; }} />
                </div>
              )
            ) : (
              <p className="muted-text">Image uploads aren't set up on this server, so figures can't be added.</p>
            )}

            {content.kind === "toc" && (
              <>
                <h3 style={{ marginTop: "1.3rem" }}>Articles</h3>
                {content.sections.map((section, si) => (
                  <div className="article-section" key={si}>
                    <div className="row" style={{ gap: "0.5rem" }}>
                      <input aria-label={`Section ${si + 1} title`} value={section.title} maxLength={200} placeholder="Section title"
                        onChange={(e) => setSection(si, { title: e.target.value })} style={{ fontWeight: 800 }} />
                      <button className="small danger" aria-label={`Remove section ${si + 1}`}
                        onClick={() => update({ sections: content.sections.filter((_, i) => i !== si) })}><Icon name="trash" size={15} /></button>
                    </div>
                    <ul className="article-list">
                      {section.articles.map((article, ai) => (
                        <li className="article-item" key={ai}>
                          <div className="fields">
                            <input aria-label="Article title" value={article.title} maxLength={500} placeholder="Title"
                              onChange={(e) => setArticle(si, ai, { title: e.target.value })} />
                            <input aria-label="Authors" value={article.authors} maxLength={600} placeholder="Authors"
                              onChange={(e) => setArticle(si, ai, { authors: e.target.value })} />
                            <div className="split">
                              <input aria-label="DOI" value={article.doi} maxLength={200} placeholder="DOI (10.xxxx/…)"
                                onChange={(e) => setArticle(si, ai, { doi: e.target.value })} />
                              <input aria-label="Pages" value={article.pages} maxLength={40} placeholder="Pages"
                                onChange={(e) => setArticle(si, ai, { pages: e.target.value })} />
                            </div>
                            <input aria-label="Article page link" type="url" value={article.url} maxLength={500} placeholder="Article page link (the title opens it; optional)"
                              onChange={(e) => setArticle(si, ai, { url: e.target.value })} />
                          </div>
                          <button className="small danger" aria-label={`Remove ${article.title || "article"}`} onClick={() => removeArticle(si, ai)}>
                            <Icon name="trash" size={15} />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button className="small" style={{ marginTop: "0.5rem" }}
                      onClick={() => setSection(si, { articles: [...section.articles, blankArticle()] })}><Icon name="plus" size={15} /> Add article</button>
                  </div>
                ))}
                <button className="small" style={{ marginTop: "0.8rem" }}
                  onClick={() => update({ sections: [...content.sections, { title: "", articles: [blankArticle()] }] })}>
                  <Icon name="plus" size={15} /> Add section
                </button>
                <p className="field-note">Articles without a title are left out.</p>
              </>
            )}
          </div>
        )}
      </div>

      <PreviewCard content={content} notice={notice} setNotice={setNotice} onNext={onNext} />
    </div>
  );
}

function PreviewCard({ content, notice, setNotice, onNext }) {
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [renderError, setRenderError] = useState(null);
  const [rendering, setRendering] = useState(false);
  const counter = useRef(0);

  useEffect(() => {
    if (!content) return undefined;
    if (!content.subject.trim()) {
      setRenderError({ message: "Add a subject to see the preview." });
      return undefined;
    }
    const id = ++counter.current;
    const timer = setTimeout(async () => {
      setRendering(true);
      try {
        const data = await api("/api/email/render", { method: "POST", json: { content } });
        if (id !== counter.current) return;
        setHtml(data.html);
        setText(data.text);
        setRenderError(null);
      } catch (failure) {
        if (id === counter.current) setRenderError(failure);
      } finally {
        if (id === counter.current) setRendering(false);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [content]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(html);
      setNotice("HTML copied.");
    } catch {
      setNotice("Couldn't copy. Use Download instead.");
    }
  }

  function download() {
    const blob = new Blob([html], { type: "text/html" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(content.subject || "email").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "email"}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  return (
    <div className="card" style={{ position: "sticky", top: "1rem", minWidth: 0 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Live preview</h2>
        {rendering && <span className="muted-text">Updating…</span>}
      </div>
      {!content ? (
        <div className="preview-frame" style={{ display: "grid", placeItems: "center", height: 320 }}>
          <p className="muted-text" style={{ textAlign: "center", padding: "1rem" }}>Generate an email or start blank to see it here.</p>
        </div>
      ) : (
        <>
          {content.preheader && <p className="field-note" style={{ marginTop: 0 }}><strong>{content.subject}</strong> · {content.preheader}</p>}
          <iframe className="preview-frame" title="Email preview" sandbox="" srcDoc={html} />
          <ErrorNote error={renderError} />
          <SuccessNote>{notice}</SuccessNote>
          <div className="actions">
            <button onClick={copy} disabled={!html}><Icon name="copy" /> Copy HTML</button>
            <button onClick={download} disabled={!html}><Icon name="download" /> Download HTML</button>
            <button className="primary" onClick={onNext} disabled={!html || Boolean(renderError)}><Icon name="send" /> Continue to send</button>
          </div>
          <p className="field-note">
            In copied or downloaded HTML, figure links last one hour and the unsubscribe link is a placeholder.
            Emails sent from the Send tab embed the figures and get a real unsubscribe link.
          </p>
          {text && (
            <details style={{ marginTop: "0.8rem" }}>
              <summary>Plain-text version</summary>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", maxHeight: 300, overflow: "auto" }}>{text}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function TemplatesCard({ content, setContent, templateId, setTemplateId, templateName, setTemplateName, onLoaded, openRequest, clearOpenRequest }) {
  const [templates, setTemplates] = useState(null);
  const [saved, setSaved] = useState("");
  const { busy, error, run } = useBusy();

  const load = () => run("list", async () => setTemplates((await api("/api/email/templates")).templates));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (asNew) =>
    run("save", async () => {
      const json = { name: templateName.trim() || content.subject, content };
      const data = templateId && !asNew
        ? await api(`/api/email/templates/${templateId}`, { method: "PUT", json })
        : await api("/api/email/templates", { method: "POST", json });
      setTemplateId(data.template.id);
      setTemplateName(data.template.name);
      setSaved(`Saved "${data.template.name}".`);
      setTemplates((await api("/api/email/templates")).templates);
    });

  const open = (id) =>
    run(`open-${id}`, async () => {
      const data = await api(`/api/email/templates/${id}`);
      const loaded = { ...blankContent(data.template.content.kind), ...data.template.content };
      setContent(loaded);
      setTemplateId(data.template.id);
      setTemplateName(data.template.name);
      setSaved(`Loaded "${data.template.name}".`);
      onLoaded(loaded);
    });

  useEffect(() => {
    if (!openRequest) return;
    clearOpenRequest();
    open(openRequest);
  }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = (item) => {
    if (!window.confirm(`Delete the template "${item.name}"? This can't be undone.`)) return;
    run(`delete-${item.id}`, async () => {
      await api(`/api/email/templates/${item.id}`, { method: "DELETE" });
      if (item.id === templateId) setTemplateId(null);
      setTemplates((old) => old.filter((t) => t.id !== item.id));
      setSaved(`Deleted "${item.name}".`);
    });
  };

  return (
    <div className="card">
      <h2>Templates</h2>
      {content && (
        <>
          <label htmlFor="es-tname">Template name</label>
          <input id="es-tname" value={templateName} maxLength={120} onChange={(e) => setTemplateName(e.target.value)}
            placeholder={content.subject || "Name this template"} />
          <div className="actions" style={{ marginTop: "0.7rem" }}>
            <button className="primary" onClick={() => save(false)} disabled={Boolean(busy) || !content.subject.trim()}>
              {busy === "save" ? "Saving…" : templateId ? "Save changes" : "Save template"}
            </button>
            {templateId && <button onClick={() => save(true)} disabled={Boolean(busy) || !content.subject.trim()}>Save as new</button>}
          </div>
        </>
      )}
      <ErrorNote error={error} />
      <SuccessNote>{saved}</SuccessNote>
      {templates === null ? (
        <p className="muted-text">{busy === "list" ? "Loading templates…" : "Templates couldn't be loaded."}</p>
      ) : templates.length === 0 ? (
        <p className="muted-text">No saved templates yet.</p>
      ) : (
        <ul className="template-list">
          {templates.map((item) => (
            <li className="template-item" key={item.id}>
              <div>
                <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</strong>
                <span className="muted-text" style={{ fontSize: "0.78rem" }}>
                  {item.kind === "toc" ? "Table of contents" : "Banner"} · {new Date(item.updated_at).toLocaleDateString()}
                  {item.id === templateId && " · open"}
                </span>
              </div>
              <div style={{ display: "flex", gap: "0.35rem" }}>
                <button className="small" onClick={() => open(item.id)} disabled={Boolean(busy)}>
                  {busy === `open-${item.id}` ? "Loading…" : "Load"}
                </button>
                <button className="small danger" onClick={() => remove(item)} disabled={Boolean(busy)} aria-label={`Delete ${item.name}`}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Send tab ---

function SendTab({ active, content, templateName, goDesign }) {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState({ from_name: "", reply_to: "", footer: "" });
  const [settingsSaved, setSettingsSaved] = useState("");
  const [mode, setMode] = useState("paste");
  const [pasted, setPasted] = useState("");
  const [list, setList] = useState(null);
  const [sent, setSent] = useState("");
  const [campaigns, setCampaigns] = useState(null);
  const { busy, error, setError, run } = useBusy();
  const settingsState = useBusy();

  async function loadStatus() {
    const data = await api("/api/email/status");
    setStatus(data);
    setSettings(data.settings);
  }

  async function loadCampaigns() {
    setCampaigns((await api("/api/email/campaigns")).campaigns);
  }

  useEffect(() => {
    if (!active) return;
    loadStatus().catch(setError);
    loadCampaigns().catch(setError);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const polling = active && (campaigns ?? []).some((c) => ACTIVE_STATUSES.includes(c.status));
  // There is no server thread on Vercel: while this page is open it asks the server to send the
  // next batch (about 40 seconds of emails each). The cron job carries on when the page is closed.
  useEffect(() => {
    if (!polling) return undefined;
    let stopped = false;
    (async () => {
      while (!stopped) {
        const list = (await api("/api/email/campaigns").catch(() => null))?.campaigns;
        if (stopped || !list) break;
        setCampaigns(list);
        const next = list.find((c) => ACTIVE_STATUSES.includes(c.status));
        if (!next) break;
        await api(`/api/email/campaigns/${next.id}/step`, { method: "POST" }).catch(() => null);
        await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
      }
      if (!stopped) loadStatus().catch(() => {});
    })();
    return () => {
      stopped = true;
      loadStatus().catch(() => {});
    };
  }, [polling]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = () =>
    settingsState.run("save", async () => {
      const data = await api("/api/email/settings", { method: "PUT", json: settings });
      setSettings(data.settings);
      setSettingsSaved("Sender settings saved.");
    });

  const checkPasted = () =>
    run("parse", async () => {
      setList(await api("/api/email/recipients/parse", { method: "POST", json: { text: pasted } }));
    });

  async function uploadList(file) {
    setList(null);
    if (!file) return;
    await run("parse", async () => {
      const form = new FormData();
      form.append("file", file);
      setList(await api("/api/email/recipients/parse", { method: "POST", form }));
    });
  }

  const unsubscribed = new Set(list?.unsubscribed ?? []);
  const sendable = (list?.recipients ?? []).filter((r) => !unsubscribed.has(r.email));
  const remainingToday = status ? Math.max(0, status.daily_limit - status.sent_today) : 0;

  const sendTest = () =>
    run("test", async () => {
      const data = await api("/api/email/test", { method: "POST", json: { content, name: templateName } });
      setSent(`Test sent to ${data.sent_to}. Check your inbox (and spam folder).`);
      loadStatus().catch(() => {});
    });

  function sendAll() {
    const count = sendable.length;
    const message = `Send "${content.subject}" to ${count} recipient${count === 1 ? "" : "s"}?`
      + (count > remainingToday ? `\n\nOnly ${remainingToday} more emails can go out today; the rest will pause until you resume.` : "")
      + "\n\nThis can't be undone once sending starts.";
    if (!window.confirm(message)) return;
    run("send", async () => {
      const data = await api("/api/email/campaigns", {
        method: "POST",
        json: { content, recipients: sendable, confirm: true, name: templateName },
      });
      setCampaigns((old) => [data.campaign, ...(old ?? []).filter((c) => c.id !== data.campaign.id)]);
      setSent(`Sending to ${count} recipients. Progress is shown below.`);
      setList(null);
      setPasted("");
    });
  }

  const changeCampaign = (campaign, action) => {
    if (action === "cancel" && !window.confirm(`Cancel "${campaign.subject}"? Emails already sent can't be recalled.`)) return;
    run(`${action}-${campaign.id}`, async () => {
      const data = await api(`/api/email/campaigns/${campaign.id}/${action}`, { method: "POST" });
      setCampaigns((old) => old.map((c) => (c.id === campaign.id ? data.campaign : c)));
    });
  };

  const sendBlocked = !content
    ? "Design an email first."
    : status && !status.smtp_ready ? "Email isn't set up on this server. Ask your administrator to add the SMTP settings."
    : !content.subject.trim() ? "The email needs a subject." : null;

  return (
    <div className="studio">
      <div style={{ display: "grid", gap: "1.1rem", minWidth: 0 }}>
        {status && (
          <div className="stat-row">
            <div className="stat"><strong>{remainingToday}</strong><span>Left today (of {status.daily_limit})</span></div>
            <div className="stat"><strong>{status.sent_today}</strong><span>Sent today on this server</span></div>
            <div className="stat"><strong>{status.unsubscribed}</strong><span>Unsubscribed from you</span></div>
          </div>
        )}

        <div className="card">
          <h2>Sender</h2>
          <div className="two-col">
            <div>
              <label htmlFor="es-from">From name</label>
              <input id="es-from" value={settings.from_name} maxLength={100}
                onChange={(e) => setSettings({ ...settings, from_name: e.target.value })} placeholder="Journal of Applied Science" />
            </div>
            <div>
              <label htmlFor="es-reply">Reply-to address</label>
              <input id="es-reply" type="email" value={settings.reply_to} maxLength={254}
                onChange={(e) => setSettings({ ...settings, reply_to: e.target.value })} />
            </div>
          </div>
          <label htmlFor="es-footer">Footer: organisation and postal address</label>
          <textarea id="es-footer" rows={2} value={settings.footer} maxLength={600}
            onChange={(e) => setSettings({ ...settings, footer: e.target.value })}
            placeholder="Example Publishing Ltd, 1 Main Street, City, Country" />
          <p className="field-note">Anti-spam laws require a postal address in bulk email. An unsubscribe link is added automatically.</p>
          <ErrorNote error={settingsState.error} />
          <SuccessNote>{settingsSaved}</SuccessNote>
          <div className="actions">
            <button onClick={saveSettings} disabled={Boolean(settingsState.busy)}>
              {settingsState.busy ? "Saving…" : "Save sender settings"}
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Recipients</h2>
          <div className="segmented">
            <button className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>Paste</button>
            <button className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>CSV / Excel</button>
          </div>
          {mode === "paste" ? (
            <>
              <label htmlFor="es-recip" className="sr-only">Email addresses</label>
              <textarea id="es-recip" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} style={{ marginTop: "0.6rem" }}
                placeholder={"One per line, or separated by commas. Names are optional:\nJane Smith <jane@example.com>\nraj@example.org"} />
              <div className="actions" style={{ marginTop: "0.6rem" }}>
                <button onClick={checkPasted} disabled={Boolean(busy) || !pasted.trim()}>
                  {busy === "parse" ? "Checking…" : "Check list"}
                </button>
              </div>
            </>
          ) : (
            <div className="dropzone" style={{ marginTop: "0.6rem" }}>
              <Icon name="upload" size={22} />
              <span>{busy === "parse" ? "Reading the file…" : "A column named Email is used; a Name column is optional."}</span>
              <input type="file" aria-label="Recipients file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => uploadList(e.target.files?.[0])} />
            </div>
          )}

          {list && (
            <div style={{ marginTop: "0.9rem" }}>
              <div className="stat-row">
                <div className="stat"><strong>{sendable.length}</strong><span>Will receive it</span></div>
                <div className="stat"><strong>{list.invalid.length}</strong><span>Not valid</span></div>
                <div className="stat"><strong>{list.duplicates}</strong><span>Duplicates removed</span></div>
                <div className="stat"><strong>{list.unsubscribed.length}</strong><span>Unsubscribed</span></div>
              </div>
              {sendable.length > 0 && (
                <details style={{ marginTop: "0.7rem" }}>
                  <summary>Show recipients</summary>
                  <ul className="recipient-sample">
                    {sendable.slice(0, 200).map((r) => <li key={r.email}>{r.name ? `${r.name} <${r.email}>` : r.email}</li>)}
                    {sendable.length > 200 && <li className="muted-text">…and {sendable.length - 200} more</li>}
                  </ul>
                </details>
              )}
              {list.invalid.length > 0 && (
                <details open style={{ marginTop: "0.7rem" }}>
                  <summary className="warn-text">Addresses that aren't valid (skipped)</summary>
                  <ul className="recipient-sample">{list.invalid.map((e, i) => <li key={`${e}-${i}`}>{e}</li>)}</ul>
                </details>
              )}
              {list.unsubscribed.length > 0 && (
                <details style={{ marginTop: "0.7rem" }}>
                  <summary>Unsubscribed addresses (skipped)</summary>
                  <ul className="recipient-sample">{list.unsubscribed.map((e) => <li key={e}>{e}</li>)}</ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="card glow">
          <h2>Send</h2>
          {content
            ? <p className="muted-text">Email: <strong>{content.subject || "(no subject)"}</strong> <button className="link" onClick={goDesign}>Edit</button></p>
            : <p className="muted-text">No email yet. <button className="link" onClick={goDesign}>Design one first</button>.</p>}
          {sendBlocked && content && <p className="note note-warn">{sendBlocked}</p>}
          <ErrorNote error={error} />
          <SuccessNote>{sent}</SuccessNote>
          <div className="actions">
            <button onClick={sendTest} disabled={Boolean(busy) || Boolean(sendBlocked)}>
              <Icon name="mail" /> {busy === "test" ? "Sending test…" : "Send test to me"}
            </button>
            <button className="accent" onClick={sendAll} disabled={Boolean(busy) || Boolean(sendBlocked) || sendable.length === 0}>
              <Icon name="send" /> {busy === "send" ? "Starting…" : `Send to ${sendable.length} recipient${sendable.length === 1 ? "" : "s"}`}
            </button>
          </div>
          <p className="field-note">Send yourself a test first. Bulk emails go out in the background, a little over one a second.</p>
        </div>
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>Campaigns</h2>
          <button className="small" onClick={() => loadCampaigns().catch(setError)}>Refresh</button>
        </div>
        {campaigns === null ? (
          <p className="muted-text">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="muted-text">Nothing sent yet. Campaigns you send appear here with their progress.</p>
        ) : (
          <ul className="campaign-list">
            {campaigns.map((c) => <CampaignItem key={c.id} campaign={c} busy={busy} onChange={changeCampaign} />)}
          </ul>
        )}
        <p className="field-note">See the <Link to="/history">History</Link> page for social posts.</p>
      </div>
    </div>
  );
}

function CampaignItem({ campaign, busy, onChange }) {
  const done = campaign.sent + campaign.failed + campaign.skipped;
  const percent = campaign.total ? Math.round((done / campaign.total) * 100) : 0;
  const [label, tone] = STATUS_BADGE[campaign.status] ?? [campaign.status, "muted"];
  const canCancel = ["queued", "sending", "paused"].includes(campaign.status);
  return (
    <li className="campaign-item">
      <div className="row" style={{ marginBottom: 0 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{campaign.subject || campaign.name}</strong>
          <span className="muted-text" style={{ fontSize: "0.78rem" }}>{new Date(campaign.created_at).toLocaleString()}</span>
        </div>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Sending progress">
        <div style={{ width: `${percent}%` }} />
      </div>
      <p className="muted-text" style={{ fontSize: "0.82rem", margin: 0 }}>
        {campaign.sent} sent · {campaign.failed} failed · {campaign.skipped} skipped · {campaign.remaining} left of {campaign.total}
      </p>
      {campaign.error && <p className="warn-text" style={{ fontSize: "0.85rem" }}>{campaign.error}</p>}
      {campaign.failures.length > 0 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary>Failed addresses ({campaign.failures.length}{campaign.failed > campaign.failures.length ? ` of ${campaign.failed}` : ""})</summary>
          <ul className="recipient-sample">
            {campaign.failures.map((f, i) => <li key={`${f.email}-${i}`}><strong>{f.email}</strong>: {f.error}</li>)}
          </ul>
        </details>
      )}
      {(campaign.status === "paused" || canCancel) && (
        <div className="actions" style={{ marginTop: "0.6rem" }}>
          {campaign.status === "paused" && (
            <button className="small primary" onClick={() => onChange(campaign, "resume")} disabled={Boolean(busy)}>
              {busy === `resume-${campaign.id}` ? "Resuming…" : "Resume"}
            </button>
          )}
          {canCancel && (
            <button className="small danger" onClick={() => onChange(campaign, "cancel")} disabled={Boolean(busy)}>
              {busy === `cancel-${campaign.id}` ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
