#!/usr/bin/env python3
"""
update_stats.py — refresh a creator tab's stats from the CDP sweepers
(scrape/{tiktok,instagram,youtube}_sweep.js) and append the newest videos.
One orchestrator for all three platforms — no paid API.

  Observe  read tab; map columns; collect this platform's rows; parse each Post URL's
           key (TT aweme_id / IG shortcode / YT videoId); frontier = latest Post date.
  Orient   load the sweep cache (unified {"posts":{key:{views,likes,create_time}},"ids":[…]});
           auto-fetch any sheet key the cache missed; NEW = swept ids not in the sheet
           whose SGT date > frontier.
  Act      refresh Views/Engagement(=likes)/Stats-Last-Updated on UNPAID rows (Post date
           only when it changed); append new videos as fresh rows (formulas cloned from
           the section's last row). Highlight is DERIVED FROM STATE every run (idempotent):
             • Paid=Y  -> cleared (settled; the Paid column keeps its own green via CF)
             • new this run        -> 🟠 orange
             • unpaid + refreshed  -> 🟡 yellow   (so last run's oranges become yellow)
             • unpaid + not found  -> 🔴 red
           Paid rows are frozen (not re-scraped) unless --all-rows.
  Loop     read back and verify.

Usage:
  python3 update_stats.py --platform youtube               # refresh unpaid + append new
  python3 update_stats.py --platform instagram --no-new    # refresh/recolour only
  python3 update_stats.py --platform tiktok --dry-run
  python3 update_stats.py --platform youtube --all-rows    # also re-scrape paid rows
"""
import argparse, json, os, re, subprocess, sys
from datetime import datetime, date, timezone, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
SGT = timezone(timedelta(hours=8))
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
YELLOW = {"red": 1.0,  "green": 0.92, "blue": 0.60}   # 🟡 updated
ORANGE = {"red": 1.0,  "green": 0.75, "blue": 0.40}   # 🟠 new video
RED    = {"red": 0.96, "green": 0.60, "blue": 0.60}   # 🔴 couldn't find
WHITE  = {"red": 1.0,  "green": 1.0,  "blue": 1.0}    # cleared (settled/paid)

DEFAULT_TAB = "Copy of SCRAPE TEST Gabby (ID)"


def parse_tt(url):
    m = re.search(r"/(?:video|photo)/(\d+)", url or "")
    return m.group(1) if m else None


def parse_ig(url):
    m = re.search(r"instagram\.com/(?:reel|reels|p|tv)/([\w-]+)", url or "")
    return m.group(1) if m else None


def parse_yt(url):
    m = re.search(r"(?:/shorts/|/watch\?v=|youtu\.be/|/embed/|/live/)([\w-]{11})", url or "")
    return m.group(1) if m else None


PLATFORMS = {
    "tiktok":    {"host": "tiktok.com",    "key": parse_tt, "sweep": "tiktok_sweep.js",
                  "cache": "cache_tiktok_gabby_cdp.json", "fetch_mode": "ids",
                  "new_url": lambda k, h: f"https://www.tiktok.com/@{h}/video/{k}"},
    "instagram": {"host": "instagram.com", "key": parse_ig, "sweep": "instagram_sweep.js",
                  "cache": "cache_ig_gabby_cdp.json", "fetch_mode": "codes",
                  "new_url": lambda k, h: f"https://www.instagram.com/reel/{k}/"},
    "youtube":   {"host": "youtube.com",   "key": parse_yt, "sweep": "youtube_sweep.js",
                  "cache": "cache_yt_gabby_cdp.json", "fetch_mode": "ids",
                  "new_url": lambda k, h: f"https://www.youtube.com/shorts/{k}"},
}


def load_env():
    for line in open(os.path.join(ROOT, "secrets.env")):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)


def service():
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    cred = os.environ["GOOGLE_APPLICATION_CREDENTIALS"]
    if not os.path.isabs(cred):
        cred = os.path.join(ROOT, cred)
    creds = Credentials.from_service_account_file(cred, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds).spreadsheets()


def col_a1(idx):
    s = ""; idx += 1
    while idx:
        idx, r = divmod(idx - 1, 26)
        s = chr(65 + r) + s
    return s


def sgt_date(create_time):
    return datetime.fromtimestamp(int(create_time), SGT).date()


def to_serial(d):
    return (d - date(1899, 12, 30)).days


def tt_handle(rows):
    for (_, _, _, _, url) in rows:
        m = re.search(r"tiktok\.com/@([\w.]+)", url or "")
        if m:
            return m.group(1)
    return "tiktok"


def fetch_missing(plat, keys):
    if not keys:
        return {}
    node = os.path.join(ROOT, "scrape", plat["sweep"])
    print(f"[fetch] {len(keys)} key(s) missing from cache -> sweeping individually …", file=sys.stderr)
    res = subprocess.run(["node", node, plat["fetch_mode"], ",".join(keys)],
                         capture_output=True, text=True, timeout=900)
    for ln in reversed((res.stdout or "").strip().splitlines()):
        if ln.strip().startswith("{"):
            return json.loads(ln.strip()).get("posts", {})
    print(f"[fetch] failed:\n{res.stderr[-500:]}", file=sys.stderr)
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--platform", required=True, choices=list(PLATFORMS))
    ap.add_argument("--tab", default=DEFAULT_TAB)
    ap.add_argument("--cache", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-new", action="store_true", help="refresh/recolour only; don't append")
    ap.add_argument("--all-rows", action="store_true",
                    help="also re-scrape Paid=Y rows (still cleared, not highlighted)")
    a = ap.parse_args()
    plat = PLATFORMS[a.platform]
    cache_path = a.cache or os.path.join(ROOT, plat["cache"])

    load_env()
    svc = service()
    SID = os.environ["SPREADSHEET_ID"]

    meta = svc.get(spreadsheetId=SID).execute()
    gid = next((s["properties"]["sheetId"] for s in meta["sheets"]
                if s["properties"]["title"] == a.tab), None)
    if gid is None:
        sys.exit(f"[sheet] tab not found: {a.tab!r}")

    grid = svc.values().get(spreadsheetId=SID, range=f"'{a.tab}'!A1:AC400",
                            valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    hdr_i = next((i for i, r in enumerate(grid) if "S/n" in r and "Post URL" in r), None)
    if hdr_i is None:
        sys.exit("[sheet] couldn't find header row (S/n + Post URL)")
    col = {name: idx for idx, name in enumerate(grid[hdr_i]) if name}
    for n in ["S/n", "Post URL", "Views", "Engagement", "Post date", "Paid (Y/N)", "Stats Last Updated"]:
        if n not in col:
            sys.exit(f"[sheet] header missing column {n!r} (have {list(col)})")
    cURL, cV, cE, cD, cP, cU = (col["Post URL"], col["Views"], col["Engagement"],
                                col["Post date"], col["Paid (Y/N)"], col["Stats Last Updated"])

    rows, last_row = [], hdr_i
    for i in range(hdr_i + 1, len(grid)):
        row = grid[i]
        url = row[cURL] if len(row) > cURL else ""
        if not isinstance(url, str) or plat["host"] not in url:
            continue
        paid = str(row[cP]).strip().upper() if len(row) > cP else ""
        odate = row[cD] if len(row) > cD else ""
        rows.append((i + 1, plat["key"](url), paid, odate, url))
        last_row = i
    if not rows:
        sys.exit(f"[sheet] no {a.platform} rows found")
    sheet_keys = {k for (_, k, _, _, _) in rows if k}
    frontier = None
    for (_, _, _, od, _) in rows:
        if isinstance(od, (int, float)) and od > 1000:
            d = date(1899, 12, 30) + timedelta(days=int(od))
            frontier = d if frontier is None else max(frontier, d)
    handle = tt_handle(rows) if a.platform == "tiktok" else ""
    print(f"[sheet] {a.platform}: {len(rows)} rows (r{rows[0][0]}–r{rows[-1][0]}); frontier={frontier}")

    if not os.path.exists(cache_path):
        sys.exit(f"[cache] missing {cache_path} — run the sweep first")
    sweep = json.load(open(cache_path))
    posts = dict(sweep.get("posts", {}))
    chan_ids = list(sweep.get("ids") or posts.keys())
    # only fetch stats for rows we'll actually refresh (paid rows are frozen -> skip them)
    refresh_keys = {k for (_, k, paid, _, _) in rows if k and (paid != "Y" or a.all_rows)}
    miss = [k for k in refresh_keys if k not in posts]
    if miss:
        fetched = fetch_missing(plat, miss)
        posts.update(fetched)
        if fetched:                        # persist so subsequent runs don't re-fetch
            out = dict(sweep); out["posts"] = posts
            json.dump(out, open(cache_path, "w"), indent=2)

    today = datetime.now(SGT).date()
    value_updates, yellow, red, clear, report, still_missing = [], [], [], [], [], []

    # ── refresh (unpaid rows) / clear (paid rows) ──
    for (rn, key, paid, odate, url) in rows:
        is_paid = (paid == "Y")
        if is_paid:
            clear.append(rn)                       # settled -> unhighlighted (idempotent)
        if is_paid and not a.all_rows:
            continue                               # frozen: don't re-scrape paid rows
        p = posts.get(key)
        if not p or (p.get("views") in ("", None) and p.get("likes") in ("", None)):
            if not is_paid:
                red.append(rn); still_missing.append((rn, key, url))
            continue
        value_updates.append({"range": f"'{a.tab}'!{col_a1(cV)}{rn}", "values": [[p["views"]]]})
        value_updates.append({"range": f"'{a.tab}'!{col_a1(cE)}{rn}", "values": [[p["likes"]]]})
        value_updates.append({"range": f"'{a.tab}'!{col_a1(cU)}{rn}",
                              "values": [[f"=DATE({today.year},{today.month},{today.day})"]]})
        dc = ""
        if p.get("create_time"):
            sd = sgt_date(p["create_time"])
            if not isinstance(odate, (int, float)) or int(odate) != to_serial(sd):
                value_updates.append({"range": f"'{a.tab}'!{col_a1(cD)}{rn}",
                                      "values": [[f"=DATE({sd.year},{sd.month},{sd.day})"]]})
                dc = f" date→{sd.isoformat()}"
        if not is_paid:
            yellow.append(rn)
        report.append((rn, key, p["views"], p["likes"], paid, dc))

    # ── new videos (swept ids not in sheet, posted after frontier) ──
    new_vids = []
    if not a.no_new and frontier is not None:
        for k in chan_ids:
            if k in sheet_keys:
                continue
            p = posts.get(k)
            if not p or not p.get("create_time"):
                continue
            sd = sgt_date(p["create_time"])
            if sd > frontier:
                new_vids.append((k, sd, p))
        new_vids.sort(key=lambda t: t[1])

    print(f"\n{'row':>4} {'key':>16} {'Views':>8} {'Likes':>6} paid")
    for (rn, key, v, l, paid, dc) in report:
        print(f"{rn:>4} {str(key):>16} {str(v):>8} {str(l):>6} {paid}{dc}")
    print(f"\n[plan] {len(yellow)} refreshed 🟡, {len(clear)} paid→cleared"
          + (f", {len(red)} missing 🔴" if red else "")
          + (f"; append {len(new_vids)} new 🟠" if new_vids else "; no new videos"))
    for (rn, key, url) in still_missing:
        print(f"  🔴 row {rn}: {key} not found — {url}")
    for (k, sd, p) in new_vids:
        print(f"  🟠 NEW {k}  {sd.isoformat()}  views={p['views']} likes={p['likes']}  {str(p.get('title',''))[:44]}")

    if a.dry_run:
        print("\n[dry-run] no writes.")
        return

    if value_updates:
        svc.values().batchUpdate(spreadsheetId=SID, body={
            "valueInputOption": "USER_ENTERED", "data": value_updates}).execute()
        print(f"\n[write] refreshed {len(report)} rows ({len(value_updates)} cells)")

    orange = []
    if new_vids:
        # is there another section immediately below (its 1st S/n would need reconnecting)?
        nxt_row = grid[last_row + 1] if last_row + 1 < len(grid) else []
        has_next = len(nxt_row) > cURL and isinstance(nxt_row[cURL], str) and nxt_row[cURL].strip() != ""
        orange = append_new(svc, SID, gid, a.tab, col, last_row, new_vids, today, plat, handle, has_next)

    # ── highlight: derive from state, whole data row (Paid col keeps its CF green) ──
    lo, hi = min(col.values()), max(col.values())
    reqs = []
    def paint(rn, rgb):
        reqs.append({"repeatCell": {
            "range": {"sheetId": gid, "startRowIndex": rn - 1, "endRowIndex": rn,
                      "startColumnIndex": lo, "endColumnIndex": hi + 1},
            "cell": {"userEnteredFormat": {"backgroundColor": rgb}},
            "fields": "userEnteredFormat.backgroundColor"}})
    # orange rows shift down if IG/TT inserted; append_new already coloured them, skip here
    for rn in clear:  paint(rn, WHITE)
    for rn in yellow: paint(rn, YELLOW)
    for rn in red:    paint(rn, RED)
    if reqs:
        svc.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
        print(f"[colour] {len(yellow)} 🟡  {len(clear)} cleared  {len(red)} 🔴  {len(orange)} 🟠")

    verify(svc, SID, a.tab, col, report)


def append_new(svc, SID, gid, tab, col, last_row_idx0, new_vids, today, plat, handle, has_next):
    n = len(new_vids)
    src = last_row_idx0
    start = last_row_idx0 + 1
    ncols = max(col.values()) + 1
    svc.batchUpdate(spreadsheetId=SID, body={"requests": [
        {"insertDimension": {"range": {"sheetId": gid, "dimension": "ROWS",
                                       "startIndex": start, "endIndex": start + n},
                             "inheritFromBefore": True}},
        {"copyPaste": {
            "source": {"sheetId": gid, "startRowIndex": src, "endRowIndex": src + 1,
                       "startColumnIndex": 0, "endColumnIndex": ncols},
            "destination": {"sheetId": gid, "startRowIndex": start, "endRowIndex": start + n,
                            "startColumnIndex": 0, "endColumnIndex": ncols},
            "pasteType": "PASTE_NORMAL"}},
    ]}).execute()

    cURL, cV, cE, cD, cP, cU = (col["Post URL"], col["Views"], col["Engagement"],
                                col["Post date"], col["Paid (Y/N)"], col["Stats Last Updated"])
    data, orange = [], []
    for j, (k, sd, p) in enumerate(new_vids):
        rn = start + j + 1
        data += [
            {"range": f"'{tab}'!{col_a1(cURL)}{rn}", "values": [[plat["new_url"](k, handle)]]},
            {"range": f"'{tab}'!{col_a1(cV)}{rn}",   "values": [[p["views"]]]},
            {"range": f"'{tab}'!{col_a1(cE)}{rn}",   "values": [[p["likes"]]]},
            {"range": f"'{tab}'!{col_a1(cD)}{rn}",   "values": [[f"=DATE({sd.year},{sd.month},{sd.day})"]]},
            {"range": f"'{tab}'!{col_a1(cP)}{rn}",   "values": [["N"]]},
            {"range": f"'{tab}'!{col_a1(cU)}{rn}",   "values": [[f"=DATE({today.year},{today.month},{today.day})"]]},
        ]
        orange.append(rn)
    svc.values().batchUpdate(spreadsheetId=SID, body={
        "valueInputOption": "USER_ENTERED", "data": data}).execute()

    lo, hi = min(col.values()), max(col.values())
    reqs = [{"repeatCell": {
        "range": {"sheetId": gid, "startRowIndex": rn - 1, "endRowIndex": rn,
                  "startColumnIndex": lo, "endColumnIndex": hi + 1},
        "cell": {"userEnteredFormat": {"backgroundColor": ORANGE}},
        "fields": "userEnteredFormat.backgroundColor"}} for rn in orange]
    svc.batchUpdate(spreadsheetId=SID, body={"requests": reqs}).execute()
    # reconnect the S/n chain ONLY when a real section follows: its first row still
    # refs the pre-insert row, spawning a parallel chain. (No-op when appending into a gap.)
    if has_next:
        b = col_a1(col["S/n"]); nxt = start + n + 1     # 1-based row below the appended block
        svc.values().update(spreadsheetId=SID, range=f"'{tab}'!{b}{nxt}",
                            valueInputOption="USER_ENTERED",
                            body={"values": [[f"={b}{nxt-1}+1"]]}).execute()
    print(f"[append] added {n} new row(s) at r{start+1}–r{start+n} 🟠")
    return orange


def verify(svc, SID, tab, col, report):
    cV, cE = col["Views"], col["Engagement"]
    vr = svc.values().get(spreadsheetId=SID, range=f"'{tab}'!A1:AC400",
                          valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    ok = 0
    for (rn, key, v, l, paid, dc) in report:
        r = vr[rn - 1] if rn - 1 < len(vr) else []
        if (r[cV] if len(r) > cV else None) == v and (r[cE] if len(r) > cE else None) == l:
            ok += 1
        else:
            print(f"  [verify] row {rn}: mismatch")
    print(f"[verify] {ok}/{len(report)} refreshed rows confirmed")


if __name__ == "__main__":
    main()
