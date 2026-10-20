#!/usr/bin/env bash
# A process NAMED claude that shows claude's dialogs and logs every key it
# gets, one %q-quoted token per line (test-dialog.js + M34). On start it shows
# the Bash permission dialog; a digit, Escape or Enter answers it (back to the
# ❯ prompt); D shows it again, T shows the folder-trust list (unnumbered:
# ↓/↑ move the ❯ — redrawn, like claude — Enter confirms); Tab opens the amend
# line (text, then Enter). A arms "show the same dialog again right after the
# next answer" (a retried tool: the result line above, the dialog below, no
# idle screen in between); I arms "swallow the next answer" (the keystroke is
# logged, the screen does not change); M shows a "Needs input" screen that is
# no dialog (a y/n question with no option list).
if [ -z "$HADRON_FIX_REEXEC" ]; then HADRON_FIX_REEXEC=1 exec -a claude bash "$0" "$@"; fi
LOG="$1"
log() { printf '%q\n' "$1" >> "$LOG"; }
# claude pins its dialog at the bottom of the screen; the detector reads the
# last 15 rows, so each screen is scrolled down past a tall pane first.
fresh() { printf '\e[2J\e[H'; yes '' | head -n 120; }
MODE=idle; SEL=0; REPEAT=0; IGNORE=0
idle() { MODE=idle; fresh; printf '\n\xe2\x9d\xaf \n'; }
dialog_bash() { MODE=bash; fresh; [ -n "$1" ] && printf '%s\n' "$1"; cat <<'EOT'
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Remove zz.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 rm -f zz.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /home/user/proj
      from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
EOT
}
dialog_trust() { MODE=trust; fresh; cat <<'EOT'
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/proj

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open
 source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

EOT
  if [ "$SEL" = 0 ]; then printf ' \xe2\x9d\xaf No, exit\n   Yes, I trust this folder\n'; else printf '   No, exit\n \xe2\x9d\xaf Yes, I trust this folder\n'; fi
  printf '\n Enter to confirm · Esc to cancel\n'
}
answered() { # a digit, Enter or Escape took the dialog
  if [ "$IGNORE" = 1 ]; then IGNORE=0; return; fi
  if [ "$REPEAT" = 1 ]; then REPEAT=0; dialog_bash ' ⎿  Removed zz.txt'; return; fi
  if [ "$MODE" = miss ]; then idle; return; fi
  idle
}
dialog_bash
while IFS= read -rsN1 ch; do
  case "$ch" in
    $'\e')
      rest=""; IFS= read -rsN2 -t 0.2 rest
      case "$rest" in
        "[B"|"OB") log DOWN; if [ "$MODE" = trust ]; then SEL=1; dialog_trust; else printf '\n'; fi;;
        "[A"|"OA") log UP; if [ "$MODE" = trust ]; then SEL=0; dialog_trust; else printf '\n'; fi;;
        "") log ESC; answered;;
        *) log "ESC$rest";;
      esac;;
    $'\t') log TAB; printf '\n Yes, and tell Claude what to do next: ';;
    $'\r'|$'\n') log ENTER; answered;;
    [0-9]) log "$ch"; answered;;
    D) log D; dialog_bash;;
    T) log T; SEL=0; dialog_trust;;
    A) log A; REPEAT=1;;
    I) log I; IGNORE=1;;
    M) log M; MODE=miss; fresh; printf '\n Do you want to proceed? (y/n) \n';;
    *) log "$ch"; printf '%s' "$ch";;
  esac
done
