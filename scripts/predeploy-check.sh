#!/bin/bash
# Pre-deploy safety check — run BEFORE restarting the production Hadron service.
#
# Proves, on the staging instance, that a service restart does not interrupt
# running agents (the 2026-07-11 incident class: KillMode=control-group nuked
# every agent's tmux + claude process on deploy):
#
#   1. snapshot every claude PID under the staging tmux sessions
#   2. fire a live task into a claude agent so it is WORKING mid-restart
#   3. systemctl restart the staging service
#   4. assert: service up, HTTP up, every PID survived, sessions identical,
#      the busy agent is still busy, and no auto-resume fired (nothing died)
#   5. sanity-check the PROD unit still has KillMode=process
#
# Usage: scripts/predeploy-check.sh
#   env overrides: STG_SERVICE, STG_WS, STG_PORT, PROD_SERVICE, LIVE_AGENT
set -u
STG_SERVICE=${STG_SERVICE:-hadron-staging}
STG_WS=${STG_WS:-/home/ubuntu/staging-ws}
STG_PORT=${STG_PORT:-3001}
PROD_SERVICE=${PROD_SERVICE:-hadron}
LIVE_AGENT=${LIVE_AGENT:-dummy}

PASS=0; FAIL=0
ok() { if eval "$1"; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2"; fi; }
TOKEN=$(cat "$STG_WS/.hadron/token")
api() { curl -s -m 10 -H "x-hadron-token: $TOKEN" -H "Content-Type: application/json" "$@"; }
PREFIX="hadron-$(basename "$STG_WS")"

echo "# pre-deploy check: restart survivability on $STG_SERVICE"

# ── 1. snapshot ──
SESSIONS_BEFORE=$(tmux ls -F '#{session_name}' 2>/dev/null | grep "^$PREFIX" | sort)
PIDS_BEFORE=$(for s in $SESSIONS_BEFORE; do
  p=$(tmux list-panes -t "$s" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "$p" ] && pgrep -P "$p" -f claude 2>/dev/null || ps --ppid "$p" -o pid=,comm= 2>/dev/null | awk '/claude/{print $1}'
done | sort -u)
N_PIDS=$(echo "$PIDS_BEFORE" | grep -c . || true)
ok "[ $N_PIDS -ge 1 ]" "snapshot: $N_PIDS claude process(es) under $PREFIX-*"

# ── 2. make the canary WORK through the restart ──
api -X POST "http://127.0.0.1:$STG_PORT/api/sessions/$LIVE_AGENT/message" \
  -d '{"text":"Count from 1 to 25 in English words, one per line, slowly and carefully. Do not use any tools."}' >/dev/null
sleep 6
STATE_BEFORE=$(api "http://127.0.0.1:$STG_PORT/api/sessions" | python3 -c "
import json,sys
print(next((s.get('state') for s in json.load(sys.stdin) if s['id']=='$LIVE_AGENT'),'?'))")
ok "[ \"$STATE_BEFORE\" = working ]" "canary '$LIVE_AGENT' is working at restart time (state=$STATE_BEFORE)"

# ── 3. the restart ──
sudo systemctl restart "$STG_SERVICE"
sleep 4
ok "[ \"\$(systemctl is-active $STG_SERVICE)\" = active ]" "service came back (active)"
CODE=$(curl -s -m 5 -o /dev/null -w "%{http_code}" -H "x-hadron-token: $TOKEN" "http://127.0.0.1:$STG_PORT/api/sessions" || true)
ok "[ \"$CODE\" = 200 ]" "HTTP answers after restart ($CODE)"

# ── 4. nothing was interrupted ──
DEAD=""
for p in $PIDS_BEFORE; do kill -0 "$p" 2>/dev/null || DEAD="$DEAD $p"; done
ok "[ -z \"$DEAD\" ]" "every claude PID survived the restart${DEAD:+ (DEAD:$DEAD)}"
SESSIONS_AFTER=$(tmux ls -F '#{session_name}' 2>/dev/null | grep "^$PREFIX" | sort)
ok "[ \"$SESSIONS_BEFORE\" = \"$SESSIONS_AFTER\" ]" "tmux session list identical"
sleep 8
STATE_AFTER=$(api "http://127.0.0.1:$STG_PORT/api/sessions" | python3 -c "
import json,sys
print(next((s.get('state') for s in json.load(sys.stdin) if s['id']=='$LIVE_AGENT'),'?'))")
ok "[ \"$STATE_AFTER\" = working ] || [ \"$STATE_AFTER\" = done ] || [ \"$STATE_AFTER\" = idle ]" \
  "canary kept running through the restart (state now: $STATE_AFTER)"
RESUMES=$(journalctl -u "$STG_SERVICE" --since "1 minute ago" 2>/dev/null | grep -c "resuming session" || true)
ok "[ \"$RESUMES\" = 0 ]" "no auto-resume fired (nothing died to resume)"

# ── 5. prod unit config sanity ──
KM=$(systemctl show "$PROD_SERVICE" -p KillMode --value 2>/dev/null)
ok "[ \"$KM\" = process ]" "prod unit $PROD_SERVICE has KillMode=process ($KM)"
EN=$(systemctl is-enabled "$PROD_SERVICE" 2>/dev/null)
ok "[ \"$EN\" = enabled ]" "prod unit is boot-enabled ($EN)"

echo
[ $FAIL -eq 0 ] && echo "PRE-DEPLOY CHECK PASS ($PASS checks) — safe to restart $PROD_SERVICE" \
               || echo "PRE-DEPLOY CHECK FAIL ($FAIL failed) — DO NOT deploy"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
