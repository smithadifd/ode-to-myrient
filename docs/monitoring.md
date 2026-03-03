# Monitoring & Recovery

Read this when checking on download progress or diagnosing issues.

## Quick Status Check

Do these in order — usually the first 1-2 tell you everything:

1. **Read `data/status.md`** — the monitor writes a snapshot each cycle with per-system progress bars, active download count, and failure count.
2. **Check completion count**: `wc -l data/download_log.txt`
3. **Is the node process alive?** `pgrep -f "node.*downloader"`
4. **Active downloads**: `ls roms/.rom_zips/*.crdownload 2>/dev/null | wc -l`

If status.md is recent (within the monitor's interval) and shows progress, things are fine.

## Deep Check

When the quick check looks off, or for periodic deep monitoring:

1. **Read the last 20 lines of the downloader output log** (wherever it's being teed to, often `/tmp/downloader_out.txt`)
2. **Measure download speed**:
   - Check crdownload file sizes: `ls -la roms/.rom_zips/*.crdownload`
   - Wait 60 seconds
   - Check again, compute delta
   - Healthy: 800-1200 MB/hr per worker
   - Concerning: <500 MB/hr per worker sustained
3. **Check `data/download_failures.txt`** for new entries — especially patterns like repeated "saveAs: canceled" or "Timeout"

## What to Look For

### Stall
No new completions AND no active crdownloads for 30+ minutes. The process may be hung on a Cloudflare challenge or a dead connection.

**Fix**: Kill the downloader process, wait 1-2 minutes, restart. Resume logic handles everything — nothing is lost.

### Slow Speeds
Sustained <500 KB/s per worker. Likely Cloudflare is throttling.

**Fix**: Kill the downloader, wait 15-30 minutes for rate limits to reset, restart with fewer workers or a longer `BASE_DELAY_MS` in `.env`.

### saveAs Canceled Errors
Cloudflare's download token expired mid-flight. The retry logic handles occasional instances automatically.

If it's happening on **every** file: the entire browser session's auth is stale. Kill and restart the downloader — the fresh browser launch gets a new Cloudflare session.

### 3+ Consecutive Failures
The downloader auto-pauses 5 minutes and sends a Discord alert. If it keeps happening after the pause, something systemic is wrong:
- Cloudflare may have fully blocked the IP (wait 30-60 min)
- Myrient may be down (check in a real browser)
- Network issues

### Orphan UUID Files in .rom_zips
Files with UUID names (like `ef36cc22-...`) that aren't `.crdownload` — these are downloads Chrome completed but the Node handler missed (usually due to a crash mid-extraction).

**Fix**: These are valid zip files. Extract manually with `unzip`, verify the ROM is there, then add the entry to `data/download_log.txt` in the format `system_id/original_filename.zip`.

## Recovery Actions Reference

| Symptom | Action |
|---------|--------|
| Process dead | Restart downloader. Resume is automatic. |
| Throttled / slow | Kill, wait 15-30 min, restart with fewer workers |
| Cloudflare blocking | Kill, wait 30-60 min. Fresh browser launch gets new session |
| Orphan zips | Extract manually, add to download_log.txt |
| Repeated timeouts on one file | Likely a very large file (>2 GB). Let the retry logic work. If it perm-fails after 3 attempts, skip it. |
| Monitor not writing status.md | Check if monitor process is alive: `pgrep -f "monitor.sh"`. Restart if dead. |

## Headless Mode

Once visible-browser downloads are confirmed working:

1. Update `.env`: `HEADLESS=true`
2. Restart the downloader

Headless is more efficient (less RAM, no GPU rendering) and better for overnight runs. The monitor + Discord notifications replace the visual feedback.

## Updating CLAUDE.local.md

After each monitoring session, update the Session Notes section in `CLAUDE.local.md` with:
- Current system being downloaded and progress
- Active PIDs (downloader, restart loop, monitor)
- Speed observations
- Any issues encountered and how they were resolved
- Estimated time remaining

This gives the next Claude Code session (or a returning user) full context.
