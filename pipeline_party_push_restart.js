import fs from 'node:fs';

const ACCOUNTS_FILE = './data/accounts.json';
const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_party_push_restart.json';
const LOG_FILE = './pipeline_party_push_restart.log';
const SLEEP_MS = 2400; // 2.4s between invites

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
      invited: [],
      totalInvited: 0,
      completed: false
    };
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

async function sendPartyInvite(cookie, userId) {
  try {
    const resp = await fetch('https://lagoslife.app/api/invite', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ to: userId })
    });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, ok: resp.ok, data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

async function collectAllActiveContacts(miles, fleetAccounts, burners) {
  const candidateMap = new Map();
  const fleetUids = new Set([
    miles.uid,
    ...fleetAccounts.map(a => a.uid).filter(Boolean),
    ...burners.map(b => b.uid).filter(Boolean)
  ]);

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
        username: p.username ? `@${p.username.replace(/^@/, '')}` : '',
        name: p.name || p.username || cleanId.slice(0, 8),
        source: source
      });
    }
  }

  // 1. Miles Pete Inboxes & Chat Threads
  log('📡 [1/7] Scanning Miles Pete inbox chat threads...');
  try {
    const res = await fetch('https://lagoslife.app/api/messages', {
      headers: { cookie: miles.cookie, accept: 'application/json', 'user-agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const data = await res.json();
      for (const t of (data.threads || [])) {
        addCandidate(t, t.online ? 'miles_online_chat' : 'miles_chat');
      }
      log(`   ✅ Extracted ${candidateMap.size} candidates from Miles inbox.`);
    }
  } catch (e) {
    log(`   ⚠️ Miles inbox scan error: ${e.message}`);
  }

  // 2. All 10 Burner Inboxes (Active Citizens talking to Burners)
  log('📡 [2/7] Scanning all 10 Burner inboxes for active citizens...');
  for (const b of burners) {
    try {
      const res = await fetch('https://lagoslife.app/api/messages', {
        headers: { cookie: b.cookie, accept: 'application/json', 'user-agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const data = await res.json();
        for (const t of (data.threads || [])) {
          addCandidate(t, `burner_${b.user}`);
        }
      }
    } catch {}
  }
  log(`   ✅ Total candidates after Burners: ${candidateMap.size}`);

  // 3. Other Fleet Inboxes (PrinceDavid, Danyeko, Kuronox, etc.)
  log('📡 [3/7] Scanning other Fleet account inboxes...');
  for (const acc of fleetAccounts) {
    if (acc.user === 'milespete' || !acc.cookie) continue;
    try {
      const res = await fetch('https://lagoslife.app/api/messages', {
        headers: { cookie: acc.cookie, accept: 'application/json', 'user-agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const data = await res.json();
        for (const t of (data.threads || [])) {
          addCandidate(t, `fleet_${acc.user}`);
        }
      }
    } catch {}
  }
  log(`   ✅ Total candidates after Fleet inboxes: ${candidateMap.size}`);

  // 4. Live Map Homes (Online & AtHome Residents)
  log('📡 [4/7] Querying live map homes across Lagos...');
  try {
    const hRes = await fetch('https://lagoslife.app/api/homes?map=1', {
      headers: { cookie: miles.cookie, accept: 'application/json', 'user-agent': 'Mozilla/5.0' }
    });
    if (hRes.ok) {
      const hData = await hRes.json();
      for (const h of (hData.homes || [])) {
        if (h.online || h.atHome) {
          addCandidate(h, 'map_online_home');
        }
      }
      log(`   ✅ Total candidates after Map Homes: ${candidateMap.size}`);
    }
  } catch (e) {
    log(`   ⚠️ Map homes scan error: ${e.message}`);
  }

  // 5. Live World Hubs (Active Players & Guests in Banana Island, Clubs, Mainland)
  log('📡 [5/7] Querying live public world roaming hubs...');
  const zones = ['bananaIsland', 'island', 'mainland', 'lekki', 'clubEko', 'shrine', 'beach', 'unilag', 'ekoHotels'];
  for (const loc of zones) {
    try {
      const wRes = await fetch('https://lagoslife.app/api/world', {
        method: 'POST',
        headers: { cookie: miles.cookie, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
        body: JSON.stringify({ location: loc })
      });
      if (wRes.ok) {
        const wData = await wRes.json();
        for (const g of (wData.guests || [])) addCandidate(g, `world_${loc}`);
        for (const p of (wData.players || [])) addCandidate(p, `world_${loc}`);
      }
    } catch {}
  }
  log(`   ✅ Total candidates after World Hubs: ${candidateMap.size}`);

  // 6. Confirmed Online Database & Party Guests Ever
  log('📡 [6/7] Merging verified online players and party guests registry...');
  try {
    if (fs.existsSync('./active_online_players.json')) {
      const onlinePlayers = JSON.parse(fs.readFileSync('./active_online_players.json', 'utf8'));
      for (const p of onlinePlayers) addCandidate(p, 'active_online_db');
    }
  } catch {}

  try {
    if (fs.existsSync('./all_party_guests_ever.json')) {
      const guests = JSON.parse(fs.readFileSync('./all_party_guests_ever.json', 'utf8'));
      for (const g of guests) addCandidate(g, 'party_guest_veteran');
    }
  } catch {}

  log(`📡 [7/7] Consolidation complete!`);
  return Array.from(candidateMap.values());
}

async function main() {
  log('========================================================================');
  log('🎉 LIVE PARTY INVITATION RESTART ENGINE');
  log('   Pusher Host: @milespete (Miles Peter)');
  log('   Mode: Rapid Full Fleet Active Contacts Harvesting & Dispatch');
  log('========================================================================');

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  let burners = [];
  try {
    burners = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));
  } catch {}

  const miles = accounts.find(a => a.user.toLowerCase() === 'milespete');
  if (!miles || !miles.cookie) throw new Error('Miles Pete account not found in accounts.json!');

  log(`👑 Host: @${miles.user} (${miles.name}) - UID: ${miles.uid}`);

  const candidates = await collectAllActiveContacts(miles, accounts, burners);
  log(`\n🎯 TOTAL ACTIVE CONTACTS AVAILABLE TO INVITE: ${candidates.length} PLAYERS!`);

  // Start fresh restart state
  const state = loadState();
  const invitedSet = new Set(state.invited);

  let sent = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    const handle = p.username || p.name || p.id;

    if (invitedSet.has(p.id)) {
      skipped++;
      continue;
    }

    log(`[${i + 1}/${candidates.length}] 💌 Inviting ${handle} (${p.name || ''}) [${p.source}]...`);

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      const res = await sendPartyInvite(miles.cookie, p.id);

      if (res.status === 200 && res.ok) {
        log(`   ✅ Party invite delivered to ${handle}!`);
        state.invited.push(p.id);
        state.totalInvited = state.invited.length;
        invitedSet.add(p.id);
        saveState(state);
        sent++;
        await sleep(SLEEP_MS);
        break;
      } else if (res.status === 429) {
        const errMsg = res.data?.error || res.data?.message || 'Rate limit';
        log(`   ⏳ Notice: ${errMsg}`);

        if (errMsg.includes('already invited') || errMsg.includes('just invited') || errMsg.includes('pending')) {
          log(`   ℹ️ ${handle} already has an active pending invite.`);
          state.invited.push(p.id);
          state.totalInvited = state.invited.length;
          invitedSet.add(p.id);
          saveState(state);
          break;
        }

        const match = errMsg.match(/wait\s+(\d+)\s+minute/i);
        if (match) {
          const waitMins = parseInt(match[1], 10);
          log(`   ⏸️ Platform cooldown: waiting ${waitMins} min...`);
          await sleep((waitMins * 60 + 5) * 1000);
          log(`   ▶️ Resuming invite dispatch!`);
          continue;
        }

        log(`   ⏳ Backing off 6s...`);
        await sleep(6000);
        break;
      } else {
        const errDetail = res.data?.error || JSON.stringify(res.data || res.error || {});
        log(`   ⚠️ Status ${res.status}: ${errDetail}`);
        state.invited.push(p.id);
        invitedSet.add(p.id);
        saveState(state);
        await sleep(1500);
        break;
      }
    }
  }

  state.completed = true;
  saveState(state);

  log('========================================================================');
  log('🎉 PARTY INVITATION RESTART PUSH FINISHED!');
  log(`   • Newly Dispatched: ${sent}`);
  log(`   • Already Handled:   ${skipped}`);
  log(`   • Total Dispatched:  ${state.totalInvited}`);
  log('========================================================================');
}

main().catch(err => {
  log(`💥 FATAL ERROR: ${err.message}`);
  console.error(err);
});
