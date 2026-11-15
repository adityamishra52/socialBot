import { Fragment, useCallback, useEffect, useState } from "react";
import { api, getToken, setSignedOutHandler, setToken } from "../api.js";
import { ErrorNote, SuccessNote, featureLabel, formatUsd, labelOf } from "../shared.jsx";

const ADMIN = { scope: "admin" };

function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function PinForm({ onLogin }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api("/api/admin/login", { method: "POST", json: { pin }, ...ADMIN });
      setToken(token, "admin");
      onLogin();
    } catch (failure) {
      setError(failure);
    } finally {
      setPin("");
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>Admin</h1>
        <label htmlFor="admin-pin">Admin PIN</label>
        <input id="admin-pin" type="password" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus required />
        <ErrorNote error={error} />
        <button className="primary" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
      </form>
    </main>
  );
}

function EmailOutcome({ result, to }) {
  if (!result) return null;
  if (result.sent) return <p>Sign-in details were emailed to {to}.</p>;
  return (
    <p className="warn-text">
      The email wasn't sent: {result.error} {result.hint}
    </p>
  );
}

function EmailCheckbox({ id, checked, onChange, emailReady }) {
  return (
    <label className={emailReady ? "check" : "check disabled"} htmlFor={id}>
      <input id={id} type="checkbox" checked={emailReady && checked} disabled={!emailReady} onChange={(e) => onChange(e.target.checked)} />
      Email the sign-in details to the user
      {!emailReady && <span className="muted-text"> (email isn't set up on the server)</span>}
    </label>
  );
}

function CreateUser({ onCreated, emailReady }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const { user, email: emailResult } = await api("/api/admin/users", {
        method: "POST",
        json: { email, name, password, send_email: emailReady && sendEmail },
        ...ADMIN,
      });
      setCreated({ email: user.email, password, emailResult });
      setEmail("");
      setName("");
      setPassword("");
      await onCreated();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Create user</h2>
      <div className="two-col">
        <div>
          <label htmlFor="new-email">Email</label>
          <input id="new-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="new-name">Name</label>
          <input id="new-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <label htmlFor="new-user-password">Password</label>
      <div className="input-row">
        <input id="new-user-password" type="text" autoComplete="off" spellCheck="false" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="button" onClick={() => setPassword(generatePassword())}>Generate</button>
      </div>
      <p className="field-note">At least 8 characters. The user can change it on their Settings page.</p>
      <div className="email-option">
        <EmailCheckbox id="new-send-email" checked={sendEmail} onChange={setSendEmail} emailReady={emailReady} />
      </div>
      <ErrorNote error={error} />
      {created && (
        <div className="note" role="status">
          <strong>User created. Copy this password now, because it won't be shown again.</strong>
          <p>Email: <code>{created.email}</code></p>
          <p>Password: <code>{created.password}</code></p>
          <EmailOutcome result={created.emailResult} to={created.email} />
        </div>
      )}
      <div className="actions">
        <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create user"}</button>
      </div>
    </form>
  );
}

function UserRow({ user, onChanged, emailReady }) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [emailResult, setEmailResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function update(json, done) {
    setBusy(true);
    setError(null);
    setMessage("");
    setEmailResult(null);
    try {
      const data = await api(`/api/admin/users/${user.id}`, { method: "PATCH", json, ...ADMIN });
      done?.();
      setEmailResult(data.email ?? null);
      await onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  function savePassword(event) {
    event.preventDefault();
    const shown = password;
    update({ password, send_email: emailReady && sendEmail }, () => {
      setResetting(false);
      setPassword("");
      setMessage(`New password: ${shown}. Copy it now, because it won't be shown again.`);
    });
  }

  return (
    <li className="user-row">
      <div className="user-main">
        <div>
          <strong>{user.name || user.email}</strong>
          {user.name && <span className="muted-text"> · {user.email}</span>}
          <p className="muted-text">
            {user.last_login_at ? `Last sign-in ${new Date(user.last_login_at).toLocaleString()}` : "Hasn't signed in yet"}
          </p>
        </div>
        <span className="badges">
          <span className={`badge ${user.active ? "good" : "muted"}`}>{user.active ? "Active" : "Deactivated"}</span>
          <span className={`badge ${user.autopost ? "brand" : "muted"}`}>{user.autopost ? "Auto-post approved" : "Auto-post off"}</span>
        </span>
        <div className="actions tight">
          <button onClick={() => update({ autopost: !user.autopost })} disabled={busy}>
            {user.autopost ? "Stop auto-posting" : "Approve auto-posting"}
          </button>
          <button onClick={() => { setResetting(!resetting); setPassword(""); }} disabled={busy}>Reset password</button>
          <button onClick={() => update({ active: !user.active })} disabled={busy}>
            {user.active ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
      {resetting && (
        <form className="reset-form" onSubmit={savePassword}>
          <div className="input-row">
            <label className="sr-only" htmlFor={`reset-${user.id}`}>New password for {user.email}</label>
            <input id={`reset-${user.id}`} type="text" autoComplete="off" spellCheck="false" minLength={8} placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="button" onClick={() => setPassword(generatePassword())}>Generate</button>
            <button className="primary" disabled={busy}>Save</button>
          </div>
          <EmailCheckbox id={`reset-email-${user.id}`} checked={sendEmail} onChange={setSendEmail} emailReady={emailReady} />
        </form>
      )}
      <ErrorNote error={error} />
      {message && (
        <div className="note" role="status">
          <p>{message}</p>
          <EmailOutcome result={emailResult} to={user.email} />
        </div>
      )}
    </li>
  );
}

const PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]];

function UserUsage({ user }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api(`/api/admin/users/${user.id}/usage`, ADMIN).then((d) => setRuns(d.runs)).catch(setError);
  }, [user.id]);
  if (error) return <ErrorNote error={error} />;
  if (!runs) return <p className="muted-text">Loading…</p>;
  if (!runs.length) return <p className="muted-text">No AI use yet.</p>;
  return (
    <div className="table-scroll">
      <table className="cost-table">
        <thead>
          <tr>
            <th>When</th><th>Feature</th><th>What</th><th>Model</th><th className="num">Tokens in / out</th><th className="num">Cost</th><th>Published</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{new Date(run.created_at).toLocaleString()}</td>
              <td>{featureLabel(run.feature)}{!run.ok && <span className="badge bad" style={{ marginLeft: 6 }}>Failed</span>}</td>
              <td>{run.label}</td>
              <td>{run.models.join(", ")}</td>
              <td className="num">{run.input_tokens.toLocaleString()} / {(run.output_tokens + run.thinking_tokens).toLocaleString()}</td>
              <td className="num">{run.unpriced_calls && !run.cost_usd ? "price unknown" : formatUsd(run.cost_usd)}</td>
              <td>{run.published.length ? run.published.map((p) => p.platforms.map(labelOf).join(", ")).join("; ") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsagePanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    setError(null);
    api(`/api/admin/usage?days=${days}`, ADMIN).then(setData).catch(setError);
  }, [days]);

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2 style={{ margin: 0 }}>AI cost by user</h2>
          <p className="muted-text" style={{ margin: "0.3rem 0 0" }}>
            Every Gemini call, priced from the tokens Gemini reported and Google's published rates. Failed attempts are included, because they're billed too.
          </p>
        </div>
        <div className="segmented">
          {PERIODS.map(([value, label]) => (
            <button key={value} className={days === value ? "on" : ""} onClick={() => setDays(value)}>{label}</button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {data && (
        <>
          <div className="stat-row">
            <div className="stat"><strong>{formatUsd(data.total_cost_usd)}</strong><span>Total AI cost</span></div>
            <div className="stat"><strong>{data.total_runs.toLocaleString()}</strong><span>AI runs</span></div>
            <div className="stat"><strong>{data.users.filter((u) => u.runs).length}</strong><span>Users with AI use</span></div>
          </div>
          <div className="table-scroll" style={{ marginTop: "1rem" }}>
            <table className="cost-table">
              <thead>
                <tr><th>User</th><th className="num">Runs</th><th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Cost</th><th>Last use</th><th /></tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <Fragment key={user.id}>
                    <tr>
                      <td><strong>{user.name || user.email}</strong>{user.name && <div className="muted-text">{user.email}</div>}</td>
                      <td className="num">{user.runs}</td>
                      <td className="num">{user.input_tokens.toLocaleString()}</td>
                      <td className="num">{user.output_tokens.toLocaleString()}</td>
                      <td className="num"><strong>{formatUsd(user.cost_usd)}</strong></td>
                      <td>{user.last_at ? new Date(user.last_at).toLocaleDateString() : "—"}</td>
                      <td>
                        {user.runs > 0 && (
                          <button className="small" onClick={() => setOpen(open === user.id ? null : user.id)}>
                            {open === user.id ? "Hide" : "Each post"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === user.id && (
                      <tr><td colSpan={7}><UserUsage user={user} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-note">
            {data.prices.free_tier
              ? "GEMINI_BILLING_TIER is set to free, so calls are recorded at $0."
              : `Paid-tier Standard prices, checked ${data.prices.checked} (${data.prices.source}). Calls on a free-tier key aren't billed by Google; set GEMINI_BILLING_TIER=free to record them as $0. Your Google Cloud bill is the final word.`}
          </p>
        </>
      )}
    </section>
  );
}

function AutopilotPanel() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("/api/admin/autopilot", ADMIN).then(setState).catch(setError);
  }, []);

  async function toggle() {
    const turningOn = !state.enabled;
    if (!turningOn && !window.confirm("Stop every auto-post bot on this server? Bots keep their settings and start again when you switch this back on.")) return;
    setBusy(true);
    setError(null);
    try {
      setState(await api("/api/admin/autopilot", { method: "PUT", json: { enabled: turningOn }, ...ADMIN }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Auto-post bots</h2>
        {state && <span className={`badge ${state.enabled ? "good" : "muted"}`}>{state.enabled ? "On" : "Off"}</span>}
      </div>
      <p className="muted-text">
        Bots post on their own on users' schedules. They run only while this is on <strong>and</strong> you've approved
        the user below. Turning it off stops every bot at once; their settings are kept.
      </p>
      {state?.reels_unavailable && <p className="note note-warn">Reels can't be made on this server yet: {state.reels_unavailable}</p>}
      <ErrorNote error={error} />
      {state && (
        <div className="actions">
          <button className={state.enabled ? "danger" : "primary"} onClick={toggle} disabled={busy}>
            {busy ? "Saving…" : state.enabled ? "Switch auto-posting off" : "Switch auto-posting on"}
          </button>
        </div>
      )}
    </section>
  );
}

export default function Admin() {
  const [signedIn, setSignedIn] = useState(Boolean(getToken("admin")));
  const [users, setUsers] = useState(null);
  const [emailReady, setEmailReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSignedOutHandler(() => setSignedIn(false), "admin");
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api("/api/admin/users", ADMIN);
      setUsers(data.users);
      setEmailReady(Boolean(data.email_ready));
    } catch (failure) {
      setError(failure);
    }
  }, []);

  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, load]);

  function signOut() {
    setToken(null, "admin");
    setUsers(null);
    setSignedIn(false);
  }

  if (!signedIn) return <PinForm onLogin={() => setSignedIn(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Social Autopost Admin</span>
        <span className="spacer" />
        <button className="link" onClick={signOut}>Sign out</button>
      </header>
      <main className="content admin">
        <AutopilotPanel />
        <UsagePanel />
        <CreateUser onCreated={load} emailReady={emailReady} />
        <section className="card">
          <h2>Users</h2>
          <ErrorNote error={error} />
          {users?.length === 0 && <p className="muted-text">No users yet. Create the first one above.</p>}
          <ul className="users">
            {users?.map((user) => <UserRow key={user.id} user={user} onChanged={load} emailReady={emailReady} />)}
          </ul>
        </section>
      </main>
    </div>
  );
}
