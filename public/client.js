/* =========================================================
   LagosLife Treasury VIP — Client Controller
   ========================================================= */

const API = window.location.origin;
let clientToken = localStorage.getItem("lls_vip_token") || null;
let currentAccount = null;

const $ = id => document.getElementById(id);

function getHeaders() {
  const h = { "content-type": "application/json" };
  if (clientToken) h["x-client-token"] = clientToken;
  return h;
}

function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return "₦0";
  const num = Number(n);
  if (num >= 1e15) return `₦${(num / 1e15).toFixed(2)}Q`;
  if (num >= 1e12) return `₦${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `₦${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `₦${(num / 1e6).toFixed(2)}M`;
  return `₦${num.toLocaleString()}`;
}

function parseAmount(raw) {
  if (!raw) return 0;
  const s = String(raw).trim().toLowerCase().replace(/,/g, "").replace(/\s/g, "");
  if (s.endsWith("q")) return parseFloat(s) * 1e15;
  if (s.endsWith("t")) return parseFloat(s) * 1e12;
  if (s.endsWith("b")) return parseFloat(s) * 1e9;
  if (s.endsWith("m")) return parseFloat(s) * 1e6;
  if (s.endsWith("k")) return parseFloat(s) * 1e3;
  return parseFloat(s) || 0;
}

function showToast(msg, type = "info") {
  const container = $("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------
// Init
// ---------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupAuthEvents();
  setupActions();
  setupScheduleHandlers();

  // Check URL query for 1-tap mobile import (?import=cookie...)
  const params = new URLSearchParams(window.location.search);
  const importCookie = params.get("import");
  if (importCookie) {
    showToast("Importing session from mobile link...", "info");
    await handleCookieImport(importCookie);
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  if (clientToken) {
    await refreshClientSession();
  } else {
    showAuthView();
  }

  // Poll active transfers every 2.5s if logged in
  setInterval(() => {
    if (clientToken) refreshClientSession();
  }, 2500);
});

function showAuthView() {
  $("auth-section").classList.remove("hidden");
  $("dashboard-section").classList.add("hidden");
  $("header-account-pill").classList.add("hidden");
}

function showDashboardView(account) {
  currentAccount = account;
  $("auth-section").classList.add("hidden");
  $("dashboard-section").classList.remove("hidden");
  $("header-account-pill").classList.remove("hidden");
  $("user-display-name").textContent = `@${account.user}`;
  $("meta-user").textContent = `${account.name} (@${account.user})`;
  $("client-balance").textContent = fmtMoney(account.money);
}

// ---------------------------------------------------------
// Two-Factor (2FA) Modal Helpers
// ---------------------------------------------------------
let currentTwoFactorChallenge = null;

function openTwoFactorModal(challenge, method, to) {
  currentTwoFactorChallenge = challenge;
  $("twofactor-code-input").value = "";
  
  if (method === "email") {
    $("twofactor-desc").textContent = to 
      ? `We emailed a 6-digit verification code to ${to}. Enter it below to complete connection:` 
      : "A 6-digit verification code was emailed to your address. Enter it below:";
    $("twofactor-resend-row").classList.remove("hidden");
  } else {
    $("twofactor-desc").textContent = "Type the 6-digit code your authenticator app shows for Lagos Life:";
    $("twofactor-resend-row").classList.add("hidden");
  }

  $("twofactor-modal").classList.remove("hidden");
  setTimeout(() => $("twofactor-code-input").focus(), 150);
}

function closeTwoFactorModal() {
  currentTwoFactorChallenge = null;
  $("twofactor-modal").classList.add("hidden");
}

// ---------------------------------------------------------
// Session API Calls
// ---------------------------------------------------------
async function refreshClientSession() {
  if (!clientToken) return;
  try {
    const res = await fetch(`${API}/api/client/status`, { headers: getHeaders() });
    if (res.ok) {
      const data = await res.json();
      showDashboardView(data.account);
      renderJobs(data.jobs || []);
    } else if (res.status === 401) {
      clientToken = null;
      localStorage.removeItem("lls_vip_token");
      showAuthView();
    }
  } catch (err) {
    console.error("Session refresh error:", err);
  }
}

async function handleCookieImport(cookie) {
  try {
    const res = await fetch(`${API}/api/client/import-cookie`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: cookie.trim() })
    });
    const data = await res.json();
    if (res.ok) {
      clientToken = data.token;
      localStorage.setItem("lls_vip_token", data.token);
      showToast(`Welcome ${data.account.name}!`, "success");
      showDashboardView(data.account);
    } else {
      showToast(data.error || "Failed to import session", "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------
// Auth Tabs & Handlers
// ---------------------------------------------------------
function setupTabs() {
  // Auth tabs (Login vs Cookie)
  document.querySelectorAll(".auth-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".auth-tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      const target = $(`auth-tab-${btn.dataset.auth}`);
      if (target) target.classList.add("active");
    });
  });

  // Mode tabs (Single vs Bulk)
  document.querySelectorAll(".mode-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".mode-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      const target = $(`mode-${btn.dataset.mode}`);
      if (target) target.classList.add("active");
    });
  });

  // Amount Chips for Single
  document.querySelectorAll("[data-amt]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-amt]").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      const val = chip.dataset.amt;
      $("amount-input").value = fmtMoney(val).replace("₦", "");
    });
  });

  // Amount Chips for Bulk
  document.querySelectorAll("[data-bulk-amt]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-bulk-amt]").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      $("bulk-amount-per").value = chip.dataset.bulkAmt;
    });
  });
}

function setupAuthEvents() {
  // Direct Login Submit
  $("btn-submit-login").addEventListener("click", async () => {
    const user = $("login-username").value.trim().replace(/^@/, "");
    const pass = $("login-password").value;
    if (!user || !pass) return showToast("Enter your username and password", "error");

    showToast("Connecting to LagosLife...", "info");
    try {
      const res = await fetch(`${API}/api/client/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (data.twoFactorRequired) {
        openTwoFactorModal(data.challenge, data.method, data.to);
        showToast("Two-step login code required 🛡️", "info");
        return;
      }
      if (res.ok) {
        clientToken = data.token;
        localStorage.setItem("lls_vip_token", data.token);
        showToast(`Connected as ${data.account.name}!`, "success");
        showDashboardView(data.account);
      } else {
        showToast(data.error || "Login failed. Check credentials.", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Two-Factor Modal Submit
  $("btn-twofactor-submit").addEventListener("click", async () => {
    const code = $("twofactor-code-input").value.trim();
    if (!code) return showToast("Enter your 6-digit code", "error");
    if (!currentTwoFactorChallenge) return showToast("Session expired. Please sign in again.", "error");

    showToast("Verifying two-step code...", "info");
    try {
      const res = await fetch(`${API}/api/client/2fa`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: currentTwoFactorChallenge, code })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        closeTwoFactorModal();
        clientToken = data.token;
        localStorage.setItem("lls_vip_token", data.token);
        showToast(`Connected as ${data.account.name}! 🛡️`, "success");
        showDashboardView(data.account);
      } else {
        showToast(data.error || "Invalid verification code", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Two-Factor Code Enter Key
  $("twofactor-code-input").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-twofactor-submit").click();
    }
  });

  // Two-Factor Modal Cancel
  $("btn-twofactor-cancel").addEventListener("click", () => {
    closeTwoFactorModal();
    showToast("Two-step verification cancelled", "info");
  });

  // Two-Factor Resend Email Code
  $("btn-twofactor-resend").addEventListener("click", async () => {
    if (!currentTwoFactorChallenge) return;
    showToast("Requesting new email code...", "info");
    try {
      const res = await fetch(`${API}/api/client/2fa/resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: currentTwoFactorChallenge })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`New verification code sent${data.to ? ` to ${data.to}` : ""}! 📧`, "success");
      } else {
        showToast(data.error || "Failed to resend code", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Cookie Import Submit
  $("btn-submit-cookie").addEventListener("click", async () => {
    const raw = $("cookie-input").value.trim();
    if (!raw) return showToast("Paste your cookie string", "error");
    await handleCookieImport(raw);
  });

  // Copy Bookmarklet Code
  $("btn-copy-code").addEventListener("click", () => {
    const code = $("bookmarklet-code").textContent;
    navigator.clipboard.writeText(code);
    showToast("Bookmarklet code copied! Paste in lagoslife.app address bar", "success");
  });

  // Logout / Disconnect
  $("btn-logout").addEventListener("click", async () => {
    if (confirm("Disconnect and wipe your session from this server?")) {
      try {
        await fetch(`${API}/api/client/logout`, { method: "POST", headers: getHeaders() });
      } catch {}
      clientToken = null;
      localStorage.removeItem("lls_vip_token");
      currentAccount = null;
      showToast("Session wiped successfully", "info");
      showAuthView();
    }
  });

  // Refresh Balance Button
  $("btn-refresh-balance").addEventListener("click", async () => {
    await refreshClientSession();
    showToast("Balance updated", "info");
  });
}

// ---------------------------------------------------------
// Actions (Send & Bulk)
// ---------------------------------------------------------
function setupActions() {
  // Recipient Lookup
  $("btn-resolve").addEventListener("click", () => resolveRecipient($("target-input").value));
  $("target-input").addEventListener("blur", () => resolveRecipient($("target-input").value));

  // Single Transfer Launch
  $("btn-send-single").addEventListener("click", async () => {
    const to = $("target-input").value.trim();
    const rawAmt = $("amount-input").value.trim();
    if (!to || !rawAmt) return showToast("Recipient and amount required", "error");

    const amount = parseAmount(rawAmt);
    if (amount <= 0) return showToast("Invalid amount", "error");

    let scheduledAt = null;
    const schedToggle = $("client-single-schedule-toggle");
    if (schedToggle && schedToggle.checked) {
      const schedTime = $("client-single-schedule-time")?.value;
      if (!schedTime) return showToast("Please select a target date and time", "error");
      const targetTs = new Date(schedTime).getTime();
      if (isNaN(targetTs) || targetTs <= Date.now()) {
        return showToast("Scheduled time must be in the future", "error");
      }
      scheduledAt = new Date(targetTs).toISOString();
    }

    const twoStepCode = $("single-twostep-input") ? $("single-twostep-input").value.trim() : "";

    showToast(scheduledAt ? "Queuing scheduled transfer..." : "Starting transfer in background...", "info");
    try {
      const res = await fetch(`${API}/api/client/send`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ to, amount, scheduledAt, twoStepCode })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(scheduledAt ? "Transfer scheduled successfully! ⏰" : "Transfer actively streaming!", "success");
        $("amount-input").value = "";
        refreshClientSession();
      } else {
        showToast(data.error || "Failed to start transfer", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  // Bulk Transfer Launch
  $("btn-send-bulk").addEventListener("click", async () => {
    const rawLines = $("bulk-recipients").value
      .split(/[\n,]/)
      .map(s => s.trim().replace(/^[\d\.\-\*\•\)\(\]\"\'\s]+/, "").replace(/[\"\'\,]/g, "").trim().replace(/^@/, ""))
      .filter(Boolean);
    const amountPer = parseAmount($("bulk-amount-per").value) || 100_000_000_000;
    if (rawLines.length === 0) return showToast("Paste at least one username", "error");
    if (amountPer <= 0) return showToast("Invalid amount per person", "error");

    let scheduledAt = null;
    const schedToggle = $("client-bulk-schedule-toggle");
    if (schedToggle && schedToggle.checked) {
      const schedTime = $("client-bulk-schedule-time")?.value;
      if (!schedTime) return showToast("Please select a target date and time", "error");
      const targetTs = new Date(schedTime).getTime();
      if (isNaN(targetTs) || targetTs <= Date.now()) {
        return showToast("Scheduled time must be in the future", "error");
      }
      scheduledAt = new Date(targetTs).toISOString();
    }

    const twoStepCode = $("bulk-twostep-input") ? $("bulk-twostep-input").value.trim() : "";

    showToast(scheduledAt ? `Queuing scheduled bulk for ${rawLines.length} players...` : `Launching bulk send to ${rawLines.length} players...`, "info");
    try {
      const res = await fetch(`${API}/api/client/batch`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ recipients: rawLines, amountPerUser: amountPer, scheduledAt, twoStepCode })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(scheduledAt ? "Bulk transfer scheduled successfully! ⏰" : `Bulk distribution running for ${rawLines.length} players!`, "success");
        $("bulk-recipients").value = "";
        refreshClientSession();
      } else {
        showToast(data.error || "Bulk send failed", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

// ---------------------------------------------------------
// Schedule UI Handlers
// ---------------------------------------------------------
function setupScheduleHandlers() {
  const configs = [
    {
      toggle: $("client-single-schedule-toggle"),
      panel: $("client-single-schedule-panel"),
      input: $("client-single-schedule-time"),
      preview: $("client-single-schedule-preview"),
      btnLabel: $("client-single-btn-label"),
      defaultLabel: "🚀 Launch Background Transfer",
      scheduledLabel: "⏰ Queue Scheduled Transfer"
    },
    {
      toggle: $("client-bulk-schedule-toggle"),
      panel: $("client-bulk-schedule-panel"),
      input: $("client-bulk-schedule-time"),
      preview: $("client-bulk-schedule-preview"),
      btnLabel: $("client-bulk-btn-label"),
      defaultLabel: "👥 Distribute to All",
      scheduledLabel: "⏰ Queue Scheduled Bulk"
    }
  ];

  configs.forEach(cfg => {
    if (!cfg.toggle) return;

    cfg.toggle.addEventListener("change", () => {
      if (cfg.toggle.checked) {
        cfg.panel.classList.remove("hidden");
        if (cfg.btnLabel) cfg.btnLabel.textContent = cfg.scheduledLabel;
        if (!cfg.input.value) {
          const d = new Date(Date.now() + 30 * 60 * 1000);
          cfg.input.value = formatDateTimeLocal(d);
        }
        updateSchedulePreview(cfg);
      } else {
        cfg.panel.classList.add("hidden");
        if (cfg.btnLabel) cfg.btnLabel.textContent = cfg.defaultLabel;
        if (cfg.preview) cfg.preview.textContent = "";
      }
    });

    if (cfg.input) {
      cfg.input.addEventListener("input", () => updateSchedulePreview(cfg));
    }
  });

  // Preset chips
  document.querySelectorAll(".btn-preset-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const target = chip.dataset.target; // client-single or client-bulk
      const input = $(`${target}-schedule-time`);
      const cfg = configs.find(c => c.input === input);
      if (!input || !cfg) return;

      const offset = chip.dataset.offset;
      const preset = chip.dataset.preset;
      const now = new Date();

      if (offset) {
        const targetDate = new Date(now.getTime() + parseInt(offset, 10) * 60 * 1000);
        input.value = formatDateTimeLocal(targetDate);
      } else if (preset === "tonight12") {
        const targetDate = new Date(now);
        targetDate.setHours(24, 0, 0, 0);
        input.value = formatDateTimeLocal(targetDate);
      } else if (preset === "tomorrow6") {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + 1);
        targetDate.setHours(6, 0, 0, 0);
        input.value = formatDateTimeLocal(targetDate);
      }

      updateSchedulePreview(cfg);
    });
  });
}

function formatDateTimeLocal(d) {
  const pad = n => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function updateSchedulePreview(cfg) {
  if (!cfg.input || !cfg.preview) return;
  const val = cfg.input.value;
  if (!val) {
    cfg.preview.textContent = "";
    return;
  }

  const targetDate = new Date(val);
  const diffMs = targetDate.getTime() - Date.now();
  if (isNaN(diffMs) || diffMs <= 0) {
    cfg.preview.innerHTML = `<span style="color:var(--danger)">⚠️ Please choose a future time</span>`;
    return;
  }

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const timeStr = targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = targetDate.toLocaleDateString([], { month: 'short', day: 'numeric' });

  let countdown = "";
  if (hours > 0) countdown = `${hours}h ${mins}m`;
  else countdown = `${mins}m`;

  cfg.preview.innerHTML = `<span>⏳ Commencing <strong>${dateStr} at ${timeStr}</strong> (in ~${countdown})</span>`;
}

async function resolveRecipient(query) {
  if (!query) return;
  const prevBox = $("target-preview");
  const prevName = $("target-name");
  const prevId = $("target-id");

  try {
    const res = await fetch(`${API}/api/resolve-recipient?q=${encodeURIComponent(query)}`);
    if (res.ok) {
      const data = await res.json();
      prevBox.classList.remove("hidden");
      prevName.textContent = data.name ? `${data.name} (@${data.username})` : `@${data.username}`;
      prevId.textContent = data.id;
      return data.id;
    }
  } catch {}
}

// ---------------------------------------------------------
// Render Active Jobs
// ---------------------------------------------------------
function renderJobs(jobs) {
  const container = $("client-jobs-list");
  const badge = $("client-active-badge");
  const scheduled = jobs.filter(j => j.status === "SCHEDULED");
  const running = jobs.filter(j => j.status === "RUNNING");
  const paused = jobs.filter(j => j.status === "PAUSED");
  const awaitingCode = jobs.filter(j => j.status !== "CANCELLED" && j.remaining > 0 && (!!j.needsTwoStep || (j.logs && j.logs.some(l => String(l).toLowerCase().includes("two-step")))));

  if (badge) {
    if (awaitingCode.length > 0) {
      badge.textContent = `${awaitingCode.length} Needs 2FA Code`;
      badge.className = "active-badge badge-warning-pill";
    } else {
      badge.className = "active-badge";
      const parts = [];
      if (running.length > 0) parts.push(`${running.length} Running`);
      if (scheduled.length > 0) parts.push(`${scheduled.length} Scheduled`);
      if (paused.length > 0) parts.push(`${paused.length} Paused`);
      badge.textContent = parts.length > 0 ? parts.join(", ") : "0 Active";
    }
  }

  if (!jobs || jobs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">☕</div>
        <p>No active transfers running right now. Choose a recipient and amount above!</p>
      </div>
    `;
    return;
  }

  // Remove empty state if present
  const emptyState = container.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  // Remove stale cards
  const activeIds = new Set(jobs.slice(0, 10).map(j => j.id));
  container.querySelectorAll(".job-card[data-job-id]").forEach(card => {
    if (!activeIds.has(card.dataset.jobId)) card.remove();
  });

  jobs.slice(0, 10).forEach(j => {
    const isScheduled = j.status === "SCHEDULED";
    const isCancelled = j.status === "CANCELLED";
    const isCompleted = j.status === "COMPLETED" || (j.total > 0 && j.remaining === 0);
    const isRunning = j.status === "RUNNING";
    const isPaused = j.status === "PAUSED";
    const needsTwoStep = !isCancelled && !isCompleted && j.remaining > 0 && (!!j.needsTwoStep || (j.logs && j.logs.some(l => String(l).toLowerCase().includes("two-step"))));
    const pct = j.total > 0 ? Math.min(100, Math.round(((j.total - j.remaining) / j.total) * 100)) : 0;

    let countdownText = "";
    if (isScheduled && j.scheduledTimestamp) {
      const diffMs = j.scheduledTimestamp - Date.now();
      if (diffMs > 0) {
        const h = Math.floor(diffMs / 3600000);
        const m = Math.floor((diffMs % 3600000) / 60000);
        const s = Math.floor((diffMs % 60000) / 1000);
        countdownText = `⏳ Starts in: ${h > 0 ? `${h}h ` : ''}${m}m ${s}s`;
      } else {
        countdownText = `⏳ Starting imminently...`;
      }
    }

    const lastLog = j.logs && j.logs.length > 0 ? j.logs[j.logs.length - 1] : (isScheduled ? "Scheduled" : isPaused ? "Paused" : "Sending...");

    let actionButtons = "";
    if (isScheduled) {
      actionButtons = `
        <div class="job-actions">
          <button class="btn-pause btn-start-now-job" onclick="startNowClientJob('${j.id}')">Start Now</button>
          <button class="btn-stop" onclick="stopClientJob('${j.id}')">Cancel</button>
        </div>
      `;
    } else if (isRunning) {
      actionButtons = `
        <div class="job-actions">
          <button class="btn-pause" onclick="pauseClientJob('${j.id}')">Pause</button>
          <button class="btn-stop" onclick="stopClientJob('${j.id}')">Stop</button>
        </div>
      `;
    } else if (isPaused || needsTwoStep || j.status === "FAILED") {
      actionButtons = `
        <div class="job-actions">
          <button class="btn-resume" onclick="resumeClientJob('${j.id}')">${j.status === "FAILED" ? "Retry" : "Resume"}</button>
          <button class="btn-stop" onclick="stopClientJob('${j.id}')">${j.status === "FAILED" ? "Dismiss" : "Stop"}</button>
        </div>
      `;
    } else if (isCompleted) {
      actionButtons = `
        <div class="job-actions" style="align-items:center;">
          <span style="font-size:11px; color:var(--apple-green); font-weight:700;">Completed</span>
          <button class="btn-dismiss-job" onclick="dismissClientJob('${j.id}')" title="Dismiss">✕</button>
        </div>
      `;
    } else if (isCancelled) {
      actionButtons = `
        <div class="job-actions" style="align-items:center;">
          <span style="font-size:11px; color:var(--text-tertiary); font-weight:600;">Cancelled</span>
          <button class="btn-dismiss-job" onclick="dismissClientJob('${j.id}')" title="Dismiss">✕</button>
        </div>
      `;
    } else {
      actionButtons = `
        <div class="job-actions" style="align-items:center;">
          <span style="font-size:11px; color:var(--apple-red); font-weight:600;">${j.status}</span>
          <button class="btn-dismiss-job" onclick="dismissClientJob('${j.id}')" title="Dismiss">✕</button>
        </div>
      `;
    }

    let card = container.querySelector(`.job-card[data-job-id="${j.id}"]`);

    if (!card) {
      card = document.createElement("div");
      card.className = `job-card ${isScheduled ? 'scheduled' : ''}`;
      card.dataset.jobId = j.id;

      const twoStepBoxHtml = needsTwoStep ? `
        <div class="card-twostep-box" id="twostep-box-${j.id}">
          <div class="card-twostep-header">🛡️ Two-Step Verification Required:</div>
          <div style="font-size:11px; opacity:0.85; margin: 3px 0 6px 0;">Enter your 6-digit code (from Authenticator App or Email) or PIN</div>
          <div class="card-twostep-controls">
            <input type="text" id="twostep-input-${j.id}" placeholder="PIN or 6-digit code" maxlength="10" class="mono-input card-twostep-field" autocomplete="off">
            <button class="card-twostep-btn" id="twostep-btn-${j.id}" onclick="submitCardTwoStep('${j.id}')">Submit & Send</button>
          </div>
          <div style="margin-top:5px; display:flex; justify-content:space-between; align-items:center;">
            <button type="button" class="btn-resend-twostep" style="background:none; border:none; color:var(--apple-blue, #0071e3); font-size:11px; cursor:pointer; padding:2px 0; text-decoration:underline;" onclick="resendClientEmailCode('${j.id}')">📧 Resend Email Code</button>
          </div>
        </div>
      ` : "";

      card.innerHTML = `
        <div class="job-header">
          <span class="job-title">
            ${isScheduled ? '<span class="badge-scheduled">Scheduled</span> ' : ''}
            To ${j.originalInput || j.targetLabel || j.target}
          </span>
          <div class="job-actions-slot">${actionButtons}</div>
        </div>
        <div class="twostep-slot">${twoStepBoxHtml}</div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${pct}%; ${isScheduled ? 'background: var(--apple-purple);' : isPaused || needsTwoStep ? 'background: var(--apple-amber);' : ''}"></div>
        </div>
        <div class="job-meta">
          <span class="job-progress-text">${isScheduled ? countdownText : `Progress: ${pct}% (${j.txCount || 0} / ${j.totalTxs || 1} TXs)`}</span>
          <span class="job-remaining-text">Remaining: ${fmtMoney(j.remaining)}</span>
        </div>
        <div class="job-log">${lastLog}</div>
      `;
      container.appendChild(card);

      const newInput = card.querySelector(`#twostep-input-${j.id}`);
      if (newInput) {
        newInput.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitCardTwoStep(j.id);
          }
        });
      }
    } else {
      // In-place stable updates: preserve inputs and prevent blinking
      const actionsSlot = card.querySelector(".job-actions-slot");
      if (actionsSlot && actionsSlot.innerHTML !== actionButtons) {
        actionsSlot.innerHTML = actionButtons;
      }

      const twoStepSlot = card.querySelector(".twostep-slot");
      if (twoStepSlot) {
        const existingTwoStepBox = twoStepSlot.querySelector(".card-twostep-box");
        if (needsTwoStep && !existingTwoStepBox) {
          twoStepSlot.innerHTML = `
            <div class="card-twostep-box" id="twostep-box-${j.id}">
              <div class="card-twostep-header">🛡️ Two-Step Verification Required:</div>
              <div style="font-size:11px; opacity:0.85; margin: 3px 0 6px 0;">Enter your 6-digit code (from Authenticator App or Email) or PIN</div>
              <div class="card-twostep-controls">
                <input type="text" id="twostep-input-${j.id}" placeholder="PIN or 6-digit code" maxlength="10" class="mono-input card-twostep-field" autocomplete="off">
                <button class="card-twostep-btn" id="twostep-btn-${j.id}" onclick="submitCardTwoStep('${j.id}')">Submit & Send</button>
              </div>
              <div style="margin-top:5px; display:flex; justify-content:space-between; align-items:center;">
                <button type="button" class="btn-resend-twostep" style="background:none; border:none; color:var(--apple-blue, #0071e3); font-size:11px; cursor:pointer; padding:2px 0; text-decoration:underline;" onclick="resendClientEmailCode('${j.id}')">📧 Resend Email Code</button>
              </div>
            </div>
          `;
          const input = twoStepSlot.querySelector(`#twostep-input-${j.id}`);
          if (input) {
            input.addEventListener("keydown", e => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCardTwoStep(j.id);
              }
            });
            setTimeout(() => input.focus(), 50);
          }
        } else if (needsTwoStep && existingTwoStepBox) {
          // If paused or failed, ensure the button is never stuck in 'Verifying...' state
          const btn = existingTwoStepBox.querySelector(".card-twostep-btn");
          if (btn && btn.disabled && (isPaused || j.status === 'PAUSED')) {
            btn.disabled = false;
            btn.textContent = "Submit & Send";
          }
        } else if (!needsTwoStep && existingTwoStepBox) {
          existingTwoStepBox.remove();
        }
      }

      const progressFill = card.querySelector(".progress-bar-fill");
      if (progressFill) {
        progressFill.style.width = `${pct}%`;
        progressFill.style.background = isScheduled ? 'var(--apple-purple)' : (isPaused || needsTwoStep) ? 'var(--apple-amber)' : '';
      }

      const progressText = card.querySelector(".job-progress-text");
      if (progressText) {
        progressText.textContent = isScheduled ? countdownText : `Progress: ${pct}% (${j.txCount || 0} / ${j.totalTxs || 1} TXs)`;
      }

      const remainingText = card.querySelector(".job-remaining-text");
      if (remainingText) {
        remainingText.textContent = `Remaining: ${fmtMoney(j.remaining)}`;
      }

      const logEl = card.querySelector(".job-log");
      if (logEl && logEl.textContent !== lastLog) {
        logEl.textContent = lastLog;
      }
    }
  });
}

window.submitCardTwoStep = async jobId => {
  const input = document.getElementById(`twostep-input-${jobId}`);
  const code = input ? input.value.trim() : "";
  if (!code) return showToast("Enter your PIN or 2FA code", "error");

  const btn = document.getElementById(`twostep-btn-${jobId}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Verifying...";
  }

  showToast("Submitting PIN/code & resuming...", "info");
  try {
    await resumeClientJob(jobId, code);
  } finally {
    setTimeout(() => {
      const curBtn = document.getElementById(`twostep-btn-${jobId}`);
      if (curBtn && curBtn.disabled) {
        curBtn.disabled = false;
        curBtn.textContent = "Submit & Send";
      }
    }, 1500);
  }
};

window.resendClientEmailCode = async jobId => {
  try {
    showToast("Requesting email code from LagosLife...", "info");
    const res = await fetch(`${API}/api/client/resend-code`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ jobId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || "Code sent to your email!", "success");
    } else {
      showToast(data.error || "Failed to trigger email code", "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.dismissClientJob = async jobId => {
  try {
    const res = await fetch(`${API}/api/client/dismiss`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ jobId })
    });
    if (res.ok) {
      await refreshClientSession();
    }
  } catch {}
};

window.startNowClientJob = async jobId => {
  try {
    const res = await fetch(`${API}/api/client/start-now`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ jobId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("Transfer launched immediately", "success");
      refreshClientSession();
    } else {
      showToast(data.error || "Failed to trigger job", "error");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.pauseClientJob = async jobId => {
  try {
    const res = await fetch(`${API}/api/client/pause`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ jobId })
    });
    if (res.ok) {
      showToast("Transfer paused", "info");
      refreshClientSession();
    }
  } catch (err) {
    showToast(err.message, "error");
  }
};

window.resumeClientJob = async (jobId, twoStepCode = null) => {
  try {
    const code = twoStepCode || (document.getElementById(`twostep-input-${jobId}`) ? document.getElementById(`twostep-input-${jobId}`).value.trim() : "");
    const res = await fetch(`${API}/api/client/resume`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ jobId, twoStepCode: code })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("Transfer resumed!", "success");
      await refreshClientSession();
    } else {
      showToast(data.error || "Failed to resume transfer", "error");
      const btn = document.getElementById(`twostep-btn-${jobId}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Submit & Send";
      }
    }
  } catch (err) {
    showToast(err.message, "error");
    const btn = document.getElementById(`twostep-btn-${jobId}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Submit & Send";
    }
  }
};

window.stopClientJob = async jobId => {
  try {
    const res = await fetch(`${API}/api/client/stop`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ jobId })
    });
    if (res.ok) {
      showToast("Transfer stopped", "info");
      refreshClientSession();
    }
  } catch (err) {
    showToast(err.message, "error");
  }
};

