import { useCallback, useEffect, useState } from "react";
import { api, getToken, setSignedOutHandler, setToken } from "./api.js";
import Admin from "./pages/Admin.jsx";
import Analyze from "./pages/Analyze.jsx";
import Autopost from "./pages/Autopost.jsx";
import Compose from "./pages/Compose.jsx";
import EmailStudio from "./pages/EmailStudio.jsx";
import History from "./pages/History.jsx";
import Login from "./pages/Login.jsx";
import Writer from "./pages/Writer.jsx";
import ReelStudio from "./pages/ReelStudio.jsx";
import Settings from "./pages/Settings.jsx";
import SitePost from "./pages/SitePost.jsx";
import Topics from "./pages/Topics.jsx";
import { Link, RouterProvider, useRouter } from "./router.jsx";
import { ErrorNote } from "./shared.jsx";
import { Icon, Logo, ThemeToggle } from "./ui.jsx";

const NAV = [
  { to: "/compose", label: "Compose", icon: "pen" },
  { to: "/analyze", label: "Analyze & Post", icon: "sparkles", isNew: true },
  { to: "/reel", label: "Site to Reel", icon: "film", isNew: true },
  { to: "/site-post", label: "Site to Post", icon: "globe", isNew: true },
  { to: "/manuscript", label: "Manuscript & Book Writer", icon: "doc", isNew: true },
  { to: "/email", label: "Email Studio", icon: "mail", isNew: true },
  { to: "/autopost", label: "Autopost bots", icon: "bot", isNew: true },
  { to: "/topics", label: "Topics", icon: "list" },
  { to: "/history", label: "History", icon: "clock" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

function UserApp() {
  const { path, navigate } = useRouter();
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  const [me, setMe] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [linkedinResult] = useState(() => new URLSearchParams(window.location.search).get("linkedin"));
  const [menuOpen, setMenuOpen] = useState(false);
  const [tasks, setTasks] = useState({});

  useEffect(() => {
    setSignedOutHandler(() => {
      setMe(null);
      setSignedIn(false);
    });
    if (linkedinResult) window.history.replaceState({}, "", window.location.pathname);
  }, [linkedinResult]);

  const refreshMe = useCallback(async () => {
    setLoadError(null);
    try {
      setMe(await api("/api/me"));
    } catch (failure) {
      setLoadError(failure);
    }
  }, []);

  useEffect(() => {
    if (signedIn) refreshMe();
  }, [signedIn, refreshMe]);

  // Give every page its own address: /login when signed out, /compose as the home page.
  useEffect(() => {
    if (!signedIn && path !== "/login") navigate("/login", { replace: true });
    if (signedIn && !NAV.some((item) => item.to === path)) navigate("/compose", { replace: true });
    setMenuOpen(false);
  }, [signedIn, path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event) => event.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Long AI jobs keep running when you leave their page; the sidebar shows their state.
  useEffect(() => {
    const onTask = (event) => {
      const { path: taskPath, state } = event.detail;
      setTasks((old) => {
        const next = { ...old };
        if (state === "running") next[taskPath] = "running";
        else if (state === "done" && window.location.pathname !== taskPath) next[taskPath] = "ready";
        else delete next[taskPath];
        return next;
      });
    };
    window.addEventListener("sa-task", onTask);
    return () => window.removeEventListener("sa-task", onTask);
  }, []);

  useEffect(() => {
    setTasks((old) => (old[path] === "ready" ? Object.fromEntries(Object.entries(old).filter(([k]) => k !== path)) : old));
  }, [path]);

  function signOut() {
    setToken(null);
    setMe(null);
    setSignedIn(false);
  }

  if (!signedIn) return <Login onLogin={() => setSignedIn(true)} />;

  const current = NAV.find((item) => item.to === path);
  const name = me?.user.name || me?.user.email || "";

  return (
    <div className="shell">
      <div className={menuOpen ? "scrim open" : "scrim"} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className={menuOpen ? "sidebar open" : "sidebar"} aria-label="Main">
        <div className="logo-box">
          <Logo />
          <button className="icon close" onClick={() => setMenuOpen(false)} aria-label="Close menu"><Icon name="x" /></button>
        </div>
        <div className="card-dark sidebar-promo">
          <span className="live">Live</span>
          <strong>Create, analyse, publish</strong>
          <p>Write posts with AI, score them, post to LinkedIn, Facebook and Instagram, and send email campaigns.</p>
        </div>
        {me && (
          <div className="user-chip">
            <span className="avatar">{(name.charAt(0) || "S").toUpperCase()}</span>
            <div>
              <strong>{me.user.name || "Your account"}</strong>
              <span>{me.user.email}</span>
            </div>
          </div>
        )}
        <p className="nav-label">Tools</p>
        <nav className="nav">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className={path === item.to ? "active" : undefined}
              aria-current={path === item.to ? "page" : undefined}>
              <Icon name={item.icon} />
              {item.label}
              {tasks[item.to] === "running" ? <span className="task">Working</span>
                : tasks[item.to] === "ready" ? <span className="task ready">Ready</span>
                : item.isNew && <span className="new">New</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button onClick={signOut}><Icon name="logout" /> Sign out</button>
        </div>
      </aside>

      <div className="main">
        <header className="appbar">
          <button className="icon menu" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <span className="appbar-title">{current?.label}</span>
          <div className="appbar-actions">
            <ThemeToggle />
            {path !== "/analyze" && (
              <Link to="/analyze" className="button accent"><Icon name="sparkles" /> Analyze a post</Link>
            )}
          </div>
        </header>
        <main className="content">
          {loadError && (
            <>
              <ErrorNote error={loadError} />
              <button onClick={refreshMe}>Try again</button>
            </>
          )}
          {!me && !loadError && <p className="muted-text">Loading your workspace…</p>}
          {me && (
            <>
              {/* Compose, Analyze, Site to Reel, Manuscript Writer and Email Studio stay mounted, so their work keeps running on other pages. */}
              <div hidden={path !== "/compose"}><Compose me={me} refreshMe={refreshMe} /></div>
              <div hidden={path !== "/analyze"}><Analyze me={me} refreshMe={refreshMe} /></div>
              <div hidden={path !== "/reel"}><ReelStudio me={me} refreshMe={refreshMe} active={path === "/reel"} /></div>
              <div hidden={path !== "/site-post"}><SitePost me={me} refreshMe={refreshMe} /></div>
              <div hidden={path !== "/manuscript"}><Writer me={me} active={path === "/manuscript"} /></div>
              <div hidden={path !== "/email"}><EmailStudio me={me} active={path === "/email"} /></div>
              {path === "/topics" && <Topics refreshMe={refreshMe} />}
              {path === "/history" && <History />}
              <div hidden={path !== "/autopost"}><Autopost me={me} active={path === "/autopost"} /></div>
              {path === "/settings" && <Settings me={me} refreshMe={refreshMe} linkedinResult={linkedinResult} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Routes() {
  const { path } = useRouter();
  return path === "/admin" || path.startsWith("/admin/") ? <Admin /> : <UserApp />;
}

export default function App() {
  return (
    <RouterProvider>
      <Routes />
    </RouterProvider>
  );
}
