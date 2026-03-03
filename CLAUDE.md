# ode-to-myrient — Claude Code Instructions

**Read `CLAUDE.local.md` first** (if it exists) for user-specific config and session state.

You are managing a Playwright-based ROM downloader for Myrient. Your job: setup, downloads, monitoring, recovery, Discord notifications.

## Project Layout

```
src/downloader.js          — Parallel download engine (Playwright + stealth)
src/scraper.js             — Myrient directory scraper & games.json generator
src/config.js              — Config loader (.env + defaults)
scripts/monitor.sh         — Background monitor (status.md + Discord alerts)
data/games.json            — Download manifest (source of truth)
data/download_log.txt      — Completed downloads (append-only)
data/download_failures.txt — Failed downloads with reasons
data/status.md             — Live progress snapshot (written by monitor)
.env                       — User config (paths, workers, Discord webhook)
CLAUDE.local.md            — User-specific notes and session state
```

## What To Do

**Route to the right doc based on what's needed:**

### Fresh install (no `.env` or no `data/games.json`)
→ Read **`docs/setup.md`** — walks through the full setup conversation: console selection, game filtering, config generation, first run.

### Launching or operating the downloader
Quick reference — these are the essential commands:

```bash
# Test pipeline (one game)
node src/downloader.js --test

# Run downloader
node src/downloader.js

# Auto-restart loop (for unattended runs)
while true; do
  node src/downloader.js --workers=3 2>&1 | tee -a /tmp/downloader_out.txt
  sleep 30
done

# Background monitor
nohup bash scripts/monitor.sh > /tmp/monitor.log 2>&1 &
```

### Checking progress or troubleshooting
→ Read **`docs/monitoring.md`** — status checks, symptom → fix lookup table, recovery actions, headless mode.

### Understanding the codebase
→ Read **`docs/architecture.md`** — why Playwright, worker model, download flow, throttle detection, resume logic.

## Key Principles

1. **The downloader is fully resumable.** Kill and restart freely — `download_log.txt` + filesystem scanning means nothing is lost.
2. **All HTTP traffic goes through Playwright.** Cloudflare's TLS fingerprinting blocks direct Node.js requests. No shortcuts.
3. **Discord is optional.** Everything works without it. If configured, it's a notification layer, not a dependency.
4. **Update `CLAUDE.local.md`** after every monitoring session with PIDs, progress, speed observations, and issues.
