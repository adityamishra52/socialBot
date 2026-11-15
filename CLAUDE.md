# Social Autopost: project notes

One TanStack Start app (React 19, Vite, Nitro) deployed to Vercel. Writes posts, reels, emails, manuscripts and books with Gemini **lite** models and publishes to LinkedIn, a Facebook Page and Instagram. Multi-user. MongoDB is the only storage (no S3, no Redis). The old Python/Flask + Vite version lives in `_legacy/` (git-ignored, reference only).

## Layout

- `src/routes/`: TanStack file routes. `__root.tsx` (document, CSS), `index.tsx` and `$.tsx` render the dashboard (`ssr: false`), `api/$.ts` sends every `/api/*` request to `src/server/app.ts`.
- `src/client/`: the dashboard (JSX). `App.jsx` is the shell; pages stay mounted so long jobs keep running. `router.jsx` maps the old `{path, navigate, Link}` API onto TanStack Router. `api.js` (same-origin fetch, `uploadFile` in 3 MB pieces, `compressImage`; `api("/api/image", {form})` and `api("/api/reel/upload", {form})` are redirected to chunked uploads).
  - `pages/Writer.jsx`: Manuscript & Book Writer (wizard: type → topic & details → proof material → research → voice & layout; then the workspace: editor left, paged preview right).
  - `lib/layout.js` (blocks for preview/print/Word), `lib/Preview.jsx` (pagination, page numbers, mirrored margins, running headers, TOC, `printPages`), `lib/exportDocx.js` (Word via `docx`), `lib/readfiles.js` (PDF via pdfjs, .docx via mammoth, ZIP via fflate, in the browser), `lib/images.js` (4:5 fitting, SVG→PNG, data-URL uploads).
  - `reel/renderer.js`: Three.js reel renderer, recorded with MediaRecorder.
- `src/shared/`: used by both sides. `render.ts` (citations and reference styles: vancouver, ama, ieee, apa, harvard, chicago, mla; `renderManuscript`, `renderBook`, BibTeX/RIS), `charts.ts` (SVG charts/diagrams, `checkChart` refuses numbers not stated in the text, `suggestCharts` from a spreadsheet, Okabe–Ito palette), `sheets.ts` (CSV/XLSX rows without a library).
- `src/server/`:
  - `app.ts`: route table and dispatcher (`[method, path, "user"|"admin"|"public", handler]`), sessions, account/settings routes, `/api/cron/tick`. Other routes: `routes-social.ts`, `routes-email.ts`, `routes-admin.ts`, `routes-manuscript.ts`.
  - `db.ts`: cached MongoClient, indexes, `pack`/`unpack` (non-query fields zipped into BSON Binary `z` as a real ZIP with `data.json`).
  - `files.ts`: images/videos/audio in `files` + gzip `file_chunks`; signed public links (`/api/public/file/<token>`) for Meta to fetch; range/streaming responses.
  - `gemini.ts`: lite-only model chain (`GEMINI_MODEL` must contain "lite"), retries on 404 to the next model, `requestJson`, lite TTS, optional image model, pricing, `trackUsage` (AsyncLocalStorage). `usage.ts`: `aiRun` saves each run to `ai_usage`.
  - `platforms.ts`: LinkedIn (text, images, video in steps), Facebook (Page token lookup, photos, video by URL), Instagram (containers in steps). `publish.ts`: publish jobs stored on the History record and advanced by later requests (`advancePublish`, locked with `locked_until`), never retried.
  - `research.ts`: PubMed, Europe PMC, Crossref, Semantic Scholar, OpenAlex, arXiv, DOAJ, Open Library with a date range, merged and ranked (`mergeWorks`); `publicWork` never shows service names.
  - `writer.ts`: manuscript plan → sections (2 per call) → finish; book outline → one chapter per call → preface/conclusion/glossary; `revise`, three-persona `review`, `suggestFigures`. `sources.ts`: web pages, GitHub repos, journal guidelines, ISBN lookup, Openverse images, drawn figures.
  - `reel.ts` (site reading, storyboard, captions), `generator.ts` (posts, analyze), `emailer.ts` (content model, escaped HTML), `mail.ts` (nodemailer), `campaigns.ts` (batch sending), `autopilot.ts` (bots, cron tick), `purge.ts`, `web.ts` (safe fetching, private-IP refusal, HTML parsing with htmlparser2).

## Commands

```bash
npm test
```

```bash
npm run build
```

```bash
npm run dev
```

## Rules that matter

- **Serverless:** no background threads. Long work is split into steps the browser drives (`/api/manuscript/:id/step`, `/api/email/campaigns/:id/step`, `/api/publish/job/:id`) or the cron tick runs. Keep each request under ~50 s (`maxDuration` 60).
- **Request bodies are limited to 4.5 MB on Vercel:** upload files with `uploadFile` (chunks), read proof material in the browser, never send many data-URL images in one request.
- **Gemini lite only** (text, TTS and the lite image model `gemini-3.1-flash-lite-image`). Never add non-lite models. `GEMINI_IMAGE_MODEL=off` switches images off; image buttons are hidden when `me.services.ai_images` is false.
- **Never invent references:** only records from research or added sources; `keepKnown` drops unknown `[R#]`.
- **Research UI never names the services** searched.
- **Secrets:** use `registerSecret`/`redact`; never register `ADMIN_PIN`. Tokens are AES-GCM encrypted (`auth.ts`).
- **Per-user publishing:** only the user's own Meta/LinkedIn credentials (`configForUser`); server `FB_*`/`IG_*` values are never used.
- **Email:** never accept raw HTML; render through `emailer.renderHtml`. Every bulk email carries an unsubscribe link and `List-Unsubscribe` headers.
- **Don't retry publish calls automatically**, to avoid double posts.
- **Retention:** MongoDB TTL indexes (`db.ts` `ensureIndexes`) delete posts, templates, campaigns, manuscripts, research, bot runs and files (`expires_at`) after `HISTORY_DAYS` (7). Saving a template or manuscript pushes its files' `expires_at` back (`touchFiles`). `ai_usage`, users, connections, topics, bots and unsubscribes are kept.
- **JavaScript sites:** `web.renderedPage` (Jina Reader) is the fallback when a page's HTML has too little text; `readPage`, `readIssue`, `readJournal` and reel linked pages use it. `READER_FALLBACK=off` disables it.
- **Local settings:** `.env` (git-ignored) is loaded by `env.ts` when not on Vercel. Never commit it.
- Tests (`tests/`, `vitest.config.ts`) never touch the network or a database.

## Git

Push over SSH to `git@github-personal:adityamishra52/socialBot.git` (the `github-personal` alias signs in as adityamishra52), branch `main`.
