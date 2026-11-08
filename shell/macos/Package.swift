// swift-tools-version:5.9
// Hadron's Mac shell: one window of WKWebView around the web client, built on a
// Mac with `shell/macos/build.sh` (no Xcode project — SwiftPM + a hand-made bundle).
import PackageDescription

let package = Package(
  name: "HadronShell",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "HadronShell", path: "Sources/HadronShell",
                      swiftSettings: [.unsafeFlags(["-parse-as-library"])])
  ]
)
