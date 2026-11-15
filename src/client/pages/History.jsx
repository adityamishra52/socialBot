import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useRouter } from "../router.jsx";
import { EMAIL_OPEN_KEY, ErrorNote, MANUSCRIPT_OPEN_KEY, StatusBadge, featureLabel, formatUsd, labelOf } from "../shared.jsx";
import { Icon } from "../ui.jsx";

const FILTERS = [
  ["all", "All"],
  ["post", "Posts"],
  ["reel", "Reels"],
  ["campaign", "Email campaigns"],
  ["template", "Email templates"],
  ["manuscript", "Manuscripts"],
  ["ai", "AI activity"],
];
const CAMPAIGN_BADGE = {
  queued: ["Queued", "brand"], sending: ["Sending", "brand"], paused: ["Paused", "warn"],
  cancelled: ["Cancelled", "muted"], done: ["Finished", "good"],
};
const KIND_LABEL = {
  post: "Post", reel: "Reel", campaign: "Email campaign", template: "Email template", ai: "AI activity", manuscript: "Manuscript",
};
const MANUSCRIPT_BADGE = {
  ready: ["Ready", "good"], writing: ["Writing…", "brand"], revising: ["Revising…", "brand"], failed: ["Failed", "bad"],
  interrupted: ["Interrupted", "warn"],
};
const VOICE_LABEL = { ai: "AI-written", expert: "Expert", researcher: "Researcher", student: "College student" };

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

// Every kind of activity as one list of cards, newest first.
function toItems(data) {
  const items = [];
  for (const e of data.entries ?? []) {
    const results = Object.values(e.platforms ?? {});
    items.push({
      type: e.kind === "reel" ? "reel" : "post", id: e.id, at: e.timestamp, title: e.topic || "(no topic)", raw: e,
      search: `${e.topic} ${Object.entries(e.platforms ?? {}).map(([k, r]) => `${k} ${r.text ?? ""}`).join(" ")}`,
      ok: results.some((r) => r.ok), failed: results.some((r) => !r.ok && !r.skipped && !r.pending),
      publishing: e.status === "publishing",
    });
  }
  for (const c of data.campaigns ?? []) {
    items.push({ type: "campaign", id: c.id, at: c.created_at, title: c.subject || c.name, raw: c, search: `${c.subject} ${c.name}` });
  }
  for (const t of data.templates ?? []) {
    items.push({ type: "template", id: t.id, at: t.updated_at, title: t.name || t.subject, raw: t, search: `${t.name} ${t.subject}` });
  }
  for (const m of data.manuscripts ?? []) {
    items.push({ type: "manuscript", id: m.id, at: m.updated_at, title: m.title || "Untitled manuscript", raw: m,
      search: `${m.title} ${m.type_label}` });
  }
  for (const r of data.ai_runs ?? []) {
    items.push({ type: "ai", id: r.id, at: r.created_at, title: r.label || featureLabel(r.feature), raw: r, search: `${r.label} ${r.feature}` });
  }
  return items.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function CardSummary({ item }) {
  const { type, raw } = item;
  if (type === "post" || type === "reel") {
    return (
      <div className="history-platform-row">
        {Object.entries(raw.platforms ?? {}).map(([name, r]) => (
          <span key={name} className="history-platform"><StatusBadge result={r} /> {labelOf(name)}</span>
        ))}
      </div>
    );
  }
  if (type === "campaign") {
    const done = raw.sent + raw.failed + raw.skipped;
    const percent = raw.total ? Math.round((done / raw.total) * 100) : 0;
    return (
      <>
        <div className="progress" aria-label="Sending progress"><div style={{ width: `${percent}%` }} /></div>
        <p className="muted-text history-meta">{raw.sent} sent · {raw.failed} failed · {raw.skipped} skipped of {raw.total}</p>
      </>
    );
  }
  if (type === "template") return <p className="muted-text history-meta">Subject: {raw.subject || "(none)"}</p>;
  if (type === "manuscript") {
    return (
      <p className="muted-text history-meta">
        {raw.type_label}{raw.voice && ` · ${VOICE_LABEL[raw.voice] ?? raw.voice}`}
        {raw.word_count > 0 && ` · ${raw.word_count.toLocaleString()} words`}
      </p>
    );
  }
  return <p className="muted-text history-meta">{featureLabel(raw.feature)} · {raw.calls} AI call{raw.calls === 1 ? "" : "s"}</p>;
}

function badgeFor(item) {
  if (item.type === "campaign") return CAMPAIGN_BADGE[item.raw.status] ?? [item.raw.status, "muted"];
  if (item.type === "template") return [item.raw.kind === "toc" ? "Table of contents" : "Banner", "brand"];
  if (item.type === "manuscript") return MANUSCRIPT_BADGE[item.raw.status] ?? [item.raw.status, "muted"];
  if (item.type === "ai") return [item.raw.ok ? formatUsd(item.raw.cost_usd) : "Failed", item.raw.ok ? "muted" : "bad"];
  if (item.publishing) return ["Publishing…", "brand"];
  if (item.failed && item.ok) return ["Partly posted", "warn"];
  return item.ok ? ["Posted", "good"] : ["Failed", "bad"];
}

function Details({ item, onClose, openInEmail, openManuscript }) {
  const { type, raw } = item;
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={item.title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <span className="badge brand">{KIND_LABEL[type]}</span>
            <h2 style={{ margin: "0.5rem 0 0.2rem" }}>{item.title}</h2>
            <p className="muted-text" style={{ margin: 0 }}>{when(item.at)}</p>
          </div>
          <button className="small" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        {(type === "post" || type === "reel") && (
          <>
            {raw.video_url && <video className="history-media" src={raw.video_url} controls playsInline />}
            {!raw.video_url && raw.image_url && <img className="history-media" src={raw.image_url} alt="" />}
            {raw.ai_cost_usd !== undefined && <p className="muted-text">AI cost {formatUsd(raw.ai_cost_usd)}</p>}
            {Object.entries(raw.platforms ?? {}).map(([name, r]) => (
              <div key={name} className="history-detail">
                <div className="row" style={{ marginBottom: "0.4rem" }}>
                  <strong><StatusBadge result={r} /> {labelOf(name)}</strong>
                  {r.ok && r.url?.startsWith("https://") && (
                    <a className="button small" href={r.url} target="_blank" rel="noreferrer">View on {labelOf(name)}</a>
                  )}
                </div>
                {r.error && <p className={r.skipped ? "muted-text" : "warn-text"}>{r.error}</p>}
                {r.hint && <p className="hint">{r.hint}</p>}
                {r.text && <pre className="history-text">{r.text}</pre>}
              </div>
            ))}
            {raw.video_url && <p className="field-note">The video link works for one hour. Reopen History for a new one.</p>}
          </>
        )}

        {type === "campaign" && (
          <>
            <div className="stat-row" style={{ marginTop: "0.8rem" }}>
              <div className="stat"><strong>{raw.sent}</strong><span>Sent</span></div>
              <div className="stat"><strong>{raw.failed}</strong><span>Failed</span></div>
              <div className="stat"><strong>{raw.skipped}</strong><span>Skipped</span></div>
              <div className="stat"><strong>{raw.remaining}</strong><span>Left of {raw.total}</span></div>
            </div>
            {raw.error && <p className="warn-text">{raw.error}</p>}
            {raw.failures?.length > 0 && (
              <details open style={{ marginTop: "0.8rem" }}>
                <summary>Failed addresses ({raw.failures.length})</summary>
                <ul className="recipient-sample">
                  {raw.failures.map((f, i) => <li key={`${f.email}-${i}`}><strong>{f.email}</strong>: {f.error}</li>)}
                </ul>
              </details>
            )}
            <div className="actions">
              <button className="primary" onClick={() => openInEmail({ tab: "send" })}><Icon name="mail" /> Open in Email Studio</button>
            </div>
            {["queued", "sending", "paused"].includes(raw.status) && (
              <p className="field-note">Pause, resume or cancel it from the Send tab.</p>
            )}
          </>
        )}

        {type === "template" && (
          <>
            <p><strong>Subject:</strong> {raw.subject || "(none)"}</p>
            <p className="muted-text">Saved templates are kept until you delete them.</p>
            <div className="actions">
              <button className="primary" onClick={() => openInEmail({ template: raw.id })}><Icon name="pen" /> Open and edit</button>
            </div>
          </>
        )}

        {type === "manuscript" && (
          <>
            <p><strong>{raw.type_label}</strong>{raw.voice && ` · written like: ${VOICE_LABEL[raw.voice] ?? raw.voice}`}</p>
            <p className="muted-text">
              {raw.word_count > 0 ? `${raw.word_count.toLocaleString()} words. ` : ""}
              Started {when(raw.created_at)}, last changed {when(raw.updated_at)}. Kept for a few days after its last change:
              download the Word file to keep it.
            </p>
            <div className="actions">
              <button className="primary" onClick={() => openManuscript(raw.id)}><Icon name="doc" /> Open in Manuscript Writer</button>
            </div>
          </>
        )}

        {type === "ai" && (
          <div className="stat-row" style={{ marginTop: "0.8rem" }}>
            <div className="stat"><strong>{formatUsd(raw.cost_usd)}</strong><span>Cost</span></div>
            <div className="stat"><strong>{raw.calls}</strong><span>AI calls</span></div>
            <div className="stat"><strong>{raw.input_tokens.toLocaleString()}</strong><span>Input tokens</span></div>
            <div className="stat"><strong>{(raw.output_tokens + raw.thinking_tokens).toLocaleString()}</strong><span>Output tokens</span></div>
          </div>
        )}
        {type === "ai" && (
          <p className="muted-text" style={{ marginTop: "0.8rem" }}>
            {featureLabel(raw.feature)} · {raw.models.join(", ") || "model unknown"}
            {raw.published?.length > 0 && ` · Published to ${[...new Set(raw.published.flatMap((p) => p.platforms))].map(labelOf).join(", ")}`}
          </p>
        )}
      </div>
    </div>
  );
}

export default function History() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(null);
  const { navigate } = useRouter();

  const load = () => api("/api/history").then(setData).catch(setError);
  useEffect(() => { load(); }, []);

  const items = useMemo(() => (data ? toItems(data) : []), [data]);
  // While a reel is still publishing, refresh every few seconds so its results appear.
  const publishing = items.some((i) => i.publishing || (i.type === "manuscript" && ["writing", "revising"].includes(i.raw.status)));
  useEffect(() => {
    if (!publishing) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [publishing]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const result = { all: items.length };
    items.forEach((i) => { result[i.type] = (result[i.type] ?? 0) + 1; });
    return result;
  }, [items]);
  const shown = items.filter((i) => (filter === "all" || i.type === filter)
    && (!query.trim() || i.search.toLowerCase().includes(query.trim().toLowerCase())));

  const emailsSent = (data?.campaigns ?? []).reduce((n, c) => n + c.sent, 0);
  const aiCost = (data?.ai_runs ?? []).reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const keepDays = data?.keep_days ?? 7;

  function openManuscript(id) {
    sessionStorage.setItem(MANUSCRIPT_OPEN_KEY, id);
    setOpen(null);
    navigate("/manuscript");
  }

  function openInEmail(request) {
    sessionStorage.setItem(EMAIL_OPEN_KEY, JSON.stringify(request));
    setOpen(null);
    navigate("/email");
  }

  return (
    <section style={{ display: "grid", gap: "1.1rem" }}>
      <div className="card">
        <div className="row">
          <div>
            <h1 style={{ marginBottom: "0.3rem" }}>History</h1>
            <p className="muted-text" style={{ margin: 0 }}>
              Everything from the last {keepDays} days. Posts, reels, email campaigns and AI activity are deleted
              automatically after {keepDays} days; saved email templates are kept until you delete them.
            </p>
          </div>
          <button className="small" style={{ flexShrink: 0 }} onClick={load}>Refresh</button>
        </div>
        {data && (
          <div className="stat-row" style={{ marginTop: "1rem" }}>
            <div className="stat"><strong>{counts.post ?? 0}</strong><span>Posts</span></div>
            <div className="stat"><strong>{counts.reel ?? 0}</strong><span>Reels</span></div>
            <div className="stat"><strong>{emailsSent}</strong><span>Emails sent</span></div>
            <div className="stat"><strong>{counts.template ?? 0}</strong><span>Saved templates</span></div>
            <div className="stat"><strong>{counts.manuscript ?? 0}</strong><span>Manuscripts</span></div>
            <div className="stat"><strong>{formatUsd(aiCost)}</strong><span>AI cost ({keepDays} days)</span></div>
          </div>
        )}
        <div className="history-toolbar">
          <div className="chips" role="tablist" aria-label="Filter history">
            {FILTERS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} className={`chip ${filter === key ? "on" : ""}`}
                onClick={() => setFilter(key)}>
                {label} <span className="chip-count">{counts[key] ?? 0}</span>
              </button>
            ))}
          </div>
          <input type="search" aria-label="Search history" placeholder="Search titles and captions…" value={query}
            onChange={(e) => setQuery(e.target.value)} />
        </div>
        <ErrorNote error={error} />
      </div>

      {!data && !error && <p className="muted-text">Loading…</p>}
      {data && shown.length === 0 && (
        <div className="card"><p className="muted-text" style={{ margin: 0 }}>Nothing here yet for this filter.</p></div>
      )}
      <div className="history-grid">
        {shown.map((item) => {
          const [label, tone] = badgeFor(item);
          return (
            <button key={`${item.type}-${item.id}`} className={`history-card card type-${item.type}`} onClick={() => setOpen(item)}>
              <div className="row" style={{ marginBottom: "0.35rem", alignItems: "flex-start" }}>
                <span className="history-kind">{KIND_LABEL[item.type]}</span>
                <span className={`badge ${tone}`}>{label}</span>
              </div>
              <strong className="history-title">{item.title}</strong>
              <span className="muted-text history-meta">{when(item.at)}{item.raw.bot && ` · by bot "${item.raw.bot}"`}</span>
              <CardSummary item={item} />
            </button>
          );
        })}
      </div>
      {open && <Details item={open} onClose={() => setOpen(null)} openInEmail={openInEmail} openManuscript={openManuscript} />}
    </section>
  );
}
