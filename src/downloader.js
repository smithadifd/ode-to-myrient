#!/usr/bin/env node
/**
 * downloader.js — Myrient ROM Downloader (parallel worker edition)
 *
 * Why Playwright for everything (not just session setup):
 *   Cloudflare uses JA3 TLS fingerprinting. Node.js's TLS ClientHello has a
 *   different fingerprint from Chrome, so direct https.request() calls are
 *   blocked at the TLS layer — even with valid cookies. All HTTP traffic must
 *   go through the Playwright-controlled Chromium instance.
 *
 * Architecture:
 *   - One browser context shared across N worker pages
 *   - Each worker maintains its own page on the system directory listing
 *   - Workers pull from a shared queue (JS single-threaded → no mutex needed)
 *   - CDP Page.downloadProgress used for progress; no UUID temp file polling
 *     (avoids race conditions with multiple concurrent downloads)
 *
 * Usage:
 *   node src/downloader.js                # uses WORKERS from .env (default 3)
 *   node src/downloader.js --workers=2    # override worker count
 *   node src/downloader.js --test         # one game only (pipeline test)
 */
'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const extractZip    = require('extract-zip');
const fs            = require('fs');
const path          = require('path');
const { config, ensureDirs, discord } = require('./config');

chromium.use(StealthPlugin());

// ── CLI overrides ────────────────────────────────────────────────────────────
const TEST_MODE = process.argv.includes('--test');
const CONCURRENCY = TEST_MODE ? 1 : parseInt(
  (process.argv.find(a => a.startsWith('--workers=')) || `--workers=${config.workers}`).split('=')[1]
);

// ── Mutable state ────────────────────────────────────────────────────────────
const state = {
  completed:      null,   // Set of "system/filename" strings
  gamesData:      null,
  browser:        null,
  consecFailures: 0,      // shared across workers
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtBytes(b) {
  if (!b || b <= 0) return '0 B';
  if (b < 1_024)         return `${b} B`;
  if (b < 1_048_576)     return `${(b / 1_024).toFixed(1)} KB`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1_073_741_824).toFixed(2)} GB`;
}

function loadCompleted() {
  const set = new Set();
  if (!fs.existsSync(config.logFile)) return set;
  for (const ln of fs.readFileSync(config.logFile, 'utf8').split('\n')) {
    const t = ln.trim();
    if (t) set.add(t);
  }
  return set;
}

function fileOnDisk(systemId, zipFilename) {
  const dir = path.join(config.downloadDir, systemId);
  if (!fs.existsSync(dir)) return false;
  const stem = path.parse(zipFilename).name.toLowerCase();
  const files = fs.readdirSync(dir).map(f => path.parse(f).name.toLowerCase());

  // 1. Exact stem prefix: handles extra suffixes e.g. "Wrecking Crew (Japan) (Disk Writer).fds"
  if (files.some(f => f.startsWith(stem))) return true;

  // 2. Title-only fallback: handles region substitution where server only has Japan version
  //    but games.json lists USA. e.g. "Garou (USA).zip" → "Garou (Japan) (Track 1).bin" on disk.
  //    Anchors with ' (' to avoid "Mario" matching "Mario Kart".
  const titleOnly = stem.split(' (')[0];
  return files.some(f => f.startsWith(titleOnly + ' (') || f === titleOnly);
}

function logDone(systemId, filename) {
  fs.appendFileSync(config.logFile, `${systemId}/${filename}\n`);
}

function logFail(systemId, filename, reason) {
  const ts = new Date().toISOString();
  fs.appendFileSync(config.failFile, `[${ts}] ${systemId}/${filename}: ${reason}\n`);
}

function verifyZip(zipPath) {
  const { size } = fs.statSync(zipPath);
  if (size < 200) throw new Error(`File too small (${size} bytes) — likely an error page`);
  const buf = Buffer.alloc(4);
  const fd  = fs.openSync(zipPath, 'r');
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
    throw new Error(`Invalid zip header: ${buf.toString('hex')} — Cloudflare may have blocked the download`);
  }
}

// ── Directory Scan ───────────────────────────────────────────────────────────
async function scanDirectoryListing(page) {
  const entries = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href') || '')
      .filter(h => h.toLowerCase().endsWith('.zip'))
      .map(h => {
        const decoded  = decodeURIComponent(h);
        const filename = decoded.split('/').pop();
        return [filename.toLowerCase(), h];
      });
  });
  return entries;
}

function findDirEntry(entries, filename) {
  const lower = filename.toLowerCase();

  // 1. Exact case-insensitive match
  let hit = entries.find(([k]) => k === lower);
  if (hit) return hit[1];

  // 2. Match title + region, ignoring language suffix
  const noLang = lower.replace(/\s+\([a-z,]+\)\.zip$/, '.zip');
  hit = entries.find(([k]) => k.replace(/\s+\([a-z,]+\)\.zip$/, '.zip') === noLang);
  if (hit) return hit[1];

  // 3. Match on title only (before first parenthesis)
  const titleOnly = lower.split(' (')[0];
  const candidates = entries.filter(([k]) => k.startsWith(titleOnly));
  if (candidates.length === 1) return candidates[0][1];

  return null;
}

// ── Session Refresh ──────────────────────────────────────────────────────────
async function refreshSession(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
      await sleep(2_500);
      return true;
    } catch (e) {
      console.log(`    (session refresh attempt ${attempt}/3 failed: ${e.message.split('\n')[0]})`);
      if (attempt < 3) await sleep(20_000);
    }
  }
  return false;
}

// ── Download + Extract One Game ──────────────────────────────────────────────
async function processGame(workerId, page, context, system, game, idx, total, dirEntries) {
  const shortName = config.shortNames[system.id] || system.id;
  const W         = `[W${workerId + 1}]`;
  const tag       = `[${shortName} ${idx}/${total}]`;
  const gameName  = path.parse(game.filename).name;
  const zipPath   = path.join(config.zipsDir, game.filename);

  // Purge any leftover partial zip from a previous attempt
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  console.log(`${W} ${tag} Downloading: ${gameName}...`);
  const startMs = Date.now();

  // ── Step 1: CDP for file size + progress
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');

  let fileSize    = 0;
  let cdpReceived = 0;
  let lastPct     = -1;

  const stemFragment = encodeURIComponent(gameName.substring(0, 20));
  client.on('Network.responseReceived', (event) => {
    if (event.response.url.includes(stemFragment) || event.response.url === game.url) {
      const cl = event.response.headers['content-length'] || event.response.headers['Content-Length'];
      if (cl) fileSize = parseInt(cl, 10);
    }
  });

  client.on('Page.downloadProgress', (event) => {
    if (event.totalBytes > 0)    fileSize    = event.totalBytes;
    if (event.receivedBytes > 0) cdpReceived = event.receivedBytes;
  });

  // ── Step 2: Find the href in the scanned directory listing, then click it
  const rawHref = findDirEntry(dirEntries, game.filename);
  if (!rawHref) {
    await client.detach().catch(() => {});
    throw new Error(`SKIP:Not in directory listing: ${game.filename}`);
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 5 * 60_000 });

  await page.evaluate((href) => {
    const link = Array.from(document.querySelectorAll('a[href]'))
      .find(a => a.getAttribute('href') === href);
    if (link) link.click();
  }, rawHref);

  const download = await downloadPromise;

  // ── Step 3: Save + progress ticker
  let saveComplete = false;
  const savePromise = download.saveAs(zipPath).then(() => { saveComplete = true; });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`saveAs timed out after ${config.saveTimeoutMs / 60_000} min`)), config.saveTimeoutMs)
  );

  const ticker = setInterval(() => {
    if (saveComplete) return;
    try {
      const elapsed = (Date.now() - startMs) / 1_000;
      const size    = cdpReceived;
      if (size <= 0) return;
      const speed  = elapsed > 0 ? size / elapsed : 0;
      const pct    = fileSize > 0 ? Math.round(size / fileSize * 100) : -1;
      const dlMB   = (size / 1_048_576).toFixed(1);
      const totMB  = fileSize > 0 ? (fileSize / 1_048_576).toFixed(1) : '?';
      const spdStr = speed > 0 ? ` @ ${fmtBytes(speed)}/s` : '';

      // Log at 25% milestones
      if (pct >= 0 && pct !== lastPct && pct % 25 === 0) {
        lastPct = pct;
        console.log(`  ${W} ${tag} ${gameName} — ${pct}% (${dlMB}/${totMB} MB)${spdStr}`);
      }
    } catch (_) {}
  }, 2_000);

  await Promise.race([savePromise, timeoutPromise]);
  clearInterval(ticker);
  await client.detach().catch(() => {});

  // ── Step 4: Report and verify
  const elapsedS  = ((Date.now() - startMs) / 1_000).toFixed(1);
  const finalSize = fs.statSync(zipPath).size;
  console.log(`${W} ${tag} ↳ ${fmtBytes(finalSize)} in ${elapsedS}s`);

  verifyZip(zipPath);

  // ── Step 5: Extract
  const sysDir = path.join(config.downloadDir, system.id);
  fs.mkdirSync(sysDir, { recursive: true });
  process.stdout.write(`${W} ${tag} Extracting...`);
  await extractZip(zipPath, { dir: sysDir });

  if (!fileOnDisk(system.id, game.filename)) {
    throw new Error(`Extraction failed: no file matching "${gameName}" in ${sysDir}`);
  }

  // ── Step 6: Commit, clean up
  logDone(system.id, game.filename);
  fs.unlinkSync(zipPath);

  try {
    const tempPath = await download.path();
    if (tempPath && fs.existsSync(tempPath) && tempPath !== zipPath) {
      fs.unlinkSync(tempPath);
    }
  } catch (_) {}

  console.log(` done.`);

  // Discord notification (optional, non-blocking)
  discord(`✅ ${shortName} ${idx}/${total}: ${gameName} (${fmtBytes(finalSize)}, ${elapsedS}s)`).catch(() => {});
}

// ── Worker ───────────────────────────────────────────────────────────────────
async function runWorker(workerId, page, context, system, queue, dirEntries) {
  const W = `[W${workerId + 1}]`;
  let downloadsSinceRefresh = 0;

  while (true) {
    const item = queue.shift();
    if (!item) break;

    const { game, idx, total } = item;
    const key = `${system.id}/${game.filename}`;

    // Double-check: another worker may have completed this while we were busy
    if (state.completed.has(key) || fileOnDisk(system.id, game.filename)) {
      if (!state.completed.has(key)) { logDone(system.id, game.filename); state.completed.add(key); }
      continue;
    }

    let success = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        await processGame(workerId, page, context, system, game, idx, total, dirEntries);
        state.completed.add(key);
        success = true;
        state.consecFailures = 0;
        downloadsSinceRefresh++;

        // Periodic session refresh
        if (downloadsSinceRefresh >= config.sessionRefresh) {
          console.log(`  ${W} (periodic session refresh)`);
          try {
            await refreshSession(page, config.myrientBaseUrl + '/');
            await page.goto(system.base_url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
            await sleep(1_500);
          } catch (refreshErr) {
            if (refreshErr.message.includes('closed') || refreshErr.message.includes('Target page')) {
              console.error(`  ${W} Browser closed during periodic refresh — worker exiting.`);
              return;
            }
            throw refreshErr;
          }
          downloadsSinceRefresh = 0;
        }
        break;

      } catch (err) {
        // SKIP: file not on server — no point retrying
        if (err.message.startsWith('SKIP:')) {
          console.log(`  ${W} Skipping: ${err.message.slice(5)}`);
          logFail(system.id, game.filename, err.message.slice(5));
          success = true;
          break;
        }

        console.error(`\n  ${W} ✗ Attempt ${attempt}/${config.maxRetries}: ${err.message}`);

        // Clean up partial zip
        const zipPath = path.join(config.zipsDir, game.filename);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        if (attempt < config.maxRetries) {
          const retryWait = attempt * 15_000;
          console.log(`  ${W} Refreshing session, retrying in ${retryWait / 1_000}s...`);
          try {
            await refreshSession(page, config.myrientBaseUrl + '/');
            await page.goto(system.base_url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
            await sleep(1_500);
          } catch (refreshErr) {
            if (refreshErr.message.includes('closed') || refreshErr.message.includes('Target page')) {
              console.error(`  ${W} Browser closed during session refresh — logging failure, moving on.`);
              break;
            }
            throw refreshErr;
          }
          await sleep(retryWait);
        }
      }
    }

    if (!success) {
      state.consecFailures++;
      logFail(system.id, game.filename, `Failed after ${config.maxRetries} attempts`);
      console.error(`  ${W} Logged failure: ${game.filename}`);

      if (state.consecFailures >= 3) {
        console.log(`\n  3+ consecutive failures — pausing ${config.consecFailPause / 60_000} min.`);
        await discord(`⚠️ 3+ consecutive failures — pausing ${config.consecFailPause / 60_000} min`).catch(() => {});
        await sleep(config.consecFailPause);
        state.consecFailures = 0;
      }
    }

    await sleep(config.baseDelayMs);
  }

  console.log(`  ${W} Queue exhausted — worker done.`);
}

// ── Progress Report ──────────────────────────────────────────────────────────
function printReport(systems, completed) {
  const failCount = fs.existsSync(config.failFile)
    ? fs.readFileSync(config.failFile, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  console.log('\n=== Progress Report ===');
  let totDone = 0, totAll = 0;
  for (const sys of systems) {
    const done  = sys.games.filter(g => completed.has(`${sys.id}/${g.filename}`)).length;
    const total = sys.games.length;
    totDone += done;
    totAll  += total;
    console.log(`  ${sys.name.padEnd(26)} ${String(done).padStart(3)}/${total}  (${total - done} remaining)`);
  }
  console.log(`  ${'─'.repeat(38)}`);
  console.log(`  Total:   ${totDone}/${totAll} complete`);
  console.log(`  Failed:  ${failCount} (see download_failures.txt)`);

  // Discord summary (non-blocking)
  discord(`📊 Progress: ${totDone}/${totAll} complete, ${failCount} failed`).catch(() => {});
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  ensureDirs();

  state.completed = loadCompleted();
  state.gamesData = JSON.parse(fs.readFileSync(config.gamesFile, 'utf8'));
  let systems     = [...state.gamesData.systems].sort((a, b) => a.priority - b.priority);

  if (TEST_MODE) {
    console.log('┌─ TEST MODE: downloading one game to verify pipeline ─┐\n');
    // Pick the first system that has pending games
    const testSys = systems.find(s => s.games.some(g => !state.completed.has(`${s.id}/${g.filename}`)));
    if (testSys) systems = [testSys];
    else { console.log('No pending games to test with.'); return; }
  }

  console.log(`Launching Chromium (headless: ${config.headless}, workers: ${CONCURRENCY})...`);
  state.browser = await chromium.launch({
    headless: config.headless,
    downloadsPath: config.zipsDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-crash-reporter', '--no-crash-upload'],
  });

  const context = await state.browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });

  // Establish initial Cloudflare session
  const page0 = await context.newPage();
  console.log(`Navigating to ${config.myrientBaseUrl}...`);
  for (let attempt = 1; ; attempt++) {
    try {
      await page0.goto(config.myrientBaseUrl + '/', { timeout: 30_000, waitUntil: 'domcontentloaded' });
      await sleep(2_500);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      console.log(`  Initial nav failed (${err.message.split('\n')[0]}), retrying in 30s... (${attempt}/5)`);
      await sleep(30_000);
    }
  }

  const userAgent = await page0.evaluate(() => navigator.userAgent);
  console.log(`UA: ${userAgent}\n`);
  await discord(`🚀 Downloader started — ${CONCURRENCY} workers, ${systems.length} systems queued`).catch(() => {});

  try {
    for (const system of systems) {
      console.log(`\n══ ${system.name}  [priority ${system.priority}] ══`);

      // Build pending list; backfill disk files missing from log
      const pending = system.games.filter(g => {
        const key = `${system.id}/${g.filename}`;
        if (state.completed.has(key)) return false;
        if (fileOnDisk(system.id, g.filename)) {
          logDone(system.id, g.filename);
          state.completed.add(key);
          return false;
        }
        return true;
      });

      if (pending.length === 0) {
        console.log('  All done — skipping.');
        continue;
      }

      const toProcess     = TEST_MODE ? [pending[0]] : pending;
      const actualWorkers = Math.min(CONCURRENCY, toProcess.length);
      console.log(`  ${toProcess.length} to download (${system.games.length} total), ${actualWorkers} worker(s)\n`);

      // Create worker pages — page0 is reused as worker 0
      const pages = [page0];

      try {
        await page0.goto(system.base_url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
        await sleep(1_500);
      } catch (e) {
        console.log(`  [W1] Directory nav failed: ${e.message.split('\n')[0]}`);
      }

      for (let i = 1; i < actualWorkers; i++) {
        const p = await context.newPage();
        try {
          await p.goto(system.base_url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
          await sleep(1_000 + i * 500);
        } catch (e) {
          console.log(`  [W${i + 1}] Directory nav failed: ${e.message.split('\n')[0]}`);
        }
        pages.push(p);
      }

      // Scan directory listing once (shared read-only across all workers)
      let dirEntries = [];
      try {
        dirEntries = await scanDirectoryListing(pages[0]);
        console.log(`  Directory scan: ${dirEntries.length} zip files found on server\n`);
      } catch (e) {
        console.log(`  Directory scan failed: ${e.message}`);
      }

      // Build shared queue
      const queue = toProcess.map((game, i) => ({
        game,
        idx:   i + 1,
        total: toProcess.length,
      }));

      // Launch all workers concurrently
      await Promise.all(
        pages.map((page, i) => runWorker(i, page, context, system, queue, dirEntries))
      );

      // Close extra pages (keep page0 for next system)
      for (let i = 1; i < pages.length; i++) {
        await pages[i].close().catch(() => {});
      }

      printReport(systems, state.completed);

      // Discord: system complete
      const sysDone = system.games.filter(g => state.completed.has(`${system.id}/${g.filename}`)).length;
      if (sysDone === system.games.length) {
        await discord(`🎉 ${system.name} COMPLETE! (${sysDone}/${system.games.length})`).catch(() => {});
      }
    }

    console.log('\nAll done!');
    await discord('🏁 All systems complete!').catch(() => {});

  } catch (err) {
    console.error('\nFatal error:', err);
    await discord(`🚨 Fatal error: ${err.message}`).catch(() => {});
  } finally {
    printReport(systems, state.completed);
    console.log('\nClosing browser...');
    await state.browser.close();
  }
}

// ── Graceful SIGINT ──────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n\nInterrupted — printing progress and shutting down...');
  if (state.gamesData && state.completed) {
    printReport(
      [...state.gamesData.systems].sort((a, b) => a.priority - b.priority),
      state.completed
    );
  }
  if (state.browser) await state.browser.close().catch(() => {});
  process.exit(0);
});

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
