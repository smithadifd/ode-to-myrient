#!/usr/bin/env node
/**
 * scraper.js — Myrient Directory Scraper & games.json Generator
 *
 * Browses Myrient's Apache-style directory listings using Playwright
 * to enumerate available consoles and their game files.
 *
 * Modes:
 *   1. Interactive (default) — Claude Code or the user walks through
 *      console selection, game filtering, and manifest generation.
 *   2. CLI — pass flags directly for automation.
 *
 * Usage:
 *   node src/scraper.js                          # interactive (for Claude Code)
 *   node src/scraper.js --list-systems            # print available systems
 *   node src/scraper.js --system=3ds --all        # all games for a system
 *   node src/scraper.js --system=3ds --top=25     # top 25 games (by filename, A-Z)
 *   node src/scraper.js --scan-existing           # scan download dir for already-owned files
 *
 * Output: writes/updates data/games.json
 *
 * Note: "top games" sorting is alphabetical from the directory listing.
 * For curated "best of" lists, Claude Code should use its knowledge of
 * game quality to filter the scraped results — the scraper just provides
 * the raw catalog from Myrient.
 */
'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs   = require('fs');
const path = require('path');
const { config, ensureDirs } = require('./config');

chromium.use(StealthPlugin());

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Known Myrient directory paths ────────────────────────────────────────────
// Maps system IDs to their Myrient directory paths.
// These are the most common No-Intro / Redump verified sets.
// Users can add custom paths in CLAUDE.local.md or extend this map.
const SYSTEM_CATALOG = {
  // Nintendo
  '3ds':        { name: 'Nintendo 3DS',           path: '/files/No-Intro/Nintendo - Nintendo 3DS (Decrypted)/' },
  'nds':        { name: 'Nintendo DS',             path: '/files/No-Intro/Nintendo - Nintendo DS (Decrypted)/' },
  'n64':        { name: 'Nintendo 64',             path: '/files/No-Intro/Nintendo - Nintendo 64 (ByteSwapped)/' },
  'snes':       { name: 'Super Nintendo',          path: '/files/No-Intro/Nintendo - Super Nintendo Entertainment System/' },
  'nes':        { name: 'Nintendo NES',            path: '/files/No-Intro/Nintendo - Nintendo Entertainment System (Headered)/' },
  'gb':         { name: 'Game Boy',                path: '/files/No-Intro/Nintendo - Game Boy/' },
  'gbc':        { name: 'Game Boy Color',          path: '/files/No-Intro/Nintendo - Game Boy Color/' },
  'gba':        { name: 'Game Boy Advance',        path: '/files/No-Intro/Nintendo - Game Boy Advance/' },
  'gamecube':   { name: 'Nintendo GameCube',       path: '/files/Redump/Nintendo - GameCube - NKit RVZ [zstd-19-128k]/' },
  'wii':        { name: 'Nintendo Wii',            path: '/files/Redump/Nintendo - Wii - NKit RVZ [zstd-19-128k]/' },
  'virtualboy': { name: 'Virtual Boy',             path: '/files/No-Intro/Nintendo - Virtual Boy/' },
  'fds':        { name: 'Famicom Disk System',     path: '/files/No-Intro/Nintendo - Family Computer Disk System (FDS)/' },
  'wiiu':       { name: 'Nintendo Wii U',          path: '/files/Redump/Nintendo - Wii U - WUX/' },
  'dsi':        { name: 'Nintendo DSi',            path: '/files/No-Intro/Nintendo - Nintendo DSi (Decrypted)/' },
  'new3ds':     { name: 'New Nintendo 3DS',        path: '/files/No-Intro/Nintendo - New Nintendo 3DS (Decrypted)/' },

  // Sony
  'psx':        { name: 'PlayStation',             path: '/files/Redump/Sony - PlayStation/' },
  'ps2':        { name: 'PlayStation 2',           path: '/files/Redump/Sony - PlayStation 2/' },
  'psp':        { name: 'PlayStation Portable',    path: '/files/Redump/Sony - PlayStation Portable/' },
  'ps3':        { name: 'PlayStation 3',           path: '/files/Redump/Sony - PlayStation 3/' },

  // Sega
  'genesis':    { name: 'Sega Genesis',            path: '/files/No-Intro/Sega - Mega Drive - Genesis/' },
  'dreamcast':  { name: 'Sega Dreamcast',          path: '/files/Redump/Sega - Dreamcast/' },
  'saturn':     { name: 'Sega Saturn',             path: '/files/Redump/Sega - Saturn/' },
  'mastersystem': { name: 'Sega Master System',    path: '/files/No-Intro/Sega - Master System - Mark III/' },

  // Microsoft
  'xbox':       { name: 'Xbox',                    path: '/files/Redump/Microsoft - Xbox/' },
  'xbox360':    { name: 'Xbox 360',                path: '/files/Redump/Microsoft - Xbox 360/' },

  // Other
  'arcade':     { name: 'Arcade (MAME)',           path: '/files/MAME/MAME Current ROMs (split)/' },
  'atari2600':  { name: 'Atari 2600',              path: '/files/No-Intro/Atari - 2600/' },
  'atari5200':  { name: 'Atari 5200',              path: '/files/No-Intro/Atari - 5200/' },
  'atari7800':  { name: 'Atari 7800',              path: '/files/No-Intro/Atari - 7800/' },
  'pcengine':   { name: 'PC Engine / TurboGrafx',  path: '/files/No-Intro/NEC - PC Engine - TurboGrafx-16/' },
};

// ── Scrape a directory listing ───────────────────────────────────────────────
async function scrapeDirectory(page, dirUrl) {
  await page.goto(dirUrl, { timeout: 30_000, waitUntil: 'domcontentloaded' });
  await sleep(2_000);

  const files = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => {
        const href = a.getAttribute('href') || '';
        const text = a.textContent.trim();
        return { href, text };
      })
      .filter(({ href }) => href.endsWith('.zip') || href.endsWith('.7z'))
      .map(({ href, text }) => {
        const decoded  = decodeURIComponent(href);
        const filename = decoded.split('/').pop();
        return { filename, href };
      });
  });

  return files;
}

// ── Filter: USA/World region only ────────────────────────────────────────────
function filterUSA(files) {
  return files.filter(f => {
    const lower = f.filename.toLowerCase();
    return lower.includes('(usa') || lower.includes('(world') || lower.includes('(us,');
  });
}

// ── Scan existing files on disk ──────────────────────────────────────────────
function scanExisting(systemId) {
  const dir = path.join(config.downloadDir, systemId);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir).map(f => path.parse(f).name.toLowerCase())
  );
}

// ── Build games.json for selected systems ────────────────────────────────────
async function buildManifest(selectedSystems, options = {}) {
  const { topN = 0, usaOnly = true } = options;

  console.log(`Launching Chromium to scrape Myrient...`);
  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Establish Cloudflare session
  console.log('Establishing session with Myrient...');
  await page.goto(config.myrientBaseUrl + '/', { timeout: 30_000, waitUntil: 'domcontentloaded' });
  await sleep(3_000);

  const systems = [];

  for (let i = 0; i < selectedSystems.length; i++) {
    const sysId = selectedSystems[i];
    const catalog = SYSTEM_CATALOG[sysId];
    if (!catalog) {
      console.error(`Unknown system: ${sysId}`);
      continue;
    }

    const dirUrl = config.myrientBaseUrl + catalog.path;
    console.log(`\n[${i + 1}/${selectedSystems.length}] Scraping ${catalog.name}...`);
    console.log(`  URL: ${dirUrl}`);

    let files;
    try {
      files = await scrapeDirectory(page, dirUrl);
      console.log(`  Found ${files.length} total files`);
    } catch (err) {
      console.error(`  Failed to scrape: ${err.message}`);
      continue;
    }

    // Filter to USA/World if requested
    if (usaOnly) {
      files = filterUSA(files);
      console.log(`  After USA/World filter: ${files.length} files`);
    }

    // Top N (alphabetical) if requested
    if (topN > 0 && files.length > topN) {
      files.sort((a, b) => a.filename.localeCompare(b.filename));
      files = files.slice(0, topN);
      console.log(`  Trimmed to top ${topN}`);
    }

    // Check existing downloads
    const existing = scanExisting(sysId);
    let completedCount = 0;

    const games = files.map(f => {
      const stem = path.parse(f.filename).name.toLowerCase();
      const alreadyHave = existing.has(stem) ||
        [...existing].some(e => e.startsWith(stem.split(' (')[0]));
      if (alreadyHave) completedCount++;
      return {
        filename: f.filename,
        url: config.myrientBaseUrl + catalog.path + f.href,
        completed: alreadyHave,
      };
    });

    if (completedCount > 0) {
      console.log(`  Already have ${completedCount}/${games.length} on disk`);
    }

    systems.push({
      id: sysId,
      name: catalog.name,
      priority: i + 1,
      base_url: dirUrl,
      total: games.length,
      completed: completedCount,
      remaining: games.length - completedCount,
      games,
    });

    // Polite delay between systems
    if (i < selectedSystems.length - 1) await sleep(3_000);
  }

  await browser.close();

  // Write manifest
  const manifest = { systems };
  const outPath = config.gamesFile;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  console.log(`\n✓ Manifest written to ${outPath}`);
  console.log(`  ${systems.length} systems, ${systems.reduce((s, sys) => s + sys.games.length, 0)} total games`);
  console.log(`  ${systems.reduce((s, sys) => s + sys.completed, 0)} already on disk`);

  return manifest;
}

// ── CLI mode ─────────────────────────────────────────────────────────────────
async function cli() {
  ensureDirs();

  if (process.argv.includes('--list-systems')) {
    console.log('\nAvailable systems on Myrient:\n');
    for (const [id, info] of Object.entries(SYSTEM_CATALOG)) {
      console.log(`  ${id.padEnd(14)} ${info.name}`);
    }
    console.log(`\nUsage: node src/scraper.js --system=<id> [--all | --top=N] [--include-all-regions]`);
    return;
  }

  const systemArg = process.argv.find(a => a.startsWith('--system='));
  if (!systemArg) {
    console.log('Usage:');
    console.log('  node src/scraper.js --list-systems');
    console.log('  node src/scraper.js --system=3ds --all');
    console.log('  node src/scraper.js --system=3ds --top=25');
    console.log('  node src/scraper.js --system=3ds,gamecube,psp --top=50');
    console.log('\nOr let Claude Code handle it interactively.');
    return;
  }

  const systems = systemArg.split('=')[1].split(',');
  const topArg  = process.argv.find(a => a.startsWith('--top='));
  const topN    = topArg ? parseInt(topArg.split('=')[1]) : 0;
  const usaOnly = !process.argv.includes('--include-all-regions');

  await buildManifest(systems, { topN, usaOnly });
}

// ── Exports (for use by Claude Code or other scripts) ────────────────────────
module.exports = {
  SYSTEM_CATALOG,
  scrapeDirectory,
  filterUSA,
  scanExisting,
  buildManifest,
};

// Run CLI if called directly
if (require.main === module) {
  cli().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
