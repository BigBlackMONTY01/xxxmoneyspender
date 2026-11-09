import fs from 'node:fs';

const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_lldc_gist_state.json';
const LOG_FILE = './pipeline_lldc_gist_blitz.log';

const ROUND_DELAY_MIN_MS = 2 * 60_000;
const ROUND_DELAY_MAX_MS = 5 * 60_000;
const BURNER_POST_INTERVAL_MS = 30_000;
const TOTAL_ROUNDS = 6;
const MAX_ATTEMPTS = 2; // retry twice per burner per round, then move on

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const roundDelay = () => Math.floor(ROUND_DELAY_MIN_MS + Math.random() * (ROUND_DELAY_MAX_MS - ROUND_DELAY_MIN_MS));
const formatMs = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m ${s % 60}s`; };

const BROADCAST_MESSAGES = [
  { tier: 'script', theme: 'Skip the grind', text: 'Skip the grind. 1Tn in-game transfer plus the script that runs your game money for you. 6K, negotiable. DM @spacetech_.' },
  { tier: 'script', theme: 'Start rich', text: 'Start the game already rich. 1Tn and money script, 6K negotiable. Game currency only. DM @spacetech_.' },
  { tier: 'script', theme: 'Hands-free', text: 'Your in-game money, hands-free. 1Tn plus automation script for 6K, negotiable. DM @spacetech_.' },
  { tier: 'script', theme: 'Serious gamers', text: 'For serious gamers: 1Tn with money script included. 6K, negotiable. Message @spacetech_ before it goes.' },
  { tier: 'script', theme: 'One buyer', text: 'One 1Tn account, one money script, one buyer. 6K, negotiable. In-game currency. DM @spacetech_.' },
  { tier: 'script', theme: 'Outspend everyone', text: 'Outspend everyone in the game. 1Tn account plus the script that keeps the money moving. 6K, negotiable. DM @spacetech_.' },
  { tier: 'script', theme: 'Ready to play', text: 'Ready-to-play? 1Tn account with a money script. No grinding, no waiting. 6K, negotiable. DM @spacetech_.' },
  { tier: 'script', theme: 'More options', text: 'Need more? Bigger balances and other accounts available too. 1Tn account plus script from 6K, negotiable. DM @spacetech_.' },
  { tier: 'script', theme: 'Ask first', text: 'Questions welcome. 1Tn in-game account plus money script, 6K negotiable. Ask first, buy after. DM @spacetech_.' },
  { tier: 'script', theme: 'Price talk', text: 'Price is negotiable. 1Tn game account plus script, starting at 6K. Let\'s talk: DM @spacetech_.' }
];


async function callGistApi(cookie, body) {
  try {
    const res = await fetch('https://lagoslife.app/api/gist', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Only script tier for now. When other tiers exist, weight them here.
function pickRoundTopics(n) {
  const pool = shuffle(BROADCAST_MESSAGES);
  const picks = [];
  for (let i = 0; i < n; i++) picks.push(pool[i % pool.length]);
  return picks;
}

// Treat 401/403 as dead accounts. Other failures are transient and retried.
function isDeadAccount(res) {
  if (res.status === 401 || res.status === 403) return true;
  const err = String(res.data?.error || res.error || '').toLowerCase();
  return err.includes('unauthorized') || err.includes('forbidden') || err.includes('login') || err.includes('session');
}

function markDead(state, burner, reason) {
  state.deadBurners = state.deadBurners || {};
  if (!state.deadBurners[burner.user]) {
    state.deadBurners[burner.user] = { name: burner.name, reason, at: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    log(`💀 [@${burner.user}] marked dead: ${reason}`);
  }
}

async function publishRound(burners, state, roundNum, usedPairs) {
  log(`\n📢 ROUND ${roundNum}/${TOTAL_ROUNDS}`);
  const dead = state.deadBurners || {};
  const alive = burners.filter(b => !dead[b.user]);
  if (!alive.length) {
    log('🛑 No live burners left, stopping.');
    return false;
  }
  if (alive.length < burners.length) {
    log(`ℹ️ Skipping ${burners.length - alive.length} dead burner(s) this round.`);
  }

  const shuffledBurners = shuffle(alive);
  const topics = pickRoundTopics(shuffledBurners.length);

  for (let i = 0; i < shuffledBurners.length; i++) {
    const burner = shuffledBurners[i];
    let topic = topics[i];
    let key = `${burner.user}::${topic.theme}`;
    let g = 0;
    while (usedPairs.has(key) && g < 10) {
      g++;
      topic = BROADCAST_MESSAGES[(BROADCAST_MESSAGES.indexOf(topic) + g) % BROADCAST_MESSAGES.length];
      key = `${burner.user}::${topic.theme}`;
    }
    usedPairs.add(key);

    log(`⚡ [@${burner.user}] ${topic.theme}: "${topic.text.slice(0, 40)}..."`);

    let sent = false, attempts = 0;
    while (!sent && attempts < MAX_ATTEMPTS) {
      attempts++;
      const res = await callGistApi(burner.cookie, { action: 'post', text: topic.text, chip: null });
      if (res.ok && res.data?.post?.id) {
        sent = true;
        state.posts.push({ id: res.data.post.id, author: burner.user, authorName: burner.name, body: topic.text, theme: topic.theme, tier: topic.tier, round: roundNum, postedAt: new Date().toISOString() });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        log(`✅ [@${burner.user}] Live: ${res.data.post.id}`);
      } else {
        log(`⚠️ [@${burner.user}] attempt ${attempts}/${MAX_ATTEMPTS} ${res.status}: ${res.data?.error || res.error}`);
        if (isDeadAccount(res)) {
          markDead(state, burner, `${res.status} ${res.data?.error || res.error || ''}`.trim());
          break;
        }
        if (attempts < MAX_ATTEMPTS) await sleep(4000);
      }
    }

    if (!sent && !(state.deadBurners || {})[burner.user]) {
      log(`❌ [@${burner.user}] gave up after ${attempts} attempts, moving on`);
    }

    if (i < shuffledBurners.length - 1) {
      log(`⏳ Waiting ${formatMs(BURNER_POST_INTERVAL_MS)} before next burner...`);
      await sleep(BURNER_POST_INTERVAL_MS);
    }
  }
  return true;
}

async function main() {
  log('LLDC GIST BLITZ');
  const burners = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));
  let state = { startedAt: new Date().toISOString(), posts: [], deadBurners: {}, completed: false };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  state.deadBurners = state.deadBurners || {};

  if (state.deadBurners && Object.keys(state.deadBurners).length) {
    log(`ℹ️ ${Object.keys(state.deadBurners).length} burner(s) already dead from previous runs.`);
  }

  const usedPairs = new Set();
  for (const p of state.posts) if (p.theme) usedPairs.add(`${p.author}::${p.theme}`);

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    const roundStart = Date.now();
    const ok = await publishRound(burners, state, round, usedPairs);
    if (!ok) break;
    log(`⏱ Round ${round} took ${formatMs(Date.now() - roundStart)}`);

    if (round < TOTAL_ROUNDS) {
      const wait = roundDelay();
      log(`⏳ Pausing ${formatMs(wait)} before round ${round + 1}...`);
      await sleep(wait);
    }
  }

  state.completed = true;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const deadCount = Object.keys(state.deadBurners || {}).length;
  log(`\nDONE. Posts: ${state.posts.length}. Dead burners: ${deadCount}.`);
}

main().catch(err => { log(`ERROR: ${err.message}`); console.error(err); });
