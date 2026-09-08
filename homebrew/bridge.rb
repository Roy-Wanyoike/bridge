# homebrew/bridge.rb — Homebrew formula for the Bridge CLI.
#
# Installed from the GitHub release binaries produced by
# .github/workflows/release.yml (scripts/package-release.mjs layout).
#
# Local tap layout (for testing):
#   brew tap-new <user>/bridge
#   cp homebrew/bridge.rb $(brew --repository)/Library/Taps/<user>/homebrew-bridge/
#   brew install <user>/bridge/bridge
class Bridge < Formula
  desc "One contract, every language, zero interoperability drift"
  homepage "https://github.com/Roy-Wanyoike/bridge"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.intel?
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-darwin-amd64"
      sha256 :no_check # pinned per release by the release workflow
    else
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-darwin-arm64"
      sha256 :no_check
    end
  end
  on_linux do
    if Hardware::CPU.intel?
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-linux-amd64"
      sha256 :no_check
    else
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-linux-arm64"
      sha256 :no_check
    end
  end

  def install
    bin.install "bridge-#{version}" => "bridge" if File.exist?("bridge-#{version}")
    binary = Dir["bridge-v#{version}-*"].first
    File.delete(binary) if File.exist?(binary) # formula installs the fetched binary directly
    bin.install binary => "bridge" if binary
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bridge version")
  end
end
