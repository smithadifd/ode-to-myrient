# Setup Guide

Read this when there's no `.env` or no `data/games.json` — i.e., the user hasn't been set up yet.

## Install Dependencies

```bash
npm run setup
```

This runs `npm install` and `npx playwright install chromium`.

## Ask What They Want

Walk through these conversationally — one or two at a time, not a wall of questions.

### 1. Which consoles?

Show the available systems from `src/scraper.js` SYSTEM_CATALOG. Let them pick multiple. The full list:

| ID | System |
|----|--------|
| 3ds | Nintendo 3DS |
| nds | Nintendo DS |
| n64 | Nintendo 64 |
| snes | Super Nintendo |
| nes | NES |
| gb | Game Boy |
| gbc | Game Boy Color |
| gba | Game Boy Advance |
| gamecube | GameCube |
| wii | Wii |
| virtualboy | Virtual Boy |
| fds | Famicom Disk System |
| psx | PlayStation |
| ps2 | PlayStation 2 |
| psp | PSP |
| genesis | Sega Genesis |
| dreamcast | Dreamcast |
| saturn | Sega Saturn |
| mastersystem | Master System |
| arcade | Arcade (MAME) |
| atari2600 | Atari 2600 |
| atari5200 | Atari 5200 |
| atari7800 | Atari 7800 |
| pcengine | PC Engine / TurboGrafx |

### 2. How many games per console?

Three options:

- **All available** — everything in Myrient's directory for that system (USA/World region filter applied by default)
- **Top N** — a number like 25, 50, 100. The scraper pulls alphabetically from Myrient. After scraping, you should use your knowledge of game quality to **reorder** the list — put must-haves first (Zelda, Mario, Pokemon for Nintendo; God of War, Final Fantasy for Sony; Sonic for Sega, etc.). The downloader processes games in array order.
- **Specific titles** — they name exactly what they want, you search the scraped listing

### 3. Do they already have ROMs?

If yes, ask where. The scraper's `scanExisting()` function checks the download directory and marks matches as already completed. This avoids re-downloading.

### 4. Where to save?

Default is `./roms` relative to the project. They can set any absolute path via `DOWNLOAD_DIR` in `.env`.

### 5. Discord notifications?

Optional. If yes, they provide a webhook URL. Explain: they'll get pings for system completions, crashes, stalls, and a morning summary at 8 AM.

### 6. Workers?

Default 3. Explain the tradeoff: more workers = faster downloads but higher risk of Cloudflare rate limiting. 2-4 is the sweet spot. Recommend starting with 3.

### 7. Headless?

Recommend `false` (visible browser) for the first run so they can watch downloads happen and verify the pipeline works. Switch to `true` once confirmed — headless is more efficient for unattended runs.

## Generate Config

Write `.env` from their answers. Then run the scraper:

```bash
node src/scraper.js --system=3ds,gamecube,psp --top=50
```

Or for all games (no top-N limit):
```bash
node src/scraper.js --system=3ds,gamecube,psp --all
```

Or call `buildManifest()` programmatically:
```js
const { buildManifest } = require('./src/scraper');
await buildManifest(['3ds', 'gamecube', 'psp'], { topN: 50, usaOnly: true });
```

### Curating the list

If they asked for "top N" games, review the generated `data/games.json` after scraping. The scraper produces an alphabetical list — reorder by quality. Move the must-haves to the top of each system's games array. The downloader processes in array order, so this determines priority.

## Write CLAUDE.local.md

Create `CLAUDE.local.md` (copy from `CLAUDE.local.md.example`) with:
- Their chosen consoles and game counts
- Download directory path
- Any notes about their setup
- Session state section (you'll update this as you monitor)

## First Run

Recommend a test run first:

```bash
node src/downloader.js --test
```

This downloads one game and verifies the full pipeline (Cloudflare bypass → download → zip verify → extract → log). Once confirmed working, launch the real thing:

```bash
node src/downloader.js
```

For unattended operation, use the restart loop:

```bash
while true; do
  echo "[$(date)] Starting downloader..."
  node src/downloader.js --workers=3 2>&1 | tee -a /tmp/downloader_out.txt
  echo "[$(date)] Downloader exited. Restarting in 30s..."
  sleep 30
done
```

Save the PID of the loop process — it's the lifeline. Don't kill it unless intentionally stopping.

Then launch the monitor:

```bash
nohup bash scripts/monitor.sh > /tmp/monitor.log 2>&1 &
```
