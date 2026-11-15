# Social Autopost

AI posts, reels, email campaigns, journal manuscripts and books, written with **Google Gemini lite models** and published to LinkedIn, a Facebook Page and Instagram. Several people can use it, each with their own accounts.

It is one **TanStack Start** app that deploys to **Vercel only**: pages and API in a single deployment, no separate backend, no AWS, no Redis. All data, including uploaded images and videos, is stored in **MongoDB**, with the bulky parts of every record saved as a ZIP archive in a binary field.

## What's inside

| Page | What it does |
|---|---|
| Compose | Writes a post for each platform from a topic, then publishes it. |
| Analyze & Post | Scores a draft, explains what to fix, rewrites it per platform and publishes it. |
| Site to Reel | Reads a web page, writes a 15–20 s storyboard, voices it, renders a 3D reel in your browser and posts it. |
| Site to Post | Reads a page, writes long captions and offers the page's images (fitted to 4:5), then posts one or several. |
| **Manuscript & Book Writer** | See below. |
| Email Studio | Table-of-contents and banner emails, templates, test sends and bulk campaigns with unsubscribe links. |
| Autopost bots | Post on a schedule from your website's pages. |
| Topics, History, Settings | Topic rotation, the last 7 days of activity, and each user's own accounts. |
| /admin | Users, AI cost per user, and the server-wide autopost switch. Nothing links to it. |

### Manuscript & Book Writer

1. Choose **Manuscript** (a journal article) or **Book**.
2. Give the topic and details. For a book: name, subtitle, kind of book, readers, chapters and words per chapter, preface, glossary, learning objectives, review questions, case studies and more.
3. **Upload proof material** (PDF, Word, ZIP, Excel/CSV, text or code, read in your browser), web pages, GitHub repositories and books by ISBN.
4. **Research online** between two dates. Free scholarly services are searched together and the results are merged, de-duplicated and ranked. The page only says "Researching…", then shows up to **100 titles** to tick.
5. Choose the **writing voice** (AI, Researcher, Professor, Industry expert, Student, Clinician, Science communicator), the citation style and the **page layout**: page size (A4, A5, B5, Letter, 6 × 9 in, custom…), margins (with mirrored inside/outside margins and a gutter), where page numbers go and **the number they start at**, roman numerals for front matter, font, size, line spacing, chapters on odd pages, running headers, title, copyright and contents pages.
6. The AI writes it step by step (an outline, then a few sections or one chapter per step), so no request runs long.
7. **Edit on the left, see the laid-out pages on the right**. Download a **Word** file with the same layout, or **Print / PDF**. Revise with AI, run a three-reviewer **quality review**, add figures (from your own spreadsheet, charts and diagrams drawn from the text, free openly licensed photos, or uploads), and export references as BibTeX or RIS.

References come only from the real records you picked or added; the AI cites them by id and unknown ids are removed, so no reference can be invented. Missing facts are left as highlighted `[[placeholders]]`.

## Deploy on Vercel

1. Create a free **MongoDB Atlas** cluster. Under Network Access allow `0.0.0.0/0` (Vercel has no fixed IP). Copy the connection string.
2. Import this repository in Vercel. The framework is detected; no root directory or build settings are needed.
3. Add the environment variables from [`.env.example`](.env.example): at least `MONGODB_URI`, `APP_SECRET_KEY`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_PIN`, `GEMINI_API_KEY` and `CRON_SECRET`. Redeploy after adding variables.
4. Open `https://YOUR-SITE/admin`, enter the PIN and create the first user.
5. Add `https://YOUR-SITE/api/linkedin/callback` as a redirect URL in your LinkedIn app.
6. Scheduled work (bots, email batches, clean-up) runs from `/api/cron/tick`. `vercel.json` runs it daily (the Hobby plan's limit). For more frequent runs, point a free cron service at `https://YOUR-SITE/api/cron/tick?key=CRON_SECRET`. While the Email Studio or Autopost page is open, the browser drives sending and due bots itself.

### Keeping costs low

- Only Gemini **lite** models are used: text `gemini-3.1-flash-lite` (falling back to `gemini-3.1-flash-lite-preview` and `gemini-3.5-flash-lite` when Google's servers are busy), voiceovers `gemini-3.8-flash-lite-tts`, images `gemini-3.1-flash-lite-image`.
- AI images use the lite image model (`gemini-3.1-flash-lite-image`); set `GEMINI_IMAGE_MODEL=off` to switch them off.
- Every Gemini call is priced from Gemini's own token counts and shown on each page, in History and on /admin.
- Vercel Hobby and Atlas M0 (free) are enough for a small team: files are compressed in MongoDB, and MongoDB itself deletes every post, reel, campaign, email template, manuscript, book and stored file **7 days** after it was made or last changed (TTL indexes, `HISTORY_DAYS`). Users, settings, bots, unsubscribes and the **AI cost records are kept**, so costs can always be shown.

### Limits on Vercel

- Requests are limited to 4.5 MB, so files are uploaded in 3 MB pieces and proof material is read in the browser.
- There is no headless browser on Vercel. Pages built with JavaScript (React, Vue…) are read through Jina Reader (r.jina.ai, free; `JINA_API_KEY` raises its limits).
- Bots make image posts. Reels are rendered in your browser in Site to Reel.

## Run locally

```bash
npm install
npm run dev
```

Set the variables from `.env.example` in your shell (or a `.env` file loaded by your shell) first. Open http://localhost:3000.

```bash
npm test
```

```bash
npm run build
```

## Security

- Passwords are hashed with scrypt. Sessions are signed tokens: 12 hours for users, 2 hours for the admin. Changing a password ends that user's sessions.
- Access tokens and app secrets are encrypted with AES-256-GCM before they are stored, and never sent back to the browser.
- Ten wrong passwords (or five wrong PINs) lock sign-in for 15 minutes, counted in MongoDB across all serverless instances.
- Every query is scoped to the signed-in user. Server-level Meta credentials are never used for a user's posts.
- Web pages are read only from public addresses. Email HTML is always rendered from structured content with every value escaped.
