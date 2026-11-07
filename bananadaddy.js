import fs from 'node:fs';

const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_lldc_gist_state.json';
const LOG_FILE = './pipeline_lldc_gist_blitz.log';

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BROADCAST_MESSAGES = [
  { theme: 'Official Service Announcement', text: '🌍 Worldwide Broadcast! The Server-End Money Injector is available! Generate 500B every 35 minutes. 💰 Money and accounts also available. DM @spacetech_!' },
  { theme: 'Money Injector Showcase', text: '500B EVERY 35 MINUTES! 💸 Get access to the Server-End Money Injector today. Serious buyers only! Contact @spacetech_.' },
  { theme: 'Exclusive Money Deals', text: 'Looking for in-game money? We have money packages, account deals and our exclusive Server-End Money Injector available! 💰 DM @spacetech_.' },
  { theme: 'Account Marketplace', text: 'Need a new game account? We also have accounts available alongside our money services. Get in touch with @spacetech_! 🌍' },
  { theme: 'Fast Money Generation', text: 'Why settle for less? Generate 500B every 35 minutes with our Server-End Money Injector! 🚀 Serious inquiries only. DM @spacetech_.' },
  { theme: 'Serious Buyers Only', text: 'Exclusive offers for serious buyers! Server-End Money Injector, in-game money and accounts available. No time wasters. 📩 @spacetech_' },
  { theme: 'Worldwide Availability', text: '🌍 Worldwide availability! Our Server-End Money Injector generates 500B every 35 minutes. Money and accounts also available. Contact @spacetech_!' },
  { theme: 'Premium Services', text: 'Looking for premium in-game services? Explore our Server-End Money Injector, money packages and account offers. 💎 DM @spacetech_!' },
  { theme: 'Money & Accounts', text: '💰 MONEY AVAILABLE. ACCOUNTS AVAILABLE. SERVER-END INJECTOR AVAILABLE. 500B every 35 minutes! Everything in one place. DM @spacetech_!' },
  { theme: 'Final Call', text: 'Your next big in-game upgrade starts here! 🔥 500B every 35 minutes with our Server-End Money Injector. Money and accounts also available. @spacetech_' }
];

// Number of post rounds (round 1 = first pass, then shuffle + repost)
const TOTAL_ROUNDS = 3;

async function callGistApi(cookie, body) {
  try {
    const res = await fetch('https://lagoslife.app/api/gist', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// Fisher-Yates shuffle
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function publishRound(burners, state, roundNum, usedPairs) {
  log(`\n📢 ROUND ${roundNum}: DISPATCHING LLDC GISTS...`);

  // Shuffle burners and topics independently, then pair them up
  const shuffledBurners = shuffle(burners);
  const shuffledTopics = shuffle(BROADCAST_MESSAGES);

  for (let i = 0; i < shuffledBurners.length; i++) {
    const burner = shuffledBurners[i];
    const postConfig = shuffledTopics[i % shuffledTopics.length];

    // Skip duplicate (burner + topic) combos if possible
    let pairKey = `${burner.user}::${postConfig.theme}`;
    let guard = 0;
    while (usedPairs.has(pairKey) && guard < 10) {
      const altTopic = shuffledTopics[(i + guard + 1) % shuffledTopics.length];
      pairKey = `${burner.user}::${altTopic.theme}`;
      guard++;
    }
    const finalTopic = guard > 0
      ? shuffledTopics[(i + guard) % shuffledTopics.length]
      : postConfig;

    // Reset pairKey for actual chosen topic
    pairKey = `${burner.user}::${finalTopic.theme}`;
    usedPairs.add(pairKey);

    log(`⚡ [@${burner.user}] Round ${roundNum} (${finalTopic.theme}): "${finalTopic.text.slice(0, 45)}..."`);

    let sent = false;
    let attempts = 0;

    while (!sent && attempts < 5) {
      attempts++;
      const res = await callGistApi(burner.cookie, {
        action: 'post',
        text: finalTopic.text,
        chip: null
      });

      if (res.ok && res.data?.post?.id) {
        sent = true;
        state.posts.push({
          id: res.data.post.id,
          author: burner.user,
          authorName: burner.name,
          body: finalTopic.text,
          theme: finalTopic.theme,
          round: roundNum,
          postedAt: new Date().toISOString()
        });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        log(`✅ [@${burner.user}] Gist Live! ID: ${res.data.post.id}`);
      } else {
        log(`⚠️ [@${burner.user}] Notice (${res.status}): ${res.data?.error || res.error}. Retrying in 4s...`);
        await sleep(4000);
      }
    }

    await sleep(2500);
  }
}

async function main() {
  log('========================================================================');
  log('🏛️ VIRAL LLDC LAGOS GIST BLITZ — MULTI-ROUND SHUFFLE ENGINE');
  log('   Focus: Posts only (no comments). Topics shuffled per round.');
  log('========================================================================');

  const burners = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));

  let state = {
    startedAt: new Date().toISOString(),
    posts: [],
    completed: false
  };

  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}

  // Track (burner::theme) combos already used so we don't repeat the same combo
  const usedPairs = new Set();
  for (const p of state.posts) {
    if (p.theme) usedPairs.add(`${p.author}::${p.theme}`);
  }

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    await publishRound(burners, state, round, usedPairs);
    if (round < TOTAL_ROUNDS) {
      log(`\n🔄 Round ${round} complete. Shuffling topics and burners for next round...`);
      await sleep(5000);
    }
  }

  state.completed = true;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  log('\n========================================================================');
  log('🏁 MULTI-ROUND SHUFFLE ENGINE FINISHED!');
  log(`   📊 Summary:`);
  log(`   - Total Gists Published: ${state.posts.length}`);
  log(`   - Rounds Completed: ${TOTAL_ROUNDS}`);
  log(`   - Burners Used: ${burners.length}`);
  log('========================================================================');
}

main().catch(err => {
  log(`💥 FATAL BLITZ ERROR: ${err.message}`);
  console.error(err);
});
