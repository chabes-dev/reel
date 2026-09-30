# Reel

A personal bookmark library for YouTube ads worth remembering.

Live: https://reel-chabes-devs-projects.vercel.app

## Why it exists
YouTube links die when brands take a campaign offline. Reel stores a *fingerprint* of each ad at capture time, so it can be found again elsewhere:

- Title, channel and a small JPEG copy of the thumbnail (survives takedowns)
- Brand, ad/campaign name, agency, year, market
- A tagline or line you remember (the best re-find key)
- Tags and free-form notes ("Your thinking")
- "Find it again" buttons: YouTube, Google Videos, Vimeo, Ads of the World, exact-line search, Wayback

## Decisions so far
- Single self-contained `index.html`, no build step, no dependencies
- Desktop / browser-first (capture happens at the Mac, links arrive via Outlook)
- `localStorage` (key `reel_v1`) is the working copy; Export / Import JSON still works (import now merges, never replaces, when served from Vercel)
- Cloud backup: `/api/library` merges every change into one private file on Vercel Blob (store `reel-library`), newest edit per ad wins, deletes are tombstones, one dated snapshot per day in `snapshots/`. Thumbnails go to `thumbs/<videoId>.jpg` once each
- Every `/api/*` call needs the passphrase in the `REEL_KEY` env var; the browser keeps it in `localStorage` (`reel_cloud_key`)
- Auto-fill: `/api/enrich` reads the YouTube description, then an AI with web search finds brand, campaign, agency, year, market, category and tagline. Fills empty fields only; filled fields get an "auto" tag until edited. Engine: Google Gemini with Google Search grounding when `GEMINI_API_KEY` is set (free tier, no card; newest stable Flash model picked automatically, override with `GEMINI_MODEL`); otherwise Claude via Vercel AI Gateway (needs a card on the Vercel account; model via `ENRICH_MODEL`)
- Spend guard: `/api/enrich` counts every search in `usage/YYYY-MM.json` and refuses once the month hits `ENRICH_MONTHLY_LIMIT` ads (default 100) or `ENRICH_MONTHLY_BUDGET` estimated USD (default 4.50). The footer shows this month's count, estimated cost and the AI Gateway credit Vercel reports (`/api/usage`)
- No video downloads; must stay free
- Metadata via YouTube oEmbed (fallback: noembed.com); thumbnails from i.ytimg.com
- Paste accepts whole emails — Outlook safelinks and `&amp;` are unwrapped

## Find the team
- In each ad, a collapsed **The team** section (tap to open). "Find the team" asks Gemini + Google Search for the published credits (agency creatives, strategists, director, production company; max 12) via `/api/team`
- Never answered from memory. Each name is checked against the pages Google cited and the YouTube description: found → ✓ with that page as source; not found → "unconfirmed · check" (a Google search for that name + the ad)
- Add people by hand (`Name | Role`), remove wrong ones; tapping a name searches the library for everything that person worked on. Names, roles and companies are searchable
- Google's free tier allows about 20 requests a day on the search-capable model (gemini-2.5-flash); auto-fill and Find the team share them

## Phone
- Layout: two-column grid, full-screen ad view with a sticky Done bar, fields before the search buttons, no auto-focused keyboard
- **Paste link** button next to the capture box (phones have no ⌘V); tapping the thumbnail replaces it
- Share buttons open the native share sheet (WhatsApp, Messages…) instead of copying
- Installable: `manifest.webmanifest` + icons. On Android, once installed, Reel appears in YouTube's Share menu (Web Share Target). Any `/?url=…` or `/?text=…` link saves the YouTube link inside it — usable from an iOS Shortcut

## Keyboard
- `⌘V` anywhere — save any YouTube links on the clipboard
- `⧉ Copy link` on a card or in an ad copies `https://youtu.be/<id>` for sharing
- `/` — focus search · `Esc` — close / clear search
- Paste an image while an ad is open — replaces its thumbnail

## Deploy
Vercel project `reel` (team `chabes-devs-projects`), static page + three functions in `api/`, no framework, no build step. Pushes to `main` deploy to production.

## Testing
Before shipping changes, exercise it in a real browser (Playwright + Chromium) with YouTube endpoints stubbed: link parsing (watch / youtu.be / shorts / Outlook safelinks), capture + dedupe, metadata + thumbnail storage, dead-link flagging, detail editing, tags, search (accent-insensitive), filters, persistence, delete + undo, export.
