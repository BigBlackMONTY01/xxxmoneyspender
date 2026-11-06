import fs from "node:fs";

// Session Cookie for @blaqsebastian
const COOKIE = "ll_dev=6a3s6k3232505u2d; ll_session=339d61047977ccde5cdc1ff6217ed6992e93fd8e2d842193fa95b54129d8f3fd; ll_pass=eyJpIjoiYmQ3NzI5ZmExZWVhNDJhMGJlNDAiLCJ1IjoiZGF0aWVtbzAwMSIsIm4iOiJEYXRpZW1vIiwidCI6IlpWN2Vzb21PODdpWjFKTzEiLCJlIjoxNzkzMTA4NTM4NjE0fQ.H6lpEoOLgwIRRqda7G0FFZ7qPDYkTkwCSPqOiPMqr1E";

const BASE_URL = "https://lagoslife.app/api/messages";
const STATE_FILE = "./bulk_message_state.json";
const RECIPIENTS_FILE = "./recipients_to_message.json";

// Default delay between messages (in ms) to avoid spam filters / rate limits
const DELAY_MS = Number(process.env.DELAY_MS) || 2500;
const RETRY_DELAY_MS = 5000;

function loadRecipients() {
  if (!fs.existsSync(RECIPIENTS_FILE)) {
    console.error(`Recipients file not found at ${RECIPIENTS_FILE}. Run 'node fetch_inbox_recipients.js' first!`);
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(RECIPIENTS_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to parse recipients file:", err.message);
    return [];
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sent: {}, failed: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendMessage(targetId, body) {
  try {
    const resp = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "cookie": COOKIE,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: JSON.stringify({ to: targetId, body })
    });

    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

async function main() {
  let list = loadRecipients();
  const state = loadState();

  // Filter options via environment variables
  if (process.env.ONLY_UNREAD === "1") {
    list = list.filter(r => r.unread > 0);
    console.log(`🔍 Filter applied: ONLY_UNREAD=1 (${list.length} recipients)`);
  }
  if (process.env.ONLY_ONLINE === "1") {
    list = list.filter(r => r.online);
    console.log(`🔍 Filter applied: ONLY_ONLINE=1 (${list.length} recipients)`);
  }

  // Sort so currently online players get contacted first
  list.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));

  // Message template (supports placeholders {name} and {username})
  const TEMPLATE = process.env.MSG || "Hey {name}! Server-End Money Injector Script Available: 500B / 25 mins. Also Available: Money & Stacked Accounts.. SERIOUS BUYERS ONLY.. DM @spacetech_ for enquiries";

  console.log("=================================================");
  console.log("    LAGOSLIFE BULK MESSAGE SENDER (@milespete)   ");
  console.log("=================================================");
  console.log(`Targets queued: ${list.length}`);
  console.log(`Template: "${TEMPLATE}"`);
  console.log(`Delay: ${DELAY_MS / 1000}s per message\n`);

  let count = 0;

  for (const item of list) {
    const targetId = item.id;
    const name = item.name || "friend";
    const username = item.username || "";

    if (!targetId) continue;

    // Skip if already sent
    if (state.sent[targetId]) {
      console.log(`⏩ [Skipped] Already sent to ${name} (${username || targetId})`);
      continue;
    }

    // Format personalized text
    const messageBody = TEMPLATE
      .replace(/\{name\}/gi, name)
      .replace(/\{username\}/gi, username);

    count++;
    console.log(`[#${count}] Sending to ${name} (${username || targetId})...`);

    let success = false;
    let attempts = 0;

    while (!success && attempts < 3) {
      attempts++;
      const res = await sendMessage(targetId, messageBody);

      if (res.status === 200) {
        success = true;
        state.sent[targetId] = {
          sentAt: new Date().toISOString(),
          name,
          username,
          msgId: res.data.id || null
        };
        saveState(state);
        console.log(`  ✅ Sent! (Message ID: ${res.data.id || "ok"})`);
        await sleep(DELAY_MS);
      } else if (res.status === 429) {
        console.log(`  ⏳ Rate limited (429). Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      } else if (res.status === 401) {
        console.error(`  🔒 Session expired! Update COOKIE in script.`);
        process.exit(1);
      } else {
        console.error(`  ❌ Error ${res.status}:`, res.data || res.error);
        state.failed[targetId] = { error: res.data || res.error, at: new Date().toISOString() };
        saveState(state);
        break;
      }
    }
  }

  console.log("\n🎉 Finished broadcast run!");
  console.log(`Total messages sent this run: ${count}`);
}

main().catch(console.error);
