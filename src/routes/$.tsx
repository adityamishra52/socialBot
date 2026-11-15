import { createFileRoute } from "@tanstack/react-router";
import App from "../client/App.jsx";

// Every dashboard page (/compose, /manuscript, /admin...) is drawn by the same app shell, which
// keeps long-running pages mounted while you move between them.
export const Route = createFileRoute("/$")({
  ssr: false,
  component: App,
});
