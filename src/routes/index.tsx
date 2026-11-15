import { createFileRoute } from "@tanstack/react-router";
import App from "../client/App.jsx";

// The dashboard runs in the browser only (it keeps the session in sessionStorage).
export const Route = createFileRoute("/")({
  ssr: false,
  component: App,
});
