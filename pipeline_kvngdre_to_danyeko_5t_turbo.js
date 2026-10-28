import fs from 'node:fs';
import crypto from 'node:crypto';

const ACCOUNTS_FILE = './data/accounts.json';
const STATE_FILE = './balances_kvngdre_to_danyeko_5t.json';
const LOG_FILE = './pipeline_kvngdre_to_danyeko_5t.log';

const SENDER_KEY = 'Kvngdre';
const TARGET_ID = '0579690997144755a973'; // Danny (@danyeko)
const TARGET_NAME = 'danyeko';
const TOTAL_GOAL = 5_000_000_000_000;    // ₦5.0 Trillion Total
const CHUNK_SIZE = 100_000_000_000;      // ₦100 Billion max per request
const DELAY_MS = 20_500;                 // 20.5s cooldown
const RAPID_RETRY_MS = 3_000;            // 3s retry on 429

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
      sender: SENDER_KEY,
      targetId: TARGET_ID,
      targetUsername: TARGET_NAME,
      totalGoal: TOTAL_GOAL,
      totalDelivered: 100_000_000_000, // 1st 100B already confirmed
      txCount: 1,
      completed: false,
      history: [
        {
          sender: SENDER_KEY,
          amount: 100_000_000_000,
          at: new Date().toISOString(),
          txId: '851dd38d205546ef86cb'
        }
      ]
    };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

async function sendTransaction(cookie, targetId, amount) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const res = await fetch('https://lagoslife.app/api/send', {
      method: 'POST',
      headers: {
        cookie: cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ to: targetId, amount })
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

async function main() {
  log(`🚀 INITIALIZING 5 TRILLION TURBO PIPELINE: @${SENDER_KEY} -> @${TARGET_NAME}`);
  log(`🎯 Target UID: ${TARGET_ID} | Chunk Size: ₦${(CHUNK_SIZE / 1e9).toFixed(0)}B (50 TXs needed)`);

  const accountsRaw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const dre = accountsRaw.find(a => a.user.toLowerCase() === 'kvngdre');
  if (!dre) throw new Error('Kvngdre account not found in data/accounts.json');

  const state = loadState();
  saveState(state);

  log(`📊 Initial State: Delivered ₦${(state.totalDelivered / 1e12).toFixed(3)}T / 5.0T (${((state.totalDelivered / TOTAL_GOAL) * 100).toFixed(1)}%) | TX #${state.txCount}/50`);

  while (state.totalDelivered < TOTAL_GOAL) {
    const remaining = TOTAL_GOAL - state.totalDelivered;
    if (remaining <= 0) break;

    const sendAmt = Math.min(CHUNK_SIZE, remaining);
    log(`⚡ Dispatching ₦${(sendAmt / 1e9).toFixed(0)}B chunk to @${TARGET_NAME}...`);

    let sent = false;
    let attempts = 0;

    while (!sent && attempts < 10) {
      attempts++;
      const r = await sendTransaction(dre.cookie, TARGET_ID, sendAmt);

      if (r.ok || r.status === 200) {
        sent = true;
        state.totalDelivered += sendAmt;
        state.txCount += 1;
        const pct = ((state.totalDelivered / TOTAL_GOAL) * 100).toFixed(1);

        log(`✅ Sent ₦${(sendAmt / 1e9).toFixed(0)}B! (TX #${state.txCount}/50) -> Delivered: ₦${(state.totalDelivered / 1e12).toFixed(3)}T / 5.0T (${pct}%)`);

        state.history.push({
          sender: SENDER_KEY,
          amount: sendAmt,
          at: new Date().toISOString(),
          txId: r.data?.id
        });
        saveState(state);

        if (state.totalDelivered >= TOTAL_GOAL) {
          state.completed = true;
          saveState(state);
          log(`🎉🎉🎉 GOAL REACHED! ₦5.000 TRILLION FULLY DELIVERED TO @${TARGET_NAME}!`);
          break;
        }

        // Wait cooldown between sends
        await sleep(DELAY_MS);
      } else if (r.status === 429) {
        log(`⏳ Rate limit 429 hit. Waiting ${RAPID_RETRY_MS / 1000}s rapid cooldown...`);
        await sleep(RAPID_RETRY_MS);
      } else {
        const errMsg = r.data?.error || r.error || JSON.stringify(r.data);
        log(`⚠️ Notice (${r.status}): ${errMsg}. Backing off 10s...`);
        await sleep(10000);
      }
    }
  }

  log(`🏁 5 TRILLION PIPELINE FINISHED! State saved to ${STATE_FILE}`);
}

main().catch(err => {
  log(`💥 FATAL ERROR: ${err.message}`);
  console.error(err);
});
