import fs from 'node:fs';
import crypto from 'node:crypto';

const ACCOUNTS_FILE = './data/accounts.json';
const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_lldc_party_switch_cash_blitz.json';
const LOG_FILE = './pipeline_lldc_party_switch_cash_blitz.log';
const WORKER_SLEEP_MS = 2500; // 2.5s between sends per worker

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
      totalRecipients: 0,
      totalCashDelivered: 0,
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

async function ensureJoinedLLDC(sender) {
  try {
    const res = await fetch('https://lagoslife.app/api/parties', {
      method: 'POST',
      headers: {
        cookie: sender.cookie,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ op: 'join', party: 'b80b966fbd6d4e81a6e1' })
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok || d.success) {
      log(`   🎗️ [@${sender.user}] Confirmed member of LLDC!`);
    } else {
      log(`   ℹ️ [@${sender.user}] Party status: ${d.error || 'Registered'}`);
    }
  } catch {}
}

async function sendCash(sender, toUid, amount) {
  const idempotencyKey = crypto.randomUUID();
  const body = {
    to: toUid,
    amount: amount,
    note: 'Join LLDC! 🎗️ Free ₦1B-10B Airdrop'
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

  function addCandidate(p, source) {
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
        source
      });
    }
  }

  log('📡 Harvesting active citizens across all armada inboxes...');
  for (const s of allSenders) {
    try {
      const res = await fetch('https://lagoslife.app/api/messages', {
        headers: { cookie: s.cookie, accept: 'application/json', 'user-agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const d = await res.json();
        for (const t of (d.threads || [])) {
          addCandidate(t, `inbox_${s.user}`);
        }
      }
    } catch {}
  }
  log(`   ✅ Candidates from inboxes: ${candidateMap.size}`);

  log('📡 Harvesting from live 3D map homes...');
  try {
    const hRes = await fetch('https://lagoslife.app/api/homes?map=1', {
      headers: { cookie: allSenders[0].cookie, accept: 'application/json' }
    });
    if (hRes.ok) {
      const hData = await hRes.json();
      for (const h of (hData.homes || [])) {
        if (h.online || h.atHome) addCandidate(h, 'map_home');
      }
    }
  } catch {}
  log(`   ✅ Candidates after map homes: ${candidateMap.size}`);

  log('📡 Harvesting from live world roaming hubs...');
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
        for (const g of (wData.guests || [])) addCandidate(g, `world_${loc}`);
        for (const p of (wData.players || [])) addCandidate(p, `world_${loc}`);
      }
    } catch {}
  }
  log(`   ✅ Candidates after world zones: ${candidateMap.size}`);

  log('📡 Merging active players and party guest databases...');
  try {
    if (fs.existsSync('./active_online_players.json')) {
      const db = JSON.parse(fs.readFileSync('./active_online_players.json', 'utf8'));
      for (const p of db) addCandidate(p, 'online_db');
    }
  } catch {}

  try {
    if (fs.existsSync('./all_party_guests_ever.json')) {
      const guests = JSON.parse(fs.readFileSync('./all_party_guests_ever.json', 'utf8'));
      for (const g of guests) addCandidate(g, 'party_guest');
    }
  } catch {}

  return Array.from(candidateMap.values());
}

async function main() {
  log('========================================================================');
  log('💸 MASS LLDC CASH DROP + PARTY SWITCH ENGINE (₦1B - ₦10B RANDOM)');
  log('   Rule: Use ALL armada accounts (MilesPete, Burners, Fleet), NO KVNGDRE');
  log('   Incentive: Immediate ₦1B-₦10B Cash Transfer + Direct LLDC Switch Instructions');
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

  log(`👥 Active Parallel Senders Armada: ${senders.length} accounts armed! (Kvngdre strictly excluded)`);
  senders.forEach((s, idx) => log(`   [#${idx + 1}] @${s.user} (${s.name})`));

  log('\n🎗️ Verifying all armada accounts are registered members of LLDC...');
  for (const s of senders) {
    await ensureJoinedLLDC(s);
  }

  const initialStats = await getPartyStats(senders[0].cookie);
  if (initialStats) {
    log(`📊 CURRENT PARTY STANDINGS: LLDC: ${initialStats.lldcMembers} members | NIP: ${initialStats.nipMembers} members`);
  }

  const citizens = await collectAllActiveCitizens(senders);
  log(`\n🎯 TOTAL TARGET CITIZENS TO CONTACT: ${citizens.length} CITIZENS!`);

  const state = loadState();
  let queueIdx = 0;

  async function runWorker(sender) {
    log(`👷 [@${sender.user}] Worker online. Processing cash & message queue...`);

    while (queueIdx < citizens.length) {
      const citizen = citizens[queueIdx++];
      if (!citizen) break;

      if (state.sentIds[citizen.id]) continue;

      const cleanName = citizen.name?.trim() || citizen.username || 'Citizen';
      const handle = citizen.username ? `@${citizen.username}` : citizen.id.slice(0, 8);

      // Random cash drop from ₦1B to ₦10B
      const randomB = Math.floor(Math.random() * 10) + 1; // 1 to 10
      const cashAmount = randomB * 1_000_000_000;

      log(`⚡ [@${sender.user} ➔ ${handle}] Sending ₦${randomB}B cash alert + LLDC switch directions...`);

      // 1. Send Cash via /api/send
      let cashOk = false;
      let cashAttempts = 0;

      while (!cashOk && cashAttempts < 3) {
        cashAttempts++;
        const sendRes = await sendCash(sender, citizen.id, cashAmount);
        if (sendRes.ok || sendRes.status === 200) {
          cashOk = true;
          log(`   💰 [@${sender.user} ➔ ${handle}] ₦${randomB}B Cash Alert Sent!`);
        } else if (sendRes.status === 429) {
          log(`   ⏳ [@${sender.user}] Transfer rate limit (429). Waiting 5s...`);
          await sleep(5000);
        } else {
          const err = sendRes.data?.error || sendRes.error || JSON.stringify(sendRes.data);
          log(`   ⚠️ [@${sender.user}] Cash transfer info (${sendRes.status}): ${err}`);
          break;
        }
      }

      await sleep(400);

      // 2. Send Message via /api/messages
      const messageText = 
`Hey ${cleanName}! 💸 Just sent you ₦${randomB},000,000,000 (${randomB}B) CASH!
Check your wallet alert right now!
Now join/switch to LL Democratic Congress (LLDC) right now:
📍 Open Phone ➔ Lagos Gov ➔ Parties tab ➔ Tap 'Switch' or 'Join' on LL Democratic Congress (LLDC) 🎗️!
Reply 'DONE' once you switch for another ₦5B bonus! 🔥`;

      let msgOk = false;
      let msgAttempts = 0;

      while (!msgOk && msgAttempts < 3) {
        msgAttempts++;
        const msgRes = await sendMessage(sender.cookie, citizen.id, messageText);
        if (msgRes.ok || msgRes.status === 200) {
          msgOk = true;
        } else if (msgRes.status === 429) {
          log(`   ⏳ [@${sender.user}] Message rate limit (429). Waiting 5s...`);
          await sleep(5000);
        } else {
          const err = msgRes.data?.error || msgRes.error || JSON.stringify(msgRes.data);
          log(`   ⚠️ [@${sender.user}] Message info (${msgRes.status}): ${err}`);
          break;
        }
      }

      // Record state
      state.sentIds[citizen.id] = {
        at: new Date().toISOString(),
        sender: sender.user,
        username: citizen.username,
        amount: cashAmount,
        amountB: randomB,
        cashDelivered: cashOk,
        messageDelivered: msgOk
      };
      state.totalRecipients += 1;
      if (cashOk) state.totalCashDelivered += cashAmount;
      saveState(state);

      const totalDeliveredB = (state.totalCashDelivered / 1_000_000_000).toLocaleString();
      log(`✅ [@${sender.user} ➔ ${handle}] Complete! (Recipients: ${state.totalRecipients}/${citizens.length} | Total Cash: ₦${totalDeliveredB}B)`);

      if (state.totalRecipients % 20 === 0) {
        const stats = await getPartyStats(sender.cookie);
        if (stats) {
          log(`📊 LIVE STANDINGS: LLDC: ${stats.lldcMembers} members | NIP: ${stats.nipMembers} members (Sent: ${state.totalRecipients})`);
        }
      }

      await sleep(WORKER_SLEEP_MS);
    }

    log(`🏁 [@${sender.user}] Cash blitz worker finished!`);
  }

  log(`\n🔥 LAUNCHING ALL ${senders.length} CASH SENDER WORKERS IN PARALLEL (STAGGERED 1s)...`);
  const workerPromises = senders.map(async (sender, i) => {
    await sleep(i * 1000);
    await runWorker(sender);
  });

  await Promise.all(workerPromises);

  state.completed = true;
  saveState(state);

  const finalB = (state.totalCashDelivered / 1_000_000_000).toLocaleString();
  log('========================================================================');
  log('🎉 MASS LLDC CASH DROP + PARTY SWITCH ENGINE FINISHED!');
  log(`   • Total Citizens Reached: ${state.totalRecipients}`);
  log(`   • Total Cash Delivered: ₦${finalB} Billion`);
  log('========================================================================');
}

main().catch(err => {
  log(`💥 FATAL CASH BLITZ ERROR: ${err.message}`);
  console.error(err);
});
