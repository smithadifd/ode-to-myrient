'use strict';

const path = require('path');
const fs   = require('fs');

// Load .env from project root (one level up from src/)
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// ── Resolve paths ────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolvePath(p) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(PROJECT_ROOT, p);
}

const DOWNLOAD_DIR = resolvePath(process.env.DOWNLOAD_DIR || './roms');
const DATA_DIR     = resolvePath('./data');

// ── Config object ────────────────────────────────────────────────────────────

const config = {
  // Paths
  projectRoot:  PROJECT_ROOT,
  downloadDir:  DOWNLOAD_DIR,
  dataDir:      DATA_DIR,
  zipsDir:      path.join(DOWNLOAD_DIR, '.rom_zips'),
  logFile:      path.join(DATA_DIR, 'download_log.txt'),
  failFile:     path.join(DATA_DIR, 'download_failures.txt'),
  gamesFile:    path.join(DATA_DIR, 'games.json'),
  statusFile:   path.join(DATA_DIR, 'status.md'),
  stateFile:    path.join(DATA_DIR, '.monitor_state'),

  // Workers & timing
  workers:       parseInt(process.env.WORKERS || '3', 10),
  baseDelayMs:   parseInt(process.env.BASE_DELAY_MS || '3000', 10),
  maxRetries:    parseInt(process.env.MAX_RETRIES || '3', 10),
  consecFailPause: 5 * 60_000,     // 5 min pause after 3+ consecutive failures
  sessionRefresh:  10,              // re-nav every N downloads per worker
  saveTimeoutMs:   1440 * 60_000,   // 24hr cap on saveAs (handles huge files)

  // Browser
  headless: (process.env.HEADLESS || 'false').toLowerCase() === 'true',

  // Discord (optional)
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',

  // Myrient
  myrientBaseUrl: 'https://myrient.erista.me',

  // Short display names for systems
  shortNames: {
    '3ds':        '3DS',
    'wii':        'Wii',
    'gamecube':   'GCN',
    'nds':        'NDS',
    'virtualboy': 'VB',
    'fds':        'FDS',
    'ps2':        'PS2',
    'psp':        'PSP',
    'dreamcast':  'DC',
    'saturn':     'Saturn',
    'n64':        'N64',
    'snes':       'SNES',
    'nes':        'NES',
    'genesis':    'GEN',
    'gba':        'GBA',
    'gbc':        'GBC',
    'gb':         'GB',
    'psx':        'PSX',
    'arcade':     'ARC',
    'atari2600':  '2600',
    'atari5200':  '5200',
    'atari7800':  '7800',
    'pcengine':   'PCE',
    'mastersystem':'SMS',
  },
};

// ── Ensure directories exist ─────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(config.downloadDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.zipsDir, { recursive: true });
}

// ── Discord helper ───────────────────────────────────────────────────────────

async function discord(message) {
  if (!config.discordWebhookUrl) return;
  try {
    const https = require('https');
    const url = new URL(config.discordWebhookUrl);
    const payload = JSON.stringify({ content: message });
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    req.write(payload);
    req.end();
  } catch (_) {
    // Discord is best-effort — don't crash on webhook failures
  }
}

module.exports = { config, ensureDirs, discord };
