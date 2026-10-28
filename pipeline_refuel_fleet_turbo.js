import fs from 'node:fs';
import crypto from 'node:crypto';

const ACCOUNTS_FILE = './data/accounts.json';
const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_fleet_refuel.json';
const LOG_FILE = './pipeline_fleet_refuel.log';

const TARGET_PER_ACCOUNT = 1_000_000_000_000; // ₦1.000 Trillion per account
const CHUNK_SIZE = 100_000_000_000;          // ₦100 Billion per tx
const DELAY_MS = 20_500;                     // 20.5s turbo cooldown per sender
const RETRY_MS = 2_500;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function checkBalance(cookie) {
  try {
    const res = await fetch('https://lagoslife.app/api/save', {
      headers: { cookie, accept: 'application/json', 'user-agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return Number(data.game?.money ?? data.snap?.cash ?? data.cash ?? 0);
    }
  } catch {}
  return 0;
}

async function claimPending(cookie) {
  if (!cookie) return;
  try {
    const res = await fetch('https://lagoslife.app/api/family', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({ action: 'claim' })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendTransaction(senderCookie, targetUid, amount) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const res = await fetch('https://lagoslife.app/api/send', {
      method: 'POST',
      headers: {
        cookie: senderCookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({ to: targetUid, amount })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

function loadState(recipients) {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    const s = {
      totalRefueled: 0,
      totalTxs: 0,
      completed: false,
      recipients: {}
    };
    for (const r of recipients) {
      s.recipients[r.user] = {
        name: r.name,
        uid: r.uid,
        funded: 0,
        txCount: 0,
        done: false
      };
    }
    return s;
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

async function main() {
  log('========================================================================');
  log('⚡ TURBO FLEET REFUEL ENGINE: Top Up All Burners & Recruits to ₦1.000T');
  log('   Senders: @danyeko & @princedavid in parallel');
  log('   Rule: Round-robin distribution for rapid fleet readiness');
  log('========================================================================');

  const accountsRaw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const burnersRaw = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));

  // Senders: danyeko (~20T) & princedavid (~5T)
  const senders = accountsRaw.filter(a => ['danyeko', 'princedavid'].includes(a.user.toLowerCase()));
  if (!senders.length) throw new Error('No sender accounts found!');

  // Recipients to refuel: All 10 burners + fleet recruits with < 1T
  const recipients = [];

  for (const b of burnersRaw) {
    recipients.push({
      user: b.user,
      name: b.name || b.user,
      uid: b.uid,
      cookie: b.cookie
    });
  }

  // Also include low balance main fleet accounts
  const fleetUsers = ['kuronox', 'rezeeeee', 'blaqdiamond', 'mr_who'];
  for (const acc of accountsRaw) {
    if (fleetUsers.includes(acc.user.toLowerCase())) {
      recipients.push({
        user: acc.user,
        name: acc.name,
        uid: acc.uid,
        cookie: acc.cookie
      });
    }
  }

  log(`📋 Target Accounts for Refuel (${recipients.length} total):`);
  recipients.forEach((r, i) => log(`   [#${i + 1}] @${r.user} (${r.name}) - UID: ${r.uid}`));

  const state = loadState(recipients);
  saveState(state);

  // Queue of chunks to dispatch
  // Round-robin: We do passes across all accounts needing funds
  let queue = [];

  function rebuildQueue() {
    queue = [];
    // Up to 10 rounds of ₦100B
    for (let round = 1; round <= 10; round++) {
      for (const r of recipients) {
        const rState = state.recipients[r.user] || { funded: 0, done: false };
        if (!rState.done && rState.funded < TARGET_PER_ACCOUNT) {
          queue.push({
            user: r.user,
            name: r.name,
            uid: r.uid,
            cookie: r.cookie,
            round
          });
        }
      }
    }
  }

  rebuildQueue();
  log(`🎯 Total ₦100B chunks in queue: ${queue.length} (${(queue.length * 100 / 1e3).toFixed(1)} Trillion needed)`);

  let queueIdx = 0;
  let activeWorkers = 0;

  async function runSenderWorker(sender) {
    activeWorkers++;
    log(`👷 [@${sender.user}] Worker online. Ready to refuel fleet...`);

    while (queueIdx < queue.length) {
      const job = queue[queueIdx++];
      if (!job) break;

      const rState = state.recipients[job.user];
      if (rState.done || rState.funded >= TARGET_PER_ACCOUNT) continue;

      log(`⚡ [@${sender.user} ➔ @${job.user}] Dispatching ₦100B chunk (Round ${job.round})...`);

      let sent = false;
      let attempts = 0;

      while (!sent && attempts < 15) {
        attempts++;
        const res = await sendTransaction(sender.cookie, job.uid, CHUNK_SIZE);

        if (res.ok || res.status === 200) {
          sent = true;
          rState.funded += CHUNK_SIZE;
          rState.txCount += 1;
          state.totalRefueled += CHUNK_SIZE;
          state.totalTxs += 1;

          if (rState.funded >= TARGET_PER_ACCOUNT) {
            rState.done = true;
          }

          saveState(state);

          const rBalT = (rState.funded / 1e12).toFixed(2);
          const totalT = (state.totalRefueled / 1e12).toFixed(2);
          log(`✅ [@${sender.user} ➔ @${job.user}] Refueled ₦100B! (Target: ₦${rBalT}T/1.0T | Fleet Refueled: ₦${totalT}T)`);

          // Claim immediately on recipient
          if (job.cookie) {
            await claimPending(job.cookie);
          }

          // Safe cooldown
          await sleep(DELAY_MS);
        } else if (res.status === 429) {
          log(`⏳ [@${sender.user}] Rate limit 429 hit. Waiting ${RETRY_MS / 1000}s...`);
          await sleep(RETRY_MS);
        } else {
          const errMsg = res.data?.error || res.error || JSON.stringify(res.data);
          log(`⚠️ [@${sender.user}] Notice (${res.status}): ${errMsg}. Backing off 10s...`);
          await sleep(10000);
        }
      }
    }

    log(`🏁 [@${sender.user}] Worker finished its queue!`);
    activeWorkers--;
  }

  // Launch both senders staggered by 10s so they never collide
  const promises = [
    runSenderWorker(senders[0]),
    (async () => {
      if (senders[1]) {
        await sleep(10000);
        await runSenderWorker(senders[1]);
      }
    })()
  ];

  await Promise.all(promises);

  state.completed = true;
  saveState(state);
  log('\n🎉 ALL FLEET ACCOUNTS AND BURNERS HAVE BEEN FULLY REFUELED TO ₦1.000T!');
}

main().catch(err => {
  log(`💥 FATAL ERROR: ${err.message}`);
  console.error(err);
});
