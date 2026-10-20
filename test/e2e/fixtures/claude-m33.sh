#!/usr/bin/env bash
if [ -z "$HADRON_FIX_REEXEC" ]; then HADRON_FIX_REEXEC=1 exec -a claude bash "$0" "$@"; fi
TR="$1"; LOG="$2"
printf '\e[?2004h' # bracketed paste on, like claude: tmux then wraps a paste-buffer in the markers
printf '\n❯ \n'
buf=""; inpaste=0
M0=$'\e[200~'; M1=$'\e[201~' # quoted in the patterns: a bare [200~ would be a bracket expression
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG"
  case "$line" in *"$M0"*) inpaste=1; line="${line#*"$M0"}";; esac
  if [ "$inpaste" = 1 ]; then
    case "$line" in
      *"$M1"*) line="${line%"$M1"*}"; buf="${buf}${line}"; inpaste=0
        python3 - "$TR" "$buf" <<'PY'
import json, sys, uuid, datetime
tr, text = sys.argv[1], sys.argv[2]
with open(tr, "a") as f:
    f.write(json.dumps({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), "message": {"role": "user", "content": text}}) + "\n")
PY
        buf="";;
      *) buf="${buf}${line}"$'\n';;
    esac
  fi
  printf '\n❯ \n'
done
