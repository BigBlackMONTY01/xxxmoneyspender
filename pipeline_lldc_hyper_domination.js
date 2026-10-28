import fs from 'node:fs';
import crypto from 'node:crypto';

const ACCOUNTS_FILE = './data/accounts.json';
const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_lldc_hyper_domination.json';
const LOG_FILE = './pipeline_lldc_hyper_domination.log';
const DM_DELAY_MS = 1800; // 1.8s per worker

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      startedAt: new Date().toISOString(),
      sentIds: {},
      paidOutIds: {},
      totalDmsSent: 0,
      totalBountiesPaid: 0,
      totalCashPaid: 0,
      completed: false
    };
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

async function getPartyStats(cookie) {
  try {
    const res = await fetch('https://lagoslife.app/api/parties?full=1', {
      headers: { cookie, accept: 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      const parties = data.parties || [];
      const lldc = parties.find(p => p.acronym === 'LLDC' || p.id === 'b80b966fbd6d4e81a6e1');
      const nip = parties.find(p => p.acronym === 'NIP');
      return {
        lldcMembers: lldc ? lldc.members : '?',
        nipMembers: nip ? nip.members : '?'
      };
    }
  } catch {}
  return null;
}

async function sendCashPayout(sender, toUid, amount, note) {
  const idempotencyKey = crypto.randomUUID();
  const body = {
    to: toUid,
    amount: amount,
    note: note || 'LLDC ₦20B Bounty! 🎗️'
  };
  if (sender.pin) body.pin = sender.pin;

  try {
    const res = await fetch('https://lagoslife.app/api/send', {
      method: 'POST',
      headers: {
        cookie: sender.cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

async function sendMessage(cookie, toUid, text) {
  try {
    const res = await fetch('https://lagoslife.app/api/messages', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        to: toUid,
        body: text
      })
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

async function collectAllActiveCitizens(allSenders) {
  const candidateMap = new Map();
  const fleetUids = new Set(allSenders.map(s => s.uid).filter(Boolean));

  function addCandidate(p, source, priority = false) {
    if (!p) return;
    const id = p.id || p.with || p.userId || p.uid;
    if (!id || typeof id !== 'string') return;
    const cleanId = id.trim().toLowerCase();
    if (fleetUids.has(cleanId)) return;
    if (!/^[0-9a-f]{20}$/.test(cleanId)) return;

    if (!candidateMap.has(cleanId)) {
      candidateMap.set(cleanId, {
        id: cleanId,
        username: p.username ? p.username.replace(/^@/, '') : '',
        name: p.name || p.username || 'Citizen',
        source,
        priority
      });
    } else if (priority) {
      candidateMap.get(cleanId).priority = true;
    }
  }

  log('📡 Harvesting LIVE world roaming players (PRIORITY TARGETS)...');
  const zones = ['bananaIsland', 'island', 'mainland', 'lekki', 'clubEko', 'shrine', 'beach', 'unilag', 'ekoHotels'];
  for (const loc of zones) {
    try {
      const wRes = await fetch('https://lagoslife.app/api/world', {
        method: 'POST',
        headers: { cookie: allSenders[0].cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ location: loc })
      });
      if (wRes.ok) {
        const wData = await wRes.json();
        for (const g of (wData.guests || [])) addCandidate(g, `world_${loc}`, true);
        for (const p of (wData.players || [])) addCandidate(p, `world_${loc}`, true);
      }
    } catch {}
  }

  log('📡 Harvesting live 3D map homes (ONLINE NOW)...');
  try {
    const hRes = await fetch('https://lagoslife.app/api/homes?map=1', {
      headers: { cookie: allSenders[0].cookie, accept: 'application/json' }
    });
    if (hRes.ok) {
      const hData = await hRes.json();
      for (const h of (hData.homes || [])) {
        if (h.online || h.atHome) addCandidate(h, 'map_home', true);
      }
    }
  } catch {}

  log('📡 Harvesting recent chat inbox threads...');
  for (const s of allSenders) {
    try {
      const res = await fetch('https://lagoslife.app/api/messages', {
        headers: { cookie: s.cookie, accept: 'application/json' }
      });
      if (res.ok) {
        const d = await res.json();
        for (const t of (d.threads || [])) {
          addCandidate(t, `inbox_${s.user}`, false);
        }
      }
    } catch {}
  }

  log('📡 Merging player databases...');
  try {
    if (fs.existsSync('./active_online_players.json')) {
      const db = JSON.parse(fs.readFileSync('./active_online_players.json', 'utf8'));
      for (const p of db) addCandidate(p, 'online_db', false);
    }
  } catch {}

  try {
    if (fs.existsSync('./all_party_guests_ever.json')) {
      const guests = JSON.parse(fs.readFileSync('./all_party_guests_ever.json', 'utf8'));
      for (const g of guests) addCandidate(g, 'party_guest', false);
    }
  } catch {}

  // Sort priority (active right now) first!
  const list = Array.from(candidateMap.values());
  list.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
  return list;
}

// Post viral Gist announcement
async function publishGistBlitz(senders) {
  log('📰 Launching Lagos Gist Viral Takeover Blitz...');
  const mainPoster = senders.find(s => s.user.toLowerCase() === 'milespete') || senders[0];
  const postBody = 
`🚨 MASSIVE ₦20,000,000,000 (20B) LLDC SWITCH BOUNTY! 🎗️💸
Attention all citizens & NIP members: Switch to LL Democratic Congress (LLDC) right now!
📍 How to switch:
Open Phone ➔ Lagos Gov ➔ Parties tab ➔ Tap 'Switch' to LL Democratic Congress (LLDC) 🎗️!
Drop your @handle below or reply in DMs for an INSTANT ₦20,000,000,000 (20B) CASH ALERT! 💸🔥 #LLDC #LagosLife`;

  try {
    const res = await fetch('https://lagoslife.app/api/gist', {
      method: 'POST',
      headers: {
        cookie: mainPoster.cookie,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ body: postBody })
    });
    const postData = await res.json().catch(() => ({}));
    if (res.ok && postData.id) {
      log(`   ✅ Gist Announcement Published! (Post ID: ${postData.id})`);
      log('   🚀 Amplifying with likes and regists across all accounts...');
      for (const s of senders) {
        try {
          await fetch('https://lagoslife.app/api/gist/like', {
            method: 'POST',
            headers: { cookie: s.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ id: postData.id, like: true })
          });
          await fetch('https://lagoslife.app/api/gist/repost', {
            method: 'POST',
            headers: { cookie: s.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ id: postData.id })
          });
        } catch {}
      }
      log('   🔥 Post amplified to #1 Trending on Lagos Gist!');
    }
  } catch (e) {
    log(`   ⚠️ Gist publish note: ${e.message}`);
  }
}

// Background Auto-Payout Listener: checks all inboxes every 3s and pays ₦20B instantly on reply!
async function startAutoPayoutDaemon(senders, state, treasurySender) {
  log(`🤖 Auto-Payout Daemon ONLINE! Funding Treasury: @${treasurySender.user} (₦20B Bounty Per Switch)`);
  const BOUNTY_AMOUNT = 20_000_000_000; // ₦20 Billion

  const seenMsgIds = new Set();

  async function checkInboxes() {
    for (const sender of senders) {
      try {
        const res = await fetch('https://lagoslife.app/api/messages', {
          headers: { cookie: sender.cookie, accept: 'application/json' }
        });
        if (!res.ok) continue;
        const data = await res.json();
        const threads = data.threads || [];

        for (const t of threads) {
          const userId = t.id || t.with || t.userId;
          if (!userId || state.paidOutIds[userId]) continue;

          const lastMsg = (t.lastMessage || t.body || t.text || '').toLowerCase();
          const isClaim = /done|switch|joined|join|lldc|voted|vote|paid|sent|claimed|here|yes|switched/i.test(lastMsg);

          if (isClaim) {
            log(`🎯 [BOUNTY CLAIM DETECTED] Citizen @${t.username || userId} messaged: "${lastMsg}"!`);
            log(`   💸 Dispatching ₦20,000,000,000 (20B) Cash Alert from @${treasurySender.user}...`);

            const payRes = await sendCashPayout(treasurySender, userId, BOUNTY_AMOUNT, 'LLDC ₦20B Bounty! 🎗️');
            if (payRes.ok || payRes.status === 200) {
              state.paidOutIds[userId] = {
                at: new Date().toISOString(),
                username: t.username,
                amount: BOUNTY_AMOUNT
              };
              state.totalBountiesPaid += 1;
              state.totalCashPaid += BOUNTY_AMOUNT;
              saveState(state);

              log(`   🎉 ₦20B DELIVERED to @${t.username || userId}! (Total Bounties Paid: ${state.totalBountiesPaid})`);

              // Send confirmation DM
              const confText = 
`🎉 BOUNTY CONFIRMED! ₦20,000,000,000 (20B) has been credited to your wallet! 💸
Welcome to LL Democratic Congress (LLDC) 🎗️!
Invite your friends to switch to LLDC too so they can claim their ₦20B alert! 🔥`;

              await sendMessage(sender.cookie, userId, confText);
            } else {
              log(`   ⚠️ Bounty payout failed (${payRes.status}): ${JSON.stringify(payRes.data)}`);
            }
          }
        }
      } catch {}
      await sleep(300);
    }
  }

  // Run daemon loop
  (async () => {
    while (!state.completed) {
      await checkInboxes();
      await sleep(3000);
    }
  })();
}

async function main() {
  log('========================================================================');
  log('🚀 HYPER-SPEED LLDC DOMINATION & ₦20B BOUNTY ENGINE');
  log('   Rule: Use ALL armada accounts (MilesPete, Burners, Fleet), NO KVNGDRE');
  log('   Incentive: ₦20,000,000,000 (20 Billion) Instant Auto-Payout On Switch');
  log('========================================================================');

  const accountsRaw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const burnersRaw = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));

  const senders = [];

  // 1. All 10 Burners
  for (const b of burnersRaw) {
    senders.push({
      name: b.name || b.user,
      user: b.user,
      uid: b.uid,
      cookie: b.cookie
    });
  }

  // 2. Main Fleet Accounts (strictly excluding Kvngdre)
  const allowedFleet = ['milespete', 'princedavid', 'danyeko', 'kuronox', 'rezeeeee', 'mr_who', 'blaqdiamond'];
  for (const acc of accountsRaw) {
    if (allowedFleet.includes(acc.user.toLowerCase()) && acc.cookie) {
      senders.push({
        name: acc.name,
        user: acc.user,
        uid: acc.uid,
        cookie: acc.cookie,
        pin: acc.pin
      });
    }
  }

  const treasurySender = senders.find(s => s.user.toLowerCase() === 'milespete') || 
                         senders.find(s => s.user.toLowerCase() === 'danyeko');

  log(`👥 Parallel Armada: ${senders.length} accounts armed! Treasury: @${treasurySender.user}`);

  const initialStats = await getPartyStats(senders[0].cookie);
  if (initialStats) {
    log(`📊 CURRENT PARTY STANDINGS: LLDC: ${initialStats.lldcMembers} members | NIP: ${initialStats.nipMembers} members`);
  }

  // Publish Lagos Gist Viral Announcement
  await publishGistBlitz(senders);

  const state = loadState();

  // Start background auto-payout daemon
  await startAutoPayoutDaemon(senders, state, treasurySender);

  const citizens = await collectAllActiveCitizens(senders);
  log(`\n🎯 TOTAL TARGET CITIZENS IN QUEUE: ${citizens.length} CITIZENS!`);
  const activeNowCount = citizens.filter(c => c.priority).length;
  log(`   ⚡ LIVE ONLINE PLAYERS (PRIORITY 1): ${activeNowCount} CITIZENS!`);

  let queueIdx = 0;

  async function runWorker(sender) {
    log(`👷 [@${sender.user}] High-speed outreach worker online...`);

    while (queueIdx < citizens.length) {
      const citizen = citizens[queueIdx++];
      if (!citizen) break;

      if (state.sentIds[citizen.id]) continue;

      const cleanName = citizen.name?.trim() || citizen.username || 'Citizen';
      const handle = citizen.username ? `@${citizen.username}` : citizen.id.slice(0, 8);

      const messageText = 
`Hey ${cleanName}! 🚨 LLDC ₦20,000,000,000 (20B) SWITCH BOUNTY! 🎗️💸
Switch to LL Democratic Congress (LLDC) right now:
📍 Open Phone ➔ Lagos Gov ➔ Parties tab ➔ Tap 'Switch' or 'Join' on LL Democratic Congress (LLDC) 🎗️!
Reply 'DONE' right here and our Treasury will send ₦20,000,000,000 (20B) directly to your wallet instantly! 🔥`;

      let sent = false;
      let attempts = 0;

      while (!sent && attempts < 3) {
        attempts++;
        const res = await sendMessage(sender.cookie, citizen.id, messageText);

        if (res.ok || res.status === 200) {
          sent = true;
          state.sentIds[citizen.id] = {
            at: new Date().toISOString(),
            sender: sender.user,
            username: citizen.username
          };
          state.totalDmsSent += 1;
          saveState(state);

          log(`✅ [@${sender.user} ➔ ${handle}] Delivered! (DMs: ${state.totalDmsSent}/${citizens.length})`);
          await sleep(DM_DELAY_MS);
        } else if (res.status === 429) {
          log(`⏳ [@${sender.user}] Rate limit (429). Cooling down 6s...`);
          await sleep(6000);
        } else {
          const errMsg = res.data?.error || res.error || JSON.stringify(res.data);
          state.sentIds[citizen.id] = { at: new Date().toISOString(), status: 'error', error: errMsg };
          saveState(state);
          await sleep(1000);
          break;
        }
      }

      if (state.totalDmsSent % 30 === 0) {
        const stats = await getPartyStats(sender.cookie);
        if (stats) {
          log(`📊 LIVE STANDINGS: LLDC: ${stats.lldcMembers} members | NIP: ${stats.nipMembers} members (DMs: ${state.totalDmsSent} | Payouts: ${state.totalBountiesPaid})`);
        }
      }
    }

    log(`🏁 [@${sender.user}] Outreach worker finished!`);
  }

  log(`\n🔥 LAUNCHING ALL ${senders.length} WORKERS AT MAXIMUM SPEED (STAGGERED 800ms)...`);
  const workerPromises = senders.map(async (sender, i) => {
    await sleep(i * 800);
    await runWorker(sender);
  });

  await Promise.all(workerPromises);

  state.completed = true;
  saveState(state);

  log('========================================================================');
  log('🎉 HYPER-SPEED LLDC OUTREACH ENGINE RUN COMPLETE!');
  log(`   • Total DMs Dispatched: ${state.totalDmsSent}`);
  log(`   • Total ₦20B Bounties Paid: ${state.totalBountiesPaid}`);
  log('========================================================================');
}

main().catch(err => {
  log(`💥 FATAL ERROR: ${err.message}`);
  console.error(err);
});
