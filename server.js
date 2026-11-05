import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || process.env.ADMIN_PIN || "2026";
const MAX_TRANSFER_CHUNK = 100_000_000_000; // 100 Billion max per request enforced by LagosLife API

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Only genuinely public assets are served statically
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

const DATA_DIR = path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const LEDGER_FILE = path.join(DATA_DIR, "ledger.json");
const PRIVATE_ADMIN_DIR = path.join(__dirname, "private_admin");

// In-memory sessions & active transfer workers
const adminSessions = new Map(); // token -> { createdAt, ip }
const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const activeJobs = new Map();
const cachedBalances = new Map();
const clientSessions = new Map(); // token -> { account, jobs: [] }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitInterval(delayMs, workerState) {
  const step = Math.min(50, Math.max(10, delayMs));
  let elapsed = 0;
  while (elapsed < delayMs && !workerState?.cancelled && !workerState?.paused) {
    await sleep(step);
    elapsed += step;
  }
}

async function readJson(file, def = []) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return def;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// -------------------------------------------------------------
// Authentication Helpers
// -------------------------------------------------------------
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(";").forEach(c => {
      const parts = c.split("=");
      list[parts.shift().trim()] = decodeURI(parts.join("="));
    });
  }
  return list;
}

function mergeCookies(baseCookie, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return baseCookie;
  const cookieMap = new Map();
  if (baseCookie) {
    baseCookie.split(";").forEach(part => {
      const idx = part.indexOf("=");
      if (idx !== -1) {
        cookieMap.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
      }
    });
  }
  for (const c of setCookieHeaders) {
    const raw = c.split(";")[0];
    const idx = raw.indexOf("=");
    if (idx !== -1) {
      cookieMap.set(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim());
    }
  }
  return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function checkAdminAuth(req) {
  const cookies = parseCookies(req);
  const token = req.headers["x-admin-token"] || cookies.ll_admin_session;
  if (token && adminSessions.has(token)) {
    return true;
  }
  const pin = req.headers["x-admin-pin"] || req.query.pin;
  if (pin && pin === ADMIN_PASSCODE) {
    return true;
  }
  return false;
}

function requireAdminAuth(req, res, next) {
  if (checkAdminAuth(req)) {
    return next();
  }
  return res.status(401).json({ error: "Access Denied: Master Authentication Required." });
}

function parseAmount(raw) {
  if (!raw) return 0;
  const s = String(raw).trim().toLowerCase().replace(/,/g, "").replace(/₦/g, "").replace(/\s/g, "");
  if (s.endsWith("q")) return parseFloat(s) * 1e15;
  if (s.endsWith("t")) return parseFloat(s) * 1e12;
  if (s.endsWith("b")) return parseFloat(s) * 1e9;
  if (s.endsWith("m")) return parseFloat(s) * 1e6;
  if (s.endsWith("k")) return parseFloat(s) * 1e3;
  return parseFloat(s) || 0;
}

// -------------------------------------------------------------
// Core Known Usernames Map
// -------------------------------------------------------------
const USERNAME_MAP = {
  "blaqsebastian": "7785cae4f157450490d5",
  "sebastian": "7785cae4f157450490d5",
  "milespete": "bc745837935d45efbf47",
  "miles": "bc745837935d45efbf47",
  "princedavid": "7e791760cd644f13ba5a",
  "mr_who": "d4f4aed94d6e491989cf",
  "lldc": "802ef46ea4eb4b1b8b47",
  "kvngdre": "1ab3a45045544574afe8",
  "dre": "1ab3a45045544574afe8",
  "bigola2823": "6e3c4bdaac6f4765ba52",
  "mr_ace": "6e3c4bdaac6f4765ba52"
};

// Fast Offline Contacts Cache (26,000+ players loaded from disk)
const CONTACTS_MAP = new Map();
(async () => {
  try {
    const contactsPath = path.join(__dirname, "mega_contacts_list.json");
    if (await fs.stat(contactsPath).catch(() => null)) {
      const raw = await fs.readFile(contactsPath, "utf8");
      const list = JSON.parse(raw);
      for (const item of list) {
        if (item.username && item.id) {
          const u = String(item.username).toLowerCase().replace(/^@/, "").trim();
          CONTACTS_MAP.set(u, { id: item.id, username: item.username.replace(/^@/, ""), name: item.name });
        }
      }
      console.log(`⚡ Cached ${CONTACTS_MAP.size} offline contacts for instant 0ms username resolution.`);
    }
  } catch (err) {
    console.error("Error loading mega contacts into cache:", err.message);
  }
})();

async function resolveTargetIdAsync(input, cookie) {
  if (!input) return null;
  // Strip list markers like "1. ", "- ", bullets, quotes and trim
  let trimmed = String(input).trim().replace(/^[\d\.\-\*\•\)\(\]\"\'\s]+/, "").replace(/[\"\'\,]/g, "").trim();

  // 1. Check if URL with ?with=...
  const urlMatch = trimmed.match(/[?&]with=([a-f0-9]{16,})/i);
  if (urlMatch) return { id: urlMatch[1], username: urlMatch[1] };

  // 2. Check if player profile URL
  const profileMatch = trimmed.match(/lagoslife\.app\/.*?([a-f0-9]{16,})/i);
  if (profileMatch) return { id: profileMatch[1], username: profileMatch[1] };

  // 3. Check if exact 20-character hex ID
  if (/^[a-f0-9]{20}$/i.test(trimmed)) {
    return { id: trimmed, username: trimmed };
  }

  // 4. Check known static map
  const clean = trimmed.toLowerCase().replace(/^@/, "");
  if (USERNAME_MAP[clean]) {
    return { id: USERNAME_MAP[clean], username: clean };
  }

  // 5. Check offline contacts cache (instant, no rate limits)
  if (CONTACTS_MAP.has(clean)) {
    const c = CONTACTS_MAP.get(clean);
    return { id: c.id, username: c.username, name: c.name };
  }

  // 6. Query LagosLife API live to resolve username
  try {
    const res = await fetch(`https://lagoslife.app/api/players?q=${encodeURIComponent(clean)}`, {
      headers: {
        "accept": "application/json",
        "cookie": cookie || "",
        "user-agent": "Mozilla/5.0"
      }
    });
    if (res.ok) {
      const data = await res.json();
      const players = data.players || [];
      const match = players.find(p => (p.username || "").toLowerCase() === clean) || players[0];
      if (match) {
        CONTACTS_MAP.set(clean, { id: match.id, username: match.username, name: match.name });
        return { id: match.id, username: match.username, name: match.name, avatar: match.look };
      }
    }
  } catch (err) {
    console.error("Resolve error:", err.message);
  }

  return null;
}

// -------------------------------------------------------------
// Core LagosLife API Functions
// -------------------------------------------------------------
async function fetchAccountData(cookie) {
  try {
    const res = await fetch("https://lagoslife.app/api/save", {
      headers: {
        "accept": "application/json",
        "cookie": cookie,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    const money = data.game?.money ?? data.snap?.cash ?? data.cash ?? null;
    const name = data.game?.sim?.name || data.game?.owner?.name || null;
    return { ok: true, money, name, full: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendMoney(cookie, to, amount, key, twoStepCode) {
  try {
    const body = { to, amount };
    if (twoStepCode && String(twoStepCode).trim()) {
      const codeStr = String(twoStepCode).trim();
      body.pin = codeStr;
      body.code = codeStr;
      body.twoStep = codeStr;
    }
    const headers = {
      "accept": "application/json",
      "content-type": "application/json",
      "origin": "https://lagoslife.app",
      "referer": "https://lagoslife.app/",
      "cookie": cookie,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
    };
    headers["idempotency-key"] = key || crypto.randomUUID();
    const res = await fetch("https://lagoslife.app/api/send", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

// -------------------------------------------------------------
// Ledger & Audit Log Recording
// -------------------------------------------------------------
async function recordLedgerEntry(entry) {
  try {
    const ledger = await readJson(LEDGER_FILE, []);
    const idx = ledger.findIndex(x => x.id === entry.id);
    if (idx >= 0) {
      ledger[idx] = { ...ledger[idx], ...entry };
    } else {
      ledger.unshift({
        id: entry.id || `rec_${Date.now()}_${Math.random().toString(36).slice(7)}`,
        timestamp: entry.timestamp || Date.now(),
        timeStr: new Date(entry.timestamp || Date.now()).toLocaleString("en-GB", {
          day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true
        }),
        ...entry
      });
    }
    await writeJson(LEDGER_FILE, ledger);
  } catch (err) {
    console.error("Ledger write error:", err.message);
  }
}

// -------------------------------------------------------------
// Admin Authentication Routes
// -------------------------------------------------------------

// Admin Login
app.post("/api/admin/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempt = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (attempt.lockedUntil > now) {
    const waitSec = Math.ceil((attempt.lockedUntil - now) / 1000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitSec}s.` });
  }

  const { passcode } = req.body;
  if (!passcode || passcode !== ADMIN_PASSCODE) {
    attempt.count++;
    if (attempt.count >= 5) {
      attempt.lockedUntil = now + 15 * 60 * 1000; // 15 min lockout
    }
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: "Invalid master security code." });
  }

  // Clear failed attempts on success
  loginAttempts.delete(ip);

  // Generate cryptographic session token
  const token = "adm_" + crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, { createdAt: now, ip });

  // Set secure HTTP-only cookie
  res.setHeader("Set-Cookie", `ll_admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  res.json({ success: true, token });
});

// Admin Logout
app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const token = req.headers["x-admin-token"] || cookies.ll_admin_session;
  if (token) adminSessions.delete(token);

  res.setHeader("Set-Cookie", "ll_admin_session=; Path=/; HttpOnly; Max-Age=0");
  res.json({ success: true, message: "Logged out successfully" });
});

// -------------------------------------------------------------
// Admin Dashboard & Protected View Serving
// -------------------------------------------------------------

// Master Admin View
// Master Admin View
app.get(["/admin", "/master", "/vault"], (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (checkAdminAuth(req)) {
    return res.sendFile(path.join(PRIVATE_ADMIN_DIR, "admin.html"));
  }
  return res.sendFile(path.join(PRIVATE_ADMIN_DIR, "login.html"));
});

// Dedicated Login Page
app.get("/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (checkAdminAuth(req)) {
    return res.redirect("/admin");
  }
  return res.sendFile(path.join(PRIVATE_ADMIN_DIR, "login.html"));
});

// Protected Admin Static Assets
app.get("/admin-assets/style.css", (req, res) => {
  if (checkAdminAuth(req)) {
    res.setHeader("Content-Type", "text/css");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.sendFile(path.join(PRIVATE_ADMIN_DIR, "style.css"));
  }
  res.status(403).send("Forbidden");
});

app.get("/admin-assets/app.js", (req, res) => {
  if (checkAdminAuth(req)) {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.sendFile(path.join(PRIVATE_ADMIN_DIR, "app.js"));
  }
  res.status(403).send("Forbidden");
});

// -------------------------------------------------------------
// Admin Data & Control APIs (All Require Authentication)
// -------------------------------------------------------------

// Accounts Overview (Sanitized - Never leaks raw cookies!)
app.get("/api/accounts", requireAdminAuth, async (req, res) => {
  const accounts = await readJson(ACCOUNTS_FILE, []);
  const enriched = [];

  for (const acc of accounts) {
    let cached = cachedBalances.get(acc.id);
    const now = Date.now();
    if (!cached || now - cached.timestamp > 25000) {
      const live = await fetchAccountData(acc.cookie);
      cached = {
        money: live.ok ? live.money : (cached?.money || 0),
        status: live.ok ? "ACTIVE" : (live.status === 401 ? "EXPIRED" : "ERROR"),
        timestamp: now
      };
      cachedBalances.set(acc.id, cached);
    }

    enriched.push({
      id: acc.id,
      name: acc.name,
      user: acc.user,
      uid: acc.uid,
      money: cached.money,
      status: cached.status
    });
  }

  res.json(enriched);
});

// Update Cookie for Account
app.post("/api/accounts/update-cookie", requireAdminAuth, async (req, res) => {
  const { accountId, cookie } = req.body;
  if (!accountId || !cookie) return res.status(400).json({ error: "accountId and cookie required" });

  const accounts = await readJson(ACCOUNTS_FILE, []);
  const idx = accounts.findIndex(a => a.id === accountId);
  if (idx === -1) return res.status(404).json({ error: "Account not found" });

  accounts[idx].cookie = cookie.trim();
  await writeJson(ACCOUNTS_FILE, accounts);
  cachedBalances.delete(accountId);

  res.json({ success: true, message: "Session cookie updated" });
});

// Resolve Recipient (Autocomplete)
app.get("/api/resolve-recipient", requireAdminAuth, async (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "Query required" });

  const accounts = await readJson(ACCOUNTS_FILE, []);
  const activeAcc = accounts.find(a => a.cookie) || accounts[0];

  const resolved = await resolveTargetIdAsync(query, activeAcc?.cookie);
  if (!resolved) {
    return res.status(404).json({ error: `Could not find player '${query}'.` });
  }

  return res.json(resolved);
});

// Active Transfers (Running, Paused, or Scheduled)
app.get("/api/transfers/active", requireAdminAuth, async (req, res) => {
  const jobs = await readJson(JOBS_FILE, []);
  const serverActive = jobs.filter(j => j.status === "RUNNING" || j.status === "PAUSED" || j.status === "SCHEDULED");
  res.json(serverActive);
});

// Transfer History
app.get("/api/transfers/history", requireAdminAuth, async (req, res) => {
  const jobs = await readJson(JOBS_FILE, []);
  const serverHist = jobs.filter(j => j.status !== "RUNNING" && j.status !== "PAUSED" && j.status !== "SCHEDULED");
  res.json(serverHist.slice(0, 30));
});

// Helper: Revive worker loop if server rebooted while job was PAUSED or RUNNING, or when a SCHEDULED job triggers
function reviveJobWorker(job) {
  if (activeJobs.has(job.id)) return;
  const workerState = { cancelled: false, paused: false };
  activeJobs.set(job.id, workerState);

  (async () => {
    try {
      const accounts = await readJson(ACCOUNTS_FILE, []);
      const acc = accounts.find(a => a.id === job.accountId) || accounts.find(a => a.name === job.sender);
      if (!acc || !acc.cookie) {
        job.status = "FAILED";
        job.logs = job.logs || [];
        job.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Failed to execute: Sender account session unavailable.`);
        const jobs = await readJson(JOBS_FILE, []);
        const idx = jobs.findIndex(x => x.id === job.id);
        if (idx !== -1) jobs[idx] = job;
        await writeJson(JOBS_FILE, jobs);
        activeJobs.delete(job.id);
        return;
      }

      const jobs = await readJson(JOBS_FILE, []);
      const currentJob = jobs.find(x => x.id === job.id) || job;

      // Handle Batch Transfers
      if (currentJob.type === "BATCH" && Array.isArray(currentJob.recipients)) {
        const recipients = currentJob.recipients;
        const amountPerUser = Number(currentJob.amountPerUser || currentJob.total) || 100_000_000_000;
        const maxChunk = Number.MAX_SAFE_INTEGER;
        const delayMs = 400;
        let totalTxCount = currentJob.txCount || 0;

        for (let i = 0; i < recipients.length; i++) {
          while (workerState.paused && !workerState.cancelled) {
            await sleep(1000);
          }
          if (workerState.cancelled) break;

          const rawUser = recipients[i];
          const resolved = await resolveTargetIdAsync(rawUser, acc.cookie);
          if (!resolved || !resolved.id) {
            currentJob.logs.push(`⚠️ Skipped unknown player: ${rawUser}`);
            await writeJson(JOBS_FILE, jobs);
            continue;
          }

          let userRemaining = amountPerUser;
          let userChunkCount = 0;
          const userTotalChunks = Math.ceil(amountPerUser / maxChunk);

          while (userRemaining > 0 && !workerState.cancelled) {
            while (workerState.paused && !workerState.cancelled) {
              await sleep(1000);
            }
            if (workerState.cancelled) break;

            const sendAmt = Math.min(maxChunk, userRemaining);
            let sendSuccess = false;
            let attempts = 0;

            while (!sendSuccess && attempts < 4 && !workerState.cancelled) {
              attempts++;
              const r = await sendMoney(acc.cookie, resolved.id, sendAmt, null);

              if (r.status === 200) {
                sendSuccess = true;
                userRemaining -= sendAmt;
                currentJob.remaining = Math.max(0, currentJob.remaining - sendAmt);
                totalTxCount++;
                currentJob.txCount = totalTxCount;
                userChunkCount++;

                const chunkLabel = userTotalChunks > 1 ? ` (chunk ${userChunkCount}/${userTotalChunks})` : "";
                currentJob.logs.push(`[${new Date().toLocaleTimeString()}] [${i + 1}/${recipients.length}] Sent ₦${sendAmt.toLocaleString()} to @${resolved.username}${chunkLabel} ✅`);
                await writeJson(JOBS_FILE, jobs);
                await recordLedgerEntry({ id: job.id, chunksCompleted: totalTxCount });

                if (userRemaining > 0 || i < recipients.length - 1) {
                  await waitInterval(delayMs, workerState);
                }
              } else if (r.status === 429) {
                currentJob.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) on @${resolved.username}. Rapid re-check in 2.5s...`);
                await writeJson(JOBS_FILE, jobs);
                await sleep(2500);
              } else {
                const errMsg = r.data?.error || r.data?.message || JSON.stringify(r.data || r.error || `HTTP ${r.status}`);
                currentJob.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error sending to @${resolved.username}: ${errMsg}`);
                await writeJson(JOBS_FILE, jobs);

                if (r.status === 400 && (String(errMsg).toLowerCase().includes("need") || String(errMsg).toLowerCase().includes("money") || String(errMsg).toLowerCase().includes("balance"))) {
                  currentJob.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Insufficient treasury balance. Pipeline stopped.`);
                  currentJob.status = "FAILED";
                  await writeJson(JOBS_FILE, jobs);
                  await recordLedgerEntry({ id: job.id, status: "FAILED", notes: `Failed: ${errMsg}` });
                  return;
                }
                await sleep(6000);
                break;
              }
            }

            if (!sendSuccess) {
              currentJob.logs.push(`⚠️ Skipping remaining chunks for @${resolved.username} due to transfer errors.`);
              await writeJson(JOBS_FILE, jobs);
              break;
            }
          }
        }

        if (currentJob.status === "RUNNING") {
          currentJob.status = workerState.cancelled ? "CANCELLED" : "COMPLETED";
        }
        await recordLedgerEntry({
          id: job.id,
          status: currentJob.status === "COMPLETED" ? "COMPLETED" : "STOPPED",
          chunksCompleted: totalTxCount
        });
        await writeJson(JOBS_FILE, jobs);
        activeJobs.delete(job.id);
        return;
      }

      // Handle Single and Split Transfers
      const delayMs = 400;
      const chunkSize = currentJob.remaining || currentJob.total || Number.MAX_SAFE_INTEGER;
      let remaining = Number(currentJob.remaining);
      let count = Number(currentJob.txCount) || 0;
      const totalTxs = currentJob.totalTxs || Math.ceil(currentJob.total / chunkSize);
      const resolvedTo = currentJob.target;

      while (remaining > 0 && !workerState.cancelled) {
        while (workerState.paused && !workerState.cancelled) {
          await sleep(1000);
        }
        if (workerState.cancelled) break;

        const sendAmount = Math.min(chunkSize, remaining);
        count++;
        const r = await sendMoney(acc.cookie, resolvedTo, sendAmount, null);

        if (r.status === 200) {
          remaining -= sendAmount;
          currentJob.remaining = remaining;
          currentJob.txCount = count;
          currentJob.logs.push(`[${new Date().toLocaleTimeString()}] [${count}/${totalTxs}] Sent ₦${sendAmount.toLocaleString()} ✅`);
          await writeJson(JOBS_FILE, jobs);
          await recordLedgerEntry({ id: job.id, chunksCompleted: count });

          if (remaining > 0 && !workerState.cancelled) {
            await waitInterval(delayMs, workerState);
          }
        } else if (r.status === 429) {
          currentJob.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) hit. Rapid re-check in 2.5s...`);
          await writeJson(JOBS_FILE, jobs);
          await sleep(2500);
        } else {
          const errMsg = r.data?.error || JSON.stringify(r.data || r.error);
          currentJob.logs.push(`[${new Date().toLocaleTimeString()}] Error ${r.status}: ${errMsg}`);
          if (r.status === 404 || (r.status === 400 && String(errMsg).includes("need"))) {
            currentJob.status = "FAILED";
            await writeJson(JOBS_FILE, jobs);
            await recordLedgerEntry({ id: job.id, status: "FAILED", notes: `Failed: ${errMsg}` });
            activeJobs.delete(job.id);
            return;
          }
          await writeJson(JOBS_FILE, jobs);
          await sleep(5000);
        }
      }

      if (!workerState.cancelled && currentJob.status === "RUNNING") {
        currentJob.status = "COMPLETED";
        currentJob.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 Finished delivering ₦${Number(currentJob.total).toLocaleString()}!`);
        await recordLedgerEntry({ id: job.id, status: "COMPLETED", chunksCompleted: count });
      } else if (workerState.cancelled) {
        currentJob.status = "CANCELLED";
        await recordLedgerEntry({ id: job.id, status: "STOPPED", chunksCompleted: count });
      }
      await writeJson(JOBS_FILE, jobs);
      activeJobs.delete(job.id);
    } catch (err) {
      console.error("Worker error for job:", job.id, err);
      activeJobs.delete(job.id);
    }
  })();
}

// Background Scheduler: Checks and triggers queued jobs when their appointed time arrives
async function checkScheduledQueue() {
  try {
    const jobs = await readJson(JOBS_FILE, []);
    const now = Date.now();
    let updated = false;

    for (const job of jobs) {
      if (job.status === "SCHEDULED" && job.scheduledTimestamp && job.scheduledTimestamp <= now) {
        job.status = "RUNNING";
        job.logs = job.logs || [];
        job.logs.push(`[${new Date().toLocaleTimeString()}] ⏰ Scheduled time reached (${new Date(job.scheduledTimestamp).toLocaleTimeString()}). Commencing pipeline!`);
        await recordLedgerEntry({ id: job.id, status: "RUNNING", notes: "Scheduled transfer triggered automatically" });
        reviveJobWorker(job);
        updated = true;
      }
    }

    if (updated) {
      await writeJson(JOBS_FILE, jobs);
    }

    // Also check active client sessions for scheduled transfers
    for (const session of clientSessions.values()) {
      if (!session || !Array.isArray(session.jobs)) continue;
      for (const cJob of session.jobs) {
        if (cJob.status === "SCHEDULED" && cJob.scheduledTimestamp && cJob.scheduledTimestamp <= now) {
          cJob.status = "RUNNING";
          cJob.logs = cJob.logs || [];
          cJob.logs.push(`[${new Date().toLocaleTimeString()}] ⏰ Scheduled time reached (${new Date(cJob.scheduledTimestamp).toLocaleTimeString()}). Commencing transfer!`);
          runClientWorker(cJob, session);
        }
      }
    }
  } catch (err) {
    console.error("Scheduled queue check error:", err.message);
  }
}

// Start recurring scheduler tick every 5 seconds
setInterval(checkScheduledQueue, 5000);
checkScheduledQueue();

// Start Scheduled Job Immediately Ahead of Time
app.post("/api/transfers/start-now", requireAdminAuth, async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  const jobs = await readJson(JOBS_FILE, []);
  const j = jobs.find(x => x.id === jobId);
  if (!j) return res.status(404).json({ error: "Job not found" });

  if (j.status !== "SCHEDULED") {
    return res.status(400).json({ error: `Job is currently ${j.status}, not SCHEDULED.` });
  }

  j.status = "RUNNING";
  j.logs = j.logs || [];
  j.logs.push(`[${new Date().toLocaleTimeString()}] ⚡ Manually triggered by administrator ahead of schedule.`);
  await writeJson(JOBS_FILE, jobs);
  await recordLedgerEntry({ id: jobId, status: "RUNNING", notes: "Manually triggered early" });

  reviveJobWorker(j);
  res.json({ success: true, message: "Job launched immediately", job: j });
});

// Reschedule Existing Job
app.post("/api/transfers/reschedule", requireAdminAuth, async (req, res) => {
  const { jobId, scheduledAt } = req.body;
  if (!jobId || !scheduledAt) return res.status(400).json({ error: "jobId and scheduledAt required" });

  const targetTs = new Date(scheduledAt).getTime();
  if (isNaN(targetTs) || targetTs <= Date.now()) {
    return res.status(400).json({ error: "Scheduled time must be in the future." });
  }

  const jobs = await readJson(JOBS_FILE, []);
  const j = jobs.find(x => x.id === jobId);
  if (!j) return res.status(404).json({ error: "Job not found" });

  j.status = "SCHEDULED";
  j.scheduledAt = new Date(targetTs).toISOString();
  j.scheduledTimestamp = targetTs;
  j.logs = j.logs || [];
  j.logs.push(`[${new Date().toLocaleTimeString()}] ⏰ Rescheduled for ${new Date(targetTs).toLocaleString()}.`);
  await writeJson(JOBS_FILE, jobs);
  await recordLedgerEntry({ id: jobId, status: "SCHEDULED", notes: `Rescheduled for ${new Date(targetTs).toLocaleString()}` });

  res.json({ success: true, message: "Job rescheduled", job: j });
});

// Pause Transfer
app.post("/api/transfers/pause", requireAdminAuth, async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  const jobs = await readJson(JOBS_FILE, []);
  const j = jobs.find(x => x.id === jobId);
  if (!j) return res.status(404).json({ error: "Job not found" });

  if (j.status !== "RUNNING") {
    return res.status(400).json({ error: `Job is currently ${j.status}, cannot pause.` });
  }

  j.status = "PAUSED";
  j.logs = j.logs || [];
  j.logs.push(`[${new Date().toLocaleTimeString()}] ⏸️ Transfer pipeline paused by administrator.`);
  await writeJson(JOBS_FILE, jobs);
  await recordLedgerEntry({ id: jobId, status: "PAUSED" });

  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).paused = true;
  }

  res.json({ success: true, message: "Job paused", job: j });
});

// Resume Transfer
app.post("/api/transfers/resume", requireAdminAuth, async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  const jobs = await readJson(JOBS_FILE, []);
  const j = jobs.find(x => x.id === jobId);
  if (!j) return res.status(404).json({ error: "Job not found" });

  if (j.status !== "PAUSED") {
    return res.status(400).json({ error: `Job is currently ${j.status}, cannot resume.` });
  }

  j.status = "RUNNING";
  j.logs = j.logs || [];
  j.logs.push(`[${new Date().toLocaleTimeString()}] ▶️ Transfer pipeline resumed.`);
  await writeJson(JOBS_FILE, jobs);
  await recordLedgerEntry({ id: jobId, status: "RUNNING" });

  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).paused = false;
  } else {
    // If worker process was cleared from memory, revive it!
    reviveJobWorker(j);
  }

  res.json({ success: true, message: "Job resumed", job: j });
});

// Stop / Cancel Transfer
app.post("/api/transfers/stop", requireAdminAuth, async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).cancelled = true;
    activeJobs.delete(jobId);
  }

  const jobs = await readJson(JOBS_FILE, []);
  const j = jobs.find(x => x.id === jobId);
  if (j) {
    j.status = "CANCELLED";
    j.logs = j.logs || [];
    j.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Transfer cancelled by administrator.`);
    await writeJson(JOBS_FILE, jobs);
    await recordLedgerEntry({ id: jobId, status: "STOPPED" });
    return res.json({ success: true, message: "Job cancelled" });
  }
  res.status(404).json({ error: "Job not found" });
});

// Single Transfer Execution
app.post("/api/transfers/send", requireAdminAuth, async (req, res) => {
  const { accountId, to, amount, scheduledAt } = req.body;
  const accounts = await readJson(ACCOUNTS_FILE, []);
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return res.status(404).json({ error: "Sender account not found" });

  const resolved = await resolveTargetIdAsync(to, acc.cookie);
  if (!resolved || !resolved.id) {
    return res.status(400).json({ error: `Player '${to}' could not be found.` });
  }

  const resolvedTo = resolved.id;
  const targetLabel = resolved.name ? `${resolved.name} (@${resolved.username})` : `@${resolved.username || resolvedTo}`;
  const totalNum = Number(amount);
  const chunkSize = totalNum;
  const delayMs = 400;
  const jobId = `tx_${Date.now()}_${Math.random().toString(36).slice(7)}`;
  const totalTxs = Math.ceil(totalNum / chunkSize);

  const scheduledTs = scheduledAt ? new Date(scheduledAt).getTime() : null;
  const isScheduled = Boolean(scheduledTs && !isNaN(scheduledTs) && scheduledTs > Date.now());
  const initialStatus = isScheduled ? "SCHEDULED" : "RUNNING";
  const initialLog = isScheduled
    ? `[${new Date().toLocaleTimeString()}] ⏰ Transfer scheduled for ${new Date(scheduledTs).toLocaleString()} (₦${totalNum.toLocaleString()} to ${targetLabel})`
    : `[${new Date().toLocaleTimeString()}] Transfer initialized: ₦${totalNum.toLocaleString()} to ${targetLabel}`;

  const job = {
    id: jobId,
    type: "SINGLE",
    sender: acc.name,
    accountId: acc.id,
    target: resolvedTo,
    originalInput: to,
    targetLabel,
    total: totalNum,
    remaining: totalNum,
    chunkSize,
    totalTxs,
    txCount: 0,
    status: initialStatus,
    startTime: new Date().toISOString(),
    scheduledAt: isScheduled ? new Date(scheduledTs).toISOString() : null,
    scheduledTimestamp: isScheduled ? scheduledTs : null,
    logs: [initialLog]
  };

  const jobs = await readJson(JOBS_FILE, []);
  jobs.unshift(job);
  await writeJson(JOBS_FILE, jobs);

  // Initial ledger entry
  await recordLedgerEntry({
    id: jobId,
    timestamp: Date.now(),
    sender: acc.name,
    recipient: targetLabel,
    targetId: resolvedTo,
    amount: totalNum,
    chunkSize,
    chunksCompleted: 0,
    totalChunks: totalTxs,
    status: initialStatus,
    notes: isScheduled ? `Scheduled for ${new Date(scheduledTs).toLocaleString()}` : `Initiated transfer of ₦${totalNum.toLocaleString()}`
  });

  if (isScheduled) {
    return res.json({ success: true, scheduled: true, job });
  }

  const workerState = { cancelled: false, paused: false };
  activeJobs.set(jobId, workerState);

  // Background worker
  (async () => {
    let remaining = totalNum;
    let count = 0;

    while (remaining > 0 && !workerState.cancelled) {
      while (workerState.paused && !workerState.cancelled) {
        await sleep(1000);
      }
      if (workerState.cancelled) break;

      const sendAmount = Math.min(chunkSize, remaining);
      count++;
      const r = await sendMoney(acc.cookie, resolvedTo, sendAmount, null);

      if (r.status === 200) {
        remaining -= sendAmount;
        job.remaining = remaining;
        job.txCount = count;
        job.logs.push(`[${new Date().toLocaleTimeString()}] [${count}/${totalTxs}] Sent ₦${sendAmount.toLocaleString()} ✅`);
        await writeJson(JOBS_FILE, jobs);
        await recordLedgerEntry({ id: jobId, chunksCompleted: count });

        if (remaining > 0 && !workerState.cancelled) {
          await waitInterval(delayMs, workerState);
        }
      } else if (r.status === 429) {
        job.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) hit. Rapid re-check in 2.5s...`);
        await writeJson(JOBS_FILE, jobs);
        await sleep(2500);
      } else {
        const errMsg = r.data?.error || JSON.stringify(r.data || r.error);
        job.logs.push(`[${new Date().toLocaleTimeString()}] Error ${r.status}: ${errMsg}`);
        if (r.status === 404 || (r.status === 400 && String(errMsg).includes("need"))) {
          job.status = "FAILED";
          await writeJson(JOBS_FILE, jobs);
          await recordLedgerEntry({ id: jobId, status: "FAILED", notes: `Failed: ${errMsg}` });
          activeJobs.delete(jobId);
          return;
        }
        await writeJson(JOBS_FILE, jobs);
        await sleep(5000);
      }
    }

    if (!workerState.cancelled && job.status === "RUNNING") {
      job.status = "COMPLETED";
      job.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 Finished delivering ₦${totalNum.toLocaleString()} to ${targetLabel}!`);
      await recordLedgerEntry({ id: jobId, status: "COMPLETED", chunksCompleted: count });
    } else if (workerState.cancelled) {
      job.status = "CANCELLED";
      await recordLedgerEntry({ id: jobId, status: "STOPPED", chunksCompleted: count });
    }
    await writeJson(JOBS_FILE, jobs);
    activeJobs.delete(jobId);
  })();

  res.json({ success: true, job });
});

// Multi-Account Split Transfer
app.post("/api/transfers/split", requireAdminAuth, async (req, res) => {
  const { to, plans, scheduledAt } = req.body;
  if (!to || !Array.isArray(plans) || plans.length === 0) {
    return res.status(400).json({ error: "Recipient and split plans required" });
  }

  const accounts = await readJson(ACCOUNTS_FILE, []);
  const activeAcc = accounts.find(a => a.cookie) || accounts[0];

  const resolved = await resolveTargetIdAsync(to, activeAcc?.cookie);
  if (!resolved || !resolved.id) {
    return res.status(400).json({ error: `Player '${to}' could not be found.` });
  }

  const resolvedTo = resolved.id;
  const targetLabel = resolved.name ? `${resolved.name} (@${resolved.username})` : `@${resolved.username || resolvedTo}`;
  const createdJobs = [];
  const jobs = await readJson(JOBS_FILE, []);

  const scheduledTs = scheduledAt ? new Date(scheduledAt).getTime() : null;
  const isScheduled = Boolean(scheduledTs && !isNaN(scheduledTs) && scheduledTs > Date.now());
  const initialStatus = isScheduled ? "SCHEDULED" : "RUNNING";

  for (const plan of plans) {
    const acc = accounts.find(a => a.id === plan.accountId);
    if (!acc || plan.amount <= 0) continue;

    const totalNum = Number(plan.amount);
    const chunkSize = totalNum;
    const delayMs = 400;
    const jobId = `split_${Date.now()}_${acc.user}_${Math.random().toString(36).slice(7)}`;
    const totalTxs = Math.ceil(totalNum / chunkSize);

    const initialLog = isScheduled
      ? `[${new Date().toLocaleTimeString()}] ⏰ Split leg scheduled for ${new Date(scheduledTs).toLocaleString()}: ${acc.name} -> ${targetLabel} (₦${totalNum.toLocaleString()})`
      : `[${new Date().toLocaleTimeString()}] Split leg started: ${acc.name} -> ${targetLabel} (₦${totalNum.toLocaleString()})`;

    const job = {
      id: jobId,
      type: "SPLIT",
      sender: acc.name,
      accountId: acc.id,
      target: resolvedTo,
      originalInput: to,
      targetLabel,
      total: totalNum,
      remaining: totalNum,
      chunkSize,
      totalTxs,
      txCount: 0,
      status: initialStatus,
      startTime: new Date().toISOString(),
      scheduledAt: isScheduled ? new Date(scheduledTs).toISOString() : null,
      scheduledTimestamp: isScheduled ? scheduledTs : null,
      logs: [initialLog]
    };

    createdJobs.push(job);
    jobs.unshift(job);

    await recordLedgerEntry({
      id: jobId,
      timestamp: Date.now(),
      sender: acc.name,
      recipient: targetLabel,
      targetId: resolvedTo,
      amount: totalNum,
      chunkSize,
      chunksCompleted: 0,
      totalChunks: totalTxs,
      status: initialStatus,
      notes: isScheduled ? `Scheduled split leg for ${new Date(scheduledTs).toLocaleString()}` : `Split transfer leg of ₦${totalNum.toLocaleString()}`
    });

    if (isScheduled) {
      continue;
    }

    const workerState = { cancelled: false, paused: false };
    activeJobs.set(jobId, workerState);

    (async () => {
      let remaining = totalNum;
      let count = 0;
      while (remaining > 0 && !workerState.cancelled) {
        while (workerState.paused && !workerState.cancelled) {
          await sleep(1000);
        }
        if (workerState.cancelled) break;

        const sendAmount = Math.min(chunkSize, remaining);
        count++;
        const r = await sendMoney(acc.cookie, resolvedTo, sendAmount, null);

        if (r.status === 200) {
          remaining -= sendAmount;
          job.remaining = remaining;
          job.txCount = count;
          job.logs.push(`[${new Date().toLocaleTimeString()}] [${count}/${totalTxs}] Leg ${acc.name} sent ₦${sendAmount.toLocaleString()} ✅`);
          await writeJson(JOBS_FILE, jobs);
          await recordLedgerEntry({ id: jobId, chunksCompleted: count });

          if (remaining > 0 && !workerState.cancelled) {
            await waitInterval(delayMs, workerState);
          }
        } else if (r.status === 429) {
          job.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) hit on ${acc.name}. Rapid re-check in 2.5s...`);
          await writeJson(JOBS_FILE, jobs);
          await sleep(2500);
        } else {
          const errMsg = r.data?.error || JSON.stringify(r.data || r.error);
          job.logs.push(`[${new Date().toLocaleTimeString()}] Error ${r.status}: ${errMsg}`);
          if (r.status === 404 || (r.status === 400 && String(errMsg).includes("need"))) {
            job.status = "FAILED";
            await writeJson(JOBS_FILE, jobs);
            await recordLedgerEntry({ id: jobId, status: "FAILED" });
            activeJobs.delete(jobId);
            return;
          }
          await writeJson(JOBS_FILE, jobs);
          await sleep(5000);
        }
      }

      if (job.status === "RUNNING") {
        job.status = workerState.cancelled ? "CANCELLED" : "COMPLETED";
      }
      await recordLedgerEntry({
        id: jobId,
        status: job.status === "COMPLETED" ? "COMPLETED" : "STOPPED",
        chunksCompleted: count
      });
      await writeJson(JOBS_FILE, jobs);
      activeJobs.delete(jobId);
    })();
  }

  await writeJson(JOBS_FILE, jobs);
  res.json({ success: true, scheduled: isScheduled, jobs: createdJobs });
});

// Batch Distribution Execution
app.post("/api/transfers/batch", requireAdminAuth, async (req, res) => {
  const { accountId, recipients, amountPerUser, scheduledAt } = req.body;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "Recipients array required" });
  }

  const accounts = await readJson(ACCOUNTS_FILE, []);
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return res.status(404).json({ error: "Sender account not found" });

  const amount = Number(amountPerUser) || 100_000_000_000;
  const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(7)}`;
  const totalAmount = recipients.length * amount;

  const scheduledTs = scheduledAt ? new Date(scheduledAt).getTime() : null;
  const isScheduled = Boolean(scheduledTs && !isNaN(scheduledTs) && scheduledTs > Date.now());
  const initialStatus = isScheduled ? "SCHEDULED" : "RUNNING";

  const job = {
    id: jobId,
    type: "BATCH",
    sender: acc.name,
    accountId: acc.id,
    recipients,
    target: `${recipients.length} recipients`,
    targetLabel: `Batch (${recipients.length} users)`,
    total: totalAmount,
    remaining: totalAmount,
    chunkSize: amount,
    totalTxs: recipients.length,
    txCount: 0,
    status: initialStatus,
    startTime: new Date().toISOString(),
    scheduledAt: isScheduled ? new Date(scheduledTs).toISOString() : null,
    scheduledTimestamp: isScheduled ? scheduledTs : null,
    logs: [isScheduled 
      ? `[${new Date().toLocaleTimeString()}] ⏰ Batch scheduled for ${new Date(scheduledTs).toLocaleString()} (${recipients.length} recipients)`
      : `[${new Date().toLocaleTimeString()}] Batch started: ${recipients.length} recipients`
    ]
  };

  const jobs = await readJson(JOBS_FILE, []);
  jobs.unshift(job);
  await writeJson(JOBS_FILE, jobs);

  await recordLedgerEntry({
    id: jobId,
    timestamp: Date.now(),
    sender: acc.name,
    recipient: `Batch (${recipients.length} users)`,
    targetId: "BATCH",
    amount: totalAmount,
    chunkSize: amount,
    chunksCompleted: 0,
    totalChunks: recipients.length,
    status: initialStatus,
    notes: isScheduled ? `Scheduled batch distribution for ${new Date(scheduledTs).toLocaleString()}` : `Batch distribution of ₦${amount.toLocaleString()} each`
  });

  if (isScheduled) {
    return res.json({ success: true, scheduled: true, job });
  }

  const workerState = { cancelled: false, paused: false };
  activeJobs.set(jobId, workerState);

  (async () => {
    try {
      const maxChunk = Number.MAX_SAFE_INTEGER;
      const delayMs = 400;
      let totalTxCount = 0;

      for (let i = 0; i < recipients.length; i++) {
        const rawUser = recipients[i];
        while (workerState.paused && !workerState.cancelled) {
          await sleep(1000);
        }
        if (workerState.cancelled) break;

        const resolved = await resolveTargetIdAsync(rawUser, acc.cookie);
        if (!resolved || !resolved.id) {
          job.logs.push(`⚠️ Skipped unknown player: ${rawUser}`);
          await writeJson(JOBS_FILE, jobs);
          continue;
        }

        let userRemaining = amount;
        let userChunkCount = 0;
        const userTotalChunks = Math.ceil(amount / maxChunk);

        while (userRemaining > 0 && !workerState.cancelled) {
          while (workerState.paused && !workerState.cancelled) {
            await sleep(1000);
          }
          if (workerState.cancelled) break;

          const sendAmt = Math.min(maxChunk, userRemaining);
          let sendSuccess = false;
          let attempts = 0;

          while (!sendSuccess && attempts < 4 && !workerState.cancelled) {
            attempts++;
            const r = await sendMoney(acc.cookie, resolved.id, sendAmt, null);

            if (r.status === 200) {
              sendSuccess = true;
              userRemaining -= sendAmt;
              job.remaining = Math.max(0, job.remaining - sendAmt);
              totalTxCount++;
              job.txCount = totalTxCount;
              userChunkCount++;

              const chunkLabel = userTotalChunks > 1 ? ` (chunk ${userChunkCount}/${userTotalChunks})` : "";
              job.logs.push(`[${new Date().toLocaleTimeString()}] [${i + 1}/${recipients.length}] Sent ₦${sendAmt.toLocaleString()} to @${resolved.username}${chunkLabel} ✅`);
              await writeJson(JOBS_FILE, jobs);
              await recordLedgerEntry({ id: jobId, chunksCompleted: totalTxCount });

              if (userRemaining > 0 || i < recipients.length - 1) {
                await waitInterval(delayMs, workerState);
              }
            } else if (r.status === 429) {
              job.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) on @${resolved.username}. Rapid re-check in 2.5s...`);
              await writeJson(JOBS_FILE, jobs);
              await sleep(2500);
            } else {
              const errMsg = r.data?.error || r.data?.message || JSON.stringify(r.data || r.error || `HTTP ${r.status}`);
              job.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Error sending to @${resolved.username}: ${errMsg}`);
              await writeJson(JOBS_FILE, jobs);

              if (r.status === 400 && (String(errMsg).toLowerCase().includes("need") || String(errMsg).toLowerCase().includes("money") || String(errMsg).toLowerCase().includes("balance"))) {
                job.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Insufficient treasury balance. Pipeline stopped.`);
                job.status = "FAILED";
                await writeJson(JOBS_FILE, jobs);
                await recordLedgerEntry({ id: jobId, status: "FAILED", notes: `Failed: ${errMsg}` });
                return;
              }
              await sleep(6000);
              break;
            }
          }

          if (!sendSuccess) {
            job.logs.push(`⚠️ Skipping remaining chunks for @${resolved.username} due to transfer errors.`);
            await writeJson(JOBS_FILE, jobs);
            break;
          }
        }
      }

      if (job.status === "RUNNING") {
        job.status = workerState.cancelled ? "CANCELLED" : "COMPLETED";
      }
      await recordLedgerEntry({
        id: jobId,
        status: job.status === "COMPLETED" ? "COMPLETED" : "STOPPED",
        chunksCompleted: totalTxCount
      });
      await writeJson(JOBS_FILE, jobs);
    } catch (err) {
      console.error("Admin batch worker exception:", err);
    } finally {
      activeJobs.delete(jobId);
    }
  })();

  res.json({ success: true, job });
});

// Official Ledger & Audit Records API
app.get("/api/admin/ledger", requireAdminAuth, async (req, res) => {
  const ledger = await readJson(LEDGER_FILE, []);
  
  // Calculate summary metrics
  let totalVolume = 0;
  let todayVolume = 0;
  let totalTxs = 0;
  const uniqueRecipients = new Set();
  const todayStart = new Date().setHours(0, 0, 0, 0);

  for (const item of ledger) {
    const amt = Number(item.amount) || 0;
    totalVolume += amt;
    totalTxs += (Number(item.chunksCompleted) || 1);
    if (item.targetId) uniqueRecipients.add(item.targetId);
    if (item.timestamp >= todayStart) {
      todayVolume += amt;
    }
  }

  res.json({
    records: ledger,
    metrics: {
      totalVolume,
      todayVolume,
      totalTxs,
      uniqueRecipients: uniqueRecipients.size
    }
  });
});

// -------------------------------------------------------------
// VIP Client Portal API (Multi-Tenant & Isolated)
// -------------------------------------------------------------
app.get(["/client", "/vip", "/portal"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const pendingTwoFactorChallenges = new Map();

// Client Login (Username & Password)
app.post("/api/client/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });

  try {
    const cleanUser = username.trim().replace(/^@/, "");
    const loginRes = await fetch("https://lagoslife.app/api/auth/login", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "origin": "https://lagoslife.app",
        "referer": "https://lagoslife.app/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({ username: cleanUser, password })
    });

    const loginData = await loginRes.json().catch(() => ({}));

    // If account has Two-Step Login (2FA) enabled
    if (loginData.code === "two_factor" || loginData.challenge) {
      const setCookies = typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [];
      const interimCookies = setCookies.map(c => c.split(";")[0]).join("; ");
      if (loginData.challenge) {
        pendingTwoFactorChallenges.set(loginData.challenge, {
          username: cleanUser,
          interimCookies,
          createdAt: Date.now()
        });
      }
      return res.json({
        twoFactorRequired: true,
        challenge: loginData.challenge,
        method: loginData.method || "app",
        to: loginData.to || null,
        error: loginData.error || "Two-step login code required"
      });
    }

    if (!loginRes.ok) {
      return res.status(loginRes.status).json({ error: loginData.error || "Login rejected by LagosLife. Check credentials." });
    }

    const setCookies = typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [];
    const cookieStr = setCookies.map(c => c.split(";")[0]).join("; ");
    if (!cookieStr) {
      return res.status(401).json({ error: "No session cookies received" });
    }

    const authRes = await fetch("https://lagoslife.app/api/auth/me", {
      headers: { "cookie": cookieStr, "user-agent": "Mozilla/5.0" }
    });
    const authData = await authRes.json().catch(() => ({}));
    const user = authData.user || {};

    const live = await fetchAccountData(cookieStr);
    const token = "vip_" + crypto.randomUUID().replace(/-/g, "");

    const clientData = {
      token,
      account: {
        uid: user.id || "client",
        user: user.username || cleanUser,
        name: user.name || user.username || cleanUser,
        money: live.ok ? live.money : 0,
        cookie: cookieStr
      },
      jobs: []
    };

    clientSessions.set(token, clientData);
    res.json({ success: true, token, account: clientData.account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete Two-Step (2FA) Login
app.post("/api/client/2fa", async (req, res) => {
  const { challenge, code } = req.body;
  if (!challenge || !code) return res.status(400).json({ error: "Challenge and 6-digit code required" });

  try {
    const pending = pendingTwoFactorChallenges.get(challenge);
    const headers = {
      "accept": "application/json",
      "content-type": "application/json",
      "origin": "https://lagoslife.app",
      "referer": "https://lagoslife.app/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
    };
    if (pending?.interimCookies) {
      headers["cookie"] = pending.interimCookies;
    }

    const twoFaRes = await fetch("https://lagoslife.app/api/auth/2fa", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "login", challenge, code: String(code).trim().toUpperCase() })
    });

    const twoFaData = await twoFaRes.json().catch(() => ({}));
    if (!twoFaRes.ok) {
      return res.status(twoFaRes.status).json({ error: twoFaData.error || "Invalid 2FA code" });
    }

    const newCookies = (typeof twoFaRes.headers.getSetCookie === "function" ? twoFaRes.headers.getSetCookie() : [])
      .map(c => c.split(";")[0]);
    const interimList = pending?.interimCookies ? pending.interimCookies.split("; ").filter(Boolean) : [];
    const cookieMap = new Map();
    for (const c of [...interimList, ...newCookies]) {
      const idx = c.indexOf("=");
      if (idx !== -1) {
        cookieMap.set(c.slice(0, idx).trim(), c.slice(idx + 1).trim());
      }
    }
    const cookieStr = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");

    if (!cookieStr) {
      return res.status(401).json({ error: "No session cookies received from 2FA" });
    }

    pendingTwoFactorChallenges.delete(challenge);

    const authRes = await fetch("https://lagoslife.app/api/auth/me", {
      headers: { "cookie": cookieStr, "user-agent": "Mozilla/5.0" }
    });
    const authData = await authRes.json().catch(() => ({}));
    const user = authData.user || {};

    const live = await fetchAccountData(cookieStr);
    const token = "vip_" + crypto.randomUUID().replace(/-/g, "");

    const clientData = {
      token,
      account: {
        uid: user.id || "client",
        user: user.username || pending?.username || "client",
        name: user.name || user.username || pending?.username || "VIP Client",
        money: live.ok ? live.money : 0,
        cookie: cookieStr
      },
      jobs: []
    };

    clientSessions.set(token, clientData);
    res.json({ success: true, token, account: clientData.account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-send Two-Step (2FA) Code (if email method)
app.post("/api/client/2fa/resend", async (req, res) => {
  const { challenge } = req.body;
  if (!challenge) return res.status(400).json({ error: "Challenge required" });

  try {
    const resendRes = await fetch("https://lagoslife.app/api/auth/2fa", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "origin": "https://lagoslife.app",
        "referer": "https://lagoslife.app/",
        "user-agent": "Mozilla/5.0"
      },
      body: JSON.stringify({ action: "send", challenge })
    });
    const data = await resendRes.json().catch(() => ({}));
    if (!resendRes.ok) {
      return res.status(resendRes.status).json({ error: data.error || "Failed to resend code" });
    }
    res.json({ success: true, to: data.to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Client Cookie Import
app.post("/api/client/import-cookie", async (req, res) => {
  const { cookie } = req.body;
  if (!cookie) return res.status(400).json({ error: "Cookie string required" });

  try {
    const cleanCookie = cookie.trim();
    const authRes = await fetch("https://lagoslife.app/api/auth/me", {
      headers: { "cookie": cleanCookie, "user-agent": "Mozilla/5.0" }
    });
    const authData = await authRes.json().catch(() => ({}));
    if (!authData.user) {
      return res.status(401).json({ error: "Invalid or expired LagosLife session cookie" });
    }

    const live = await fetchAccountData(cleanCookie);
    const user = authData.user;
    const token = "vip_" + crypto.randomUUID().replace(/-/g, "");

    const clientData = {
      token,
      account: {
        uid: user.id,
        user: user.username,
        name: user.name || user.username,
        money: live.ok ? live.money : 0,
        cookie: cleanCookie
      },
      jobs: []
    };

    clientSessions.set(token, clientData);
    res.json({ success: true, token, account: clientData.account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Client Status
app.get("/api/client/status", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
  const session = clientSessions.get(token);
  const live = await fetchAccountData(session.account.cookie);
  if (live.ok) session.account.money = live.money;

  res.json({ account: session.account, jobs: session.jobs });
});

// Client Transfer Worker Function
function runClientWorker(job, session) {
  if (activeJobs.has(job.id)) {
    return;
  }
  const workerState = { cancelled: false, paused: false };
  activeJobs.set(job.id, workerState);

  (async () => {
    try {
      if (job.type === "batch" || job.type === "BATCH") {
        const recipients = job.recipients || [];
        const amountPerUser = Number(job.amountPerUser || job.chunkSize) || MAX_TRANSFER_CHUNK;
        const maxChunk = MAX_TRANSFER_CHUNK;
        const delayMs = job.delayMs || 400;

        for (let i = 0; i < recipients.length; i++) {
          const rawEntry = recipients[i];
          while (workerState.paused && !workerState.cancelled) {
            await sleep(1000);
          }
          if (workerState.cancelled) break;

          // Check if line contains custom amount, e.g. "milespete 50b" or "milespete:50b"
          let targetUser = rawEntry;
          let userTargetAmt = amountPerUser;
          const parts = String(rawEntry).split(/[\s:,]+/).filter(Boolean);
          if (parts.length >= 2) {
            const possibleAmt = parseAmount(parts[parts.length - 1]);
            if (possibleAmt > 0) {
              userTargetAmt = possibleAmt;
              targetUser = parts.slice(0, -1).join(" ");
            }
          }

          const resolved = await resolveTargetIdAsync(targetUser, session.account.cookie);
          if (!resolved || !resolved.id) {
            job.logs.push(`⚠️ Skipped unknown player: ${targetUser}`);
            continue;
          }

          job.logs.push(`[${new Date().toLocaleTimeString()}] 🚀 Commencing delivery to @${resolved.username} (${i + 1}/${recipients.length}) — Target: ₦${userTargetAmt.toLocaleString()}`);

          let userRemaining = userTargetAmt;
          let userChunkCount = 0;
          const userTotalChunks = Math.ceil(userTargetAmt / maxChunk);

          while (userRemaining > 0 && !workerState.cancelled) {
            while (workerState.paused && !workerState.cancelled) {
              await sleep(1000);
            }
            if (workerState.cancelled) break;

            const sendAmt = Math.min(maxChunk, userRemaining);
            let sendSuccess = false;
            let attempts = 0;

            while (!sendSuccess && !workerState.cancelled) {
              while (workerState.paused && !workerState.cancelled) {
                await sleep(1000);
              }
              if (workerState.cancelled) break;

              attempts++;
              const effectiveCode = job.twoStepCode || session.account.twoStepCode || null;
              const r = await sendMoney(session.account.cookie, resolved.id, sendAmt, null, effectiveCode);

              if (r.status === 200) {
                sendSuccess = true;
                if (effectiveCode) session.account.twoStepCode = effectiveCode;
                userRemaining -= sendAmt;
                job.remaining = Math.max(0, job.remaining - sendAmt);
                job.txCount = (job.txCount || 0) + 1;
                userChunkCount++;

                const chunkLabel = userTotalChunks > 1 ? ` (chunk ${userChunkCount}/${userTotalChunks})` : "";
                job.logs.push(`[${new Date().toLocaleTimeString()}] [${i + 1}/${recipients.length}] Sent ₦${sendAmt.toLocaleString()} to @${resolved.username}${chunkLabel} ✅`);

                if (userRemaining > 0 || i < recipients.length - 1) {
                  await waitInterval(delayMs, workerState);
                }
              } else if (r.status === 429) {
                job.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) on @${resolved.username}. Rapid re-check in 2.5s...`);
                await sleep(2500);
              } else {
                const errMsg = r.data?.error || r.data?.message || JSON.stringify(r.data || r.error || `HTTP ${r.status}`);
                job.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ Notice (${r.status || 'Network'}): ${errMsg}`);

                const errLower = String(errMsg).toLowerCase();
                if (errLower.includes("two-step") || errLower.includes("two step") || errLower.includes("two factor") || errLower.includes("2fa") || errLower.includes("pin") || errLower.includes("passcode") || errLower.includes("verification") || errLower.includes("challenge") || errLower.includes("code required")) {
                  job.status = "PAUSED";
                  job.needsTwoStep = true;
                  job.twoStepCode = null;
                  session.account.twoStepCode = null;
                  job.logs.push(`[${new Date().toLocaleTimeString()}] 🛡️ Two-step / PIN required: "${errMsg}". Enter code or PIN above to resume.`);
                  activeJobs.delete(job.id);
                  return;
                }

                if (errLower.includes("100,000,000,000") || errLower.includes("at a time")) {
                  job.chunkSize = MAX_TRANSFER_CHUNK;
                  job.logs.push(`[${new Date().toLocaleTimeString()}] 🔄 Automatically adjusted chunk to ₦100B. Retrying next chunk immediately...`);
                  break;
                }

                if (errLower.includes("need") || errLower.includes("money") || errLower.includes("balance") || errLower.includes("insufficient")) {
                  job.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Insufficient treasury balance. Transfer paused.`);
                  job.status = "PAUSED";
                  activeJobs.delete(job.id);
                  return;
                }

                if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
                  job.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ Notice from server (${r.status}): ${errMsg}`);
                  job.status = "PAUSED";
                  activeJobs.delete(job.id);
                  return;
                }

                const backoffSec = Math.min(10 + attempts * 5, 45);
                job.logs.push(`[${new Date().toLocaleTimeString()}] 🔄 Retrying chunk to @${resolved.username} in ${backoffSec}s (attempt ${attempts}) to see transfer through...`);
                let cd = 0;
                while (cd < backoffSec * 1000 && !workerState.cancelled && !workerState.paused) {
                  await sleep(1000);
                  cd += 1000;
                }
              }
            }
          }

          if (userRemaining === 0) {
            const nextMsg = i < recipients.length - 1 ? `Moving to next account (${i + 2}/${recipients.length})...` : "All accounts in bulk queue finished!";
            job.logs.push(`[${new Date().toLocaleTimeString()}] 🎯 Completed all transfers to @${resolved.username}! ${nextMsg}`);
          }
        }
      } else {
        const delayMs = job.delayMs || 400;
        job.chunkSize = Math.min(job.chunkSize || MAX_TRANSFER_CHUNK, MAX_TRANSFER_CHUNK);
        job.totalTxs = Math.ceil(job.total / job.chunkSize);
        let remaining = job.remaining;
        let count = job.txCount || 0;

        while (remaining > 0 && !workerState.cancelled) {
          while (workerState.paused && !workerState.cancelled) {
            await sleep(1000);
          }
          if (workerState.cancelled) break;

          const sendAmt = Math.min(job.chunkSize, remaining, MAX_TRANSFER_CHUNK);
          let sendSuccess = false;
          let attempts = 0;

          while (!sendSuccess && !workerState.cancelled) {
            while (workerState.paused && !workerState.cancelled) {
              await sleep(1000);
            }
            if (workerState.cancelled) break;

            attempts++;
            const effectiveCode = job.twoStepCode || session.account.twoStepCode || null;
            const r = await sendMoney(session.account.cookie, job.target, sendAmt, null, effectiveCode);

            if (r.status === 200) {
              sendSuccess = true;
              if (effectiveCode) session.account.twoStepCode = effectiveCode;
              remaining -= sendAmt;
              job.remaining = remaining;
              count++;
              job.txCount = count;
              job.logs.push(`[${new Date().toLocaleTimeString()}] [${count}/${job.totalTxs}] Sent ₦${sendAmt.toLocaleString()} ✅`);
              if (remaining > 0 && !workerState.cancelled) {
                await waitInterval(delayMs, workerState);
              }
            } else if (r.status === 429) {
              job.logs.push(`[${new Date().toLocaleTimeString()}] ⏳ Rate limit (429) hit. Rapid re-check in 2.5s...`);
              await sleep(2500);
            } else {
              const errMsg = r.data?.error || r.data?.message || JSON.stringify(r.data || r.error || `HTTP ${r.status}`);
              job.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ Notice (${r.status || 'Network'}): ${errMsg}`);

              const errLower = String(errMsg).toLowerCase();
              if (errLower.includes("two-step") || errLower.includes("two step") || errLower.includes("twofactor") || errLower.includes("two factor") || errLower.includes("2fa") || errLower.includes("pin") || errLower.includes("passcode") || errLower.includes("verification") || errLower.includes("challenge") || errLower.includes("code required")) {
                job.status = "PAUSED";
                job.needsTwoStep = true;
                job.twoStepCode = null;
                session.account.twoStepCode = null;
                job.logs.push(`[${new Date().toLocaleTimeString()}] 🛡️ Two-step / PIN required: "${errMsg}". Enter code or PIN above to resume.`);
                activeJobs.delete(job.id);
                return;
              }

              // Auto-recover if chunk limit was exceeded
              if (errLower.includes("100,000,000,000") || errLower.includes("at a time")) {
                job.chunkSize = MAX_TRANSFER_CHUNK;
                job.totalTxs = Math.ceil(job.total / job.chunkSize);
                job.logs.push(`[${new Date().toLocaleTimeString()}] 🔄 Automatically clamped chunk to ₦100B per LagosLife rule. Retrying next chunk immediately...`);
                break;
              }

              // Fatal balance errors
              if (errLower.includes("need") || errLower.includes("money") || errLower.includes("balance") || errLower.includes("insufficient")) {
                job.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Insufficient treasury balance. Transfer paused.`);
                job.status = "PAUSED";
                activeJobs.delete(job.id);
                return;
              }

              // Other 4xx errors - mark as PAUSED so user can retry or adjust
              if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
                job.logs.push(`[${new Date().toLocaleTimeString()}] ⚠️ Notice from server (${r.status}): ${errMsg}`);
                job.status = "PAUSED";
                activeJobs.delete(job.id);
                return;
              }

              // Transient network/server error backoff
              const backoffSec = Math.min(10 + attempts * 5, 30);
              job.logs.push(`[${new Date().toLocaleTimeString()}] 🔄 Retrying in ${backoffSec}s (attempt ${attempts})...`);
              let cd = 0;
              while (cd < backoffSec * 1000 && !workerState.cancelled && !workerState.paused) {
                await sleep(1000);
                cd += 1000;
              }
            }
          }
        }
      }

      if (workerState.cancelled) {
        job.status = "CANCELLED";
        job.logs.push(`[${new Date().toLocaleTimeString()}] 🛑 Transfer cancelled by user.`);
      } else if (job.remaining === 0) {
        job.status = "COMPLETED";
        job.logs.push(`[${new Date().toLocaleTimeString()}] 🎉 100% Complete! All funds successfully delivered.`);
      } else {
        job.status = "PAUSED";
        job.logs.push(`[${new Date().toLocaleTimeString()}] ⏸️ Transfer stopped with ₦${job.remaining.toLocaleString()} remaining.`);
      }
    } catch (err) {
      console.error("Client worker exception:", err);
    } finally {
      activeJobs.delete(job.id);
    }
  })();
}

// Client Send
app.post("/api/client/send", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });

  const session = clientSessions.get(token);
  const { to, amount, scheduledAt, twoStepCode, pin } = req.body;
  if (!to || !amount) return res.status(400).json({ error: "Recipient and amount required" });

  const effectiveCode = twoStepCode || pin || session.account.twoStepCode || null;
  if (effectiveCode) {
    session.account.twoStepCode = String(effectiveCode).trim();
  }

  const resolved = await resolveTargetIdAsync(to, session.account.cookie);
  if (!resolved || !resolved.id) {
    return res.status(400).json({ error: `Player '${to}' could not be found` });
  }

  const resolvedTo = resolved.id;
  const senderUser = (session.account.user || "").toLowerCase().replace(/^@/, "");
  const targetUser = (resolved.username || "").toLowerCase().replace(/^@/, "");
  if (resolvedTo === session.account.uid || (targetUser && targetUser === senderUser)) {
    return res.status(400).json({ error: "Cannot send money to yourself. Please enter a different recipient." });
  }
  const targetLabel = resolved.name ? `${resolved.name} (@${resolved.username})` : `@${resolved.username || resolvedTo}`;
  const totalNum = Number(amount);
  const chunkSize = Math.min(totalNum, MAX_TRANSFER_CHUNK);
  const delayMs = 400;
  const jobId = `client_tx_${Date.now()}_${Math.random().toString(36).slice(7)}`;
  const totalTxs = Math.ceil(totalNum / chunkSize);

  let isScheduled = false;
  let scheduledTimestamp = null;
  if (scheduledAt) {
    const targetMs = new Date(scheduledAt).getTime();
    if (!isNaN(targetMs) && targetMs > Date.now()) {
      isScheduled = true;
      scheduledTimestamp = targetMs;
    }
  }

  const job = {
    id: jobId,
    type: "single",
    sender: session.account.name,
    target: resolvedTo,
    originalInput: to,
    targetLabel,
    total: totalNum,
    remaining: totalNum,
    chunkSize,
    totalTxs,
    txCount: 0,
    delayMs,
    twoStepCode: effectiveCode ? String(effectiveCode).trim() : null,
    status: isScheduled ? "SCHEDULED" : "RUNNING",
    scheduledTimestamp,
    logs: [
      isScheduled
        ? `[${new Date().toLocaleTimeString()}] ⏰ Scheduled transfer queued for ${new Date(scheduledTimestamp).toLocaleString()}: ₦${totalNum.toLocaleString()} to ${targetLabel}`
        : `[${new Date().toLocaleTimeString()}] Transfer initialized: ₦${totalNum.toLocaleString()} to ${targetLabel}`
    ]
  };

  session.jobs.unshift(job);
  if (!isScheduled) {
    runClientWorker(job, session);
  }

  res.json({ success: true, job });
});

// Client Batch Send
app.post("/api/client/batch", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });

  const session = clientSessions.get(token);
  const { recipients, amountPerUser, scheduledAt, twoStepCode, pin } = req.body;
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "Recipients array required" });
  }

  const effectiveCode = twoStepCode || pin || session.account.twoStepCode || null;
  if (effectiveCode) {
    session.account.twoStepCode = String(effectiveCode).trim();
  }

  const amount = Number(amountPerUser) || 100_000_000_000;
  const jobId = `client_batch_${Date.now()}_${Math.random().toString(36).slice(7)}`;
  const totalAmount = recipients.length * amount;

  let isScheduled = false;
  let scheduledTimestamp = null;
  if (scheduledAt) {
    const targetMs = new Date(scheduledAt).getTime();
    if (!isNaN(targetMs) && targetMs > Date.now()) {
      isScheduled = true;
      scheduledTimestamp = targetMs;
    }
  }

  const job = {
    id: jobId,
    type: "batch",
    sender: session.account.name,
    target: `${recipients.length} recipients`,
    recipients,
    targetLabel: `Bulk (${recipients.length} players)`,
    total: totalAmount,
    remaining: totalAmount,
    chunkSize: Math.min(amount, MAX_TRANSFER_CHUNK),
    totalTxs: recipients.length * Math.ceil(amount / Math.min(amount, MAX_TRANSFER_CHUNK)),
    txCount: 0,
    twoStepCode: effectiveCode ? String(effectiveCode).trim() : null,
    status: isScheduled ? "SCHEDULED" : "RUNNING",
    scheduledTimestamp,
    logs: [
      isScheduled
        ? `[${new Date().toLocaleTimeString()}] ⏰ Scheduled bulk transfer queued for ${new Date(scheduledTimestamp).toLocaleString()}: ${recipients.length} recipients`
        : `[${new Date().toLocaleTimeString()}] Bulk transfer queued for ${recipients.length} recipients`
    ]
  };

  session.jobs.unshift(job);
  if (!isScheduled) {
    runClientWorker(job, session);
  }

  res.json({ success: true, job });
});

// Client Start Scheduled Job Now
app.post("/api/client/start-now", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const { jobId } = req.body;
  const session = clientSessions.get(token);
  const job = session.jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  if (job.status !== "SCHEDULED") {
    return res.status(400).json({ error: `Job is currently ${job.status}, not SCHEDULED.` });
  }

  job.status = "RUNNING";
  job.logs = job.logs || [];
  job.logs.push(`[${new Date().toLocaleTimeString()}] ⚡ Manually triggered by user ahead of schedule.`);
  runClientWorker(job, session);
  res.json({ success: true, message: "Job launched immediately", job });
});

// Client Pause Job
app.post("/api/client/pause", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const { jobId } = req.body;
  const session = clientSessions.get(token);
  const job = session.jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  job.status = "PAUSED";
  job.logs.push(`[${new Date().toLocaleTimeString()}] ⏸️ Transfer paused by user.`);
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).paused = true;
  }
  res.json({ success: true, message: "Transfer paused", job });
});

// Client Resume Job
app.post("/api/client/resume", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const { jobId, twoStepCode, code } = req.body;
  const session = clientSessions.get(token);
  const job = session.jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const providedCode = twoStepCode || code;
  if (providedCode) {
    const cleanCode = String(providedCode).trim();
    
    // If account requires 2FA or code is 6 digits, verify directly with LagosLife 2FA endpoint
    if (cleanCode.length === 6 || job.needsTwoStep) {
      try {
        const twoFaRes = await fetch("https://lagoslife.app/api/auth/2fa", {
          method: "POST",
          headers: {
            cookie: session.account.cookie,
            "content-type": "application/json",
            "origin": "https://lagoslife.app",
            "referer": "https://lagoslife.app/",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
          },
          body: JSON.stringify({ action: "step", code: cleanCode })
        });
        const twoFaData = await twoFaRes.json().catch(() => ({}));
        
        if (twoFaRes.ok) {
          const newCookies = (typeof twoFaRes.headers.getSetCookie === "function" ? twoFaRes.headers.getSetCookie() : [])
            .map(c => c.split(";")[0]);
          if (newCookies.length) {
            session.account.cookie = mergeCookies(session.account.cookie, newCookies);
          }
          job.logs.push(`[${new Date().toLocaleTimeString()}] 🛡️ Two-Step 2FA verified with LagosLife! Session elevated ✅`);
          job.twoStepCode = cleanCode;
          session.account.twoStepCode = cleanCode;
          job.needsTwoStep = false;
        } else if (twoFaData.error && twoFaData.error !== "Unknown action") {
          job.logs.push(`[${new Date().toLocaleTimeString()}] ❌ Two-step verification failed: ${twoFaData.error}`);
          return res.status(400).json({ error: twoFaData.error, job });
        } else {
          job.twoStepCode = cleanCode;
          session.account.twoStepCode = cleanCode;
          job.needsTwoStep = false;
        }
      } catch (err) {
        console.error("2FA step error:", err.message);
        job.twoStepCode = cleanCode;
        session.account.twoStepCode = cleanCode;
        job.needsTwoStep = false;
      }
    } else {
      job.twoStepCode = cleanCode;
      session.account.twoStepCode = cleanCode;
      job.needsTwoStep = false;
    }
  }

  // Enforce proper 100B chunks on resume
  job.chunkSize = Math.min(job.chunkSize || MAX_TRANSFER_CHUNK, MAX_TRANSFER_CHUNK);
  if (job.type !== "batch" && job.type !== "BATCH") {
    job.totalTxs = Math.ceil(job.total / job.chunkSize);
  }
  job.status = "RUNNING";
  job.logs.push(`[${new Date().toLocaleTimeString()}] ▶️ Transfer resumed${providedCode ? ' with Two-Step Code' : ''}.`);
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).paused = false;
  } else if (job.remaining > 0) {
    runClientWorker(job, session);
  }
  res.json({ success: true, message: "Transfer resumed", job });
});

// Client Resend 2FA Email Code
app.post("/api/client/resend-code", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const session = clientSessions.get(token);

  try {
    const r = await fetch("https://lagoslife.app/api/auth/2fa", {
      method: "POST",
      headers: {
        cookie: session.account.cookie,
        "content-type": "application/json",
        accept: "application/json",
        "origin": "https://lagoslife.app",
        "referer": "https://lagoslife.app/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({ action: "send" })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      return res.json({ success: true, message: data.to ? `2FA code sent to ${data.to}` : "2FA code sent to your email!" });
    } else {
      return res.status(r.status).json({ error: data.error || "Failed to trigger email code" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Client Stop Job
app.post("/api/client/stop", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const { jobId } = req.body;
  const session = clientSessions.get(token);
  const job = session.jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  job.status = "CANCELLED";
  job.needsTwoStep = false;
  job.logs.push(`[${new Date().toLocaleTimeString()}] ⏹️ Transfer cancelled by user.`);
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).cancelled = true;
    activeJobs.delete(jobId);
  }
  res.json({ success: true, message: "Transfer cancelled", job });
});

// Client Dismiss Job
app.post("/api/client/dismiss", async (req, res) => {
  const token = req.headers["x-client-token"] || req.query.token;
  if (!token || !clientSessions.has(token)) return res.status(401).json({ error: "Unauthenticated" });
  const { jobId } = req.body;
  const session = clientSessions.get(token);
  const idx = session.jobs.findIndex(j => j.id === jobId);
  if (idx !== -1) {
    if (activeJobs.has(jobId)) {
      activeJobs.get(jobId).cancelled = true;
      activeJobs.delete(jobId);
    }
    session.jobs.splice(idx, 1);
  }
  res.json({ success: true, message: "Job dismissed" });
});

// Client Logout
app.post("/api/client/logout", async (req, res) => {
  const token = req.headers["x-client-token"];
  if (token && clientSessions.has(token)) {
    const session = clientSessions.get(token);
    for (const j of session.jobs) {
      if (activeJobs.has(j.id)) activeJobs.get(j.id).cancelled = true;
    }
    clientSessions.delete(token);
  }
  res.json({ success: true, message: "Session wiped" });
});

// Health check for Render & uptime monitors
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log("==================================================");
  console.log(`🛡️ Master Treasury Cloud Vault online at http://localhost:${PORT}`);
  console.log(`🔒 Vault Authentication Mode: STRICT SESSION ISOLATION`);
  console.log("==================================================");
});
