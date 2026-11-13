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
def rec(content):
    return json.dumps({"type": "user", "uuid": str(uuid.uuid4()), "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"), "message": {"role": "user", "content": content}}) + "\n"
# /model and /effort answer like claude 2.1.321: the command envelope, then its output
names = {"sonnet": "Sonnet 5.5", "opus": "Opus 5.5", "haiku": "Haiku 4.5", "fable": "Fable 5.1"}
with open(tr, "a") as f:
    if text.startswith("/model "):
        a = text.split(" ", 1)[1]
        f.write(rec(f"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>{a}</command-args>"))
        f.write(rec(f"<local-command-stdout>Set model to \u001b[1m{names.get(a, a)}\u001b[22m and saved as your default for new sessions</local-command-stdout>"))
    elif text.startswith("/effort "):
        a = text.split(" ", 1)[1]
        f.write(rec(f"<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>{a}</command-args>"))
        f.write(rec(f"<local-command-stdout>Set effort level to {a}</local-command-stdout>"))
    else:
        f.write(rec(text))
PY
        buf="";;
      *) buf="${buf}${line}"$'\n';;
    esac
  fi
  printf '\n❯ \n'
done
