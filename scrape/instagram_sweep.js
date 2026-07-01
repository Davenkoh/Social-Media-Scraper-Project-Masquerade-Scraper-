#!/usr/bin/env node
/**
 * instagram_sweep.js — read Instagram reel stats from a logged-in Chrome over CDP.
 *
 * The tracker's CDP replacement for the ScrapeCreators instagram/user/reels sweep.
 * Like TikTok, IG serves a reel's VIEW/play count only to a real session — logged
 * out the reel page carries `if_not_gated_logged_out` with like_count but NO play
 * count. So we drive the shared logged-in Chrome profile (log in once via `login`).
 *
 * Data sources, richest first:
 *   1. /graphql/query  XHR on the profile /reels/ tab — the clips connection lists
 *      every reel's media (code / play_count / like_count / taken_at). The cheap sweep.
 *   2. inline <script type="application/json"> hydration — seeds page 1.
 *   3. per-reel /reel/<code>/ page (codes mode) — fallback for anything the sweep missed.
 *
 * Modes:
 *   node instagram_sweep.js profile "<handle>"          # sweep the whole reels tab
 *   node instagram_sweep.js codes "<c1,c2,...>"         # per-reel fallback
 *   node instagram_sweep.js login                       # open IG login, wait for session
 *   node instagram_sweep.js check                       # report login state (exit 0=in,2=out)
 *
 * Output (stdout, last line): {"handle":..,"loggedIn":true,"count":N,"posts":{"<code>":
 *   {"views":..,"likes":..,"comments":..,"create_time":<unix>,"posting_date":"YYYY-MM-DD"}},
 *   "ids":[<code>,...]}
 */
const { connect, context } = require('./cdp');

function parseCount(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).trim().replace(/,/g, '');
  const mm = s.match(/^([\d.]+)\s*([kmb])$/i);
  if (mm) return Math.round(parseFloat(mm[1]) * { k: 1e3, m: 1e6, b: 1e9 }[mm[2].toLowerCase()]);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : '';
}

async function isLoggedIn(ctx) {
  const cs = await ctx.cookies('https://www.instagram.com');
  const names = new Set(cs.filter(c => c.value).map(c => c.name));
  return names.has('sessionid') && names.has('ds_user_id');
}

// The reels-tab feed carries NO timestamp field — but an IG media `pk` is a snowflake
// whose high bits encode the creation time: ms = (pk >> 23) + IG_EPOCH_MS. (Verified to
// reproduce ScrapeCreators' taken_at to the day, 22/22.) taken_at wins if ever present.
const IG_EPOCH_MS = 1314220021721n;
function igCreateTime(o) {
  const t = parseInt(o.taken_at ?? o.taken_at_timestamp ?? o.device_timestamp, 10);
  if (Number.isFinite(t) && t > 0) return t;
  let pk = o.pk ?? o.id;
  if (typeof pk === 'string' && pk.includes('_')) pk = pk.split('_')[0];  // id = "{pk}_{userid}"
  try {
    if (pk !== undefined && /^\d+$/.test(String(pk)))
      return Number(((BigInt(String(pk)) >> 23n) + IG_EPOCH_MS) / 1000n);
  } catch (_) {}
  return '';
}

// A "reel media" object: has a shortcode `code` plus a play/view count and/or like_count.
// Views live under play_count | ig_play_count | video_view_count | view_count (logged-in only).
function mediaFrom(o) {
  if (!o || typeof o !== 'object') return null;
  const code = o.code;
  if (typeof code !== 'string' || !/^[\w-]{6,}$/.test(code)) return null;
  const views = o.play_count ?? o.ig_play_count ?? o.video_view_count ?? o.view_count;
  const likes = o.like_count;
  const hasView = views !== undefined && views !== null;
  const hasLike = likes !== undefined && likes !== null;
  if (!hasView && !hasLike) return null;
  const ct = igCreateTime(o);
  const owner = (o.user && (o.user.username || o.user.pk)) || '';
  return {
    code,
    owner: String(owner).toLowerCase(),
    media_type: o.media_type ?? '',
    product_type: o.product_type ?? '',
    views: hasView ? parseCount(views) : '',
    likes: hasLike ? parseCount(likes) : '',
    comments: parseCount(o.comment_count),
    create_time: ct === '' ? '' : ct,
    posting_date: ct === '' ? '' : new Date(ct * 1000).toISOString().slice(0, 10),
    _score: (hasView ? 2 : 0) + (ct !== '' ? 1 : 0) + (owner ? 1 : 0),
  };
}

// Deep-walk any JSON, collecting reel media keyed by code (keep the richest sighting).
function collect(root, into) {
  const stack = [root]; let hops = 0;
  while (stack.length && hops < 600000) {
    const cur = stack.pop(); hops++;
    if (cur && typeof cur === 'object') {
      const m = mediaFrom(cur);
      if (m) { const prev = into.get(m.code); if (!prev || m._score > prev._score) into.set(m.code, m); }
      for (const k in cur) { const v = cur[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }
}

async function harvestInline(page, into) {
  try {
    const blobs = await page.evaluate(() => {
      const out = [];
      for (const s of document.querySelectorAll('script[type="application/json"]')) {
        const t = s.textContent || '';
        if (/play_count|like_count|"code"/.test(t)) out.push(t);
      }
      return out;
    });
    for (const b of blobs) { try { collect(JSON.parse(b), into); } catch (_) {} }
  } catch (_) {}
}

async function sweepProfile(handle) {
  const browser = await connect();
  const ctx = await context(browser);
  const loggedIn = await isLoggedIn(ctx);
  const page = await ctx.newPage();
  const items = new Map();

  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/graphql|\/api\/v1\/(clips|feed)|web_info/.test(u)) return;
    try {
      const t = await resp.text();
      if (/play_count|like_count/.test(t)) collect(JSON.parse(t), items);
    } catch (_) {}
  });

  await page.goto(`https://www.instagram.com/${handle}/reels/`,
                  { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await harvestInline(page, items);

  let last = items.size, stable = 0;
  for (let i = 0; i < 80 && stable < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1600);
    await harvestInline(page, items);
    if (items.size === last) stable++; else { stable = 0; last = items.size; }
    if (i % 5 === 0) console.error(`[ig] scrolled ${i}x, ${items.size} reels so far`);
  }

  // keep only THIS creator's media (the reels tab can leak suggested/foreign reels).
  // The feed's user object usually carries only pk (not username), so match the DOMINANT
  // owner — on a profile's own /reels/ tab that's overwhelmingly the creator — plus any
  // reel whose owner wasn't captured.
  const counts = {};
  for (const m of items.values()) if (m.owner) counts[m.owner] = (counts[m.owner] || 0) + 1;
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const want = handle.toLowerCase();
  const posts = {};
  let dropped = 0;
  for (const m of items.values()) {
    if (m.owner && dominant && m.owner !== dominant && m.owner !== want) { dropped++; continue; }
    delete m._score; posts[m.code] = m;
  }
  console.error(`[ig] @${handle}: ${Object.keys(posts).length} own reels (owner=${dominant}; `
              + `dropped ${dropped} foreign; loggedIn=${loggedIn})`);
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  return { handle, loggedIn, count: Object.keys(posts).length, posts, ids: Object.keys(posts) };
}

async function fetchCodes(codes) {
  const browser = await connect();
  const ctx = await context(browser);
  const loggedIn = await isLoggedIn(ctx);
  const page = await ctx.newPage();
  const posts = {};
  for (const code of codes) {
    const items = new Map();
    const onResp = async (resp) => {
      if (!/graphql|web_info|\/api\/v1\//.test(resp.url())) return;
      try { const t = await resp.text(); if (/play_count|like_count/.test(t)) collect(JSON.parse(t), items); }
      catch (_) {}
    };
    page.on('response', onResp);
    await page.goto(`https://www.instagram.com/reel/${code}/`,
                    { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await harvestInline(page, items);
    page.off('response', onResp);
    const m = items.get(code);            // exact code only — never fall back to a neighbour reel
    if (m) { delete m._score; posts[code] = m;
             console.error(`[ig] ${code}: views=${m.views} likes=${m.likes} date=${m.posting_date}`); }
    else console.error(`[ig] ${code}: NOT FOUND`);
  }
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  return { handle: '', loggedIn, count: Object.keys(posts).length, posts, ids: Object.keys(posts) };
}

async function loginFlow(openIt) {
  const browser = await connect();
  const ctx = await context(browser);
  if (await isLoggedIn(ctx)) { console.error('[login] Instagram: LOGGED IN ✓'); await browser.close().catch(()=>{}); return true; }
  if (!openIt) { console.error('[login] Instagram: LOGGED OUT ✗  (run: node instagram_sweep.js login)'); await browser.close().catch(()=>{}); return false; }
  const page = (await ctx.pages())[0] || await ctx.newPage();
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  console.error('[login] Opened Instagram login in the CDP Chrome. Log in, then wait…');
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await isLoggedIn(ctx)) { console.error('[login] session detected ✓'); await browser.close().catch(()=>{}); return true; }
  }
  console.error('[login] timed out — still logged out');
  await browser.close().catch(() => {});
  return false;
}

(async () => {
  const mode = process.argv[2];
  const clean = (s) => (s || '').replace(/^https?:\/\/[^/]+\//, '').replace(/^@/, '').split(/[/?]/)[0];
  if (mode === 'login') { process.exit(await loginFlow(true) ? 0 : 2); }
  if (mode === 'check') { process.exit(await loginFlow(false) ? 0 : 2); }
  if (mode === 'profile') {
    const handle = clean(process.argv[3]);
    if (!handle) { console.error('usage: node instagram_sweep.js profile "<handle>"'); process.exit(1); }
    console.log(JSON.stringify(await sweepProfile(handle))); return;
  }
  if (mode === 'codes') {
    const codes = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) { console.error('usage: node instagram_sweep.js codes "c1,c2"'); process.exit(1); }
    console.log(JSON.stringify(await fetchCodes(codes))); return;
  }
  console.error('usage: node instagram_sweep.js <profile|codes|login|check> ...');
  process.exit(1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
