// cdp.js — connect to (or launch) a real Chrome over CDP so we can read TikTok
// stats from a logged-in browser instead of a paid API.
//
// This is the tracker's OWN standalone copy of the pattern used in Project Ana
// (engine/lib/cdp.js) — referenced, not imported. TikTok gates a post's exact
// counts behind a real browser session, so we drive a persistent Chrome profile
// that is already logged into TikTok rather than paying ScrapeCreators.
//
// The profile defaults to `~/.masquerade_chrome` (the shared Project-Ana Chrome
// that is already logged into TikTok); override with MASQ_CHROME_PROFILE.
const { chromium } = require('playwright-core');
const path = require('path');
const { spawn } = require('child_process');

const CDP = process.env.MASQ_CDP || 'http://localhost:9222';
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = process.env.MASQ_CHROME_PROFILE ||
  path.join(process.env.HOME, '.masquerade_chrome');

// Connect to the CDP Chrome on :9222, launching it with the logged-in profile if it's down.
async function connect() {
  try { return await chromium.connectOverCDP(CDP); } catch (_) {}
  console.error(`[cdp] nothing on ${CDP} -> launching Chrome with profile ${PROFILE}`);
  spawn(CHROME, [`--remote-debugging-port=9222`, `--user-data-dir=${PROFILE}`],
        { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { return await chromium.connectOverCDP(CDP); } catch (_) {}
  }
  throw new Error(`could not reach Chrome CDP on ${CDP} (is the ${PROFILE} profile ` +
                  `already open in another Chrome window? close it first)`);
}

// The browser's first existing context (the real profile), or a fresh one.
async function context(browser) {
  return browser.contexts()[0] || (await browser.newContext());
}

// Is this browser's TikTok session logged in? (views for photo posts, and reliable
// counts generally, only hydrate for a real session.)
async function isLoggedIn(ctx) {
  const cookies = await ctx.cookies('https://www.tiktok.com');
  return cookies.some(c => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value);
}

module.exports = { connect, context, isLoggedIn, CDP, CHROME, PROFILE };
