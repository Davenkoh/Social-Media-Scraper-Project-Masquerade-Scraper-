#!/usr/bin/env node
/**
 * tiktok_sweep.js — read TikTok post stats from a logged-in Chrome over CDP.
 *
 * The tracker's replacement for the ScrapeCreators `tiktok/profile/videos` sweep.
 * Referenced from Project Ana's engine/scrape/{tiktok_profile,extract_stats}.js and
 * reimplemented standalone here (no paid API). TikTok serves a post's exact counts
 * only to a real browser session, so we drive the shared logged-in Chrome profile.
 *
 * Data sources, richest first (same priority Project Ana settled on):
 *   1. /api/post/item_list/  XHR feed  — one profile scroll yields every post's itemStruct
 *      (playCount / diggCount / createTime). This is the cheap "sweep".
 *   2. /api/item/detail/     XHR       — per-post fallback (the one place a photo post's
 *      views still live) for any id the sweep missed.
 *   3. hydration JSON (__UNIVERSAL_DATA_FOR_REHYDRATION__ / SIGI_STATE) — seeds page 1.
 *
 * Modes:
 *   node tiktok_sweep.js profile "@handle"              # sweep the whole profile
 *   node tiktok_sweep.js ids "<id1,id2,...>" "@handle"  # per-post fallback via item/detail
 *   node tiktok_sweep.js login                          # open TikTok login, wait for session
 *   node tiktok_sweep.js check                          # report login state (exit 0=in, 2=out)
 *
 * Output (stdout, last line, for profile/ids):
 *   {"author":"..","loggedIn":true,"count":N,"posts":{"<aweme_id>":
 *      {"views":..,"likes":..,"comments":..,"share":..,"save":..,
 *       "create_time":<unix>,"posting_date":"YYYY-MM-DD","type":"video|photo"}, ...}}
 */
const { connect, context, isLoggedIn } = require('./cdp');

// ── count parsing ("1.2M"/"12.5K"/"1,234"/1234 -> integer, "" when absent) ────
function parseCount(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).trim().replace(/,/g, '');
  const mult = { k: 1e3, m: 1e6, b: 1e9 };
  const mm = s.match(/^([\d.]+)\s*([kmb])$/i);
  if (mm) return Math.round(parseFloat(mm[1]) * mult[mm[2].toLowerCase()]);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : '';
}

// unix seconds -> "YYYY-MM-DD" (UTC; the tracker converts to SGT when writing dates)
function postingDate(createTime) {
  const t = parseInt(createTime, 10);
  if (!Number.isFinite(t) || t <= 0) return '';
  return new Date(t * 1000).toISOString().slice(0, 10);
}

// Normalise one TikTok itemStruct (from either feed) into our flat post record.
function toPost(it, fallbackAuthor) {
  const st = Object.assign({}, it.stats || {}, it.statsV2 || {});
  const author = (it.author && (it.author.uniqueId || it.author.id)) || fallbackAuthor || '';
  return {
    id: it.id,
    author,
    type: it.imagePost ? 'photo' : 'video',
    views: parseCount(st.playCount),
    likes: parseCount(st.diggCount),
    comments: parseCount(st.commentCount),
    share: parseCount(st.shareCount),
    save: parseCount(st.collectCount),
    create_time: parseInt(it.createTime, 10) || '',
    posting_date: postingDate(it.createTime),
  };
}

// Deep-walk any JSON, collecting post-shaped objects (numeric id + stats{}) keyed by id.
function collectItems(root, into) {
  const stack = [root]; let hops = 0;
  while (stack.length && hops < 500000) {
    const cur = stack.pop(); hops++;
    if (cur && typeof cur === 'object') {
      const st = cur.stats || cur.statsV2;
      if (typeof cur.id === 'string' && /^\d{6,}$/.test(cur.id) &&
          st && typeof st === 'object' && ('diggCount' in st || 'playCount' in st)) {
        // keep the richest sighting (one that carries createTime + author)
        const prev = into.get(cur.id);
        const score = (cur.createTime ? 2 : 0) + (cur.author ? 1 : 0);
        if (!prev || score > prev._score) { cur._score = score; into.set(cur.id, cur); }
      }
      for (const k in cur) { const v = cur[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }
}

// ── profile sweep ─────────────────────────────────────────────────────────────
async function sweepProfile(handle) {
  const url = `https://www.tiktok.com/@${handle}`;
  const browser = await connect();
  const ctx = await context(browser);
  const loggedIn = await isLoggedIn(ctx);
  const page = await ctx.newPage();
  const items = new Map();

  page.on('response', async (resp) => {
    if (!/\/api\/post\/item_list/.test(resp.url())) return;
    try { collectItems(JSON.parse(await resp.text()), items); } catch (_) {}
  });

  await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  // seed from the server-rendered hydration (first page is often not an XHR)
  try {
    const hydration = await page.evaluate(() => {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
                 document.getElementById('SIGI_STATE');
      return el ? el.textContent : null;
    });
    if (hydration) collectItems(JSON.parse(hydration), items);
  } catch (_) {}

  // scroll to paginate until the harvested count stops growing (or a hard cap)
  let last = items.size, stable = 0;
  for (let i = 0; i < 80 && stable < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    if (items.size === last) stable++; else { stable = 0; last = items.size; }
    if (i % 5 === 0) console.error(`[sweep] scrolled ${i}x, ${items.size} posts so far`);
  }

  const author = [...items.values()][0]?.author?.uniqueId || handle;
  const posts = {};
  for (const it of items.values()) { const p = toPost(it, author); delete it._score; posts[p.id] = p; }

  console.error(`[sweep] @${author}: ${Object.keys(posts).length} posts (loggedIn=${loggedIn})`);
  await page.close().catch(() => {});
  await browser.close().catch(() => {});   // detaches CDP; leaves Chrome running
  return { author, loggedIn, count: Object.keys(posts).length, posts };
}

// ── per-post fallback via /api/item/detail/ ───────────────────────────────────
async function fetchByIds(ids, handle) {
  const browser = await connect();
  const ctx = await context(browser);
  const loggedIn = await isLoggedIn(ctx);
  const posts = {};
  for (const id of ids) {
    const page = await ctx.newPage();
    let found = null;
    page.on('response', async (resp) => {
      if (found) return;
      if (!/\/api\/item\/detail\/?(\?|$)/.test(resp.url())) return;
      try {
        const body = await resp.text();
        if (!/playCount|diggCount/.test(body)) return;
        const bag = new Map(); collectItems(JSON.parse(body), bag);
        found = [...bag.values()].find(it => it.id === id) || [...bag.values()][0] || null;
      } catch (_) {}
    });
    const url = `https://www.tiktok.com/@${handle || 'tiktok'}/video/${id}`;
    await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    // also read hydration in case detail XHR didn't fire
    if (!found) {
      try {
        const hy = await page.evaluate(() => {
          const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
                     document.getElementById('SIGI_STATE');
          return el ? el.textContent : null;
        });
        if (hy) { const bag = new Map(); collectItems(JSON.parse(hy), bag);
                  found = bag.get(id) || [...bag.values()][0] || null; }
      } catch (_) {}
    }
    await page.waitForTimeout(1500);
    if (found) { const p = toPost(found, handle); delete found._score; posts[p.id] = p;
                 console.error(`[detail] ${id}: views=${p.views} likes=${p.likes}`); }
    else console.error(`[detail] ${id}: NOT FOUND`);
    await page.close().catch(() => {});
  }
  await browser.close().catch(() => {});
  return { author: handle || '', loggedIn, count: Object.keys(posts).length, posts };
}

// ── login helpers ─────────────────────────────────────────────────────────────
async function loginFlow(openIt) {
  const browser = await connect();
  const ctx = await context(browser);
  if (await isLoggedIn(ctx)) {
    console.error('[login] TikTok: LOGGED IN ✓');
    await browser.close().catch(() => {});
    return true;
  }
  if (!openIt) {
    console.error('[login] TikTok: LOGGED OUT ✗  (run: node tiktok_sweep.js login)');
    await browser.close().catch(() => {});
    return false;
  }
  const page = (await ctx.pages())[0] || await ctx.newPage();
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  console.error('[login] Opened TikTok login in the CDP Chrome. Log in, then wait…');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(ctx)) {
      console.error('[login] session detected ✓');
      await browser.close().catch(() => {});
      return true;
    }
  }
  console.error('[login] timed out — still logged out');
  await browser.close().catch(() => {});
  return false;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
(async () => {
  const mode = process.argv[2];
  const clean = (s) => (s || '').replace(/^https?:\/\/[^/]+\//, '').replace(/^@/, '').split(/[/?]/)[0];

  if (mode === 'login')  { process.exit(await loginFlow(true)  ? 0 : 2); }
  if (mode === 'check')  { process.exit(await loginFlow(false) ? 0 : 2); }

  if (mode === 'profile') {
    const handle = clean(process.argv[3]);
    if (!handle) { console.error('usage: node tiktok_sweep.js profile "@handle"'); process.exit(1); }
    const out = await sweepProfile(handle);
    console.log(JSON.stringify(out));
    return;
  }
  if (mode === 'ids') {
    const ids = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);
    const handle = clean(process.argv[4]);
    if (!ids.length) { console.error('usage: node tiktok_sweep.js ids "id1,id2" "@handle"'); process.exit(1); }
    const out = await fetchByIds(ids, handle);
    console.log(JSON.stringify(out));
    return;
  }
  console.error('usage: node tiktok_sweep.js <profile|ids|login|check> ...');
  process.exit(1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
