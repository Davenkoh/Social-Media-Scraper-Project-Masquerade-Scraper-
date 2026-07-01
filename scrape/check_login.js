#!/usr/bin/env node
// check_login.js — report login state of the CDP Chrome for tiktok / instagram / youtube.
// Usage: node check_login.js
const { connect, context } = require('./cdp');

async function cookieNames(ctx, url) {
  const cs = await ctx.cookies(url);
  return new Set(cs.filter(c => c.value).map(c => c.name));
}

(async () => {
  const browser = await connect();
  const ctx = await context(browser);

  const tt = await cookieNames(ctx, 'https://www.tiktok.com');
  const ig = await cookieNames(ctx, 'https://www.instagram.com');
  const yt = await cookieNames(ctx, 'https://www.youtube.com');

  const ttIn = tt.has('sessionid') || tt.has('sessionid_ss');
  const igIn = ig.has('sessionid') && ig.has('ds_user_id');
  // YouTube/Google session cookies:
  const ytIn = yt.has('SAPISID') || yt.has('__Secure-3PAPISID') || yt.has('LOGIN_INFO');

  console.log(JSON.stringify({
    tiktok:    { loggedIn: ttIn, cookies: [...tt].filter(n => /session|sid/i.test(n)) },
    instagram: { loggedIn: igIn, cookies: [...ig].filter(n => /session|ds_user|csrf/i.test(n)) },
    youtube:   { loggedIn: ytIn, cookies: [...yt].filter(n => /SAPISID|LOGIN_INFO|SID/i.test(n)) },
  }, null, 2));

  await browser.close().catch(() => {});
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
