// massdelete.js
// Usage:
//   node massdelete.js --dry-run --limit 500      (will prompt for login)
//   LL_USER=x LL_PASS=y node massdelete.js --limit 500
//   node massdelete.js --until 2025-06-01

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const BASE = 'https://lagoslife.app';
const SESSION_CACHE = path.join(__dirname, '.ll_session.json');
const CHECKPOINT = path.join(__dirname, 'massdelete_checkpoint.json');
const DELAY_MS = 1500;
const MAX_RETRIES = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdin = process.stdin;
    process.stdout.write(question);
    const onData = char => {
      const s = char.toString();
      if (s === '\n' || s === '\r' || s === '\u0004') {
        stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(buffer);
      } else if (s === '\u0003') {
        process.exit(1);
      } else if (s === '\u007f') {
        if (buffer.length) { buffer = buffer.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        buffer += s;
        process.stdout.write('*');
      }
    };
    let buffer = '';
    stdin.on('data', onData);
  });
}

function askVisible(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, a => { rl.close(); resolve(a.trim()); });
  });
}

function cookieFromSetCookie(headers) {
  const raw = headers.getSetCookie?.() ?? [];
  const pick = raw.find(c => c.startsWith('ll_session='));
  return pick ? pick.split(';')[0] : null;
}

async function login(username, password) {
  const res1 = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'massdelete/1.0' },
    body: JSON.stringify({ username, password })
  });
  const d1 = await res1.json().catch(() => ({}));

  if (res1.status === 401 && d1.code === 'two_factor') {
    const code = await askVisible('2FA code: ');
    const res2 = await fetch(`${BASE}/api/auth/2fa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'massdelete/1.0' },
      body: JSON.stringify({ action: 'login', challenge: d1.challenge, code })
    });
    const d2 = await res2.json().catch(() => ({}));
    if (!res2.ok || !d2.ok) throw new Error(`2fa failed: ${res2.status} ${JSON.stringify(d2)}`);
    const cookie = cookieFromSetCookie(res2.headers);
    if (!cookie) throw new Error('no ll_session cookie in 2fa response');
    return cookie;
  }

  if (!res1.ok) throw new Error(`login ${res1.status}: ${JSON.stringify(d1)}`);
  const cookie = cookieFromSetCookie(res1.headers);
  if (!cookie) throw new Error('login ok but no session cookie');
  return cookie;
}

async function fetchMe(cookie) {
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { cookie, accept: 'application/json', 'user-agent': 'massdelete/1.0' }
  });
  if (!res.ok) return null;
  const d = await res.json().catch(() => ({}));
  return d.user || null;
}

async function fetchFeed(cookie, uid, cursor) {
  const params = new URLSearchParams({ of: uid });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${BASE}/api/gist?${params}`, {
    headers: { cookie, accept: 'application/json', 'user-agent': 'massdelete/1.0' }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function deletePost(cookie, id) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res, data;
    try {
      res = await fetch(`${BASE}/api/gist`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'massdelete/1.0'
        },
        body: JSON.stringify({ action: 'delete', id })
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      console.log(`  network error on ${id}: ${err.message} (${attempt})`);
      await sleep(1000 * attempt);
      continue;
    }

    if (res.ok && (data.ok || data.deleted)) return 'deleted';
    if (res.status === 404) return 'gone';
    if (res.status === 401 || res.status === 403) return 'auth';
    if (res.status === 429) { await sleep(5000 * attempt); continue; }
    console.log(`  ${id} -> ${res.status} ${JSON.stringify(data)} (${attempt})`);
    await sleep(1000 * attempt);
  }
  return 'failed';
}

// EDIT ME if the feed shape differs
const pickPosts = data => data.posts || data.gist || data.items || data.feed || [];
const postId = p => String(p.id ?? p.postId ?? p._id);

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')); }
  catch { return { deleted: [], gone: [], failed: [], cursor: null, done: false }; }
}
const saveCheckpoint = cp => fs.writeFileSync(CHECKPOINT, JSON.stringify(cp, null, 2));

async function getCredentials() {
  let user = process.env.LL_USER;
  let pass = process.env.LL_PASS;
  if (!user) user = await askVisible('Username: ');
  if (!pass) pass = await askHidden('Password: ');
  if (!user || !pass) throw new Error('username and password required');
  return { user, pass };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const untilIdx = process.argv.indexOf('--until');
  const until = untilIdx > -1 ? new Date(process.argv[untilIdx + 1]) : null;
  const limIdx = process.argv.indexOf('--limit');
  const limit = limIdx > -1 ? parseInt(process.argv[limIdx + 1], 10) : Infinity;

  const { user, pass } = await getCredentials();

  let cookie = null;
  try {
    const cached = JSON.parse(fs.readFileSync(SESSION_CACHE, 'utf8'));
    if (cached.cookie && cached.user === user) {
      const me = await fetchMe(cached.cookie);
      if (me) { cookie = cached.cookie; console.log('reused cached session'); }
    }
  } catch {}

  if (!cookie) {
    console.log('logging in...');
    cookie = await login(user, pass);
    fs.writeFileSync(SESSION_CACHE, JSON.stringify({ cookie, user, at: Date.now() }), { mode: 0o600 });
  }

  const me = await fetchMe(cookie);
  if (!me) throw new Error('session invalid after login');
  console.log(`logged in as @${me.username} (${me.id})`);

  const cp = loadCheckpoint();
  const deleted = new Set(cp.deleted);
  const gone = new Set(cp.gone);
  const failed = new Set(cp.failed);
  let cursor = cp.cursor;

  let seen = 0, dCount = 0, gCount = 0, sCount = 0, fCount = 0;

  console.log(dryRun ? 'DRY RUN' : 'LIVE');

  while (true) {
    const { status, data } = await fetchFeed(cookie, me.id, cursor);

    if (status === 401) {
      console.log('session expired, re-login');
      cookie = await login(user, pass);
      fs.writeFileSync(SESSION_CACHE, JSON.stringify({ cookie, user, at: Date.now() }), { mode: 0o600 });
      continue;
    }
    if (status !== 200) { console.error(`feed ${status}: ${JSON.stringify(data)}`); break; }

    const posts = pickPosts(data);
    if (!posts.length) { console.log('no more posts'); break; }

    for (const p of posts) {
      seen++;
      if (dCount + gCount + fCount >= limit) {
        console.log(`reached --limit ${limit}, stopping`);
        saveCheckpoint({ deleted: [...deleted], gone: [...gone], failed: [...failed], cursor });
        return;
      }

      const id = postId(p);
      if (!id || id === 'undefined') { sCount++; continue; }
      if (deleted.has(id) || gone.has(id)) { sCount++; continue; }

      const created = p.createdAt || p.postedAt || p.time;
      if (until && created && new Date(created) < until) {
        console.log('reached --until, stopping');
        saveCheckpoint({ deleted: [...deleted], gone: [...gone], failed: [...failed], cursor });
        return;
      }

      if (dryRun) {
        console.log(`would delete ${id}  ${created || ''}  ${String(p.body || p.text || '').slice(0, 60)}`);
        dCount++;
        continue;
      }

      const r = await deletePost(cookie, id);
      if (r === 'deleted') { deleted.add(id); dCount++; console.log(`OK ${id} (${dCount})`); }
      else if (r === 'gone') { gone.add(id); gCount++; console.log(`--  ${id} already gone`); }
      else if (r === 'auth') {
        console.log('auth lost, re-login and retry');
        cookie = await login(user, pass);
        fs.writeFileSync(SESSION_CACHE, JSON.stringify({ cookie, user, at: Date.now() }), { mode: 0o600 });
        continue;
      }
      else { failed.add(id); fCount++; console.log(`FAIL ${id}`); }

      if ((dCount + gCount + fCount) % 10 === 0) {
        saveCheckpoint({ deleted: [...deleted], gone: [...gone], failed: [...failed], cursor });
      }
      await sleep(DELAY_MS);
    }

    cursor = data.nextCursor || data.cursor || null;
    saveCheckpoint({ deleted: [...deleted], gone: [...gone], failed: [...failed], cursor });
    if (!cursor) break;
  }

  saveCheckpoint({ deleted: [...deleted], gone: [...gone], failed: [...failed], cursor, done: true });
  console.log(`\nDone. seen=${seen} deleted=${dCount} alreadyGone=${gCount} skipped=${sCount} failed=${fCount}`);
}

main().catch(err => { console.error(err); process.exit(1); });
