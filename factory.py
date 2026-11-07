import time
import random
import string
import json
import threading
from curl_cffi import requests as cffi_requests
import cloudscraper

# ─── CONFIG ─────────────────────────────────────────────────
TREASURY_ID = "8b0ce8157f5a447dbe58"   # your main receiving account
PIN_TO_SET = "2005"
ACCOUNTS_TO_GENERATE = 1000
SEND_AMOUNT = 999_999_950               # 1B minus 50 fee
SEND_DELAY = 22                         # /api/send rate limit
POOL_FILE = "burner_pool.json"
FAILED_FILE = "failed_accounts.json"
THREADS = 1                             # 1 = safe. 3-5 = faster but riskier on Cloudflare

# If using a solver API, put key here. If using Playwright, leave as None.
CAPTCHA_SOLVER = None   # e.g. "capsolver_api_key_here"

# ─── UTILS ──────────────────────────────────────────────────
def rand_str(n=10):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))

def rand_name():
    return f"{rand_str(6).capitalize()} {rand_str(6).capitalize()}"

def rand_email():
    return f"{rand_str(12)}@mailinator.com"

def rand_born():
    year = random.randint(1990, 2005)
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    return f"{year}-{month:02d}-{day:02d}"

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


# ─── CAPTCHA SOLVER ─────────────────────────────────────────
def solve_turnstile(sitekey, url):
    """
    Solve Cloudflare Turnstile. Returns a token string or None.
    """
    # Free option on iOS/a-Shell using cloudscraper:
    # cloudscraper bypasses JS challenges automatically on session requests,
    # so no explicit turnstile token needs to be fetched out-of-band.
    return None


# ─── FACTORY: CREATE ACCOUNTS ───────────────────────────────
def create_one_account(idx):
    """Create a single account. Returns dict or None."""
    username = f"burn_{rand_str(10)}"
    password = f"Pw_{rand_str(8)}!"
    name = rand_name()
    email = rand_email()
    born = rand_born()
    
    s = cffi_requests.Session(impersonate="chrome120")
    s.headers.update({
        "content-type": "application/json",
        "origin": "https://lagoslife.app",
        "referer": "https://lagoslife.app/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    })
    
    try:
        # Warm up session using cloudscraper
        s.get("https://lagoslife.app", timeout=20)
        
        # Get captcha sitekey
        cap = s.get("https://lagoslife.app/api/captcha?for=signup", timeout=15).json()
        sitekey = cap["siteKey"]
        
        # Get token from our function
        token = solve_turnstile(sitekey, "https://lagoslife.app/signup")
        
        # Register using cloudscraper session (s.post)
        reg = s.post("https://lagoslife.app/api/auth/register", json={
            "username": username,
            "password": password,
            "name": name,
            "email": email,
            "adult": True,
            "born": born,
            "captcha": token,
        }, timeout=20)

        print(reg.text)

        if reg.status_code != 200:
            log(f"[{idx}] ✗ Register failed: {reg.status_code} {reg.text[:100]}")
            return None
        
        user_id = reg.json()["user"]["id"]
        
        # Set PIN
        pin = s.post("https://lagoslife.app/api/send-pin", json={
            "action": "set",
            "pin": PIN_TO_SET,
            "password": password,
        }, timeout=15)
        
        if pin.status_code != 200:
            log(f"[{idx}] ✗ PIN set failed: {pin.text[:100]}")
            return None
        
        log(f"[{idx}] ✓ Created {username} ({user_id})")
        return {
            "username": username,
            "password": password,
            "uid": user_id,
            "name": name,
            "email": email,
        }
    except Exception as e:
        log(f"[{idx}] ✗ Exception: {e}")
        return None

def generate_pool():
    """Generate ACCOUNTS_TO_GENERATE fresh accounts."""
    try:
        with open(POOL_FILE, "r") as f:
            pool = json.load(f)
    except FileNotFoundError:
        pool = []
    
    log(f"Starting with {len(pool)} existing accounts. Target: {ACCOUNTS_TO_GENERATE}")
    
    idx = len(pool)
    while len(pool) < ACCOUNTS_TO_GENERATE:
        idx += 1
        acc = create_one_account(idx)
        if acc:
            pool.append(acc)
            with open(POOL_FILE, "w") as f:
                json.dump(pool, f, indent=2)
        time.sleep(1)   # be gentle
    
    log(f"✓ Pool complete: {len(pool)} accounts saved to {POOL_FILE}")

# ─── BURNER: USE ACCOUNTS ───────────────────────────────────
def burn_one_account(acc, idx):
    """Burn a single account: login → inject 1B → send out."""
    s = cffi_requests.Session(impersonate="chrome120")
    s.headers.update({
        "content-type": "application/json",
        "origin": "https://lagoslife.app",
        "referer": "https://lagoslife.app/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    })
    
    try:
        # Login
        s.get("https://lagoslife.app", timeout=20)
        login = s.post("https://lagoslife.app/api/auth/login", json={
            "username": acc["username"],
            "password": acc["password"],
        }, timeout=20)
        
        if login.status_code != 200:
            log(f"[{idx}] ✗ Login failed: {login.text[:100]}")
            return False
        
        # Fresh save — game is null
        save = s.get("https://lagoslife.app/api/save", timeout=15).json()
        
        if save.get("game") is None:
            # Brand new account — first write establishes the save
            # Need a minimal game object. Use one of your existing template saves.
            with open("template_save.json", "r") as f:
                template = json.load(f)
            
            game = template["game"]
            game["money"] = 1_000_000_000
            game["owner"] = acc["uid"]
            if "sim" in game:
                game["sim"]["name"] = acc["name"]
            
            put = s.put("https://lagoslife.app/api/save", json={
                "game": game,
                "owner": acc["uid"],
                "base": 0,
                "fresh": True,
                "replace": 0,
                "build": "prod",
            }, timeout=15)
        else:
            # Existing save — overwrite money
            save["game"]["money"] = 1_000_000_000
            put = s.put("https://lagoslife.app/api/save", json={
                "game": save["game"],
                "base": save.get("base") or save.get("updatedAt"),
                "build": "prod",
            }, timeout=15)
            
            # Handle stale retry
            if put.status_code == 409:
                retry = put.json()
                save["game"]["money"] = 1_000_000_000
                put = s.put("https://lagoslife.app/api/save", json={
                    "game": save["game"],
                    "base": retry.get("updatedAt"),
                    "build": "prod",
                }, timeout=15)
        
        if put.status_code != 200:
            log(f"[{idx}] ✗ Inject failed: {put.status_code} {put.text[:100]}")
            return False
        
        # Send to treasury
        send = s.post("https://lagoslife.app/api/send", json={
            "to": TREASURY_ID,
            "amount": SEND_AMOUNT,
            "pin": PIN_TO_SET,
        }, timeout=15)
        
        if send.status_code == 200:
            log(f"[{idx}] ✓ Burned {acc['username']} → ₦{SEND_AMOUNT:,}")
            return True
        else:
            log(f"[{idx}] ✗ Send failed: {send.status_code} {send.text[:100]}")
            return False
    except Exception as e:
        log(f"[{idx}] ✗ Exception: {e}")
        return False

def burn_pool():
    """Iterate through the pool and burn each account."""
    try:
        with open(POOL_FILE, "r") as f:
            pool = json.load(f)
    except FileNotFoundError:
        log("No pool file found. Run generate_pool() first.")
        return
    
    try:
        with open(FAILED_FILE, "r") as f:
            failed = json.load(f)
    except FileNotFoundError:
        failed = []
    
    log(f"Burning {len(pool)} accounts. Treasury: {TREASURY_ID}")
    total_sent = 0
    
    for idx, acc in enumerate(pool):
        # Skip already-failed ones
        if acc["uid"] in failed:
            continue
        
        ok = burn_one_account(acc, idx + 1)
        if ok:
            total_sent += SEND_AMOUNT
        else:
            failed.append(acc["uid"])
            with open(FAILED_FILE, "w") as f:
                json.dump(failed, f, indent=2)
        
        # Rate limit between sends
        time.sleep(SEND_DELAY)
    
    log(f"✓ Burn complete. Total sent: ₦{total_sent:,} (₦{total_sent/1e9:.1f}B)")
    log(f"Failed accounts: {len(failed)}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "generate":
        generate_pool()
    elif len(sys.argv) > 1 and sys.argv[1] == "burn":
        burn_pool()
    else:
        print("Usage:")
        print("  python3 factory.py generate   # create the pool")
        print("  python3 factory.py burn       # burn the pool")
