import fs from 'node:fs';
import crypto from 'node:crypto';

const TARGET_UID = '9ec1e08354ef4accb487'; // suzillious (Suzy)
const TARGET_USERNAME = 'suzillious';
const TOTAL_GOAL = 5_000_000_000_000;      // ₦5.0 Trillion Total
const CHUNK_SIZE = 100_000_000_000;        // ₦100 Billion max per request
const STATE_FILE = './balances_suzillious_5t.json';
const LOG_FILE = './pipeline_suzillious_5t.log';

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
      target: TARGET_USERNAME,
      targetUid: TARGET_UID,
      totalGoal: TOTAL_GOAL,
      totalDelivered: 0,
      txCount: 0,
      completed: false,
      history: []
    };
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

async function sendTransaction(account, amount) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const body = { to: TARGET_UID, amount };
    if (account.pin) {
      body.pin = account.pin;
    }
    const res = await fetch('https://lagoslife.app/api/send', {
      method: 'POST',
      headers: {
        cookie: account.cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

async function main() {
  log(`🚀 INITIALIZING 5 TRILLION TURBO MASS SEND TO @${TARGET_USERNAME}`);
  log(`🎯 Target UID: ${TARGET_UID} | Chunk Size: ₦${(CHUNK_SIZE / 1e9).toFixed(0)}B (50 TXs needed)`);

  const accountsRaw = JSON.parse(fs.readFileSync('./data/accounts.json', 'utf8'));
  let burnersRaw = [];
  try {
    burnersRaw = JSON.parse(fs.readFileSync('./data/campaign_burners.json', 'utf8'));
  } catch {}

  // Build sender armada EXCLUDING kvngdre
  const senders = [];

  // Burner accounts
  for (const b of burnersRaw) {
    senders.push({
      name: b.name || b.user,
      user: b.user,
      cookie: b.cookie,
      pin: null
    });
  }

  // Trusted powerhouse main accounts (excluding kvngdre)
  for (const acc of accountsRaw) {
    if (acc.user.toLowerCase() === 'kvngdre') continue;
    if (['danyeko', 'princedavid'].includes(acc.user.toLowerCase())) {
      senders.push({
        name: acc.name,
        user: acc.user,
        cookie: acc.cookie,
        pin: null
      });
    }
  }

  log(`👥 Active Parallel Senders Armada: ${senders.length} accounts armed.`);
  senders.forEach((s, idx) => log(`   [#${idx + 1}] @${s.user} (${s.name})`));

  const state = loadState();

  async function runSenderWorker(sender) {
    const localDelay = 21000;

    while (state.totalDelivered < TOTAL_GOAL) {
      const remainingGoal = TOTAL_GOAL - state.totalDelivered;
      if (remainingGoal <= 0) break;

      const sendAmt = Math.min(CHUNK_SIZE, remainingGoal);

      log(`⚡ [@${sender.user}] Dispatching ₦${(sendAmt / 1e9).toFixed(0)}B to @${TARGET_USERNAME}...`);

      const r = await sendTransaction(sender, sendAmt);

      if (r.ok || r.status === 200) {
        state.totalDelivered += sendAmt;
        state.txCount += 1;
        const progressPct = ((state.totalDelivered / TOTAL_GOAL) * 100).toFixed(1);

        log(`✅ [@${sender.user}] Sent ₦${(sendAmt / 1e9).toFixed(0)}B! (TX #${state.txCount}/50) -> Total: ₦${(state.totalDelivered / 1e12).toFixed(3)}T / 5.0T (${progressPct}%)`);

        state.history.push({
          sender: sender.user,
          amount: sendAmt,
          at: new Date().toISOString(),
          txId: r.data?.id
        });
        saveState(state);

        if (state.totalDelivered >= TOTAL_GOAL) {
          state.completed = true;
          saveState(state);
          log(`🎉🎉🎉 GOAL REACHED! ₦5.000 TRILLION FULLY DELIVERED TO @${TARGET_USERNAME}!`);
          break;
        }

        await sleep(localDelay);
      } else if (r.status === 429) {
        log(`⏳ [@${sender.user}] Rate limit 429 hit. Waiting 15s to retry...`);
        await sleep(15000);
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

  // Launch workers staggered by 1.2s to flood the network smoothly
  log(`🔥 LAUNCHING ALL ${senders.length} WORKERS IN PARALLEL...`);
  const workerPromises = senders.map(async (sender, i) => {
    await sleep(i * 1200);
    await runSenderWorker(sender);
  });

  await Promise.all(workerPromises);
  log(`🏁 5 TRILLION MASS SEND FINISHED! State saved to ${STATE_FILE}`);
}

main().catch(err => {
  log(`💥 FATAL ERROR: ${err.message}`);
  console.error(err);
});
