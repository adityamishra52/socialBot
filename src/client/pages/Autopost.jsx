import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Link } from "../router.jsx";
import { ErrorNote, PLATFORMS, SuccessNote, formatUsd, labelOf } from "../shared.jsx";
import { Icon, PageHeader } from "../ui.jsx";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CONTENT = {
  post: ["Posts", "Text and the site's image, written for each platform."],
};
const MODES = {
  trending: ["Trending", "Scroll-stopping, vivid looks and energetic voices."],
  academic: ["Academic", "Clean paper look, serif titles, calm scholarly voices."],
  mixed: ["Mixed", "Mostly trending, with academic reels in between."],
};
const RUN_BADGE = {
  running: ["Running", "brand"], posted: ["Posted", "good"], partly: ["Partly posted", "warn"],
  failed: ["Failed", "bad"], skipped: ["Skipped", "muted"],
};
const POLL_MS = 8000;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const zones = () => {
  let list = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older browsers: just the user's own zone and UTC.
  }
  return [...new Set([browserZone(), "UTC", ...list])];
};
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

function blankBot() {
  return {
    name: "", urls: [""], content: "post", reel_mode: "trending", platforms: ["facebook", "instagram"], instructions: "",
    schedule: { days: [0, 1, 2, 3, 4], times: ["10:00"], timezone: browserZone() }, active: true,
  };
}

function scheduleText(schedule) {
  const days = schedule.days.length === 7 ? "Every day"
    : schedule.days.join() === "0,1,2,3,4" ? "Weekdays"
    : schedule.days.map((d) => DAYS[d]).join(", ");
  return `${days} · ${schedule.times.join(", ")} (${schedule.timezone})`;
}

function BotEditor({ me, initial, onSaved, onCancel }) {
  const [bot, setBot] = useState(() => ({ ...initial, urls: initial.urls.length ? initial.urls : [""] }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (fields) => setBot((old) => ({ ...old, ...fields }));
  const setSchedule = (fields) => setBot((old) => ({ ...old, schedule: { ...old.schedule, ...fields } }));
  const zoneList = useRef(zones()).current;

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const json = { ...bot, urls: bot.urls.map((u) => u.trim()).filter(Boolean) };
      const data = initial.id
        ? await api(`/api/bots/${initial.id}`, { method: "PUT", json })
        : await api("/api/bots", { method: "POST", json });
      onSaved(data.bot, Boolean(initial.id));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value].sort());

  return (
    <form className="card glow" onSubmit={save}>
      <h2>{initial.id ? `Edit "${initial.name}"` : "New bot"}</h2>
      <label htmlFor="bot-name">Name</label>
      <input id="bot-name" value={bot.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. JAISW new articles" required />

      <label>Websites</label>
      {bot.urls.map((url, i) => (
        <div className="input-row" key={i} style={{ marginBottom: "0.4rem" }}>
          <input type="url" aria-label={`Website ${i + 1}`} value={url} placeholder="https://journal.example.com/issue/current"
            onChange={(e) => set({ urls: bot.urls.map((u, j) => (j === i ? e.target.value : u)) })} />
          {bot.urls.length > 1 && (
            <button type="button" className="small danger" aria-label={`Remove website ${i + 1}`}
              onClick={() => set({ urls: bot.urls.filter((_, j) => j !== i) })}><Icon name="trash" size={15} /></button>
          )}
        </div>
      ))}
      {bot.urls.length < 10 && (
        <button type="button" className="small" onClick={() => set({ urls: [...bot.urls, ""] })}><Icon name="plus" size={15} /> Add website</button>
      )}
      <p className="field-note">Each run, the bot opens one of these pages or a page they link to that it hasn't used yet, so it moves through your site.</p>

      <label>What should it make?</label>
      <div className="segmented">
        {Object.entries(CONTENT).map(([key, [label]]) => (
          <button type="button" key={key} className={bot.content === key ? "on" : ""} onClick={() => set({ content: key })}>{label}</button>
        ))}
      </div>
      <p className="field-note">{(CONTENT[bot.content] || CONTENT.post)[1]}</p>

      {false && (
        <>
          <label>Reel type</label>
          <div className="segmented">
            {Object.entries(MODES).map(([key, [label]]) => (
              <button type="button" key={key} className={bot.reel_mode === key ? "on" : ""} onClick={() => set({ reel_mode: key })}>{label}</button>
            ))}
          </div>
          <p className="field-note">{MODES[bot.reel_mode][1]}</p>
        </>
      )}

      <label>Post to</label>
      <div className="chips">
        {PLATFORMS.map((p) => {
          const connected = me.platforms[p.key]?.configured;
          return (
            <button type="button" key={p.key} className={`chip ${bot.platforms.includes(p.key) ? "on" : ""}`}
              aria-pressed={bot.platforms.includes(p.key)} onClick={() => set({ platforms: toggle(bot.platforms, p.key) })}>
              {p.label}{!connected && " (not connected)"}
            </button>
          );
        })}
      </div>

      <label>Days</label>
      <div className="chips">
        {DAYS.map((day, i) => (
          <button type="button" key={day} className={`chip ${bot.schedule.days.includes(i) ? "on" : ""}`}
            aria-pressed={bot.schedule.days.includes(i)} onClick={() => setSchedule({ days: toggle(bot.schedule.days, i) })}>{day}</button>
        ))}
      </div>
      <div className="two-col">
        <div>
          <label>Times</label>
          {bot.schedule.times.map((t, i) => (
            <div className="input-row" key={i} style={{ marginBottom: "0.4rem" }}>
              <input type="time" aria-label={`Time ${i + 1}`} value={t}
                onChange={(e) => setSchedule({ times: bot.schedule.times.map((v, j) => (j === i ? e.target.value : v)) })} />
              {bot.schedule.times.length > 1 && (
                <button type="button" className="small danger" aria-label={`Remove time ${i + 1}`}
                  onClick={() => setSchedule({ times: bot.schedule.times.filter((_, j) => j !== i) })}><Icon name="trash" size={15} /></button>
              )}
            </div>
          ))}
          {bot.schedule.times.length < 6 && (
            <button type="button" className="small" onClick={() => setSchedule({ times: [...bot.schedule.times, "18:00"] })}>
              <Icon name="plus" size={15} /> Add time
            </button>
          )}
        </div>
        <div>
          <label htmlFor="bot-zone">Time zone</label>
          <select id="bot-zone" value={bot.schedule.timezone} onChange={(e) => setSchedule({ timezone: e.target.value })}>
            {zoneList.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </div>

      <label htmlFor="bot-direction">Direction (optional)</label>
      <textarea id="bot-direction" rows={3} maxLength={1000} value={bot.instructions} onChange={(e) => set({ instructions: e.target.value })}
        placeholder="e.g. Highlight one new article each time. Invite researchers to submit. End with the journal's link." />

      <label className="check" style={{ marginTop: "0.8rem" }}>
        <input type="checkbox" checked={bot.active} onChange={(e) => set({ active: e.target.checked })} /> Bot is on
      </label>

      <ErrorNote error={error} />
      <div className="actions">
        <button className="primary" disabled={busy}>{busy ? "Saving…" : initial.id ? "Save changes" : "Create bot"}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function RunItem({ run }) {
  const [label, tone] = RUN_BADGE[run.status] ?? [run.status, "muted"];
  return (
    <li className="campaign-item">
      <div className="row" style={{ marginBottom: "0.2rem" }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: "block" }}>{run.title || (run.status === "running" ? "Working…" : run.bot_name)}</strong>
          <span className="muted-text" style={{ fontSize: "0.8rem" }}>
            {run.bot_name} · {run.kind === "reel" ? "3D reel" : "Post"} · {when(run.started_at)}
            {run.style && ` · ${run.style} look, ${run.voice} voice`}
            {run.cost_usd ? ` · AI ${formatUsd(run.cost_usd)}` : ""}
          </span>
        </div>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      {run.status === "running" && run.step && <p className="muted-text" style={{ margin: "0.3rem 0 0" }}>{run.step}…</p>}
      {run.results?.length > 0 && (
        <div className="history-platform-row">
          {run.results.map((r) => (
            <span key={r.platform} className="history-platform">
              <span className={`badge ${r.ok ? "good" : r.skipped ? "muted" : "bad"}`}>{r.ok ? "Posted" : r.skipped ? "Skipped" : "Failed"}</span>
              {r.ok && r.url?.startsWith("https://") ? <a href={r.url} target="_blank" rel="noreferrer">{labelOf(r.platform)}</a> : labelOf(r.platform)}
            </span>
          ))}
        </div>
      )}
      {run.error && run.status !== "posted" && <p className="warn-text" style={{ fontSize: "0.85rem" }}>{run.error}</p>}
      {run.hint && <p className="hint">{run.hint}</p>}
      {run.page_url && <p className="field-note" style={{ margin: "0.3rem 0 0" }}>From <a href={run.page_url} target="_blank" rel="noreferrer">{run.page_url}</a></p>}
    </li>
  );
}

export default function Autopost({ me, active }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = () => api("/api/bots").then(setData).catch(setError);
  useEffect(() => {
    if (active) load();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const working = (data?.bots ?? []).some((b) => b.running || (b.next_run_at && new Date(b.next_run_at) <= new Date()))
    || (data?.runs ?? []).some((r) => r.status === "running");
  useEffect(() => {
    if (!active || !working) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, working]); // eslint-disable-line react-hooks/exhaustive-deps

  // While this page is open, due bots run from here too (the Vercel cron job runs them otherwise).
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      const due = (data?.bots ?? []).some((b) => b.active && !b.running && b.next_run_at && new Date(b.next_run_at) <= new Date());
      if (due && !data?.blocked) api("/api/bots/tick", { method: "POST" }).then(load).catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [active, data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label, action, message) {
    setBusy(label);
    setError(null);
    setNotice("");
    try {
      await action();
      if (message) setNotice(message);
      await load();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  const toggleBot = (bot) => act(`toggle-${bot.id}`, () => api(`/api/bots/${bot.id}`, { method: "PUT", json: { ...bot, active: !bot.active } }),
    bot.active ? `"${bot.name}" is paused.` : `"${bot.name}" is on.`);
  const runNow = (bot) => act(`run-${bot.id}`, () => api(`/api/bots/${bot.id}/run`, { method: "POST" }),
    `"${bot.name}" ran. See the result below.`);
  const remove = (bot) => {
    if (!window.confirm(`Delete the bot "${bot.name}"? Its past posts stay on your accounts.`)) return;
    act(`delete-${bot.id}`, () => api(`/api/bots/${bot.id}`, { method: "DELETE" }), `Deleted "${bot.name}".`);
  };

  const bots = data?.bots ?? [];
  const usesReels = false;

  return (
    <section className="content" style={{ padding: 0 }}>
      <PageHeader
        eyebrow="Autopost bots"
        title="Bots that post for you"
        lead="Give a bot your website and a schedule. At each time it reads a new page of the site, writes a post with the page's image, and publishes it. Make 3D reels in Site to Reel."
        action={!editing && (
          <button className="accent" onClick={() => setEditing(blankBot())} disabled={bots.length >= (data?.max_bots ?? 10)}>
            <Icon name="plus" /> New bot
          </button>
        )}
      />

      {data?.blocked && (
        <p className="note note-warn">{data.blocked} You can set bots up now; they start posting once auto-posting is approved.</p>
      )}
      {data?.reels_unavailable && usesReels && (
        <p className="note note-warn">Reels can't be rendered on this server yet: {data.reels_unavailable} Post bots work already.</p>
      )}
      <ErrorNote error={error} />
      <SuccessNote>{notice}</SuccessNote>

      <div className="studio" style={{ marginTop: "1rem" }}>
        <div style={{ display: "grid", gap: "1.1rem", minWidth: 0, alignContent: "start" }}>
          {editing && (
            <BotEditor me={me} initial={editing} onCancel={() => setEditing(null)}
              onSaved={(bot, existed) => { setEditing(null); setNotice(existed ? `Saved "${bot.name}".` : `Created "${bot.name}". Next post: ${when(bot.next_run_at)}.`); load(); }} />
          )}
          {data && bots.length === 0 && !editing && (
            <div className="card">
              <h2>No bots yet</h2>
              <p className="muted-text">Create one to post automatically from your website, for example a new article every weekday at 10:00.</p>
              <button className="primary" onClick={() => setEditing(blankBot())}><Icon name="plus" /> Create your first bot</button>
            </div>
          )}
          {bots.map((bot) => (
            <div className={`card bot-card ${bot.active ? "" : "paused"}`} key={bot.id}>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ margin: 0 }}>{bot.name}</h2>
                  <p className="muted-text" style={{ margin: "0.25rem 0 0" }}>
                    {(CONTENT[bot.content] || CONTENT.post)[0]} · {bot.platforms.map(labelOf).join(", ")}
                  </p>
                </div>
                <button className={`switch ${bot.active ? "on" : ""}`} role="switch" aria-checked={bot.active} aria-label={`${bot.name} on or off`}
                  onClick={() => toggleBot(bot)} disabled={Boolean(busy)}><span /></button>
              </div>
              <ul className="plain bot-facts">
                <li><Icon name="clock" size={15} /> {scheduleText(bot.schedule)}</li>
                <li><Icon name="globe" size={15} /> {bot.urls[0]}{bot.urls.length > 1 && ` and ${bot.urls.length - 1} more`}</li>
                <li><Icon name="send" size={15} /> {bot.running ? "Running now…" : bot.active ? `Next: ${when(bot.next_run_at)}` : "Paused"} · {bot.runs} run{bot.runs === 1 ? "" : "s"} so far</li>
                {bot.last_status && <li className="muted-text">Last: {bot.last_status}</li>}
              </ul>
              <div className="actions">
                <button className="small primary" onClick={() => runNow(bot)} disabled={Boolean(busy) || bot.running || !bot.active || Boolean(data?.blocked)}>
                  <Icon name="play" size={15} /> {busy === `run-${bot.id}` ? "Queuing…" : "Run now"}
                </button>
                <button className="small" onClick={() => setEditing(bot)} disabled={Boolean(busy)}><Icon name="pen" size={15} /> Edit</button>
                <button className="small danger" onClick={() => remove(bot)} disabled={Boolean(busy) || bot.running}><Icon name="trash" size={15} /> Delete</button>
              </div>
            </div>
          ))}
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Nothing repeats</h3>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }} className="muted-text">
              <li>Every reel gets a style and voice combination you haven't had, and never the same style or voice as the reel before. Academic reels keep the paper look and change palette and voice.</li>
              <li>Each run uses a page of your site that hasn't been used yet; earlier headlines are passed to the AI, and anything too close to an earlier post is written again.</li>
              <li>Posts are published once and never retried, so nothing is posted twice. Everything a bot posts also appears in <Link to="/history">History</Link>.</li>
            </ul>
          </div>
        </div>

        <div className="card" style={{ minWidth: 0, alignSelf: "start" }}>
          <div className="row">
            <h2 style={{ margin: 0 }}>Recent runs</h2>
            <button className="small" onClick={load}>Refresh</button>
          </div>
          {!data ? <p className="muted-text">Loading…</p>
            : data.runs.length === 0 ? <p className="muted-text">Runs appear here with what was posted, the look and voice used, and any errors.</p>
            : <ul className="campaign-list">{data.runs.map((run) => <RunItem key={run.id} run={run} />)}</ul>}
        </div>
      </div>
    </section>
  );
}
