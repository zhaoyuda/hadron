import AppKit
import WebKit

// The shell is deliberately thin: the conversation UI, terminal and every
// feature live in the shared web client; this process gives them a Dock icon,
// a window that remembers itself, native Edit menus (so ⌘V and the Chinese IME
// work as in any Mac app), a Dock badge for "N need me", and a reload after
// sleep or a lost server. Nothing here knows about agents.

@main
struct HadronShellMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var web: WebController!

  static let defaultURL = "http://localhost:3000/"
  /// Validated the same way the ⌘, dialog validates: an http(s) URL with a host.
  /// `defaults write` can put anything here; a bad value falls back to localhost.
  static var serverURL: URL {
    if let s = UserDefaults.standard.string(forKey: "serverURL"), let u = URL(string: s),
       u.host != nil, ["http", "https"].contains(u.scheme ?? "") { return u }
    return URL(string: defaultURL)!
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenus()
    web = WebController()
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = "Hadron"
    window.titlebarAppearsTransparent = false
    window.setFrameAutosaveName("HadronMain")   // remembers size + position
    window.backgroundColor = NSColor(srgbRed: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
    window.contentView = web.view
    window.minSize = NSSize(width: 640, height: 400)
    window.isReleasedWhenClosed = false
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    web.load(AppDelegate.serverURL)

    // After sleep the WS is dead and the page's own reconnect may have given up:
    // reload once the machine is back.
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in self?.web.reloadIfStale() }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    return true
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // MARK: menus
  func buildMenus() {
    let main = NSMenu()

    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Hadron", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Server URL…", action: #selector(setServerURL), keyEquivalent: ",")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Hadron", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Hadron", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

    // A real Edit menu is what makes ⌘C/⌘V/⌘A and IME candidate windows behave
    // inside WKWebView — without it the key equivalents go nowhere.
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")   // first-responder action, no typed symbol
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    let pm = edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
    pm.keyEquivalentModifierMask = [.command, .option]
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)

    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
    view.addItem(.separator())
    view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
    view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")   // what ⌘+ is on the keyboard
    view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
    view.addItem(.separator())
    let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fs.keyEquivalentModifierMask = [.command, .control]
    let viewItem = NSMenuItem(); viewItem.submenu = view; main.addItem(viewItem)

    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windowMenu.addItem(.separator())
    windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = main
  }

  @objc func reload() { web.load(AppDelegate.serverURL) }
  @objc func openInBrowser() {
    let u = web.webView.url
    NSWorkspace.shared.open(["http", "https"].contains(u?.scheme ?? "") ? u! : AppDelegate.serverURL)   // not about:blank
  }
  @objc func zoomIn() { web.zoom(by: 1.1) }
  @objc func zoomOut() { web.zoom(by: 1 / 1.1) }
  @objc func zoomReset() { web.zoom(to: 1) }

  @objc func setServerURL() {
    let alert = NSAlert()
    alert.messageText = "Hadron server URL"
    alert.informativeText = "The dashboard this window shows. http://localhost:3000/ for a server on this Mac; a tailnet host for a remote one."
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
    field.stringValue = AppDelegate.serverURL.absoluteString
    alert.accessoryView = field
    alert.addButton(withTitle: "Connect")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    var s = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if !s.contains("://") { s = "http://" + s }
    if !s.hasSuffix("/") && URL(string: s)?.path.isEmpty == true { s += "/" }
    guard let u = URL(string: s), u.host != nil, ["http", "https"].contains(u.scheme ?? "") else { NSSound.beep(); return }
    UserDefaults.standard.set(u.absoluteString, forKey: "serverURL")
    web.load(u)
  }
}
