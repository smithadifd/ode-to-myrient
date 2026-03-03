# ode-to-myrient

A Playwright-based ROM downloader for [Myrient](https://myrient.erista.me) with parallel workers, adaptive throttling, and optional Discord monitoring.

Built to be managed by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — just point it at the repo and tell it what consoles you want. It handles setup, scraping, downloading, and monitoring.

## Why Playwright?

Myrient sits behind Cloudflare with JA3 TLS fingerprinting. `curl`, `wget`, Python `requests`, and Node's `https` module all get blocked at the TLS layer because their fingerprints don't match a real browser. Playwright drives actual Chromium with authentic fingerprints, so Cloudflare lets traffic through.

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/youruser/ode-to-myrient.git
cd ode-to-myrient
npm run setup
cp .env.example .env
```

Edit `.env` with your preferences (download directory, worker count, optional Discord webhook).

### With Claude Code (recommended)

Open the project in Claude Code. It reads `CLAUDE.md` and walks you through everything:

1. Asks which consoles you want
2. Asks how many games (all, top N, or specific titles)
3. Scrapes Myrient to build your game manifest
4. Launches the downloader with monitoring
5. Recovers from errors and keeps you posted via Discord

```bash
claude
# "I want to download ROMs for GameCube and PSP"
```

### Manual

```bash
# 1. See what's available
node src/scraper.js --list-systems

# 2. Scrape and build your manifest
node src/scraper.js --system=gamecube,psp --top=50

# 3. Download
node src/downloader.js

# 4. Monitor (optional, background)
nohup bash scripts/monitor.sh &
```

### Example: Top games across multiple consoles

A common use case — grab the best 25 games for a handful of consoles:

```bash
# Scrape the top 25 USA/World games for 3DS, GameCube, PSP, and Dreamcast
node src/scraper.js --system=3ds,gamecube,psp,dreamcast --top=25

# The scraper builds data/games.json with 25 games per system.
# If using Claude Code, it will reorder the list to prioritize
# well-regarded titles (Zelda, Metroid, God of War, etc.) before downloading.

# Launch with 3 workers
node src/downloader.js --workers=3
```

This would download roughly 100 games total. At ~1 GB average per game with 3 workers, expect around 8-12 hours depending on connection speed and Cloudflare throttling.

## How It Works

### Downloader (`src/downloader.js`)

The core engine. Launches Chromium with a stealth plugin, opens parallel worker tabs, and downloads files by clicking links in Myrient's Apache-style directory listings.

- **Parallel workers** — configurable (default 3). Each worker has its own browser tab. They pull from a shared queue.
- **Adaptive throttling** — backs off on HTTP 429/503, slow speeds, or consecutive failures. Pauses 5 minutes after 3+ failures in a row.
- **Fully resumable** — tracks completions in `data/download_log.txt`. On restart, it skips everything already downloaded. Also checks the filesystem for files that exist but weren't logged.
- **Zip verification** — checks file size and magic bytes before extracting. Catches Cloudflare block pages masquerading as downloads.
- **CDP progress tracking** — uses Chrome DevTools Protocol for download progress instead of polling temp files (avoids race conditions with multiple workers).

### Scraper (`src/scraper.js`)

Browses Myrient's directory listings and builds `data/games.json` — the download manifest. Filters to USA/World region by default. Can limit to top N games per system.

### Monitor (`scripts/monitor.sh`)

Background watchdog that runs alongside the downloader. Checks progress every 30-60 minutes (adaptive), writes `data/status.md`, and optionally pings Discord.

Detects: stalls, crashes, orphaned downloads, zombie temp files. Auto-cleans stale `.crdownload` files.

## Configuration

All config lives in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DOWNLOAD_DIR` | `./roms` | Where ROMs are saved (each console gets a subdirectory) |
| `WORKERS` | `3` | Parallel download workers (2-4 recommended) |
| `DISCORD_WEBHOOK_URL` | *(empty)* | Discord webhook for notifications (optional) |
| `HEADLESS` | `false` | Run browser visibly (`false`) or headless (`true`) |
| `BASE_DELAY_MS` | `3000` | Delay between downloads per worker |
| `MAX_RETRIES` | `3` | Retry attempts per file before logging failure |

### Headless vs. Visible

Start with `HEADLESS=false` so you can see the browser and verify downloads are working. Once confirmed, switch to `true` for background operation. The monitor + Discord notifications replace the visual feedback.

## Discord Integration

Optional but useful for overnight runs. Create a webhook in your Discord server (Server Settings → Integrations → Webhooks) and paste the URL in `.env`.

You'll get notifications for:
- 🚀 Downloader started
- ✅ Individual game completions
- 🎉 System completions
- ⚠️ Stalls, crashes, throttling
- ☀️ Morning summary (8 AM)

## File Structure

```
data/
  games.json              # Download manifest (generated by scraper)
  download_log.txt        # Completed downloads (system_id/filename.zip per line)
  download_failures.txt   # Failed downloads with reasons
  status.md               # Live progress snapshot (updated by monitor)
roms/                     # Downloaded ROMs (one subdirectory per console)
  .rom_zips/              # Temporary staging for zip files before extraction
```

## Tips

- **First run**: Use `--test` flag to download one game and verify the full pipeline works before committing to a big batch.
- **Large files**: GameCube, Wii, and PS2 games can be 1-4 GB each. The 24-hour saveAs timeout handles this, but monitor large downloads closely.
- **Rate limiting**: If you see sustained speeds below 500 KB/s or repeated 429 errors, reduce workers or increase `BASE_DELAY_MS`.
- **Missing games**: Some titles aren't on Myrient. These show up as "Not in directory listing" in the failures log — that's expected, not a bug.

## Background

This project was born from a race to archive ROMs from Myrient before it went offline. The name is a tribute to the service and the community that maintained it.

## License

MIT
