import fs from 'node:fs';
import crypto from 'node:crypto';

const accounts = JSON.parse(fs.readFileSync('./data/accounts.json', 'utf8'));
const miles = accounts.find(a => a.user.toLowerCase() === 'milespete');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendChunk(toUid, amount) {
  const idempotencyKey = crypto.randomUUID();
  const res = await fetch('https://lagoslife.app/api/send', {
    method: 'POST',
    headers: {
      cookie: miles.cookie,
      'content-type': 'application/json',
      accept: 'application/json',
      'idempotency-key': idempotencyKey,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify({ to: toUid, amount, note: 'Armada Refuel ⚡' })
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function refuelTarget(name, uid, totalNeeded) {
  const CHUNK = 100_000_000_000; // 100B per chunk
  let sent = 0;
  console.log(`⚡ Refueling ${name} (${uid}) with ₦${(totalNeeded/1e9)}B...`);
  while (sent < totalNeeded) {
    const chunk = Math.min(CHUNK, totalNeeded - sent);
    const res = await sendChunk(uid, chunk);
    if (res.ok || res.status === 200) {
      sent += chunk;
      console.log(`   ✅ Sent ₦${chunk/1e9}B to ${name} (${sent/1e9}/${totalNeeded/1e9}B)`);
      await sleep(1500);
    } else if (res.status === 429) {
      console.log('   ⏳ 429 cooldown, waiting 5s...');
      await sleep(5000);
    } else {
      console.log(`   ⚠️ Error: ${JSON.stringify(res.data)}`);
      break;
    }
  }
}

async function run() {
  // Refuel PrinceDavid (1T)
  await refuelTarget('PrinceDavid', '7e791760cd644f13ba5a', 1_000_000_000_000);
  // Refuel BlaqDiamond (500B)
  await refuelTarget('BlaqDiamond', 'ad90bca228584ee9abb7', 500_000_000_000);
  console.log('🎉 Refueling Complete!');
}

run().catch(console.error);
