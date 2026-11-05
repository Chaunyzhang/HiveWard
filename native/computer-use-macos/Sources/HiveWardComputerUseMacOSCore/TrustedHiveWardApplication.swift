/// Bundle ids of the apps whose computer-use sidecar may drive this helper.
public enum TrustedHiveWardApplication {
    public static func isTrusted(bundleId: String) -> Bool {
        // Why: `pnpm dev` launches as `app.hiveward.dev` and per-worktree wrapper apps use
        // `app.hiveward.dev.<name>`; the sidecar peer check must authorize both (#26498).
        bundleId == "app.hiveward" ||
            bundleId == "app.hiveward.dev" ||
            bundleId.hasPrefix("app.hiveward.dev.") ||
            bundleId == "app.hiveward" ||
            bundleId == "app.hiveward.dev" ||
            bundleId.hasPrefix("app.hiveward.dev.") ||
            bundleId == "com.github.Electron"
    }
}
