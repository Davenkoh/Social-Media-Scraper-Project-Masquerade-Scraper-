# Project Masquerade Scraper

Refresh creator-campaign performance numbers (**views + likes + post dates**) in a Google Sheet by scraping
**TikTok, Instagram, and YouTube** — using a real logged-in Chrome driven over CDP, so there's **no paid API
and $0 cost**. It also appends each creator's **newest videos** and colour-codes every row by what happened.

Built for Holicay's "Project Mas" payout tracker, but it works on any sheet with the same column layout.

> **Using this with Claude Code?** The repo ships a [`CLAUDE.md`](CLAUDE.md) that auto-loads when you open the
> folder — it teaches your Claude the sheet layout, the scraper internals, and the exact refresh workflow.
> Point Claude at a creator tab and say "refresh the stats and add the newest videos."

---

## How it works

Each platform has a Node **sweeper** (`scrape/*_sweep.js`) that opens the site in a shared Chrome profile over
the DevTools Protocol, intercepts the site's own internal API/hydration, and prints the stats as JSON. A single
Python **orchestrator** (`update_stats.py`) reads a creator tab, matches each row to the scraped data, writes
the refreshed numbers, appends new videos, and applies the colour convention.

| Platform | Login needed? | Why |
|---|---|---|
| **YouTube** | No | views + likes are in the page hydration even logged-out |
| **TikTok** | Yes | exact counts only render for a real session |
| **Instagram** | Yes | view/play count is gated behind a session (likes show logged-out; views don't) |

**Highlight convention** (derived from state every run — re-running converges to the same picture):

- 🟡 **yellow** — unpaid row, stats refreshed this run
- 🟠 **orange** — brand-new video added this run (next run it becomes yellow)
- 🔴 **red** — row couldn't be matched/scraped
- **cleared** (no fill) — Paid = `Y` row: settled, frozen, not re-scraped (the Paid column keeps its own green)

---

## Prerequisites

- **macOS** with **Google Chrome** installed
- **Node.js** 18+ and **Python** 3.9+
- A **Google Cloud service account** with the **Sheets API** enabled, and your spreadsheet **shared with the
  service account's e-mail** as Editor

## Setup

```bash
# 1. Node deps for the CDP scrapers
cd scrape && npm install && cd ..

# 2. Python deps
pip install -r requirements.txt

# 3. Secrets — copy the template and fill it in
cp secrets.env.example secrets.env
#   • put your service-account JSON somewhere gitignored (repo root is fine)
#   • set GOOGLE_APPLICATION_CREDENTIALS + SPREADSHEET_ID in secrets.env

# 4. One-time logins for TikTok + Instagram (opens Chrome; sign in once, session persists)
node scrape/tiktok_sweep.js login
node scrape/instagram_sweep.js login
node scrape/check_login.js          # confirm session state for all three
```

The scrapers share a persistent Chrome profile at `~/.masquerade_chrome` on CDP port `9222`
(launched automatically if it isn't already running). Override with `MASQ_CHROME_PROFILE` / `MASQ_CDP`.

## Usage

Two steps per platform: **sweep** (Node → cache file) then **update** (Python → sheet).

```bash
# ── YouTube (no login) ──────────────────────────────────────────────
node scrape/youtube_sweep.js sweep <CHANNEL_ID>  > cache_yt_gabby_cdp.json
python3 update_stats.py --platform youtube

# ── Instagram (needs login) ─────────────────────────────────────────
node scrape/instagram_sweep.js profile <handle>  > cache_ig_gabby_cdp.json
python3 update_stats.py --platform instagram

# ── TikTok (needs login) ────────────────────────────────────────────
node scrape/tiktok_sweep.js profile "@<handle>"  > cache_tiktok_gabby_cdp.json
python3 update_stats.py --platform tiktok
```

Useful flags on `update_stats.py`:

| Flag | Effect |
|---|---|
| `--dry-run` | print the plan, write nothing |
| `--no-new` | refresh + recolour only; don't append new videos |
| `--all-rows` | also re-scrape Paid = `Y` rows (they stay cleared, just refreshed) |
| `--tab "<name>"` | target a different sheet tab |
| `--cache <path>` | use a specific sweep cache file |

`dump_tab.py "<tab name>"` prints a tab's column map + rows — handy before a run, or for your Claude to orient.

## Adapting to your own sheet / creators

`update_stats.py` defaults (tab name, per-platform cache filenames) are set for the Holicay "Gabby" example at
the top of the file — override them with `--tab` / `--cache`, or edit the defaults. The orchestrator finds the
header row by looking for **`S/n` + `Post URL`** and maps columns by name (`Views`, `Engagement`, `Post date`,
`Paid (Y/N)`, `Stats Last Updated`), so any tab with those headers works. See [`CLAUDE.md`](CLAUDE.md) for the
full column/layout notes and gotchas.

## Repo layout

```
scrape/
  cdp.js               shared CDP connector (launches/attaches Chrome)
  check_login.js       report login state for tiktok / instagram / youtube
  tiktok_sweep.js      TikTok sweeper   (profile | ids | login | check)
  instagram_sweep.js   Instagram sweeper (profile | codes | login | check)
  youtube_sweep.js     YouTube sweeper  (channel | ids | sweep)
update_stats.py        orchestrator: refresh + append newest + colour + verify
dump_tab.py            inspect a tab's columns/rows
CLAUDE.md              project guide (auto-loads in Claude Code)
secrets.env.example    template for your keys/config
```

## Security

`secrets.env`, service-account JSON keys, and scrape caches are all gitignored — **never commit them**. Rotate a
leaked service-account key in the GCP console.
