#!/usr/bin/env bash
# monitor.sh — Autonomous ROM download monitor
#
# Consolidated from overnight_monitor_v2.sh, monitor_check.sh, and auto_monitor.sh.
# Reads config from .env, writes status to data/status.md, pings Discord (optional).
#
# Features:
#   - Adaptive polling interval: 30 min → 60 min (2 clean cycles) / 15 min (after issue)
#   - Discord alerts: system completions, node crash, orphans, stalls, morning summary
#   - Zombie crdownload auto-cleanup (>20 min stale)
#   - Writes machine-readable status.md each cycle
#
# Usage:
#   bash scripts/monitor.sh              # foreground
#   nohup bash scripts/monitor.sh &      # background (recommended)
#
# Requires: node, python3 (for games.json parsing), curl (for Discord)

set -euo pipefail

# ── Load config from .env ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Defaults
DOWNLOAD_DIR="$SCRIPT_DIR/roms"
DATA_DIR="$SCRIPT_DIR/data"
DISCORD_WEBHOOK_URL=""

if [ -f "$ENV_FILE" ]; then
  # Source .env, skipping comments and empty lines
  while IFS='=' read -r key value; do
    key=$(echo "$key" | tr -d ' ')
    value=$(echo "$value" | tr -d ' ')
    case "$key" in
      DOWNLOAD_DIR)        DOWNLOAD_DIR="$value" ;;
      DISCORD_WEBHOOK_URL) DISCORD_WEBHOOK_URL="$value" ;;
    esac
  done < <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
fi

# Resolve relative paths
[[ "$DOWNLOAD_DIR" != /* ]] && DOWNLOAD_DIR="$SCRIPT_DIR/$DOWNLOAD_DIR"
[[ "$DATA_DIR" != /* ]]     && DATA_DIR="$SCRIPT_DIR/$DATA_DIR"

DL_LOG="$DATA_DIR/download_log.txt"
FAIL_FILE="$DATA_DIR/download_failures.txt"
GAMES_FILE="$DATA_DIR/games.json"
STATUS_MD="$DATA_DIR/status.md"
STATE_FILE="$DATA_DIR/.monitor_state"
ZIPS_DIR="$DOWNLOAD_DIR/.rom_zips"
MONITOR_LOG="$DATA_DIR/monitor.log"

# ── Discord helper ────────────────────────────────────────────────────────────
discord() {
  [ -z "$DISCORD_WEBHOOK_URL" ] && return
  curl -s -o /dev/null -X POST "$DISCORD_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"content\": \"$1\"}" 2>/dev/null || true
}

discord_embed() {
  local title="$1" msg="$2" color="${3:-3447003}"
  [ -z "$DISCORD_WEBHOOK_URL" ] && return
  curl -s -o /dev/null -X POST "$DISCORD_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$msg\",\"color\":$color}]}" 2>/dev/null || true
}

# ── Sanity checks ─────────────────────────────────────────────────────────────
if [ ! -f "$GAMES_FILE" ]; then
  echo "ERROR: $GAMES_FILE not found. Run the scraper first."
  exit 1
fi

if [ ! -f "$DL_LOG" ]; then
  touch "$DL_LOG"
fi

# ── State ─────────────────────────────────────────────────────────────────────
interval=1800        # current sleep interval in seconds (start 30 min)
clean_cycles=0       # consecutive clean cycles (for backoff)
stall_cycles=0       # consecutive zero-activity cycles
prev_wc=$(wc -l < "$DL_LOG" 2>/dev/null | tr -d ' ')
announced_systems="" # pipe-separated system IDs already announced complete
morning_pinged=0
cycle=0

echo "[$(date '+%H:%M')] monitor started. prev_wc=$prev_wc interval=${interval}s" | tee -a "$MONITOR_LOG"

# ── Zombie crdownload cleanup ─────────────────────────────────────────────────
clean_zombies() {
  local cleaned=0
  [ -d "$ZIPS_DIR" ] || return
  for f in "$ZIPS_DIR"/*.crdownload; do
    [ -f "$f" ] || continue
    # Use stat in a portable way (Linux vs macOS)
    local mtime
    if stat --version 2>/dev/null | grep -q GNU; then
      mtime=$(stat -c %Y "$f")
    else
      mtime=$(stat -f %m "$f")
    fi
    local now age
    now=$(date +%s)
    age=$(( (now - mtime) / 60 ))
    if [ "$age" -gt 20 ]; then
      local sz
      if stat --version 2>/dev/null | grep -q GNU; then
        sz=$(( $(stat -c %s "$f") / 1024 / 1024 ))
      else
        sz=$(( $(stat -f %z "$f") / 1024 / 1024 ))
      fi
      echo "  [auto-clean] $(basename "$f") (${sz}MB, ${age}min stale)"
      rm "$f"
      cleaned=$((cleaned + 1))
    fi
  done
  [ "$cleaned" -gt 0 ] && echo "  Cleaned $cleaned zombie crdownload(s)"
}

# ── System completion checker ─────────────────────────────────────────────────
check_completions() {
  python3 - "$announced_systems" "$GAMES_FILE" "$DL_LOG" <<'PYEOF'
import json, sys, os
announced = set(sys.argv[1].split("|")) if sys.argv[1] else set()
with open(sys.argv[2]) as f: d = json.load(f)
with open(sys.argv[3]) as f: done = set(l.strip() for l in f if l.strip())
new_done = []
for s in d["systems"]:
    sid = s["id"]
    if sid in announced:
        continue
    total = len(s["games"])
    completed = sum(1 for g in s["games"] if f"{sid}/{g['filename']}" in done)
    if completed == total:
        new_done.append(sid)
print("|".join(new_done))
PYEOF
}

# ── Progress table generator ──────────────────────────────────────────────────
generate_progress() {
  python3 - "$GAMES_FILE" "$DL_LOG" "$FAIL_FILE" <<'PYEOF'
import json, sys, os
with open(sys.argv[1]) as f: d = json.load(f)
with open(sys.argv[2]) as f: done = set(l.strip() for l in f if l.strip())
fail_count = 0
if os.path.exists(sys.argv[3]):
    with open(sys.argv[3]) as f: fail_count = sum(1 for l in f if l.strip())
total = 0
done_total = 0
systems = sorted(d["systems"], key=lambda s: s.get("priority", 999))
for s in systems:
    sid = s["id"]
    t = len(s["games"])
    c = sum(1 for g in s["games"] if f"{sid}/{g['filename']}" in done)
    total += t
    done_total += c
    bar = '█' * round(c/t*20) + '░' * (20 - round(c/t*20)) if t > 0 else '░' * 20
    status = ' ✓' if c == t else ''
    print(f"| {sid:<12} | {c:>3}/{t} | {bar} |{status}")
print(f"TOTAL_DONE={done_total}")
print(f"TOTAL_ALL={total}")
print(f"FAIL_COUNT={fail_count}")
PYEOF
}

# ── Main loop ─────────────────────────────────────────────────────────────────
while true; do
  sleep "$interval"
  cycle=$((cycle + 1))

  now_h=$(date '+%H')
  now_m=$(date '+%M')
  now_mins=$(( 10#$now_h * 60 + 10#$now_m ))
  now_str=$(date '+%H:%M')
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  # ── Zombie cleanup ──────────────────────────────────────────────────────────
  clean_zombies

  # ── Morning summary (8:00–8:30 AM, once) ────────────────────────────────────
  if [ $now_mins -ge 480 ] && [ $now_mins -lt 510 ] && [ $morning_pinged -eq 0 ]; then
    wc_now=$(wc -l < "$DL_LOG" 2>/dev/null | tr -d ' ')
    node_pid=$(pgrep -f "node.*downloader" | head -1 || true)
    crcount=$(ls "$ZIPS_DIR"/*.crdownload 2>/dev/null | wc -l | tr -d ' ' || echo 0)
    discord "☀️ Morning summary ($now_str): $wc_now complete. Node PID: ${node_pid:-NONE}. Active downloads: $crcount."
    morning_pinged=1
    interval=1800
    clean_cycles=0
  fi
  [ $now_mins -ge 540 ] && morning_pinged=0

  # ── Process health check ────────────────────────────────────────────────────
  node_pid=$(pgrep -f "node.*downloader" | head -1 || true)
  if [ -z "$node_pid" ]; then
    discord "🚨 ROM downloader ($now_str): Node process not found! May need restart."
    clean_cycles=0
    interval=900
  fi

  # ── Orphan check ────────────────────────────────────────────────────────────
  if [ -d "$ZIPS_DIR" ]; then
    orphan_count=$(find "$ZIPS_DIR" -maxdepth 1 -type f ! -name "*.crdownload" ! -name "*.zip" ! -name ".gitkeep" -name "????????-????-????-????-????????????" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$orphan_count" -ge 2 ]; then
      discord "⚠️ ROM downloader ($now_str): $orphan_count orphan file(s) in staging dir"
      interval=900
    fi
  fi

  # ── Progress delta ──────────────────────────────────────────────────────────
  wc_now=$(wc -l < "$DL_LOG" 2>/dev/null | tr -d ' ')
  wc_delta=$(( wc_now - prev_wc ))
  crcount=$(ls "$ZIPS_DIR"/*.crdownload 2>/dev/null | wc -l | tr -d ' ' 2>/dev/null || echo 0)

  # ── System completions ──────────────────────────────────────────────────────
  new_complete=$(check_completions)
  if [ -n "$new_complete" ]; then
    for sid in $(echo "$new_complete" | tr '|' ' '); do
      discord "✅ System complete: $sid! $wc_now total done."
      announced_systems="${announced_systems}|${sid}"
    done
    clean_cycles=0
  fi

  # ── Stall detection ─────────────────────────────────────────────────────────
  if [ "$wc_delta" -eq 0 ] && [ "$crcount" -eq 0 ]; then
    stall_cycles=$(( stall_cycles + 1 ))
    if [ $stall_cycles -ge 2 ]; then
      discord "⚠️ ROM downloader ($now_str): No activity for 2 consecutive intervals — possible stall. wc=$wc_now"
      stall_cycles=0
      interval=900
      clean_cycles=0
    fi
  else
    stall_cycles=0
  fi

  # ── Adaptive interval ──────────────────────────────────────────────────────
  if [ "$wc_delta" -gt 0 ] || [ "$crcount" -gt 0 ]; then
    clean_cycles=$(( clean_cycles + 1 ))
    if [ $clean_cycles -ge 2 ] && [ $interval -lt 3600 ]; then
      interval=3600
      echo "[$now_str] 2 clean cycles — backing off to 60 min"
    elif [ $clean_cycles -lt 2 ]; then
      interval=1800
    fi
  else
    if [ $clean_cycles -gt 0 ]; then
      clean_cycles=0
      interval=900
      echo "[$now_str] Issue detected — tightening to 15 min"
    fi
  fi

  # ── Write status.md ─────────────────────────────────────────────────────────
  progress_output=$(generate_progress)
  done_count=$(echo "$progress_output" | grep '^TOTAL_DONE=' | cut -d= -f2)
  total_count=$(echo "$progress_output" | grep '^TOTAL_ALL=' | cut -d= -f2)
  fail_count=$(echo "$progress_output" | grep '^FAIL_COUNT=' | cut -d= -f2)
  table_rows=$(echo "$progress_output" | grep '^|')

  done_count=${done_count:-$wc_now}
  total_count=${total_count:-0}
  fail_count=${fail_count:-0}

  pct=0
  [ "$total_count" -gt 0 ] && pct=$(( done_count * 100 / total_count ))

  recent=$(tail -10 "$DL_LOG" 2>/dev/null | sed 's/^/- /' || echo "- (none)")

  cat > "$STATUS_MD" <<MARKDOWN
# ROM Download Status

> Auto-updated by monitor. Last update: **${timestamp}** (cycle ${cycle})

## Progress: ${done_count}/${total_count} (${pct}%)

| System       | Done  | Progress             |
|--------------|-------|----------------------|
${table_rows}

**Node PID**: ${node_pid:-NOT RUNNING}
**Active downloads**: ${crcount}
**Failed**: ${fail_count}

## Recent Completions
${recent}
MARKDOWN

  prev_wc=$wc_now
  echo "[$now_str] cycle=$cycle wc=$wc_now (Δ$wc_delta) active=$crcount interval=${interval}s" | tee -a "$MONITOR_LOG"
done
