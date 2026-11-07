import fs from 'node:fs';

const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_lldc_gist_state.json';
const LOG_FILE = './pipeline_lldc_gist_blitz.log';

const ROUND_DELAY_MIN_MS = 105_000;
const ROUND_DELAY_MAX_MS = 135_000;
const TOTAL_ROUNDS = 3;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const roundDelay = () => Math.floor(ROUND_DELAY_MIN_MS + Math.random() * (ROUND_DELAY_MAX_MS - ROUND_DELAY_MIN_MS));
const formatMs = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m ${s % 60}s`; };

const BROADCAST_MESSAGES = [
  { theme: 'Money Injector', text: 'Money injector available. Get 500B every 35 minutes. Serious buyers only. Message @spacetech_.' },
  { theme: 'Money and Accounts', text: 'Money and accounts available. Money injector too. Serious buyers only. Message @spacetech_.' },
  { theme: 'Accounts', text: 'Game accounts available. Also money and money injector. Serious buyers only. Message @spacetech_.' },
  { theme: 'Money Packages', text: 'Money packages available. Accounts too. Serious buyers only. Message @spacetech_.' },
  { theme: 'Injector Info', text: 'Want 500B every 35 minutes? Money injector available. Serious buyers only. Message @spacetech_.' },
  { theme: 'All Services', text: 'Money, accounts and money injector all available. Serious buyers only. Message @spacetech_.' },
  { theme: 'Worldwide', text: 'Money injector works anywhere. 500B every 35 minutes. Money and accounts also available. Serious buyers only. Message @spacetech_.' },
  { theme: 'Upgrade', text: 'Upgrade your game. 500B every 35 minutes with the money injector. Serious buyers only. Message @spacetech_.' },
  { theme: 'Info', text: 'For money, accounts or the money injector, message @spacetech_. Serious buyers only.' },
  { theme: 'Last Call', text: 'Money, accounts and the money injector are available. Serious buyers only. Message @spacetech_ if interested.' }
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

async function publishRound(burners, state, roundNum, usedPairs) {
  log(`\n📢 ROUND ${roundNum}`);
  const shuffledBurners = shuffle(burners);
  const shuffledTopics = shuffle(BROADCAST_MESSAGES);

  for (let i = 0; i < shuffledBurners.length; i++) {
    const burner = shuffledBurners[i];
    let topic = shuffledTopics[i % shuffledTopics.length];
    let key = `${burner.user}::${topic.theme}`;
    let g = 0;
    while (usedPairs.has(key) && g < 10) {
      g++;
      topic = shuffledTopics[(i + g) % shuffledTopics.length];
      key = `${burner.user}::${topic.theme}`;
    }
    usedPairs.add(key);

    log(`⚡ [@${burner.user}] ${topic.theme}: "${topic.text.slice(0, 40)}..."`);

    let sent = false, attempts = 0;
    while (!sent && attempts < 5) {
      attempts++;
      const res = await callGistApi(burner.cookie, { action: 'post', text: topic.text, chip: null });
      if (res.ok && res.data?.post?.id) {
        sent = true;
        state.posts.push({ id: res.data.post.id, author: burner.user, authorName: burner.name, body: topic.text, theme: topic.theme, round: roundNum, postedAt: new Date().toISOString() });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        log(`✅ [@${burner.user}] Live: ${res.data.post.id}`);
      } else {
        log(`⚠️ [@${burner.user}] ${res.status}: ${res.data?.error || res.error}`);
        await sleep(4000);
      }
    }
    await sleep(2500);
  }
}

async function main() {
  log('LLDC GIST BLITZ');
  const burners = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));
  let state = { startedAt: new Date().toISOString(), posts: [], completed: false };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  const usedPairs = new Set();
  for (const p of state.posts) if (p.theme) usedPairs.add(`${p.author}::${p.theme}`);

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    await publishRound(burners, state, round, usedPairs);
    if (round < TOTAL_ROUNDS) {
      const wait = roundDelay();
      log(`\n⏳ Next round in ~${formatMs(wait)}`);
      await sleep(wait);
    }
  }

  state.completed = true;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`\nDONE. Posts: ${state.posts.length}`);
}

main().catch(err => { log(`ERROR: ${err.message}`); console.error(err); });
