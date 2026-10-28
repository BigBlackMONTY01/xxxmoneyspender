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

const GIST_CAMPAIGN_POSTS = [
  {
    theme: 'Official Ticket Showcase',
    text: 'The only movement bringing real prosperity to Lagos! 💙💚 Stand with LLDC! Vote @Bigola2823 for President, @ghost001 for Governor & @Big_stephani for Senate! Transparent governance, zero nonsense. 🏛️✨ #LLDC #VoteLLDC #LagosLife'
  },
  {
    theme: 'Governor Leadership',
    text: 'Lagos needs leadership with real vision and integrity! That is why we stand 100% behind @ghost001 for Lagos Governor. Backed by the strongest treasury in Nigeria! 🏛️🗳️ Put Lagos first! #VoteGhost001 #LLDC #VoteLLDC #LagosGovernor'
  },
  {
    theme: 'Presidential Vision',
    text: 'National progress starts with proven visionaries! @Bigola2823 for President is the only choice for real economic transformation. Let’s make history together! 🇳🇬👑 #BigolaForPresident #LLDC #VoteLLDC #NigeriaDecides'
  },
  {
    theme: 'Senate Champion',
    text: 'Justice, fairness, and true accountability in the Senate! @Big_stephani has always stood with the people. A vote for LLDC is an investment in your future! ⚖️💪 #BigStephaniForSenate #LLDC #VoteLLDC #LagosGist'
  },
  {
    theme: 'Economic Empowerment',
    text: 'Lagosians, don’t fall for empty promises! LLDC is the only movement backed by real liquid strength and true citizen empowerment. Vote LLDC all the way! 💸🏛️ #VoteLLDC #LLDC #LagosLife #LagosGist'
  },
  {
    theme: 'Youth & Opportunity',
    text: 'Business expansion, lower taxes, and unstoppable infrastructure! That is the LLDC pledge to every young person and worker in Lagos. Support @ghost001 & @Bigola2823! 🔥✊ #LLDC #YouthForLLDC #VoteLLDC'
  },
  {
    theme: 'Citywide Movement',
    text: 'Everywhere you turn in the city, the voice is unanimous: IT’S LLDC SEASON! 🏛️💙💚 President: @Bigola2823 | Gov: @ghost001 | Senator: @Big_stephani | CBN: @_iamking_ Let’s elevate Lagos! #LLDC #VoteLLDC'
  },
  {
    theme: 'Grassroots Force',
    text: 'From Ikeja to Lekki, Surulere to the Island — the grassroots belong to the LLDC movement! Tell your friends, tell your street: Vote 🗳️ LLDC! #VoteLLDC #LLDC #LagosLife #GoodGovernance'
  },
  {
    theme: 'Real Treasury Strength',
    text: 'Real wealth generation and fair opportunities for all citizens! That is what @Bigola2823 and @ghost001 represent under LLDC. Make your vote count! 📈💼 #LLDC #VoteLLDC #LagosEconomy #Bigola2823'
  },
  {
    theme: 'Victory Rally',
    text: 'The blue & green wave cannot be stopped! 💙💚 Join the victory train and cast your ballot for LLDC. A greater Lagos starts right here! 🚀🏛️ #LLDC #VoteLLDC #LagosGist #VictoryMovement'
  }
];

const COMMENTS_POOL = [
  '100% facts! LLDC all the way! 🏛️💙💚',
  'No competition! Vote LLDC for real progress! 🔥',
  '@ghost001 is the only governor we trust! ✊',
  'The future is LLDC! Let’s go! 🚀',
  'Standing strong with @Bigola2823 for President! 👑',
  'LLDC is the only party backed by real action! 💸🏛️',
  'Vote LLDC! Tell everybody! 🗳️✨',
  'Clean governance, no stories! LLDC 💙💚'
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
