import Testing
@testable import HiveWardComputerUseMacOSCore

@Suite("TrustedHiveWardApplication")
struct TrustedHiveWardApplicationTests {
    @Test("trusts the packaged app, every dev build and stock Electron")
    func trusted() {
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward"))
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward.dev"))
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward.dev.branch"))
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward"))
        // What `pnpm dev` launches as: DEV_BUNDLE_ID in dev-electron-bundle-identity.mjs (#26498).
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward.dev"))
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward.dev.worktree"))
        #expect(TrustedHiveWardApplication.isTrusted(bundleId: "com.github.Electron"))
    }

    @Test("rejects look-alike and unrelated bundle ids")
    func untrusted() {
        #expect(!TrustedHiveWardApplication.isTrusted(bundleId: "app.hivewardevil"))
        #expect(!TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward.devtools"))
        #expect(!TrustedHiveWardApplication.isTrusted(bundleId: "app.hiveward.devtools"))
        #expect(!TrustedHiveWardApplication.isTrusted(bundleId: "app.hivewardx"))
        #expect(!TrustedHiveWardApplication.isTrusted(bundleId: "com.example.hiveward"))
        #expect(!TrustedHiveWardApplication.isTrusted(bundleId: ""))
    }
}
