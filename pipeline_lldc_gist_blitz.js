import fs from 'node:fs';

const BURNERS_FILE = './data/campaign_burners.json';
const ACCOUNTS_FILE = './data/accounts.json';
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
  {
    theme: 'Official Service Announcement',
    text: '🌍 Worldwide Broadcast! The Server-End Money Injector is available! Generate 500B every 35 minutes. 💰 Money and accounts also available. DM @spacetech!'
  },
  {
    theme: 'Money Injector Showcase',
    text: '500B EVERY 35 MINUTES! 💸 Get access to the Server-End Money Injector today. Serious buyers only! Contact @spacetech.'
  },
  {
    theme: 'Exclusive Money Deals',
    text: 'Looking for in-game money? We have money packages, account deals and our exclusive Server-End Money Injector available! 💰 DM @spacetech.'
  },
  {
    theme: 'Account Marketplace',
    text: 'Need a new game account? We also have accounts available alongside our money services. Get in touch with @spacetech! 🌍'
  },
  {
    theme: 'Fast Money Generation',
    text: 'Why settle for less? Generate 500B every 35 minutes with our Server-End Money Injector! 🚀 Serious inquiries only. DM @spacetech.'
  },
  {
    theme: 'Serious Buyers Only',
    text: 'Exclusive offers for serious buyers! Server-End Money Injector, in-game money and accounts available. No time wasters. 📩 @spacetech'
  },
  {
    theme: 'Worldwide Availability',
    text: '🌍 Worldwide availability! Our Server-End Money Injector generates 500B every 35 minutes. Money and accounts also available. Contact @spacetech!'
  },
  {
    theme: 'Premium Services',
    text: 'Looking for premium in-game services? Explore our Server-End Money Injector, money packages and account offers. 💎 DM @spacetech!'
  },
  {
    theme: 'Money & Accounts',
    text: '💰 MONEY AVAILABLE. ACCOUNTS AVAILABLE. SERVER-END INJECTOR AVAILABLE. 500B every 35 minutes! Everything in one place. DM @spacetech!'
  },
  {
    theme: 'Final Call',
    text: 'Your next big in-game upgrade starts here! 🔥 500B every 35 minutes with our Server-End Money Injector. Money and accounts also available. @spacetech'
  }
];

const COMMENTS_POOL = [
  '500B every 35 minutes? 👀 @spacetech',
  'Who else is interested in this? 🔥',
  'Money and accounts available too? 💰',
  'Serious buyers should definitely check this out!',
  'Worldwide broadcast! 🌍',
  'DM @spacetech for more information.',
  'That 500B generation rate is crazy! 🚀',
  'Anyone looking for accounts? Apparently they have those too.',
  'Server-End services available. Check with @spacetech!',
  'Interested buyers, make your inquiries! 📩',
  '500B in 35 minutes. That's a serious offer.',
  'Check out @spacetech for details! 💎',
  'Money injector and accounts in one place. 🔥',
  'Serious inquiries only, no time wasters!',
  'Worldwide availability! 🌍💰'
];


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

async function main() {
  log('========================================================================');
  log('🏛️ VIRAL LLDC LAGOS GIST BLITZ CAMPAIGN ENGINE');
  log('   Promoting LLDC, @Bigola2823, @ghost001, @Big_stephani, @_iamking_');
  log('   Active Armadas: 10 Campaign Burner Accounts');
  log('========================================================================');

  const burners = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));

  let state = {
    startedAt: new Date().toISOString(),
    posts: [],
    likesGiven: 0,
    registsGiven: 0,
    commentsGiven: 0,
    completed: false
  };

  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}

  // ==========================================
  // STEP 1: PUBLISH VIRAL GISTS
  // ==========================================
  log('\n📢 STEP 1: DISPATCHING UNIQUE LLDC GISTS ACROSS ALL BURNERS...');
  for (let i = 0; i < burners.length; i++) {
    const burner = burners[i];
    const postConfig = GIST_CAMPAIGN_POSTS[i % GIST_CAMPAIGN_POSTS.length];

    // Check if burner already posted
    const existing = state.posts.find(p => p.author === burner.user);
    if (existing) {
      log(`   [@${burner.user}] Already published: "${existing.body.slice(0, 40)}..."`);
      continue;
    }

    log(`⚡ [@${burner.user}] Publishing (${postConfig.theme}): "${postConfig.text.slice(0, 45)}..."`);

    let sent = false;
    let attempts = 0;

    while (!sent && attempts < 5) {
      attempts++;
      const res = await callGistApi(burner.cookie, {
        action: 'post',
        text: postConfig.text,
        chip: null
      });

      if (res.ok && res.data?.post?.id) {
        sent = true;
        const newPost = {
          id: res.data.post.id,
          author: burner.user,
          authorName: burner.name,
          body: postConfig.text,
          postedAt: new Date().toISOString(),
          likesCount: 0,
          registsCount: 0
        };
        state.posts.push(newPost);
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        log(`✅ [@${burner.user}] Gist Live! ID: ${newPost.id}`);
      } else {
        log(`⚠️ [@${burner.user}] Notice (${res.status}): ${res.data?.error || res.error}. Retrying in 4s...`);
        await sleep(4000);
      }
    }

    await sleep(2500); // Friendly pacing between burner posts
  }

  log(`\n🎉 Total Active Campaign Gists Published: ${state.posts.length}`);

  // ==========================================
  // STEP 2: CROSS-ARMADA LIKES & REGISTS (AMPLIFICATION)
  // ==========================================
  log('\n🚀 STEP 2: ACTIVATING CROSS-ARMADA VIRAL AMPLIFICATION (LIKES & REGISTS)...');
  for (const post of state.posts) {
    for (const burner of burners) {
      // Don't like/regist own post
      if (burner.user === post.author) continue;

      // 1. Like
      const likeRes = await callGistApi(burner.cookie, {
        action: 'like',
        id: post.id,
        on: true
      });
      if (likeRes.ok) {
        state.likesGiven++;
        log(`   ❤️ [@${burner.user}] Liked post by @${post.author}`);
      }

      await sleep(600);

      // 2. Regist (Retweet)
      const registRes = await callGistApi(burner.cookie, {
        action: 'regist',
        id: post.id,
        on: true
      });
      if (registRes.ok) {
        state.registsGiven++;
        log(`   🔁 [@${burner.user}] Registed (Retweeted) post by @${post.author}`);
      }

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      await sleep(800);
    }
  }

  // ==========================================
  // STEP 3: HIGH-ENGAGEMENT CONVERSATION THREADS
  // ==========================================
  log('\n💬 STEP 3: SEEDING ORGANIC COMMUNITY COMMENTS ON ALL GISTS...');
  for (let pIdx = 0; pIdx < state.posts.length; pIdx++) {
    const post = state.posts[pIdx];
    // Pick 2 random burners to comment on each post
    const commentators = burners
      .filter(b => b.user !== post.author)
      .sort(() => Math.random() - 0.5)
      .slice(0, 2);

    for (let cIdx = 0; cIdx < commentators.length; cIdx++) {
      const commBurner = commentators[cIdx];
      const commentText = COMMENTS_POOL[(pIdx * 2 + cIdx) % COMMENTS_POOL.length];

      const cRes = await callGistApi(commBurner.cookie, {
        action: 'comment',
        id: post.id,
        text: commentText
      });

      if (cRes.ok) {
        state.commentsGiven++;
        log(`   💬 [@${commBurner.user} ➔ @${post.author}]: "${commentText}"`);
      }

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      await sleep(1500);
    }
  }

  state.completed = true;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  log('\n========================================================================');
  log('🏁 LLDC VIRAL LAGOS GIST BLITZ FULLY EXECUTED!');
  log(`   📊 Summary:`);
  log(`   - Gists Published: ${state.posts.length}`);
  log(`   - Likes Delivered: ${state.likesGiven}`);
  log(`   - Regists (Retweets) Delivered: ${state.registsGiven}`);
  log(`   - Comments Seeded: ${state.commentsGiven}`);
  log('========================================================================');
}

main().catch(err => {
  log(`💥 FATAL BLITZ ERROR: ${err.message}`);
  console.error(err);
});
