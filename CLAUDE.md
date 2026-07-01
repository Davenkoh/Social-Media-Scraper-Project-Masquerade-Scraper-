# Holicay — Project Mas Payout Tracker (Claude project guide)

> This file is auto-loaded by Claude Code when working in this folder, so it travels with the project across
> devices (unlike `~/.claude` memory, which is per-machine). Keep project knowledge here.
> **Keys live in `secrets.env`** (gitignored), not in this guide. Load them at session start; if a key is
> still a `PASTE_…_HERE` placeholder, ask the user for it. See **Access** for the loader.

## Maintaining this guide (read before editing it)
Living doc — keep it current AND **lean**. As the workflow is used more, fold new lessons in, but think first:
**rewrite / consolidate / delete** in preference to appending. Rules: every line earns its place (a reusable
rule, fact, or gotcha — never a session play-by-play or changelog); if a new lesson generalizes or supersedes
an existing note, **replace** it rather than stack both; if something proved wrong, delete it. Aim for a sharp
operator's guide a newcomer could run from cold. Update the "Done so far" line, not a running log.

## What this project does
Refresh creator-campaign performance numbers in the Google Sheet **" Project Mas - Payout structure"**
(spreadsheetId `1rnVx2MOA3lujB8xp9Lgqn0vWZazuLYdagKkPKZMifwM`, owned by hello@holicay.com, shared with the user).
One tab per creator, plus `Overview`. Staging copies are named **`SCRAPE TEST <creator>`** /
**`TEST SCRAPE <creator>`** — edit those, not the live creator tab, unless told otherwise.

## Access
All secrets live in **`secrets.env`** (one place to swap/rotate keys): `SCRAPECREATORS_API_KEY`,
`BRIGHTDATA_API_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS` (→ the service-account JSON path),
`SPREADSHEET_ID`. Load it — shell: `set -a; source secrets.env; set +a` — or Python:
`import os; [os.environ.__setitem__(*l.strip().split('=',1)) for l in open('secrets.env') if '=' in l and not l.lstrip().startswith('#')]`
then `os.getenv('SCRAPECREATORS_API_KEY')`, etc. If a value is still `PASTE_…_HERE`, ask the user.
Service-account JSON (`holicay-402208-2761943caaf9.json`,
`holicay-message-machine@holicay-402208.iam.gserviceaccount.com`) has read+write to the sheet; google-auth
auto-reads it via `GOOGLE_APPLICATION_CREDENTIALS`. Use `google-api-python-client` + `google-auth` (installed; `gspread` is not). On macOS, Python `urllib` fails
SSL cert verify against the scraper APIs — shell out to `curl` instead. Spreadsheet locale `en_GB` (day-first
`d/m/yyyy`); timezone Asia/Singapore. Write dates as `=DATE(y,m,d)` (USER_ENTERED) so they're locale-safe and
`EOMONTH` keeps working.

## Tab layout — re-read every tab, layouts VARY
Header is ~row 10. Typical columns: S/n, Channel, Post URL, Angle, Views, Engagement(=likes), Post date,
Amount due, Paid (Y/N), Date of payment, signups, Remarks. **But layouts differ** — e.g. the Caner tab has an
extra column C (notes) shifting everything right (Channel=D … Post date=I) and stores the paid flag as
`Y`/blank in the "Amount due" column. **Formulas to NOT overwrite (replicate on new rows):** S/n `=B(prev)+1`,
Channel `=IF(SEARCH("tiktok"/"insta"/"youtube",url)…)`, Amount due `=Views/1000`, Date of payment
`=EOMONTH(postdate,0)`. Totals/`MAX`/monthly `SUMPRODUCT` sit below the data; some Total ranges are stale
(e.g. Caner `Total=SUM(G11:G81)` undercounts) — flag, don't silently "fix".
🚩 Some tabs have **no real Post URLs** (the column literally says "Tiktok"/"Instagram"); those can't be
auto-updated (no per-video key to match) — stop and tell the user.

## ⚑ Tool routing — the important rule
**Primary = CDP scrapers in `scrape/` (a real logged-in Chrome over CDP, `$0` — no paid API).** This is now
the default for all three platforms; the paid APIs below are only a fallback. Drive them via the Python
orchestrators (they map columns, match rows, refresh, append newest videos, colour, verify):
One orchestrator, `update_stats.py --platform tiktok|instagram|youtube`, drives all three:
- **TikTok** `scrape/tiktok_sweep.js`  (needs TikTok login in the Chrome profile).
- **Instagram** `scrape/instagram_sweep.js`  (**needs IG login** — views are gated logged-out;
  `node scrape/instagram_sweep.js login` opens the page, user signs in once).
- **YouTube** `scrape/youtube_sweep.js`  (**no login, no cost** — beats Bright Data; views+likes are in the
  page hydration even logged-out).
Shared Chrome lives at `~/.masquerade_chrome` on CDP :9222 (`scrape/cdp.js`); `node scrape/check_login.js`
reports session state for all three. Match rows by the id/shortcode/videoId parsed from each Post URL.
Paid-API fallback only: ScrapeCreators (TikTok/IG) / Bright Data (YouTube) — see field mappings below.

## Workflow (OODA loop, per creator tab)
**Observe** — Read the tab; map columns (varies); capture platforms (profile row), data-row range, paid flag
per row, and the **frontier = latest post date / last link already in the sheet**. Check API balances. Bail if
the tab has placeholder Post URLs (see 🚩 above).
**Orient** — Unpaid rows = Paid ≠ `Y` (literal `N` or blank, per tab) → only these get refreshed. Route each
platform (SC vs BD). "New" = posted **strictly after the frontier** (never backfill pre-campaign content).
Estimate credits/records before spending; surface if SC is low.
**Decide** — Confirm ambiguous scope with the user before writing (which "new" videos, mid-window skips,
column whitelist vs full convention, row placement: insert-in-section vs append-into-gap-before-totals).
**Act** — Scrape (below); convert dates to Asia/Singapore. Write USER_ENTERED: add/refresh a
**"Stats Last Updated"** date column (today); overwrite Views / Engagement(=likes only) / Post date on unpaid
rows only (**Paid=Y rows are frozen** — not re-scraped, unless `--all-rows`); insert+fill new rows (replicate
S/n + Channel formulas; dates via `=DATE`). **Highlight is DERIVED FROM STATE every run (idempotent), whole
data row:** Paid=Y → **cleared** (settled; the Paid column keeps its own green via conditional formatting) ·
new-this-run → 🟠 orange · unpaid+refreshed → 🟡 yellow (so last run's oranges become yellow) · unpaid+missing
→ 🔴 red. Never hard-code a colour onto a row — re-running must converge to the same picture.
**Loop** — Verify by read-back (stats populated, new rows in the right section, totals recomputed, paid rows
frozen+cleared, no red). Cache scrape output to disk so re-runs don't re-spend. → next creator.

## Scraper field mappings (validated)
**CDP scrapers (primary).** Each JS has modes; last stdout line is JSON `{"posts":{key:{views,likes,
create_time,…}},"ids":[…]}`. Sweepers intercept the site's own XHR/hydration and deep-walk for stat-bearing
objects (like the TikTok `collectItems`). Gotchas that cost real time:
- **YouTube** (`youtube_sweep.js channel|ids|sweep`, logged-out fine): per-short **views** =
  `ytInitialPlayerResponse.videoDetails.viewCount` (or `microformat…viewCount`); **likes** = deep-walk
  `ytInitialData` for `likeButtonViewModel …buttonViewModel.title`; **date** = `microformat…publishDate`
  (**Pacific** → SGT via `create_time`). Channel `/shorts` grid enumerates ids but **NOT newest-first** — always
  classify "new" by each short's own date, never by list order.
- **Instagram** (`instagram_sweep.js profile|codes`, **login required**): reels-tab `/graphql` gives
  `code`,`play_count`,`like_count` but **no timestamp** — derive date from the media `pk` snowflake:
  `unix = ((BigInt(pk) >> 23n) + 1314220021721n)/1000n` (matched ScrapeCreators taken_at 22/22). The reels feed
  **leaks foreign/suggested reels** — keep only the **dominant `user.pk`** (feed carries pk, not username).
- **new-video append** (`update_stats.py`, all three platforms): clones the section's last row (copyPaste →
  formulas/format), overwrites D/F/G/H/J/N, colours 🟠. Inserting rows **between** two sections breaks the next
  section's first S/n `=B(prev)+1` (parallel chain) — the script auto-reconnects that one cell (only when a real
  section follows, not when appending into the gap before totals).

ScrapeCreators, header `x-api-key`:
- **TikTok sweep** `GET /v3/tiktok/profile/videos?handle=<h>` (paginate `max_cursor`/`has_more`): per video
  `aweme_id`, `create_time`(unix), `statistics.play_count`=Views, `statistics.digg_count`=likes.
- **Instagram sweep** `GET /v1/instagram/user/reels?handle=<h>` (paginate `paging_info.max_id`/`more_available`):
  `code`(→`/reel/{code}/`), `taken_at`(unix), `play_count`=Views, `like_count`=likes.
- Singles (fallback): `GET /v2/tiktok/video?url=`, `GET /v1/instagram/post?url=`
  (`xdt_shortcode_media.edge_media_preview_like.count` + `video_play_count` + `taken_at_timestamp`).

Bright Data (YouTube), header `Authorization: Bearer <token>`:
1. List videos: Channels dataset `gd_lk538t2k2p1k3oos71` — `POST /datasets/v3/trigger?dataset_id=…` body
   `[{"url":"<channel_url>"}]` → poll `/datasets/v3/progress/<snap>` → `/datasets/v3/snapshot/<snap>?format=json`;
   read record's `top_videos[].video_url`.
2. Stats: Videos dataset `gd_lk56epmy2i5g7lzu0k` — collect-by-URL, body `[{"url":"…/shorts/<id>"}, …]` →
   per video `video_id`, `views`, `likes`, `num_comments`, `date_posted`(**UTC `Z`** → convert to SGT), `title`.
   (Verified to match SC's numbers.)
- YouTube RSS `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` is a free fallback but caps at the
  latest **15** entries (can miss older items). SC `/v1/youtube/video` (`viewCountInt`/`likeCountInt`/
  `publishDate`=**Pacific**→SGT) only as a tiny-volume fallback.
- Engagement = **likes only** everywhere.

## Cost rules of thumb
**CDP scrapers cost `$0`** (a local Chrome) — prefer them; the numbers below apply only to the paid-API
fallback. ScrapeCreators TikTok/IG ≈ 1 credit per 10–12 videos; YouTube ≈ 0 SC (Bright Data, ~pennies). A full
TikTok+IG sweep across all creators ≈ ~60–70 SC credits. Always estimate and warn if SC is low before spending.

## Done so far
CDP scrapers built + validated for all three platforms (`scrape/{tiktok,instagram,youtube}_sweep.js` +
`update_stats.py`). **Copy of SCRAPE TEST Gabby (ID)** fully refreshed via CDP — TikTok, Instagram (29 reels +
34 new appended), YouTube (45 shorts + 15 new) — stats+newest-videos, coloured, verified 0 blank/0 red.
Flagged but NOT added: Gabby IG mid-window skips 2026-04-08…14 (incl. `DW30EtoDxbA`, 167K views) — user's call
to backfill. Earlier: TEST SCRAPE Caner – UGX (TikTok + 2 IG) refreshed. DarioHoliday is the heavy one
(~88 YouTube shorts → now `youtube_sweep.js sweep`, $0 instead of Bright Data).
