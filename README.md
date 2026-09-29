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
- Local-only storage (`localStorage`, key `reel_v1`) with Export / Import JSON backup; sync is a possible later step
- No video downloads; must stay free
- Metadata via YouTube oEmbed (fallback: noembed.com); thumbnails from i.ytimg.com
- Paste accepts whole emails — Outlook safelinks and `&amp;` are unwrapped

## Keyboard
- `⌘V` anywhere — save any YouTube links on the clipboard
- `/` — focus search · `Esc` — close / clear search
- Paste an image while an ad is open — replaces its thumbnail

## Deploy
Vercel project `reel` (team `chabes-devs-projects`), static, no framework. Pushes to `main` deploy to production.

## Testing
Before shipping changes, exercise it in a real browser (Playwright + Chromium) with YouTube endpoints stubbed: link parsing (watch / youtu.be / shorts / Outlook safelinks), capture + dedupe, metadata + thumbnail storage, dead-link flagging, detail editing, tags, search (accent-insensitive), filters, persistence, delete + undo, export.
