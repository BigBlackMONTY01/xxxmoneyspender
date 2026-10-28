import fs from 'node:fs';
import crypto from 'node:crypto';

const BURNERS_FILE = './data/campaign_burners.json';
const ACCOUNTS_FILE = './data/accounts.json';
const LOG_FILE = './pipeline_club_eko_cash_shower.log';

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendCash(sender, toUid, amount, note) {
  const idempotencyKey = crypto.randomUUID();
  const body = {
    to: toUid,
    amount: amount,
    note: note || 'Switch to LLDC! 🎗️ Club Cash Drop'
  };
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

async function sayInWorld(sender, text) {
  try {
    await fetch('https://lagoslife.app/api/say', {
      method: 'POST',
      headers: {
        cookie: sender.cookie,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ text })
    });
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

async function main() {
  log('========================================================================');
  log('🪩 LIVE IN-WORLD CASH SHOWER & TOWN HALL ENGINE');
  log('   Target Hubs: Club Eko, The Shrine, Lekki, Beach, Banana Island');
  log('   Airdrop: ₦10,000,000,000 (10B) to every live player in room');
  log('========================================================================');

  const burners = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));

  // Use loaded burners and fleet accounts
  const senders = burners.slice(0, 6);
  const fleetSender = accounts.find(a => a.user.toLowerCase() === 'danyeko') || accounts[0];

  const paidPlayers = new Set();
  const hubs = ['clubEko', 'shrine', 'lekki', 'beach', 'bananaIsland'];

  let round = 1;
  while (true) {
    log(`\n🔄 [ROUND ${round++}] Scanning live world roaming hubs...`);
    const stats = await getPartyStats(fleetSender.cookie);
    if (stats) {
      log(`📊 CURRENT STANDINGS: LLDC: ${stats.lldcMembers} members | NIP: ${stats.nipMembers} members`);
    }

    for (let i = 0; i < hubs.length; i++) {
      const hub = hubs[i];
      const worker = senders[i % senders.length];

      try {
        // Move worker to world hub
        const wRes = await fetch('https://lagoslife.app/api/world', {
          method: 'POST',
          headers: { cookie: worker.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ location: hub })
        });

        if (wRes.ok) {
          const wData = await wRes.json();
          const people = [...(wData.guests || []), ...(wData.players || [])];

          // Shout directions to the room
          const shout = `🎗️ [LLDC ₦10B DROP] Everyone in ${hub}, open Lagos Gov ➔ Parties ➔ Switch to LLDC right now! Instant ₦10B airdrops hitting your wallet! 💸`;
          await sayInWorld(worker, shout);
          log(`📢 [@${worker.user}] Shouted in [${hub}]: "${shout}"`);

          for (const p of people) {
            const uid = p.id || p.userId || p.uid;
            if (!uid || paidPlayers.has(uid)) continue;
            if (senders.some(s => s.uid === uid)) continue;

            log(`   ⚡ [@${worker.user} ➔ @${p.username || uid}] Showering ₦10B cash drop in ${hub}...`);
            const payRes = await sendCash(worker, uid, 10_000_000_000, 'Switch to LLDC! 🎗️ Club Cash Drop');

            if (payRes.ok || payRes.status === 200) {
              paidPlayers.add(uid);
              log(`   💰 [@${worker.user} ➔ @${p.username || uid}] ₦10B Cash Delivered in ${hub}!`);
              await sleep(1500);
            } else if (payRes.status === 429) {
              log(`   ⏳ Rate limit on @${worker.user}. Cooling down 5s...`);
              await sleep(5000);
            }
          }
        }
      } catch (e) {
        log(`   ⚠️ Hub error [${hub}]: ${e.message}`);
      }
      await sleep(1000);
    }

    log(`💤 Waiting 30s before next live world patrol scan... (Total In-World Players Rewarded: ${paidPlayers.size})`);
    await sleep(30000);
  }
}

main().catch(err => {
  log(`💥 Fatal error: ${err.message}`);
  console.error(err);
});
