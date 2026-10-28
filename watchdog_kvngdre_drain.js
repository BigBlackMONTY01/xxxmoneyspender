import fs from 'node:fs';
import crypto from 'node:crypto';

const ACCOUNTS_FILE = './data/accounts.json';
const LOG_FILE = './watchdog_kvngdre_drain.log';
const DANYEKO_UID = '0579690997144755a973';
const CHUNK_SIZE = 100_000_000_000; // 100B per chunk

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getDreState(dre) {
  try {
    const res = await fetch('https://lagoslife.app/api/save', {
      headers: { cookie: dre.cookie, accept: 'application/json' }
    });
    if (res.ok) {
      const d = await res.json();
      return {
        updatedAt: d.updatedAt || 0,
        money: d.game?.money || 0,
        ok: true
      };
    }
  } catch {}
  return { ok: false };
}

async function transferFromDre(dre, amount) {
  const idempotencyKey = crypto.randomUUID();
  try {
    const res = await fetch('https://lagoslife.app/api/send', {
      method: 'POST',
      headers: {
        cookie: dre.cookie,
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': idempotencyKey,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        to: DANYEKO_UID,
        amount: amount,
        note: 'Warchest Allocation ⚡'
      })
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

async function main() {
  log('========================================================================');
  log('⏱️ KVNGDRE 30-MINUTE IDLE WATCHDOG & AUTO-DRAIN DAEMON');
  log('   Rule: If Kvngdre idle >= 30 minutes, transfer funds to Danyeko');
  log('========================================================================');

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  const dre = accounts.find(a => a.user.toLowerCase() === 'kvngdre');

  if (!dre) {
    log('❌ Kvngdre not found in accounts.json!');
    return;
  }

  while (true) {
    const state = await getDreState(dre);
    if (state.ok) {
      const now = Date.now();
      const diffMin = Math.round((now - state.updatedAt) / 60000);
      const moneyT = (state.money / 1e12).toFixed(3);

      log(`👁️ [WATCHDOG] Kvngdre Balance: ₦${moneyT}T | Idle: ${diffMin} min (Threshold: 30 min)`);

      if (diffMin >= 30 && state.money > CHUNK_SIZE) {
        log(`🚨 [IDLE THRESHOLD REACHED] Kvngdre has been inactive for ${diffMin} min! Starting transfer to Danyeko...`);
        let drainedThisSession = 0;

        while (drainedThisSession < 10_000_000_000_000) { // Drain 10T per cycle
          const check = await getDreState(dre);
          const currentDiff = Math.round((Date.now() - check.updatedAt) / 60000);
          if (currentDiff < 30) {
            log(`⚠️ Kvngdre became active again (${currentDiff} min ago)! Pausing drain.`);
            break;
          }

          const res = await transferFromDre(dre, CHUNK_SIZE);
          if (res.ok || res.status === 200) {
            drainedThisSession += CHUNK_SIZE;
            log(`   ✅ Drained ₦100B from Kvngdre to Danyeko (Session: ₦${(drainedThisSession/1e9)}B)`);
            await sleep(1500);
          } else if (res.status === 429) {
            log('   ⏳ Cooldown (429). Waiting 5s...');
            await sleep(5000);
          } else {
            log(`   ⚠️ Error: ${JSON.stringify(res.data)}`);
            break;
          }
        }
      }
    }

    await sleep(30000); // Check every 30s
  }
}

main().catch(err => {
  log(`💥 Fatal watchdog error: ${err.message}`);
  console.error(err);
});
