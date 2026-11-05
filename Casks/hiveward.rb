cask "hiveward" do
  arch arm: "arm64", intel: "x64"

  version "1.3.24"
  sha256 arm:   "fc707f290ff3b631b7b7947bf339885b61a43d2e89475997c125b61268ed4966",
         intel: "5f677c13a08f7a5740442e29d388285a86488c8c1f7aa5f10a8721a2c6ede8e4"

  url "https://github.com/Chaunyzhang/HiveWard/releases/download/v#{version}/hiveward-macos-#{arch}.dmg"
  name "HiveWard"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://onhiveward.dev/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Let the in-app updater own updates; Homebrew skips auto_updates unless --greedy.
  auto_updates true
  conflicts_with cask: "hiveward@rc"
  depends_on macos: :big_sur

  app "HiveWard.app"

  # Expose the symlink-resolving bundled CLI on PATH so headless hosts can use hiveward serve without the in-app installer.
  binary "#{appdir}/HiveWard.app/Contents/Resources/bin/hiveward"

  # Zap app-created ~/.hiveward and Electron userData for a clean uninstall.
  zap trash: [
    "~/.hiveward",
    "~/Library/Application Support/HiveWard",
    "~/Library/Caches/app.hiveward",
    "~/Library/Caches/app.hiveward.ShipIt",
    "~/Library/HTTPStorages/app.hiveward",
    "~/Library/Preferences/app.hiveward.plist",
    "~/Library/Saved Application State/app.hiveward.savedState",
  ]
end
