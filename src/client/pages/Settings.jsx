import { useEffect, useState } from "react";
import { API_BASE_URL, api, setToken } from "../api.js";
import { ErrorNote, SuccessNote, formatDate } from "../shared.jsx";

function ConnectedBadge({ ok }) {
  return <span className={`badge ${ok ? "good" : "muted"}`}>{ok ? "Connected" : "Not connected"}</span>;
}

function MetaSection({ me, settings, onSaved }) {
  const [token, setTokenValue] = useState("");
  const [pageId, setPageId] = useState(settings.fb_page_id);
  const [igId, setIgId] = useState(settings.ig_user_id);
  const [appId, setAppId] = useState(settings.meta_app_id ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState(null);

  async function run(label, action) {
    setBusy(label);
    setError(null);
    setMessage("");
    setTestResult(null);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  const save = (event) => {
    event.preventDefault();
    return run("save", async () => {
      await api("/api/settings", {
        method: "PUT",
        json: { meta_access_token: token, fb_page_id: pageId, ig_user_id: igId, meta_app_id: appId, meta_app_secret: appSecret },
      });
      setTokenValue("");
      setAppSecret("");
      setMessage("Saved.");
      await onSaved();
    });
  };

  const test = () =>
    run("test", async () => {
      const result = await api("/api/settings/test", { method: "POST" });
      setTestResult(result);
      if (result.ig_user_id_saved) {
        setIgId(result.linked_ig_user_id);
        await onSaved();
      }
    });

  const remove = () =>
    run("remove", async () => {
      await api("/api/settings/meta-token", { method: "DELETE" });
      setMessage("Access token removed.");
      await onSaved();
    });

  const removeSecret = () =>
    run("remove-secret", async () => {
      await api("/api/settings/meta-app-secret", { method: "DELETE" });
      setMessage("App secret removed.");
      await onSaved();
    });

  const token_ = testResult?.token;

  return (
    <div className="card settings-wide">
      <div className="row">
        <h2>Facebook and Instagram</h2>
        <span className="badges">
          <span className="muted-text">Facebook</span> <ConnectedBadge ok={me.platforms.facebook.configured} />
          <span className="muted-text">Instagram</span> <ConnectedBadge ok={me.platforms.instagram.configured} />
        </span>
      </div>
      <p className="muted-text">
        One Facebook Page access token works for both. Your Instagram professional account must be linked to the Page.
      </p>
      <form onSubmit={save}>
        <label htmlFor="meta-token">Page access token</label>
        <input
          id="meta-token"
          type="password"
          autoComplete="off"
          spellCheck="false"
          value={token}
          onChange={(e) => setTokenValue(e.target.value)}
          placeholder={settings.has_meta_token ? "Saved. Leave blank to keep it." : "Paste your token"}
        />
        <p className="field-note">
          A Page token, a user token or a Business Manager system-user token all work: for Facebook posts the app
          swaps it for the Page's own token. Stored encrypted and never shown again. It needs: pages_manage_posts,
          pages_manage_metadata, pages_read_engagement, pages_show_list, instagram_basic, instagram_content_publish.
        </p>
        <div className="two-col">
          <div>
            <label htmlFor="page-id">Facebook Page ID</label>
            <input id="page-id" inputMode="numeric" value={pageId} onChange={(e) => setPageId(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ig-id">Instagram user ID</label>
            <input id="ig-id" inputMode="numeric" value={igId} onChange={(e) => setIgId(e.target.value)} />
            <p className="field-note">Leave blank, and Test connection will find it from your Page.</p>
          </div>
        </div>
        <div className="two-col">
          <div>
            <label htmlFor="meta-app-id">Meta App ID (optional)</label>
            <input id="meta-app-id" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} />
          </div>
          <div>
            <label htmlFor="meta-app-secret">Meta App secret (optional)</label>
            <input id="meta-app-secret" type="password" autoComplete="off" spellCheck="false" value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder={settings.has_meta_app_secret ? "Saved. Leave blank to keep it." : "From App settings > Basic"} />
          </div>
        </div>
        <p className="field-note">
          Not needed to post. With them, Test connection shows the token's type, expiry and missing permissions, and every
          Meta call is signed with appsecret_proof, which apps with "Require app secret" switched on need.
          The secret is stored encrypted. Use the app the token was made with.
        </p>
        <ErrorNote error={error} />
        <SuccessNote>{message}</SuccessNote>
        {testResult && (
          <ul className="plain test-results">
            <li>
              <span className={`badge ${testResult.facebook.ok ? "good" : "bad"}`}>{testResult.facebook.ok ? "Works" : "Failed"}</span>{" "}
              Facebook Page: {testResult.facebook.name ?? "unknown"}
              {testResult.facebook.page_token && " (posts use the Page's own token)"}
              {testResult.facebook.error && <p className="hint">{testResult.facebook.error}</p>}
              {testResult.facebook.hint && <p className="hint">{testResult.facebook.hint}</p>}
            </li>
            <li>
              <span className={`badge ${testResult.instagram.ok ? "good" : "bad"}`}>{testResult.instagram.ok ? "Works" : "Failed"}</span>{" "}
              {testResult.instagram.ok
                ? `Instagram: @${testResult.instagram.username}`
                : `Instagram: ${testResult.instagram.error ?? "no account is linked to this Page"}`}
              {testResult.instagram.hint && <p className="hint">{testResult.instagram.hint}</p>}
            </li>
            {token_ && (token_.error ? (
              <li><span className="badge bad">App check failed</span> {token_.error}{token_.hint && <p className="hint">{token_.hint}</p>}</li>
            ) : (
              <li>
                <span className={`badge ${token_.valid ? "good" : "bad"}`}>{token_.valid ? "Valid" : "Invalid"}</span>{" "}
                Token type: {token_.type ?? "unknown"} · expires: {token_.expires}
                {token_.missing?.length > 0 && <p className="hint">Missing permissions: {token_.missing.join(", ")}</p>}
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button className="primary" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : "Save"}</button>
          <button type="button" onClick={test} disabled={Boolean(busy) || !settings.has_meta_token}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          {settings.has_meta_token && (
            <button type="button" onClick={remove} disabled={Boolean(busy)}>Remove token</button>
          )}
          {settings.has_meta_app_secret && (
            <button type="button" onClick={removeSecret} disabled={Boolean(busy)}>Remove app secret</button>
          )}
        </div>
      </form>
    </div>
  );
}

function LinkedInSection({ me, settings, onSaved }) {
  const { configured, app_ready: appReady, own_app: ownApp, expires_at: expiresAt, warning } = me.platforms.linkedin;
  const [clientId, setClientId] = useState(settings.linkedin_client_id ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  // An older server doesn't send these fields: it can't store a per-user LinkedIn app yet.
  const serverUpdated = "linkedin_redirect_uri" in settings;
  const redirectUri = settings.linkedin_redirect_uri || `${API_BASE_URL}/api/linkedin/callback`;

  async function run(label, action) {
    setBusy(label);
    setError(null);
    setMessage("");
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy("");
    }
  }

  const saveApp = (event) => {
    event.preventDefault();
    return run("save", async () => {
      await api("/api/settings", {
        method: "PUT",
        json: { linkedin_client_id: clientId, linkedin_client_secret: clientSecret },
      });
      setClientSecret("");
      setMessage("Saved. Now click Connect LinkedIn.");
      await onSaved();
    });
  };

  const removeApp = () =>
    run("remove-app", async () => {
      await api("/api/settings/linkedin-app", { method: "DELETE" });
      setClientId("");
      setMessage("LinkedIn app removed.");
      await onSaved();
    });

  const connect = () =>
    run("connect", async () => {
      const { url } = await api("/api/linkedin/start");
      window.location.assign(url);
    });

  const disconnect = () =>
    run("disconnect", async () => {
      await api("/api/linkedin", { method: "DELETE" });
      await onSaved();
    });

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card">
      <div className="row"><h2>LinkedIn</h2><ConnectedBadge ok={configured} /></div>
      <p className="muted-text">
        Use your own LinkedIn app, then sign in with LinkedIn to post to your profile. You don't need a token.
      </p>
      {warning && <p className="warn-text">{warning}</p>}
      {expiresAt && !warning && <p className="muted-text">Sign-in lasts until {formatDate(expiresAt)}.</p>}
      <form onSubmit={saveApp}>
        <label htmlFor="li-client-id">Client ID</label>
        <input id="li-client-id" autoComplete="off" spellCheck="false" value={clientId}
          onChange={(e) => setClientId(e.target.value.trim())} placeholder="From your app's Auth tab" />
        <label htmlFor="li-client-secret">Client secret</label>
        <input id="li-client-secret" type="password" autoComplete="off" spellCheck="false" value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value.trim())}
          placeholder={settings.has_linkedin_client_secret ? "Saved. Leave blank to keep it." : "Primary Client Secret"} />
        <label htmlFor="li-redirect">Authorized redirect URL</label>
        <div className="copy-field">
          <input id="li-redirect" readOnly value={redirectUri} onFocus={(e) => e.target.select()} />
          <button type="button" onClick={copyRedirect}>{copied ? "Copied" : "Copy"}</button>
        </div>
        {!serverUpdated && (
          <p className="warn-text">
            The server is running an older version, so your LinkedIn app can't be saved yet. Redeploy the backend,
            then save the Client ID and secret again.
          </p>
        )}
        <p className="field-note">
          At linkedin.com/developers: create an app, add the products "Sign In with LinkedIn using OpenID Connect" and
          "Share on LinkedIn", and paste this URL under Auth &gt; Authorized redirect URLs for your app. The secret is
          stored encrypted and never shown again.
        </p>
        {!ownApp && appReady && (
          <p className="muted-text">No app of your own saved: sign-in uses this server's shared LinkedIn app.</p>
        )}
        <ErrorNote error={error} />
        <SuccessNote>{message}</SuccessNote>
        <div className="actions">
          <button className="primary" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : "Save app"}</button>
          <button type="button" onClick={connect} disabled={Boolean(busy) || !appReady}>
            {configured ? "Sign in again" : "Connect LinkedIn"}
          </button>
          {configured && <button type="button" onClick={disconnect} disabled={Boolean(busy)}>Disconnect</button>}
          {(settings.linkedin_client_id || settings.has_linkedin_client_secret) && (
            <button type="button" onClick={removeApp} disabled={Boolean(busy)}>Remove app</button>
          )}
        </div>
      </form>
    </div>
  );
}

function WritingSection({ settings, me, onSaved }) {
  const [audience, setAudience] = useState(settings.audience);
  const [tone, setTone] = useState(settings.tone);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  async function save(event) {
    event.preventDefault();
    setError(null);
    setMessage("");
    try {
      await api("/api/settings", { method: "PUT", json: { audience, tone } });
      setMessage("Saved.");
      await onSaved();
    } catch (failure) {
      setError(failure);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Writing style</h2>
      <p className="muted-text">Your defaults for new posts.</p>
      <label htmlFor="default-audience">Audience</label>
      <input id="default-audience" value={audience} maxLength={200} onChange={(e) => setAudience(e.target.value)} placeholder={me.defaults.audience} />
      <label htmlFor="default-tone">Tone</label>
      <input id="default-tone" value={tone} maxLength={200} onChange={(e) => setTone(e.target.value)} placeholder={me.defaults.tone} />
      <ErrorNote error={error} />
      <SuccessNote>{message}</SuccessNote>
      <div className="actions"><button>Save</button></div>
    </form>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  async function save(event) {
    event.preventDefault();
    setError(null);
    setMessage("");
    try {
      const { token } = await api("/api/me/password", {
        method: "PUT",
        json: { current_password: current, new_password: next },
      });
      setToken(token);
      setCurrent("");
      setNext("");
      setMessage("Password changed.");
    } catch (failure) {
      setError(failure);
    }
  }

  return (
    <form className="card" onSubmit={save}>
      <h2>Password</h2>
      <label htmlFor="current-password">Current password</label>
      <input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <label htmlFor="new-password">New password</label>
      <input id="new-password" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      <p className="field-note">At least 8 characters.</p>
      <ErrorNote error={error} />
      <SuccessNote>{message}</SuccessNote>
      <div className="actions"><button>Change password</button></div>
    </form>
  );
}

export default function Settings({ me, refreshMe, linkedinResult }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);

  const load = () => api("/api/settings").then(setSettings).catch(setError);
  useEffect(() => {
    load();
  }, []);

  async function onSaved() {
    await Promise.all([load(), refreshMe()]);
  }

  return (
    <section>
      <h1 className="page-title">Settings</h1>
      <p className="muted-text page-subtitle">Signed in as {me.user.email}</p>
      {linkedinResult === "connected" && <SuccessNote>LinkedIn is connected.</SuccessNote>}
      {linkedinResult === "error" && (
        <ErrorNote error={{ message: "LinkedIn sign-in didn't finish.", hint: "Try connecting again." }} />
      )}
      <ErrorNote error={error} />
      {settings && (
        <div className="settings-grid">
          <MetaSection me={me} settings={settings} onSaved={onSaved} />
          <LinkedInSection me={me} settings={settings} onSaved={onSaved} />
          <WritingSection me={me} settings={settings} onSaved={onSaved} />
          <PasswordSection />
        </div>
      )}
    </section>
  );
}
