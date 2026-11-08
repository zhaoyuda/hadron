import AppKit
import WebKit

@MainActor
final class WebController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
  let view = NSView()
  let webView: WKWebView
  private var pageDead = true            // no dashboard on screen (never loaded, or the unreachable page)
  private var retryTimer: Timer?
  private var serverURL: URL = AppDelegate.serverURL
  private var downloads: [ObjectIdentifier: URL] = [:]

  override init() {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()          // the token in localStorage survives relaunches
    cfg.preferences.isElementFullscreenEnabled = true
    cfg.applicationNameForUserAgent = "HadronShell/mac"
    // Dock badge: the web client already calls navigator.setAppBadge(n) /
    // clearAppBadge() for the "N need me" count (it targets Chrome's PWA badge).
    // WKWebView has no such API, so provide one that posts to the shell.
    let badgeJS = """
    (() => {
      const post = (n) => { try { window.webkit.messageHandlers.badge.postMessage(n == null ? 0 : n); } catch {} return Promise.resolve(); };
      navigator.setAppBadge = (n) => post(n == null ? 1 : n);
      navigator.clearAppBadge = () => post(0);
      window.__hadronShell = { name: "mac", version: "\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")" };
    })();
    """
    cfg.userContentController.addUserScript(WKUserScript(source: badgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView = WKWebView(frame: .zero, configuration: cfg)
    super.init()
    webView.configuration.userContentController.add(self, name: "badge")   // WKWebView copies cfg
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsMagnification = false       // zoom goes through pageZoom (reflows; xterm refits)
    webView.allowsBackForwardNavigationGestures = false
    webView.isInspectable = UserDefaults.standard.bool(forKey: "inspectable")   // defaults write dev.hadron.shell inspectable -bool true
    webView.underPageBackgroundColor = NSColor(srgbRed: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1)
    let z = UserDefaults.standard.double(forKey: "pageZoom")
    if z > 0 { webView.pageZoom = min(max(z, 0.5), 3) }
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  func load(_ url: URL) {
    serverURL = url
    retryTimer?.invalidate(); retryTimer = nil
    webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 15))
  }

  /// Woke from sleep. The dashboard's own WS/poll reconnect (1→4 s backoff)
  /// recovers a live page in under a second, so a reload — which re-attaches
  /// every terminal and re-spawns every pty — is only for a page that is NOT
  /// there: the unreachable page, or a load that never completed.
  func reloadIfStale() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self else { return }
      if self.pageDead { self.load(self.serverURL) }
    }
  }

  func zoom(by f: CGFloat) { zoom(to: webView.pageZoom * f) }
  func zoom(to m: CGFloat) {
    webView.pageZoom = min(max(m, 0.5), 3)
    UserDefaults.standard.set(Double(webView.pageZoom), forKey: "pageZoom")
  }

  // MARK: WKScriptMessageHandler
  nonisolated func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    // Reachable from every frame (the proxied notebook iframes too), so the body
    // is data: a number in range moves the badge, anything else is ignored.
    MainActor.assumeIsolated {
      guard let raw = (message.body as? NSNumber)?.intValue, raw >= 0 else { return }
      let n = min(raw, 999)
      NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    }
  }

  // MARK: WKNavigationDelegate
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let u = webView.url, u.scheme == serverURL.scheme else { return }   // the unreachable page is about:blank
    pageDead = false; NSLog("[shell] loaded %@", u.absoluteString)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showUnreachable(error)
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showUnreachable(error)   // a committed load that died: never leave the window without a retry armed
  }
  /// A load superseded by a newer one (⌘R mid-load, the ⌘, dialog) or a policy .cancel is
  /// reported as a failure too; painting the unreachable page over the live dashboard
  /// would cancel the newer load and then reload everything. The superseding navigation
  /// reports its own failure, so nothing is lost by ignoring these.
  private func isCancellation(_ error: Error) -> Bool {
    let e = error as NSError
    return (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled)
      || (e.domain == WKErrorDomain && e.code == 102)   // WebKitErrorFrameLoadInterruptedByPolicyChange
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    if action.shouldPerformDownload { decisionHandler(.download); return }
    // Every top-frame navigation (a click, a redirect, location.href, a form)
    // either stays on the dashboard's own origin or goes to the default browser;
    // nothing else may replace the dashboard inside a chrome-less window.
    if action.targetFrame?.isMainFrame ?? true {
      if sameOrigin(url) || url.scheme == "about" || url.scheme == "blob" { decisionHandler(.allow); return }
      if ["http", "https", "mailto", "tel"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
      decisionHandler(.cancel); return
    }
    decisionHandler(.allow)   // subframes (proxied notebooks) are the page's business
  }
  private func sameOrigin(_ url: URL) -> Bool {
    url.scheme == serverURL.scheme && url.host?.lowercased() == serverURL.host?.lowercased()
      && (url.port ?? defaultPort(url.scheme)) == (serverURL.port ?? defaultPort(serverURL.scheme))
  }
  private func defaultPort(_ scheme: String?) -> Int { scheme == "https" ? 443 : 80 }

  // MARK: downloads — the artifact toolbar's Download is a blob: + a.download click
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
  nonisolated func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    MainActor.assumeIsolated {
      let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      var name = suggestedFilename.replacingOccurrences(of: "/", with: "_")
      if name.isEmpty { name = "download" }
      var dest = dir.appendingPathComponent(name)
      var i = 2
      while FileManager.default.fileExists(atPath: dest.path) {   // WebKit refuses an existing path
        let ext = (name as NSString).pathExtension, base = (name as NSString).deletingPathExtension
        dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"); i += 1
      }
      downloads[ObjectIdentifier(download)] = dest
      completionHandler(dest)
    }
  }
  nonisolated func downloadDidFinish(_ download: WKDownload) {
    MainActor.assumeIsolated {
      if let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) { NSWorkspace.shared.activateFileViewerSelecting([dest]) }
    }
  }
  nonisolated func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    MainActor.assumeIsolated {
      downloads.removeValue(forKey: ObjectIdentifier(download))
      NSLog("[shell] download failed: %@", (error as NSError).description)
      if NSApp.modalWindow == nil {
        let a = NSAlert(); a.messageText = "Download failed"; a.informativeText = error.localizedDescription; a.runModal()
      }
    }
  }

  // MARK: WKUIDelegate — target=_blank, alerts, file chooser
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    guard let url = action.request.url else { return nil }
    if sameOrigin(url) { webView.load(URLRequest(url: url)) }   // markdown.js marks every absolute href _blank
    else if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    return nil
  }
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
  }
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }
  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert(); a.messageText = prompt
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); f.stringValue = defaultText ?? ""
    a.accessoryView = f; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn ? f.stringValue : nil)
  }
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let p = NSOpenPanel(); p.allowsMultipleSelection = parameters.allowsMultipleSelection; p.canChooseDirectories = parameters.allowsDirectories
    completionHandler(p.runModal() == .OK ? p.urls : nil)
  }

  // MARK: unreachable page
  private func showUnreachable(_ error: Error) {
    if isCancellation(error) { return }
    pageDead = true
    let host = serverURL.host ?? serverURL.absoluteString
    NSLog("[shell] load failed for %@: %@", host, (error as NSError).description)
    let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
    let html = """
    <!doctype html><meta charset=utf-8><title>Hadron</title>
    <style>body{margin:0;background:#0d1117;color:#c9d1d9;font:14px -apple-system,system-ui;display:flex;align-items:center;justify-content:center;height:100vh}
    .b{max-width:460px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{color:#8b949e;margin:4px 0}code{color:#c9d1d9}</style>
    <div class=b><h1>Can't reach <code>\(esc(host))</code></h1><p>\(esc((error as NSError).localizedDescription))</p><p>Retrying every 5 s · ⌘R to retry now · ⌘, to change the server URL</p></div>
    """
    webView.loadHTMLString(html, baseURL: nil)
    retryTimer?.invalidate()
    retryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.load(self?.serverURL ?? AppDelegate.serverURL) }
    }
  }
}
