import { useEffect, useState } from "react";

export const PLATFORMS = [
  { key: "linkedin", label: "LinkedIn", limit: 3000 },
  { key: "facebook", label: "Facebook", limit: 1999 },
  { key: "instagram", label: "Instagram", limit: 2200 },
];

export const labelOf = (key) => PLATFORMS.find((p) => p.key === key)?.label ?? key;

export function formatDate(seconds) {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="note note-error" role="alert">
      <strong>{error.message}</strong>
      {error.hint && <p>{error.hint}</p>}
    </div>
  );
}

export function SuccessNote({ children }) {
  if (!children) return null;
  return <div className="note" role="status">{children}</div>;
}

export function StatusBadge({ result }) {
  if (result.pending) return <span className="badge brand">Publishing…</span>;
  const kind = result.ok ? "good" : result.skipped ? "muted" : "bad";
  const text = result.ok ? "Posted" : result.skipped ? "Skipped" : "Failed";
  return <span className={`badge ${kind}`}>{text}</span>;
}

// --- AI cost ---

export function formatUsd(value) {
  if (value === null || value === undefined) return "price unknown";
  if (value === 0) return "$0.00";
  if (value < 1) return `$${value.toFixed(value < 0.0001 ? 6 : 4)}`;
  return `$${value.toFixed(2)}`;
}

const FEATURES = {
  compose: "Compose", analyze: "Analyze", email: "Email Studio", reel: "Reel storyboard", "reel-voice": "Reel voiceover",
  autopost: "Autopost bot", "site-post": "Site to Post", manuscript: "Manuscript Writer", banner: "Banner Studio",
};
export const featureLabel = (key) => FEATURES[key] ?? key;

export function sumUsage(runs) {
  const list = (runs ?? []).filter(Boolean);
  return {
    calls: list.reduce((n, r) => n + r.calls, 0),
    input: list.reduce((n, r) => n + r.input_tokens, 0),
    output: list.reduce((n, r) => n + r.output_tokens + r.thinking_tokens, 0),
    cost: list.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
    unpriced: list.reduce((n, r) => n + r.unpriced_calls, 0),
    models: [...new Set(list.flatMap((r) => r.models))],
    free: list.some((r) => r.free_tier),
  };
}

// What the AI work behind this post really cost, from the token counts Gemini reported.
export function CostCard({ runs, title = "AI cost for this post" }) {
  const list = (runs ?? []).filter(Boolean);
  if (!list.length) return null;
  const total = sumUsage(list);
  const latest = list[list.length - 1];
  return (
    <div className="card flat cost-card" aria-label={title}>
      <div>
        <span className="cost-label">{title}</span>
        <span className="cost-value">{formatUsd(total.cost)}</span>
      </div>
      <div className="cost-detail">
        {total.input.toLocaleString()} input + {total.output.toLocaleString()} output tokens, {total.calls} AI call{total.calls === 1 ? "" : "s"}
        {list.length > 1 && <> · last run {formatUsd(latest.cost_usd)}</>}
        {total.models.length > 0 && <> · {total.models.join(", ")}</>}
        <br />
        {total.free ? "Free-tier key: Google doesn't bill these calls." : "Priced at Google's published Gemini paid-tier rates."}
        {total.unpriced > 0 && ` ${total.unpriced} call(s) used a model without a known price.`}
      </div>
    </div>
  );
}

// --- Background jobs ---

// Pages stay mounted when you leave them, so their requests keep running. This tells the sidebar.
export function announceTask(path, state) {
  window.dispatchEvent(new CustomEvent("sa-task", { detail: { path, state } }));
}

export function JobCard({ title, steps, active, startedAt, note, typical = "Usually 10–40 seconds" }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  const current = Math.min(active, steps.length - 1);
  return (
    <div className="card job-card" role="status" aria-live="polite">
      <div className="job-head">
        <span className="job-orb" aria-hidden="true" />
        <div>
          <h2>{title}</h2>
          <p className="muted-text">{steps[current]}…</p>
        </div>
      </div>
      <ol className="job-steps">
        {steps.map((step, index) => (
          <li key={step} className={index < current ? "done" : index === current ? "active" : ""}>
            <span className="tick" aria-hidden="true">{index < current ? "✓" : ""}</span>
            {step}
          </li>
        ))}
      </ol>
      <div className="job-note">
        <span aria-hidden="true">⏱</span>
        <span>{note ?? <><strong>Running in the background.</strong> You can open other pages; the results will be waiting here.</>}</span>
      </div>
      <div className="job-meta"><span>Elapsed {seconds}s</span><span>{typical}</span></div>
    </div>
  );
}

// Moves through a job's steps on a timer, since the server reports no progress mid-request.
export function useJobSteps(running, stepCount, secondsPerStep = 6) {
  const [state, setState] = useState({ active: 0, startedAt: 0 });
  useEffect(() => {
    if (!running) return undefined;
    const startedAt = Date.now();
    setState({ active: 0, startedAt });
    const timer = setInterval(() => {
      const step = Math.floor((Date.now() - startedAt) / 1000 / secondsPerStep);
      setState({ active: Math.min(stepCount - 1, step), startedAt });
    }, 500);
    return () => clearInterval(timer);
  }, [running, stepCount, secondsPerStep]);
  return state;
}

// History asks the Email Studio to open a template or its Send tab through this sessionStorage key.
export const EMAIL_OPEN_KEY = "email-studio-open";
export const MANUSCRIPT_OPEN_KEY = "manuscript-open";

// An optional link added to the posts. Off = no link.
export function LinkField({ id, on, onToggle, url, onUrl, disabled }) {
  const bad = on && url.trim() && !/^https?:\/\/\S+\.\S+$/.test(url.trim());
  return (
    <div className="link-field">
      <label className="check">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
        Add a link to the post
      </label>
      {on && (
        <>
          <input id={id} type="url" value={url} disabled={disabled} onChange={(e) => onUrl(e.target.value)}
            placeholder="https://example.com/article" aria-label="Link address" />
          {bad && <p className="warn-text">Enter a full address starting with https://</p>}
          <p className="field-note">
            Clickable in the LinkedIn and Facebook post text. Instagram doesn't allow links in captions, so there it is
            shown as "Link in bio" with the address. Put the link in your Instagram bio as well.
          </p>
        </>
      )}
    </div>
  );
}

export const linkValue = (on, url) => (on ? url.trim() : "");
