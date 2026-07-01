#!/usr/bin/env node
/**
 * youtube_sweep.js — read YouTube Shorts stats from Chrome over CDP (no paid API).
 *
 * The tracker's CDP replacement for the Bright Data YouTube path. YouTube serves
 * exact view + like counts to a logged-OUT browser in the page hydration, so unlike
 * TikTok/Instagram no session is needed:
 *   views  ytInitialPlayerResponse.videoDetails.viewCount | microformat…viewCount  (exact)
 *   likes  ytInitialData … likeButtonViewModel … buttonViewModel.title             (exact)
 *   date   ytInitialPlayerResponse.microformat…publishDate (Pacific −07/−08)  -> unix
 *
 * Modes:
 *   node youtube_sweep.js channel <channelId>          # enumerate all short ids (newest-first NOT guaranteed)
 *   node youtube_sweep.js ids "<id1,id2,...>"          # per-video stats
 *   node youtube_sweep.js sweep <channelId>            # enumerate + stats for every short
 *
 * Output (stdout, last line): {"count":N,"posts":{"<videoId>":
 *   {"views":..,"likes":..,"create_time":<unix>,"posting_date":"YYYY-MM-DD(UTC)","title":".."}, ...},
 *   "ids":[...]}  (ids present for channel/sweep)
 */
const { connect, context } = require('./cdp');

// "1.2M"/"12.5K"/"1,234"/1234 -> integer; "" when absent/non-numeric
function parseCount(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).trim().replace(/,/g, '');
  const mm = s.match(/^([\d.]+)\s*([kmb])$/i);
  if (mm) return Math.round(parseFloat(mm[1]) * { k: 1e3, m: 1e6, b: 1e9 }[mm[2].toLowerCase()]);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : '';
}

// deep-walk: first value at any key matching `re` that parseCount can turn into a number
function deepFindCount(root, re) {
  const stack = [root]; let hops = 0;
  while (stack.length && hops < 200000) {
    const cur = stack.pop(); hops++;
    if (cur && typeof cur === 'object') {
      for (const k in cur) {
        const v = cur[k];
        if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          const c = parseCount(v);
          if (c !== '') return c;
        }
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return '';
}

// find the likeButtonViewModel subtree, then the first numeric `title` inside it
function findLikes(idData) {
  const stack = [idData]; let hops = 0;
  while (stack.length && hops < 200000) {
    const cur = stack.pop(); hops++;
    if (cur && typeof cur === 'object') {
      if (cur.likeButtonViewModel) {
        const c = deepFindCount(cur.likeButtonViewModel, /^title$|^accessibilityText$|Count/);
        if (c !== '') return c;
      }
      for (const k in cur) { const v = cur[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }
  return '';
}

// collect 11-char video ids from any channel-grid renderer
function collectIds(root, into) {
  const stack = [root]; let hops = 0;
  while (stack.length && hops < 400000) {
    const cur = stack.pop(); hops++;
    if (cur && typeof cur === 'object') {
      let vid = cur.videoId;
      if (!vid && cur.onTap && cur.onTap.innertubeCommand &&
          cur.onTap.innertubeCommand.reelWatchEndpoint)
        vid = cur.onTap.innertubeCommand.reelWatchEndpoint.videoId;
      if (typeof vid === 'string' && /^[\w-]{11}$/.test(vid)) into.add(vid);
      for (const k in cur) { const v = cur[k]; if (v && typeof v === 'object') stack.push(v); }
    }
  }
}

async function enumerateChannel(page, channelId) {
  const ids = new Set();
  const onResp = async (r) => {
    if (!/youtubei\/v1\/browse/.test(r.url())) return;
    try { collectIds(JSON.parse(await r.text()), ids); } catch (_) {}
  };
  page.on('response', onResp);
  await page.goto(`https://www.youtube.com/channel/${channelId}/shorts`,
                  { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  try {
    const hy = await page.evaluate(() => window.ytInitialData ? JSON.stringify(window.ytInitialData) : null);
    if (hy) collectIds(JSON.parse(hy), ids);
  } catch (_) {}
  let last = ids.size, stable = 0;
  for (let i = 0; i < 40 && stable < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    if (ids.size === last) stable++; else { stable = 0; last = ids.size; }
  }
  page.off('response', onResp);
  return [...ids];
}

async function statsFor(page, id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`https://www.youtube.com/shorts/${id}`,
                    { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(attempt === 0 ? 3200 : 4500);
    const hy = await page.evaluate(() => JSON.stringify({
      pr: window.ytInitialPlayerResponse || null,
      id: window.ytInitialData || null,
    })).catch(() => '{}');
    const { pr, id: idData } = JSON.parse(hy || '{}');
    if (!pr && !idData) continue;
    const vd = (pr && pr.videoDetails) || {};
    const mf = (pr && pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    let views = parseCount(vd.viewCount);
    if (views === '') views = parseCount(mf.viewCount);
    const likes = findLikes(idData || {});
    const publish = mf.publishDate || mf.uploadDate || (pr && pr.publishDate) || '';
    const ct = publish ? Math.floor(new Date(publish).getTime() / 1000) : '';
    const title = (vd.title) || (mf.title && mf.title.simpleText) || '';
    if (views !== '' || likes !== '') {
      return { id, views, likes, create_time: ct || '',
               posting_date: ct ? new Date(ct * 1000).toISOString().slice(0, 10) : '',
               publish_raw: publish, title };
    }
  }
  return { id, views: '', likes: '', create_time: '', posting_date: '', title: '', missing: true };
}

(async () => {
  const mode = process.argv[2];
  const arg = process.argv[3] || '';
  const browser = await connect();
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const out = { count: 0, posts: {} };

  try {
    let ids = [];
    if (mode === 'channel' || mode === 'sweep') {
      ids = await enumerateChannel(page, arg.replace(/^.*channel\//, '').split(/[/?]/)[0]);
      out.ids = ids;
      console.error(`[yt] channel ${arg}: ${ids.length} shorts enumerated`);
      if (mode === 'channel') { console.log(JSON.stringify(out)); await browser.close().catch(()=>{}); return; }
    } else if (mode === 'ids') {
      ids = arg.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      console.error('usage: node youtube_sweep.js <channel|ids|sweep> <arg>');
      process.exit(1);
    }
    let i = 0;
    for (const id of ids) {
      const p = await statsFor(page, id);
      out.posts[id] = p; i++;
      console.error(`[yt ${i}/${ids.length}] ${id}: views=${p.views} likes=${p.likes} date=${p.posting_date}${p.missing ? '  !!MISSING' : ''}`);
    }
    out.count = Object.keys(out.posts).length;
    console.log(JSON.stringify(out));
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
