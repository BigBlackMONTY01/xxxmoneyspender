// ==========================================
// 💸 LAGOS LIFE PARTY AUTO-SPRAYER (100x MONEY GUN)
// ==========================================
// HOW TO USE:
// 1. Join any active party in LagosLife.
// 2. Paste this script into your browser console (F12 -> Console) and press Enter.
// 3. Tap "Spray" ONCE in the party (so it locks onto the exact Party Host & Target).
// 4. Choose your Spray Count (default: 100x) and Speed, then click "▶ Start 100x Auto-Spray"!

(function () {
  if (document.getElementById("ll-autosprayer-box")) {
    document.getElementById("ll-autosprayer-box").remove();
  }

  let sprayState = {
    active: false,
    intervalId: null,
    capturedUrl: "/api/spray/party",
    capturedPayload: null,
    totalSprayed: 0,
    count: 0,
    targetCount: 100,
    forceMaxStack: true,
    delayMs: 350,
    pin: localStorage.getItem("lls_user_pin") || ""
  };

  // Intercept fetch to auto-capture the exact party spray payload
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    const options = args[1] || {};

    if (
      options.method &&
      options.method.toUpperCase() === "POST" &&
      options.body &&
      !options._isAutoSpray &&
      url.toLowerCase().includes("/spray")
    ) {
      try {
        const parsed = JSON.parse(options.body);
        sprayState.capturedUrl = url;
        sprayState.capturedPayload = parsed;
        if (parsed.pin) sprayState.pin = parsed.pin;
        updateSprayerUI();
      } catch (e) {}
    }

    return originalFetch.apply(this, args);
  };

  const box = document.createElement("div");
  box.id = "ll-autosprayer-box";
  box.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: rgba(15, 17, 23, 0.96);
    border: 2px solid #d4af37;
    border-radius: 14px;
    padding: 14px 16px;
    color: #fff;
    font-family: system-ui, -apple-system, sans-serif;
    box-shadow: 0 10px 30px rgba(0,0,0,0.85);
    width: 280px;
    backdrop-filter: blur(10px);
  `;

  box.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <strong style="color:#d4af37; font-size:14px;">💸 Money Gun (100x Sprayer)</strong>
      <span id="ll-spray-badge" style="font-size:11px; padding:2px 8px; border-radius:99px; background:#333; color:#aaa;">Waiting...</span>
    </div>
    <div id="ll-spray-info" style="font-size:12px; color:#bbb; margin-bottom:10px; line-height:1.4;">
      Tap <b>"Spray"</b> ONCE in the party to lock onto the Host/Target!
    </div>
    <div style="display:flex; gap:6px; margin-bottom:8px;">
      <div style="flex:1;">
        <label style="font-size:10px; color:#888; display:block; margin-bottom:2px;">Spray Times</label>
        <input id="ll-spray-max" type="number" value="100" min="1" max="10000" style="width:100%; box-sizing:border-box; background:#1c1f2b; color:#fff; border:1px solid #333; border-radius:6px; padding:6px; font-size:12px;">
      </div>
      <div style="flex:1;">
        <label style="font-size:10px; color:#888; display:block; margin-bottom:2px;">Speed</label>
        <select id="ll-spray-speed" style="width:100%; box-sizing:border-box; background:#1c1f2b; color:#fff; border:1px solid #333; border-radius:6px; padding:6px; font-size:12px;">
          <option value="250">250ms ⚡ Turbo</option>
          <option value="350" selected>350ms 🚀 Fast</option>
          <option value="600">600ms 🍾 Normal</option>
        </select>
      </div>
    </div>
    <div style="margin-bottom:10px;">
      <input id="ll-spray-pin" type="password" placeholder="Transaction PIN (optional if saved)" value="${sprayState.pin}" style="width:100%; box-sizing:border-box; background:#1c1f2b; color:#fff; border:1px solid #333; border-radius:6px; padding:6px 8px; font-size:12px;">
    </div>
    <button id="ll-spray-toggle" style="width:100%; padding:10px; border:none; border-radius:8px; background:linear-gradient(135deg,#d4af37,#b5891c); color:#000; font-weight:700; cursor:pointer; font-size:13px;">
      ▶ Start 100x Auto-Spray
    </button>
  `;

  document.body.appendChild(box);

  function updateSprayerUI() {
    const badge = document.getElementById("ll-spray-badge");
    const info = document.getElementById("ll-spray-info");
    const btn = document.getElementById("ll-spray-toggle");
    const maxVal = Number(document.getElementById("ll-spray-max")?.value) || sprayState.targetCount;

    if (sprayState.capturedPayload) {
      badge.textContent = sprayState.active ? "SPRAYING 🔥" : "LOCKED ✅";
      badge.style.background = sprayState.active ? "#16a34a" : "#2563eb";
      badge.style.color = "#fff";
      info.innerHTML = `
        Target Locked! (₦1B/spray)<br>
        Sprays: <b style="color:#4ade80">${sprayState.count} / ${maxVal}</b> (₦${sprayState.totalSprayed.toLocaleString()})
      `;
    }

    if (sprayState.active) {
      btn.textContent = `⏹ Stop (${sprayState.count}/${maxVal})`;
      btn.style.background = "#dc2626";
      btn.style.color = "#fff";
    } else {
      btn.textContent = `▶ Start ${maxVal}x Auto-Spray`;
      btn.style.background = "linear-gradient(135deg,#d4af37,#b5891c)";
      btn.style.color = "#000";
    }
  }

  document.getElementById("ll-spray-max").addEventListener("input", e => {
    sprayState.targetCount = Number(e.target.value) || 100;
    updateSprayerUI();
  });

  document.getElementById("ll-spray-speed").addEventListener("change", e => {
    sprayState.delayMs = Number(e.target.value) || 350;
  });

  document.getElementById("ll-spray-pin").addEventListener("input", e => {
    sprayState.pin = e.target.value.trim();
  });

  async function fireOneSpray() {
    if (!sprayState.active || !sprayState.capturedPayload) return;
    if (sprayState.count >= sprayState.targetCount) {
      stopSpraying();
      return;
    }

    const payload = {
      ...sprayState.capturedPayload,
      stack: 1000000000,
      ...(sprayState.pin ? { pin: sprayState.pin } : {})
    };

    try {
      const res = await originalFetch(sprayState.capturedUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        _isAutoSpray: true
      });
      if (res.ok) {
        sprayState.count++;
        sprayState.totalSprayed += Number(payload.stack) || 1000000000;
        updateSprayerUI();
        if (sprayState.count >= sprayState.targetCount) {
          stopSpraying();
        }
      } else if (res.status === 400 || res.status === 409) {
        stopSpraying();
      }
    } catch (err) {}
  }

  function startSpraying() {
    if (!sprayState.capturedPayload) {
      alert("Please tap the 'Spray' button ONCE inside the party first so the Money Gun knows who to spray!");
      return;
    }
    sprayState.active = true;
    sprayState.count = 0;
    sprayState.totalSprayed = 0;
    sprayState.targetCount = Number(document.getElementById("ll-spray-max").value) || 100;
    sprayState.delayMs = Number(document.getElementById("ll-spray-speed").value) || 350;
    updateSprayerUI();
    fireOneSpray();
    sprayState.intervalId = setInterval(fireOneSpray, sprayState.delayMs);
  }

  function stopSpraying() {
    sprayState.active = false;
    if (sprayState.intervalId) clearInterval(sprayState.intervalId);
    sprayState.intervalId = null;
    updateSprayerUI();
  }

  document.getElementById("ll-spray-toggle").addEventListener("click", () => {
    if (sprayState.active) stopSpraying();
    else startSpraying();
  });
})();
