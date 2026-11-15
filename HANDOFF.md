# Handoff (2026-11-15)

Read this first when you continue. Project rules and layout are in [CLAUDE.md](CLAUDE.md); setup is in [README.md](README.md).

## Where things are

- **Live site:** https://social-bot-ten.vercel.app (Vercel deploys every push to `main` in about 30–40 s).
- **Repo:** `git@github.com:adityamishra52/socialBot.git`, branch `main`. Push with the SSH alias `github-personal` (the other aliases are other accounts).
- **Local secrets:** `.env` in the project folder (git-ignored). Vercel has its own copy under Settings → Environment Variables; add new variables there too, then redeploy the **newest** deployment (or push).
- **Old version:** the Python/Flask backend and old Vite frontend are in `_legacy/` on this PC only.

## What was done

1. **Rebuilt as one TanStack Start app on Vercel** (no separate backend, no AWS, no Redis). API = `src/routes/api/$.ts` → `src/server/app.ts`.
2. **MongoDB only:** records zipped into a binary field; images/videos stored as gzip chunks; uploads go in 3 MB pieces (Vercel's 4.5 MB body limit).
3. **7-day auto-delete** with MongoDB TTL indexes: posts, reels, campaigns, email templates, manuscripts, books, research, bot runs and all files. **AI cost records are kept**; History shows the all-time AI cost.
4. **Gemini lite only, with fallbacks:** `gemini-3.1-flash-lite` → `gemini-3.1-flash-lite-preview` → `gemini-flash-lite-latest` (3.5) → `gemini-3.5-flash-lite` → `gemini-2.5-flash-lite` (not available to this key). Busy (503/429) or retired (404) models move on; the writer retries a busy step itself. TTS `gemini-3.8-flash-lite-tts`; images `gemini-3.1-flash-lite-image`.
5. **Manuscript & Book Writer** (`src/client/pages/Writer.jsx`, `src/server/writer.ts`, `routes-manuscript.ts`):
   - Manuscript or Book → topic & details → proof material (PDF/Word/ZIP/Excel/text read in the browser; links, GitHub repos, ISBNs) → research → voice & layout → step-by-step writing → editor (left) + paged preview (right).
   - Research: PubMed, Europe PMC, Crossref, Semantic Scholar, OpenAlex, arXiv, DOAJ, Open Library, date range, up to 100 titles; **Select all / Unselect all**; **Research deeper** (5 more specific queries + citation chasing of ticked titles, up to 100 more, marked New). Service names are never shown.
   - Voices: AI, Researcher, Professor, Industry expert, Student, Clinician, Science communicator.
   - Book layout: page size (A4, A5, B5, Letter, 6×9, 5.5×8.5, 5×8, Royal, Crown, custom), margins incl. mirrored inside/outside and gutter, page-number position and start, roman front matter, chapters on odd pages, running headers, title/copyright/contents pages, font, size, spacing.
   - Word export and Print/PDF from the same layout; AI revise + undo; three-reviewer quality review (reviewers see citations as (Author, year) with the reference list, and advice calling real citations "placeholders" or "[R#]" is dropped, `wrongAboutPlaceholders`); references are tidied whenever shown (`tidyReference` in `render.ts`: parallel titles/names in another script dropped so the PDF has no "???", full names split, ALL-CAPS/lower-case fixed, publisher addresses and "X–X" pages cleaned); the book outline marks `off_topic` references (keyword-only matches), which chapters and revisions never cite; the glossary is defined from the sentences that use each term; figures (from your spreadsheet, charts/diagrams from the text, free Openverse photos, uploads); BibTeX/RIS export.
   - Short chapters no longer fail the book: they're kept with a note to expand them with Revise.
   - **Publish (Kindle, Play, D2D)** (workspace tab, books): a publishing kit for Amazon KDP, Google Play Books and Draft2Digital, one by one or in one ZIP: EPUB 3 (passes W3C EPUBCheck 5.4.0 with 0 errors and 0 warnings), a print-ready text PDF typeset from the Book layout (embedded open fonts, contents links, bookmarks; Hindi and other joining scripts use Print / PDF instead), the 1600 × 2560 front cover JPG, Word, an AI store listing (description, 7 keywords, BISAC-style category suggestions, audience, author bio from the author's own details) and upload steps, with KDP's paperback margin check. 6 × 9 and the other inch sizes are now exact.
   - **Share on social** (workspace tab): platforms take pictures and text, not book files, so it posts a carousel (title card or your real cover, what readers will learn, quotes checked word for word against the text) with a post per platform; download the images or post to LinkedIn, Facebook and Instagram.
6. **Banner & Poster Studio** (`/banner`; `src/client/pages/BannerStudio.jsx`, `src/client/lib/banner.js`, `src/server/banner.ts`, `routes-banner.ts`): festival/greeting, creative, research, marketing and event banners in 6 sizes, 7 art styles, colour moods, any language. AI writes the words and 1–3 concepts; pictures come from the lite image model (text-free), a free openly licensed photo (credit added to the caption) or an upload; words are drawn in real fonts and stay editable. Download PNG/JPG or post.
   - **The Gemini key's free tier allows 0 requests to `gemini-3.1-flash-lite-image`** (429 `limit: 0`), so AI pictures (here and in Compose / Site to Post) need billing turned on in Google AI Studio. Until then the app says so plainly and banners fall back to free photos.
7. **JavaScript-built sites** (React/Vue, e.g. the portfolio) are read through Jina Reader (`JINA_API_KEY` in `.env`; `READER_FALLBACK=off` disables it).
8. **Scheduled work** (bots, email batches) runs from `/api/cron/tick` with `CRON_SECRET` — daily on Vercel Hobby; for more often, use cron-job.org with `?key=CRON_SECRET`. Bots make image posts only (reels are recorded in the browser).
9. Ideas from the Rytxpress skills (G:\Shared drives\Website\Website Testing\Rytxpress): multi-database search and de-duplication, section-writing guidance, reviewer personas, data-to-figure, citation export.

## Checked

- 16 unit tests pass (`npm test`); type-check and build pass.
- Locally: API, uploads, research (99–100 titles), deeper research (+100, no duplicates), book preview pagination, Word export, all pages render.
- Against the real services: Atlas connection and TTL indexes; Gemini key and every lite model; reading the portfolio through Jina.

## Not yet verified (needs the user signed in)

- A full manuscript and a full book written end to end on the live site after the latest fixes.
- Posting to LinkedIn, Facebook and Instagram (needs the user's tokens in Settings); Instagram/Facebook fetching images and reels from `/api/public/file/…`.
- Email: test send and a small campaign over Gmail SMTP.
- Site to Reel with the portfolio on the live site.
- Banner Studio on the live site while signed in (checked locally with stubbed replies: plan → picture fallback → free photos → editing → PNG export).
- Check that `JINA_API_KEY` and `CRON_SECRET` are set on Vercel.

## Ideas for next steps

- Price for `gemini-3.1-flash-lite-image` (currently shown as "price unknown").
- Optional: write long chapters in two calls (sections split) for more consistent length.
- Optional: a "Load more" for research beyond 400 titles, or saving research lists to reuse.
