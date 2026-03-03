# Architecture

Reference material for understanding how the downloader works under the hood. You generally don't need this for day-to-day operation — it's here for debugging edge cases or making code changes.

## Why Playwright (Not curl/wget/requests)

Myrient sits behind Cloudflare with JA3 TLS fingerprinting. The JA3 fingerprint is derived from the TLS ClientHello message — cipher suites, extensions, elliptic curves, etc. Node.js's `tls` module produces a distinctly different fingerprint than Chrome.

This means:
- `curl`, `wget`, Python `requests` → blocked at the TLS layer (before HTTP even starts)
- Node.js `https.request()` with valid cookies → still blocked (wrong TLS fingerprint)
- Playwright-controlled Chromium → passes (authentic Chrome fingerprint)

The stealth plugin (`puppeteer-extra-plugin-stealth`) handles additional fingerprint vectors: WebGL, navigator properties, iframe detection, etc.

**All HTTP traffic must go through the Playwright browser.** There's no workaround for direct HTTP downloads.

## Worker Model

```
Browser (one Chromium instance)
  └── Context (shared cookies/session)
        ├── Page 0 (Worker 1) ─── pulls from shared queue
        ├── Page 1 (Worker 2) ─── pulls from shared queue
        ├── Page 2 (Worker 3) ─── pulls from shared queue
        └── ...
```

- One browser context shared across N workers — they share the Cloudflare session
- Each worker is a separate browser tab pointed at the current system's directory listing
- Workers pull from a shared JavaScript array via `queue.shift()` — JS is single-threaded, so this is atomic between await points (no mutex needed)
- Worker 0 reuses the initial page; workers 1-N get fresh pages

### Why shared context?

Cloudflare issues cookies per browser context. A shared context means one Cloudflare challenge pass covers all workers. Separate contexts would mean N independent challenges, and Cloudflare might flag that as suspicious.

## Download Flow Per File

```
1. Check if already completed (log + filesystem scan) → skip if yes
2. Find the file's <a href> in the cached directory listing
3. Click the link in the browser tab
4. Catch the download event via page.waitForEvent('download')
5. download.saveAs() to .rom_zips/ directory
6. CDP Page.downloadProgress events provide progress without filesystem polling
7. Verify zip integrity (file size > 200 bytes + PK magic bytes)
8. Extract to system directory via extract-zip
9. Verify extracted file exists on disk
10. Append to download_log.txt
11. Delete the zip file
```

### Why CDP for progress?

With multiple workers downloading simultaneously, each download gets a random UUID filename in Chrome's temp directory. Polling the filesystem for file sizes is a race condition — you can't reliably map UUIDs to games. CDP's `Page.downloadProgress` event is scoped to the page that initiated the download, so each worker gets clean progress data for its own download.

### Why click instead of direct navigation?

Myrient's directory listings are Apache-style. The file links are relative `<a href>` elements. Clicking them triggers Chrome's native download handling, which is the most reliable way to get `page.waitForEvent('download')` to fire. Direct `page.goto(fileUrl)` can sometimes trigger navigation instead of download, depending on Content-Type headers.

## Session Management

### Periodic refresh
Every `SESSION_REFRESH` downloads (default 10), each worker navigates back to Myrient's homepage and then returns to the directory listing. This refreshes the Cloudflare session cookies before they expire mid-download.

### Retry with session refresh
On failure, the worker navigates to the homepage (refresh), back to the directory, waits, then retries. This is the primary recovery mechanism for stale sessions.

## Throttle Detection

The downloader watches for several throttle signals:

| Signal | Meaning | Response |
|--------|---------|----------|
| Download >5 min for <100 MB file | Cloudflare is rate-limiting bandwidth | Increase inter-download delay |
| HTTP 403/429/503 | Explicit rate limit or block | Wait 60s, retry with longer delays |
| 3+ consecutive failures across different files | Systemic issue (not a single bad file) | Pause 5 minutes, then resume |
| Sustained <500 KB/s per worker | Soft throttle | Back off, consider fewer workers |

## Resume Logic

The downloader is fully resumable. On startup, it:

1. Reads `data/download_log.txt` into a Set of completed entries
2. For each game in `data/games.json`, checks:
   - Is it in the completed Set? → skip
   - Does the extracted file exist on disk? → add to log, skip
3. Only remaining games enter the download queue

This means you can kill and restart freely. Partial zip downloads in `.rom_zips/` are cleaned up on retry (any existing zip for a game is deleted before re-downloading).

## File Matching

Games on Myrient don't always have identical filenames to what `games.json` expects (region tags, language suffixes differ). The matching logic in `findDirEntry()` tries three strategies:

1. **Exact case-insensitive match** — most files hit this
2. **Title + region, ignoring language suffix** — handles `(USA) (En,Fr,Es)` vs `(USA)`
3. **Title-only prefix match** — handles `Garou (USA).zip` matching `Garou (Japan).zip` when only one candidate exists

The `fileOnDisk()` function uses similar fuzzy matching to detect already-extracted ROMs.
