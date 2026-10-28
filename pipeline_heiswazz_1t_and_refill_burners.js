import fs from 'node:fs';
import crypto from 'node:crypto';

const TARGET_UID = '712e924948a84d57a6d7'; // heiswazz
const TARGET_USERNAME = 'heiswazz';
const TARGET_GOAL = 1_000_000_000_000;    // ₦1.0 Trillion Total
const CHUNK_SIZE = 100_000_000_000;       // ₦100 Billion per chunk

const ACCOUNTS_FILE = './data/accounts.json';
const BURNERS_FILE = './data/campaign_burners.json';
const STATE_FILE = './balances_heiswazz_1t.json';
const REFILL_STATE_FILE = './balances_burners_refill.json';
const LOG_FILE = './pipeline_heiswazz_and_refill.log';

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function sendTransaction(cookie, recipientId, amount) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const res = await fetch('https://lagoslife.app/api/send', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({ to: recipientId, amount })
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// ==========================================
// PHASE 1: SEND 1T TO @heiswazz
// ==========================================
async function runPhase1Send(senders) {
  log('========================================================================');
  log(`🚀 PHASE 1: SEND ₦1.000 TRILLION TO @${TARGET_USERNAME}`);
  log(`🎯 Target UID: ${TARGET_UID} | Chunk Size: ₦100B (10 TXs needed)`);
  log('========================================================================');

  let state = {
    target: TARGET_USERNAME,
    targetUid: TARGET_UID,
    totalGoal: TARGET_GOAL,
    totalDelivered: 0,
    txCount: 0,
    completed: false,
    history: []
  };

  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}

  async function runSenderWorker(sender) {
    const localDelay = 21000;

    while (state.totalDelivered < TARGET_GOAL) {
      const remainingGoal = TARGET_GOAL - state.totalDelivered;
      if (remainingGoal <= 0) break;

      const sendAmt = Math.min(CHUNK_SIZE, remainingGoal);
      log(`⚡ [@${sender.user}] Dispatching ₦${(sendAmt / 1e9).toFixed(0)}B to @${TARGET_USERNAME}...`);

      const r = await sendTransaction(sender.cookie, TARGET_UID, sendAmt);

      if (r.ok || r.status === 200) {
        state.totalDelivered += sendAmt;
        state.txCount += 1;
        const progressPct = ((state.totalDelivered / TARGET_GOAL) * 100).toFixed(1);

        log(`✅ [@${sender.user}] Sent ₦${(sendAmt / 1e9).toFixed(0)}B! (TX #${state.txCount}/10) -> Total: ₦${(state.totalDelivered / 1e12).toFixed(3)}T / 1.0T (${progressPct}%)`);

        state.history.push({
          sender: sender.user,
          amount: sendAmt,
          at: new Date().toISOString(),
          txId: r.data?.id
        });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

        if (state.totalDelivered >= TARGET_GOAL) {
          state.completed = true;
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
          log(`🎉🎉🎉 PHASE 1 COMPLETE: ₦1.000 TRILLION FULLY DELIVERED TO @${TARGET_USERNAME}!`);
          break;
        }

        await sleep(localDelay);
      } else if (r.status === 429) {
        log(`⏳ [@${sender.user}] Rate limit 429. Retrying in 5s...`);
        await sleep(5000);
      } else {
        const errMsg = r.data?.error || r.error || JSON.stringify(r.data);
        log(`⚠️ [@${sender.user}] Notice (${r.status}): ${errMsg}`);
        if (errMsg && (errMsg.includes('funds') || errMsg.includes('balance') || errMsg.includes('money') || errMsg.includes('enough'))) {
          log(`🛑 [@${sender.user}] Out of funds. Retiring worker.`);
          break;
        }
        await sleep(10000);
      }
    }
  }

  log(`🔥 Launching senders in parallel for Phase 1...`);
  const promises = senders.map(async (sender, i) => {
    await sleep(i * 1200);
    await runSenderWorker(sender);
  });

  await Promise.all(promises);
  log(`🏁 PHASE 1 FINISHED! Total delivered: ₦${(state.totalDelivered / 1e12).toFixed(3)}T`);
}

// ==========================================
// PHASE 2: REFILL ALL BURNER ACCOUNTS TO 1T
// ==========================================
async function runPhase2Refill(burners, funderAccount) {
  log('\n========================================================================');
  log(`⚡ PHASE 2: REFILL ALL 10 BURNER ACCOUNTS TO ₦1.000 TRILLION WAR CHEST`);
  log(`   Funder: @${funderAccount.user} (~₦12.5T available liquid)`);
  log('========================================================================');

  let state = {
    totalRefueled: 0,
    totalTxs: 0,
    completed: false,
    burners: {}
  };

  try {
    state = JSON.parse(fs.readFileSync(REFILL_STATE_FILE, 'utf8'));
  } catch {
    for (const b of burners) {
      state.burners[b.user] = {
        name: b.name || b.user,
        uid: b.uid,
        funded: 0,
        txCount: 0,
        done: false
      };
    }
  }

  // Refill in round-robin passes of ₦100B so all accounts gain immediate liquidity
  const TARGET_PER_BURNER = 1_000_000_000_000; // ₦1.000T
  const queue = [];

  for (let round = 1; round <= 10; round++) {
    for (const b of burners) {
      const bState = state.burners[b.user] || { funded: 0, done: false };
      if (!bState.done && bState.funded < TARGET_PER_BURNER) {
        queue.push({
          user: b.user,
          name: b.name || b.user,
          uid: b.uid,
          cookie: b.cookie,
          round
        });
      }
    }
  }

  log(`📋 Refill Queue: ${queue.length} chunks of ₦100B to dispatch (Round-robin)`);

  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    const bState = state.burners[job.user];
    if (bState.done || bState.funded >= TARGET_PER_BURNER) continue;

    log(`⚡ [@${funderAccount.user} ➔ @${job.user}] Dispatching ₦100B chunk (Round ${job.round})...`);

    let sent = false;
    let attempts = 0;

    while (!sent && attempts < 15) {
      attempts++;
      const res = await sendTransaction(funderAccount.cookie, job.uid, CHUNK_SIZE);

      if (res.ok || res.status === 200) {
        sent = true;
        bState.funded += CHUNK_SIZE;
        bState.txCount += 1;
        state.totalRefueled += CHUNK_SIZE;
        state.totalTxs += 1;

        if (bState.funded >= TARGET_PER_BURNER) {
          bState.done = true;
        }

        fs.writeFileSync(REFILL_STATE_FILE, JSON.stringify(state, null, 2));

        const rBalT = (bState.funded / 1e12).toFixed(2);
        const totalT = (state.totalRefueled / 1e12).toFixed(2);
        log(`✅ [@${funderAccount.user} ➔ @${job.user}] Refueled ₦100B! (Burner: ₦${rBalT}T/1.0T | Fleet Total: ₦${totalT}T)`);

        // Claim immediately on burner
        if (job.cookie) {
          await claimPending(job.cookie);
        }

        // 20.5s cooldown
        await sleep(20500);
      } else if (res.status === 429) {
        log(`⏳ Rate limit 429. Waiting 2.5s rapid cooldown...`);
        await sleep(2500);
      } else {
        const errMsg = res.data?.error || res.error || JSON.stringify(res.data);
        log(`⚠️ Send Notice (${res.status}): ${errMsg}. Backing off 10s...`);
        await sleep(10000);
      }
    }
  }

  state.completed = true;
  fs.writeFileSync(REFILL_STATE_FILE, JSON.stringify(state, null, 2));
  log(`\n🎉 ALL 10 BURNER ACCOUNTS HAVE BEEN FULLY REFILLED TO ₦1.000T WAR CHEST!`);
}

async function main() {
  const accountsRaw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const burnersRaw = JSON.parse(fs.readFileSync(BURNERS_FILE, 'utf8'));

  // Build Phase 1 senders armada
  const senders = [];
  for (const b of burnersRaw) {
    senders.push({
      name: b.name || b.user,
      user: b.user,
      cookie: b.cookie
    });
  }

  const allowedMainUsers = ['danyeko', 'kuronox', 'rezeeeee', 'blaqdiamond', 'mr_who'];
  for (const acc of accountsRaw) {
    if (allowedMainUsers.includes(acc.user.toLowerCase())) {
      senders.push({
        name: acc.name,
        user: acc.user,
        cookie: acc.cookie
      });
    }
  }

  const danyekoAcc = accountsRaw.find(a => a.user.toLowerCase() === 'danyeko');
  if (!danyekoAcc) throw new Error('Danyeko account not found in accounts.json!');

  // Execute Phase 1: 1T to @heiswazz
  await runPhase1Send(senders);

  // Execute Phase 2: Refill all burners to 1T
  await runPhase2Refill(burnersRaw, danyekoAcc);

  log('🏁 ALL OPERATIONS (HEISWAZZ 1T + FULL BURNER REFILL) FINISHED SUCCESSFULLY!');
}

main().catch(err => {
  log(`💥 FATAL ERROR: ${err.message}`);
  console.error(err);
});
