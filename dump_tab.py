#!/usr/bin/env python3
"""dump_tab.py — print a creator tab so we can map its columns/rows before writing.
Shows both FORMATTED (what the user sees) and a compact per-row view of the data
rows with Post URL + platform classification + Paid flag + Post-date serial."""
import os, sys, re
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


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


def serial_to_iso(v):
    if isinstance(v, (int, float)) and v > 1000:
        return (date(1899, 12, 30) + timedelta(days=int(v))).isoformat()
    return ""


def platform(url):
    u = (url or "").lower()
    if "tiktok.com" in u: return "TT"
    if "instagram.com" in u: return "IG"
    if "youtube.com" in u or "youtu.be" in u: return "YT"
    return "?"


def main():
    tab = sys.argv[1] if len(sys.argv) > 1 else "Copy of SCRAPE TEST Gabby (ID)"
    load_env()
    svc = service()
    SID = os.environ["SPREADSHEET_ID"]

    # formatted (what user sees) + unformatted (serials, exact numbers)
    fmt = svc.values().get(spreadsheetId=SID, range=f"'{tab}'!A1:AC300",
                           valueRenderOption="FORMATTED_VALUE").execute().get("values", [])
    raw = svc.values().get(spreadsheetId=SID, range=f"'{tab}'!A1:AC300",
                           valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])

    print(f"=== TAB: {tab!r} ===  ({len(fmt)} rows)\n")
    print("--- TOP 12 ROWS (formatted) ---")
    for i, row in enumerate(fmt[:12]):
        cells = " | ".join(f"{col_a1(j)}:{c}" for j, c in enumerate(row) if str(c).strip())
        print(f"r{i+1:>2}: {cells}")

    # find header row
    hdr_i = next((i for i, r in enumerate(fmt) if "S/n" in r and "Post URL" in r), None)
    print(f"\n--- HEADER ROW = {hdr_i+1 if hdr_i is not None else '??'} ---")
    if hdr_i is None:
        return
    header = fmt[hdr_i]
    col = {name: idx for idx, name in enumerate(header) if str(name).strip()}
    print("cols:", {k: col_a1(v) for k, v in col.items()})

    pu = col.get("Post URL")
    pd = col.get("Post date")
    paidc = col.get("Paid (Y/N)")
    print(f"\n--- DATA ROWS (from r{hdr_i+2}) ---")
    print(f"{'row':>3} {'plt':>3} {'paid':>4} {'postdate':>11}  URL")
    counts = {}
    for i in range(hdr_i + 1, len(fmt)):
        row = raw[i] if i < len(raw) else []
        frow = fmt[i] if i < len(fmt) else []
        url = row[pu] if pu is not None and len(row) > pu else ""
        if not str(url).strip():
            # could be a totals/summary row — show if any content
            content = " | ".join(f"{col_a1(j)}:{c}" for j, c in enumerate(frow) if str(c).strip())
            if content:
                print(f"r{i+1:>2}  --- {content[:120]}")
            continue
        plt = platform(str(url))
        counts[plt] = counts.get(plt, 0) + 1
        paid = row[paidc] if paidc is not None and len(row) > paidc else ""
        ds = serial_to_iso(row[pd]) if pd is not None and len(row) > pd else ""
        print(f"r{i+1:>3} {plt:>3} {str(paid):>4} {ds:>11}  {str(url)[:78]}")
    print(f"\nplatform counts: {counts}")


if __name__ == "__main__":
    main()
