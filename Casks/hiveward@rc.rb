cask "hiveward@rc" do
  arch arm: "arm64", intel: "x64"

  version "1.4.36-rc.3"
  sha256 arm:   "563b6b14323fc9d5489299c82442d514bc12cabffc9d06d3964ed572af4b3955",
         intel: "457088c7021f07de1a419197f7b2bd00092741ad4727d4fef3d86af38a6831e7"

  url "https://github.com/Chaunyzhang/HiveWard/releases/download/v#{version}/hiveward-macos-#{arch}.dmg"
  name "HiveWard RC"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://onhiveward.dev/"

  livecheck do
    url "https://github.com/Chaunyzhang/HiveWard"
    regex(/^v?(\d+(?:\.\d+)+-rc\.\d+)$/i)
    strategy :github_releases do |json, regex|
      json.map do |release|
        next if release["draft"]
        next unless release["prerelease"]

        match = release["tag_name"]&.match(regex)
        next if match.blank?

        match[1]
      end
    end
  end

  # Use HiveWard’s prerelease-aware updater between frequent RCs.
  auto_updates true
  conflicts_with cask: "hiveward"
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
