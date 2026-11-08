# Hadron.app — the Mac shell

A thin window around the web client: Dock icon + badge ("N need me"), a window that
remembers its frame, native Edit menu (⌘V, Chinese IME), reload after sleep, an
unreachable-server page that retries. Every feature is the shared web UI; nothing
here knows about agents.

```bash
shell/macos/build.sh            # → ~/Applications/Hadron.app
open ~/Applications/Hadron.app
```

Server URL: Hadron → Server URL… (⌘,), default `http://localhost:3000/`. Stored in
`defaults` under `dev.hadron.shell serverURL`:

```bash
defaults write dev.hadron.shell serverURL http://homelab-sg:3000/
```

Downloads land in ~/Downloads and are revealed in Finder. Web Inspector:
`defaults write dev.hadron.shell inspectable -bool true` (then right-click → Inspect).

Not in this cut: global summon shortcut, menu-bar item, system notifications
(the web Notification API is not available inside WKWebView; the Dock badge is
the only out-of-app signal until a UNUserNotificationCenter bridge exists),
auto-update.
